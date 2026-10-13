import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { DateTime } from 'luxon';
import type { AppConfig } from '../config.js';
import { fromGraphUtc, toGraphLocal, toGraphUtc } from '../domain/time.js';
import {
  GraphError,
  type BusyInterval,
  type DeltaResult,
  type EventPatch,
  type GraphCaller,
  type GraphEvent,
  type GraphGateway,
  type GraphPlace,
  type GraphSubscription,
  type GraphUser,
  type NewEventInput,
  type ShowAs,
} from './types.js';

export interface TokenProvider {
  appToken(): Promise<string>;
  /** On-behalf-of: exchanges the user's access token for Ritrovo's API for a Graph token. */
  userToken(userAssertion: string): Promise<string>;
}

const GRAPH_DEFAULT_SCOPE = 'https://graph.microsoft.com/.default';

export class MsalTokenProvider implements TokenProvider {
  private cca: ConfidentialClientApplication;

  constructor(cfg: AppConfig) {
    const { tenantId, clientId, clientSecret, certPath, keyPath, authorityHost } = cfg.entra;
    if (!tenantId || !clientId) throw new Error('ENTRA_TENANT_ID e ENTRA_CLIENT_ID sono obbligatori in modalità live.');
    let credential: { clientSecret: string } | { clientCertificate: { thumbprintSha256: string; privateKey: string } };
    if (certPath && keyPath) {
      const certPem = readFileSync(certPath, 'utf8');
      const thumbprintSha256 = new X509Certificate(certPem).fingerprint256.replace(/:/g, '');
      credential = { clientCertificate: { thumbprintSha256, privateKey: readFileSync(keyPath, 'utf8') } };
    } else if (clientSecret) {
      credential = { clientSecret };
    } else {
      throw new Error('Serve un certificato (consigliato) o un client secret per il client riservato.');
    }
    this.cca = new ConfidentialClientApplication({
      auth: { clientId, authority: `${authorityHost}/${tenantId}`, ...credential },
    });
  }

  async appToken(): Promise<string> {
    const r = await this.cca.acquireTokenByClientCredential({ scopes: [GRAPH_DEFAULT_SCOPE] });
    if (!r?.accessToken) throw new GraphError(401, 'TokenError', 'Impossibile ottenere il token applicativo.');
    return r.accessToken;
  }

  async userToken(userAssertion: string): Promise<string> {
    const r = await this.cca.acquireTokenOnBehalfOf({ oboAssertion: userAssertion, scopes: [GRAPH_DEFAULT_SCOPE] });
    if (!r?.accessToken) throw new GraphError(401, 'TokenError', 'Impossibile ottenere il token delegato (on-behalf-of).');
    return r.accessToken;
  }
}

/** Limits concurrent requests per mailbox (Outlook allows four concurrent requests per app and mailbox). */
class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export interface GraphHttpOptions {
  baseUrl: string;
  tokens: TokenProvider;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  maxConcurrentPerMailbox?: number;
  logger?: { warn: (obj: unknown, msg?: string) => void };
}

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Mailbox used for concurrency limiting. */
  mailboxKey?: string;
  /** Return null instead of throwing on 404. */
  allow404?: boolean;
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const PREFER_UTC = 'outlook.timezone="UTC"';

export class GraphHttp {
  private semaphores = new Map<string, Semaphore>();
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;

  constructor(private readonly opts: GraphHttpOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxAttempts = opts.maxAttempts ?? 6;
  }

  async token(caller: GraphCaller): Promise<string> {
    if (caller.kind === 'app') return this.opts.tokens.appToken();
    if (!caller.token) throw new GraphError(401, 'MissingUserToken', 'Token utente assente: impossibile chiamare Graph per conto dell\'utente.');
    return this.opts.tokens.userToken(caller.token);
  }

  async request<T = any>(caller: GraphCaller, method: string, pathOrUrl: string, options: RequestOptions = {}): Promise<T | null> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.opts.baseUrl}${pathOrUrl}`;
    const key = (options.mailboxKey ?? 'global').toLowerCase();
    let sem = this.semaphores.get(key);
    if (!sem) {
      sem = new Semaphore(this.opts.maxConcurrentPerMailbox ?? 4);
      this.semaphores.set(key, sem);
    }
    return sem.run(async () => {
      for (let attempt = 1; ; attempt++) {
        const token = await this.token(caller);
        let res: Response;
        try {
          res = await this.fetchImpl(url, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json',
              ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
              ...options.headers,
            },
            body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          });
        } catch (err) {
          if (attempt >= this.maxAttempts) throw new GraphError(0, 'NetworkError', `Errore di rete verso Microsoft Graph: ${(err as Error).message}`);
          await this.sleep(this.backoff(attempt, null));
          continue;
        }
        if (RETRYABLE.has(res.status) && attempt < this.maxAttempts) {
          const wait = this.backoff(attempt, res.headers.get('retry-after'));
          this.opts.logger?.warn({ status: res.status, wait, url: redact(url) }, 'Graph throttling/transient error, retrying');
          await this.sleep(wait);
          continue;
        }
        if (res.status === 404 && options.allow404) return null;
        if (res.status === 204 || res.status === 202) return null;
        const text = await res.text();
        const json = text ? safeJson(text) : null;
        if (!res.ok) {
          const err = json?.error ?? {};
          throw new GraphError(res.status, err.code ?? `HTTP${res.status}`, err.message ?? `Microsoft Graph ha risposto ${res.status}`);
        }
        return json as T;
      }
    });
  }

  /** Follows @odata.nextLink pages. */
  async collect<T = any>(caller: GraphCaller, path: string, options: RequestOptions = {}): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    let guard = 0;
    while (next && guard++ < 200) {
      const page: any = await this.request(caller, 'GET', next, options);
      out.push(...(page?.value ?? []));
      next = page?.['@odata.nextLink'];
    }
    return out;
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs)) return Math.min(secs, 120) * 1000;
      const date = Date.parse(retryAfter);
      if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 120_000));
    }
    const base = Math.min(30_000, 500 * 2 ** (attempt - 1));
    return base + Math.floor(Math.random() * 250);
  }
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function redact(url: string): string {
  return url.replace(/(\$deltatoken|\$skiptoken)=[^&]+/gi, '$1=…');
}

/** Windows time zone names Graph may return, mapped to IANA zones with the same rules. */
const WINDOWS_TO_IANA: Record<string, string> = {
  UTC: 'UTC',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'GMT Standard Time': 'Europe/London',
};

export function parseGraphDateTime(v: { dateTime: string; timeZone?: string } | undefined): Date {
  if (!v) throw new Error('Data mancante nella risposta Graph');
  const tz = v.timeZone ?? 'UTC';
  if (tz === 'UTC' || tz === 'Etc/GMT' || tz === 'tzone://Microsoft/Utc') return fromGraphUtc(v.dateTime);
  const zone = WINDOWS_TO_IANA[tz] ?? tz;
  const dt = DateTime.fromISO(v.dateTime.replace(/\.\d+$/, ''), { zone });
  if (!dt.isValid) throw new Error(`Fuso orario non gestito nella risposta Graph: ${tz}`);
  return dt.toJSDate();
}

export function mapGraphEvent(j: any): GraphEvent {
  return {
    id: j.id,
    iCalUId: j.iCalUId ?? '',
    subject: j.subject ?? '',
    start: parseGraphDateTime(j.start),
    end: parseGraphDateTime(j.end),
    organizerEmail: (j.organizer?.emailAddress?.address ?? '').toLowerCase(),
    organizerName: j.organizer?.emailAddress?.name ?? undefined,
    attendees: (j.attendees ?? []).map((a: any) => ({
      email: (a.emailAddress?.address ?? '').toLowerCase(),
      name: a.emailAddress?.name ?? undefined,
      type: a.type ?? 'required',
      response: a.status?.response ?? 'none',
    })),
    showAs: (j.showAs ?? 'busy') as ShowAs,
    isCancelled: Boolean(j.isCancelled),
    type: j.type ?? 'singleInstance',
    seriesMasterId: j.seriesMasterId ?? undefined,
    onlineMeetingUrl: j.onlineMeeting?.joinUrl ?? undefined,
    transactionId: j.transactionId ?? undefined,
    responseStatus: j.responseStatus?.response ?? undefined,
  };
}

const enc = encodeURIComponent;

export class LiveGraphGateway implements GraphGateway {
  readonly mode = 'live' as const;

  constructor(
    private readonly http: GraphHttp,
    private readonly tz: string,
    private readonly windowsTimeZone: string,
  ) {}

  private base(caller: GraphCaller, mailbox: string): string {
    if (caller.kind === 'user') {
      if (caller.email.toLowerCase() !== mailbox.toLowerCase()) {
        throw new GraphError(400, 'DelegatedMailboxMismatch', 'Le chiamate delegate operano solo sul calendario dell\'utente connesso.');
      }
      return '/me';
    }
    return `/users/${enc(mailbox)}`;
  }

  async getSchedule(caller: GraphCaller, mailboxes: string[], start: Date, end: Date): Promise<Record<string, BusyInterval[]>> {
    const out: Record<string, BusyInterval[]> = {};
    if (mailboxes.length === 0) return out;
    const path = caller.kind === 'user' ? '/me/calendar/getSchedule' : `/users/${enc(mailboxes[0]!)}/calendar/getSchedule`;
    for (let i = 0; i < mailboxes.length; i += 20) {
      const chunk = mailboxes.slice(i, i + 20);
      const res: any = await this.http.request(caller, 'POST', path, {
        body: {
          schedules: chunk,
          startTime: { dateTime: toGraphUtc(start), timeZone: 'UTC' },
          endTime: { dateTime: toGraphUtc(end), timeZone: 'UTC' },
          availabilityViewInterval: 15,
        },
        headers: { Prefer: PREFER_UTC },
        mailboxKey: caller.kind === 'user' ? caller.email : mailboxes[0],
      });
      for (const s of res?.value ?? []) {
        const key = String(s.scheduleId).toLowerCase();
        if (s.error) throw new GraphError(400, 'ScheduleError', `Disponibilità non leggibile per ${key}: ${s.error.message ?? ''}`);
        out[key] = (s.scheduleItems ?? [])
          .filter((it: any) => it.status !== 'free')
          .map((it: any) => ({ start: parseGraphDateTime(it.start), end: parseGraphDateTime(it.end), status: it.status }));
      }
    }
    return out;
  }

  async createEvent(caller: GraphCaller, mailbox: string, input: NewEventInput): Promise<GraphEvent> {
    const timed = (d: Date) =>
      input.recurrence ? { dateTime: toGraphLocal(d, this.tz), timeZone: this.windowsTimeZone } : { dateTime: toGraphUtc(d), timeZone: 'UTC' };
    const body: Record<string, unknown> = {
      subject: input.subject,
      body: { contentType: 'text', content: input.bodyText ?? '' },
      start: timed(input.start),
      end: timed(input.end),
      attendees: input.attendees.map((a) => ({ emailAddress: { address: a.email, name: a.name }, type: a.type })),
      showAs: input.showAs ?? 'busy',
      allowNewTimeProposals: false,
      responseRequested: true,
    };
    if (input.location) {
      body.location = {
        displayName: input.location.displayName,
        ...(input.location.email ? { locationEmailAddress: input.location.email } : {}),
        locationType: input.location.isRoom ? 'conferenceRoom' : 'default',
      };
    }
    if (input.isOnlineMeeting) {
      body.isOnlineMeeting = true;
      body.onlineMeetingProvider = 'teamsForBusiness';
    }
    if (input.transactionId) body.transactionId = input.transactionId;
    if (input.recurrence) body.recurrence = input.recurrence;
    const res = await this.http.request(caller, 'POST', `${this.base(caller, mailbox)}/events`, {
      body,
      headers: { Prefer: PREFER_UTC },
      mailboxKey: mailbox,
    });
    return mapGraphEvent(res);
  }

  async getEvent(caller: GraphCaller, mailbox: string, id: string): Promise<GraphEvent | null> {
    const res = await this.http.request(caller, 'GET', `${this.base(caller, mailbox)}/events/${enc(id)}`, {
      headers: { Prefer: PREFER_UTC },
      mailboxKey: mailbox,
      allow404: true,
    });
    return res ? mapGraphEvent(res) : null;
  }

  async updateEvent(caller: GraphCaller, mailbox: string, id: string, patch: EventPatch): Promise<GraphEvent> {
    const body: Record<string, unknown> = {};
    if (patch.subject !== undefined) body.subject = patch.subject;
    if (patch.start) body.start = { dateTime: toGraphUtc(patch.start), timeZone: 'UTC' };
    if (patch.end) body.end = { dateTime: toGraphUtc(patch.end), timeZone: 'UTC' };
    if (patch.showAs) body.showAs = patch.showAs;
    const res = await this.http.request(caller, 'PATCH', `${this.base(caller, mailbox)}/events/${enc(id)}`, {
      body,
      headers: { Prefer: PREFER_UTC },
      mailboxKey: mailbox,
    });
    return mapGraphEvent(res);
  }

  async deleteEvent(caller: GraphCaller, mailbox: string, id: string): Promise<void> {
    await this.http.request(caller, 'DELETE', `${this.base(caller, mailbox)}/events/${enc(id)}`, { mailboxKey: mailbox, allow404: true });
  }

  async cancelEvent(caller: GraphCaller, mailbox: string, id: string, comment: string): Promise<void> {
    await this.http.request(caller, 'POST', `${this.base(caller, mailbox)}/events/${enc(id)}/cancel`, {
      body: { comment },
      mailboxKey: mailbox,
    });
  }

  async declineEvent(caller: GraphCaller, mailbox: string, id: string, comment: string): Promise<void> {
    await this.http.request(caller, 'POST', `${this.base(caller, mailbox)}/events/${enc(id)}/decline`, {
      body: { comment, sendResponse: true },
      mailboxKey: mailbox,
    });
  }

  async listInstances(caller: GraphCaller, mailbox: string, seriesMasterId: string, start: Date, end: Date): Promise<GraphEvent[]> {
    const q = `startDateTime=${enc(start.toISOString())}&endDateTime=${enc(end.toISOString())}&$top=100`;
    const items = await this.http.collect(caller, `${this.base(caller, mailbox)}/events/${enc(seriesMasterId)}/instances?${q}`, {
      headers: { Prefer: PREFER_UTC },
      mailboxKey: mailbox,
    });
    return items.map(mapGraphEvent);
  }

  async listCalendarView(caller: GraphCaller, mailbox: string, start: Date, end: Date): Promise<GraphEvent[]> {
    const q = `startDateTime=${enc(start.toISOString())}&endDateTime=${enc(end.toISOString())}&$top=100`;
    const items = await this.http.collect(caller, `${this.base(caller, mailbox)}/calendarView?${q}`, {
      headers: { Prefer: PREFER_UTC },
      mailboxKey: mailbox,
    });
    return items.map(mapGraphEvent);
  }

  async calendarViewDelta(
    caller: GraphCaller,
    mailbox: string,
    state: { deltaLink: string } | { start: Date; end: Date },
  ): Promise<DeltaResult> {
    const full = 'start' in state;
    let next: string | undefined = full
      ? `${this.base(caller, mailbox)}/calendarView/delta?startDateTime=${enc(state.start.toISOString())}&endDateTime=${enc(state.end.toISOString())}`
      : state.deltaLink;
    const events: GraphEvent[] = [];
    const removedIds: string[] = [];
    let deltaLink = '';
    let guard = 0;
    while (next && guard++ < 500) {
      const page: any = await this.http.request(caller, 'GET', next, {
        headers: { Prefer: `odata.maxpagesize=50, ${PREFER_UTC}` },
        mailboxKey: mailbox,
      });
      for (const item of page?.value ?? []) {
        if (item['@removed']) removedIds.push(item.id);
        else events.push(mapGraphEvent(item));
      }
      next = page?.['@odata.nextLink'];
      if (page?.['@odata.deltaLink']) deltaLink = page['@odata.deltaLink'];
    }
    return { events, removedIds, deltaLink, full };
  }

  async createSubscription(
    mailbox: string,
    notificationUrl: string,
    lifecycleUrl: string,
    clientState: string,
    expiration: Date,
  ): Promise<GraphSubscription> {
    const res: any = await this.http.request({ kind: 'app' }, 'POST', '/subscriptions', {
      body: {
        changeType: 'created,updated,deleted',
        notificationUrl,
        lifecycleNotificationUrl: lifecycleUrl,
        resource: `users/${mailbox}/events`,
        expirationDateTime: expiration.toISOString(),
        clientState,
      },
    });
    return { id: res.id, expirationDateTime: new Date(res.expirationDateTime) };
  }

  async renewSubscription(id: string, expiration: Date): Promise<GraphSubscription> {
    const res: any = await this.http.request({ kind: 'app' }, 'PATCH', `/subscriptions/${enc(id)}`, {
      body: { expirationDateTime: expiration.toISOString() },
    });
    return { id: res.id, expirationDateTime: new Date(res.expirationDateTime) };
  }

  async deleteSubscription(id: string): Promise<void> {
    await this.http.request({ kind: 'app' }, 'DELETE', `/subscriptions/${enc(id)}`, { allow404: true });
  }

  async listPlaces(caller: GraphCaller, kind: 'room' | 'roomList' | 'workspace'): Promise<GraphPlace[]> {
    const type = kind === 'room' ? 'microsoft.graph.room' : kind === 'roomList' ? 'microsoft.graph.roomList' : 'microsoft.graph.workspace';
    const items = await this.http.collect(caller, `/places/${type}?$top=100`);
    return items.map((p: any) => ({
      kind,
      displayName: p.displayName ?? '',
      emailAddress: p.emailAddress ? String(p.emailAddress).toLowerCase() : null,
      capacity: typeof p.capacity === 'number' ? p.capacity : null,
      building: p.building ?? null,
      floorLabel: p.floorLabel ?? null,
      tags: Array.isArray(p.tags) ? p.tags : [],
      isWheelChairAccessible: Boolean(p.isWheelChairAccessible),
      hasVideo: Boolean(p.videoDeviceName),
      hasDisplay: Boolean(p.displayDeviceName),
    }));
  }

  async searchUsers(caller: GraphCaller, query: string): Promise<GraphUser[]> {
    const q = query.replace(/"/g, '');
    const search = enc(`"displayName:${q}" OR "mail:${q}"`);
    const res: any = await this.http.request(
      caller,
      'GET',
      `/users?$search=${search}&$select=displayName,mail,userPrincipalName,department,jobTitle&$top=10`,
      { headers: { ConsistencyLevel: 'eventual' } },
    );
    return (res?.value ?? []).map((u: any) => ({
      displayName: u.displayName ?? '',
      email: String(u.mail ?? u.userPrincipalName ?? '').toLowerCase(),
      department: u.department ?? null,
      jobTitle: u.jobTitle ?? null,
    }));
  }
}

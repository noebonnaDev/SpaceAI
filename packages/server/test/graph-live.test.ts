/**
 * Contract tests for the production Microsoft Graph gateway (LiveGraphGateway) against a scripted HTTP stub:
 * request shapes, on-behalf-of vs application tokens, throttling (429 + Retry-After), paging and delta.
 */
import { describe, expect, it } from 'vitest';
import { GraphHttp, LiveGraphGateway, parseGraphDateTime, type TokenProvider } from '../src/graph/live.js';
import { GraphError } from '../src/graph/types.js';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: any;
}

function stub(responder: (call: Call, n: number) => { status: number; body?: unknown; headers?: Record<string, string> } | Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call: Call = {
      method: String(init.method),
      url,
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = await responder(call, calls.length);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const tokens: TokenProvider = {
  appToken: async () => 'app-token',
  userToken: async (assertion) => `obo(${assertion})`,
};

function gateway(fetchImpl: typeof fetch, sleeps: number[] = []) {
  const http = new GraphHttp({
    baseUrl: 'https://graph.example/v1.0',
    tokens,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return new LiveGraphGateway(http, 'Europe/Rome', 'W. Europe Standard Time');
}

const graphEvent = (over: Record<string, unknown> = {}) => ({
  id: 'AAMk1',
  iCalUId: 'uid-1',
  subject: 'Riunione',
  start: { dateTime: '2026-10-14T08:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-10-14T09:00:00.0000000', timeZone: 'UTC' },
  organizer: { emailAddress: { address: 'Marco.Esposito@contoso.example', name: 'Marco' } },
  attendees: [{ type: 'resource', status: { response: 'none' }, emailAddress: { address: 'sala@contoso.example', name: 'Sala' } }],
  showAs: 'busy',
  type: 'singleInstance',
  ...over,
});

describe('LiveGraphGateway (client Microsoft Graph di produzione)', () => {
  it('crea la prenotazione nel calendario dell\'utente con token on-behalf-of, sala come risorsa e orari UTC', async () => {
    const { calls, fetchImpl } = stub(() => ({ status: 201, body: graphEvent() }));
    const g = gateway(fetchImpl);
    const ev = await g.createEvent({ kind: 'user', email: 'marco.esposito@contoso.example', token: 'api-token' }, 'marco.esposito@contoso.example', {
      subject: 'Riunione',
      start: new Date('2026-10-14T08:00:00Z'),
      end: new Date('2026-10-14T09:00:00Z'),
      attendees: [{ email: 'sala@contoso.example', name: 'Sala', type: 'resource' }],
      location: { displayName: 'Sala', email: 'sala@contoso.example', isRoom: true },
      isOnlineMeeting: true,
      transactionId: 'booking-1',
    });
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url).toBe('https://graph.example/v1.0/me/events');
    expect(c.headers.Authorization).toBe('Bearer obo(api-token)');
    expect(c.headers.Prefer).toBe('outlook.timezone="UTC"');
    expect(c.body).toMatchObject({
      subject: 'Riunione',
      start: { dateTime: '2026-10-14T08:00:00.000', timeZone: 'UTC' },
      end: { dateTime: '2026-10-14T09:00:00.000', timeZone: 'UTC' },
      attendees: [{ emailAddress: { address: 'sala@contoso.example', name: 'Sala' }, type: 'resource' }],
      location: { displayName: 'Sala', locationEmailAddress: 'sala@contoso.example', locationType: 'conferenceRoom' },
      isOnlineMeeting: true,
      onlineMeetingProvider: 'teamsForBusiness',
      transactionId: 'booking-1',
      allowNewTimeProposals: false,
    });
    expect(ev.organizerEmail).toBe('marco.esposito@contoso.example');
    expect(ev.start.toISOString()).toBe('2026-10-14T08:00:00.000Z');
  });

  it('per le serie usa il fuso Windows "W. Europe Standard Time" e l\'ora locale', async () => {
    const { calls, fetchImpl } = stub(() => ({ status: 201, body: graphEvent({ type: 'seriesMaster' }) }));
    await gateway(fetchImpl).createEvent({ kind: 'user', email: 'a@contoso.example', token: 't' }, 'a@contoso.example', {
      subject: 'Serie',
      start: new Date('2026-10-15T09:00:00Z'),
      end: new Date('2026-10-15T10:00:00Z'),
      attendees: [],
      recurrence: {
        pattern: { type: 'weekly', interval: 1, daysOfWeek: ['thursday'], firstDayOfWeek: 'monday' },
        range: { type: 'endDate', startDate: '2026-10-15', endDate: '2026-11-12', recurrenceTimeZone: 'W. Europe Standard Time' },
      },
    });
    expect(calls[0]!.body.start).toEqual({ dateTime: '2026-10-15T11:00:00', timeZone: 'W. Europe Standard Time' });
    expect(calls[0]!.body.recurrence.range.recurrenceTimeZone).toBe('W. Europe Standard Time');
  });

  it('le operazioni applicative usano /users/{casella} e il token applicativo; le delegate rifiutano altre caselle', async () => {
    const { calls, fetchImpl } = stub(() => ({ status: 202 }));
    const g = gateway(fetchImpl);
    await g.declineEvent({ kind: 'app' }, 'sala@contoso.example', 'AAMk/1', 'Rilasciata');
    expect(calls[0]!.url).toBe('https://graph.example/v1.0/users/sala%40contoso.example/events/AAMk%2F1/decline');
    expect(calls[0]!.headers.Authorization).toBe('Bearer app-token');
    expect(calls[0]!.body).toEqual({ comment: 'Rilasciata', sendResponse: true });
    await expect(
      g.createEvent({ kind: 'user', email: 'a@contoso.example', token: 't' }, 'b@contoso.example', {
        subject: 'x',
        start: new Date(),
        end: new Date(),
        attendees: [],
      }),
    ).rejects.toBeInstanceOf(GraphError);
  });

  it('rispetta HTTP 429 con Retry-After e poi riprova', async () => {
    const sleeps: number[] = [];
    const { calls, fetchImpl } = stub((_c, n) =>
      n === 1
        ? { status: 429, body: { error: { code: 'TooManyRequests', message: 'slow down' } }, headers: { 'Retry-After': '7' } }
        : { status: 200, body: graphEvent() },
    );
    const ev = await gateway(fetchImpl, sleeps).getEvent({ kind: 'app' }, 'sala@contoso.example', 'AAMk1');
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([7000]);
    expect(ev?.id).toBe('AAMk1');
  });

  it('su 503 senza Retry-After applica un backoff esponenziale e alla fine propaga l\'errore', async () => {
    const sleeps: number[] = [];
    const { calls, fetchImpl } = stub(() => ({ status: 503, body: { error: { code: 'ServiceUnavailable', message: 'down' } } }));
    await expect(gateway(fetchImpl, sleeps).getEvent({ kind: 'app' }, 'sala@contoso.example', 'x')).rejects.toMatchObject({
      status: 503,
      code: 'ServiceUnavailable',
    });
    expect(calls).toHaveLength(6);
    expect(sleeps).toHaveLength(5);
    expect(sleeps[1]!).toBeGreaterThanOrEqual(1000);
    expect(sleeps[4]!).toBeGreaterThanOrEqual(8000);
  });

  it('segue @odata.nextLink nella calendarView e restituisce null su 404', async () => {
    const { calls, fetchImpl } = stub((c) => {
      if (c.url.includes('page2')) return { status: 200, body: { value: [graphEvent({ id: 'B', iCalUId: 'u2' })] } };
      if (c.url.includes('/events/missing')) return { status: 404, body: { error: { code: 'ErrorItemNotFound', message: 'nope' } } };
      return { status: 200, body: { value: [graphEvent({ id: 'A' })], '@odata.nextLink': 'https://graph.example/v1.0/users/x/calendarView?page2' } };
    });
    const g = gateway(fetchImpl);
    const evs = await g.listCalendarView({ kind: 'app' }, 'sala@contoso.example', new Date('2026-10-14T00:00:00Z'), new Date('2026-10-15T00:00:00Z'));
    expect(evs.map((e) => e.id)).toEqual(['A', 'B']);
    expect(calls[0]!.url).toContain('/users/sala%40contoso.example/calendarView?startDateTime=2026-10-14T00%3A00%3A00.000Z');
    expect(await g.getEvent({ kind: 'app' }, 'sala@contoso.example', 'missing')).toBeNull();
  });

  it('delta: segue le pagine, raccoglie gli eventi rimossi e restituisce il deltaLink', async () => {
    const { calls, fetchImpl } = stub((c) => {
      if (c.url.includes('skiptoken')) {
        return {
          status: 200,
          body: { value: [{ id: 'gone', '@removed': { reason: 'deleted' } }], '@odata.deltaLink': 'https://graph.example/v1.0/delta?$deltatoken=abc' },
        };
      }
      return { status: 200, body: { value: [graphEvent()], '@odata.nextLink': 'https://graph.example/v1.0/delta?$skiptoken=1' } };
    });
    const r = await gateway(fetchImpl).calendarViewDelta({ kind: 'app' }, 'sala@contoso.example', {
      start: new Date('2026-10-13T22:00:00Z'),
      end: new Date('2027-04-12T22:00:00Z'),
    });
    expect(r.full).toBe(true);
    expect(r.events).toHaveLength(1);
    expect(r.removedIds).toEqual(['gone']);
    expect(r.deltaLink).toContain('$deltatoken=abc');
    expect(calls[0]!.url).toContain('/users/sala%40contoso.example/calendarView/delta?startDateTime=');
    expect(calls[0]!.headers.Prefer).toBe('odata.maxpagesize=50, outlook.timezone="UTC"');
  });

  it('getSchedule in blocchi da 20 caselle, ignora gli intervalli "free" e segnala gli errori per casella', async () => {
    const { calls, fetchImpl } = stub((c) => ({
      status: 200,
      body: {
        value: c.body.schedules.map((s: string, i: number) => ({
          scheduleId: s,
          scheduleItems: [
            { status: 'busy', start: { dateTime: '2026-10-14T08:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-14T09:00:00.0000000', timeZone: 'UTC' } },
            { status: 'free', start: { dateTime: '2026-10-14T10:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-14T11:00:00.0000000', timeZone: 'UTC' } },
          ].slice(0, i % 2 ? 1 : 2),
        })),
      },
    }));
    const boxes = Array.from({ length: 25 }, (_, i) => `sala${i}@contoso.example`);
    const r = await gateway(fetchImpl).getSchedule({ kind: 'user', email: 'a@contoso.example', token: 't' }, boxes, new Date('2026-10-14T00:00:00Z'), new Date('2026-10-15T00:00:00Z'));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://graph.example/v1.0/me/calendar/getSchedule');
    expect(calls[0]!.body.schedules).toHaveLength(20);
    expect(Object.keys(r)).toHaveLength(25);
    expect(r['sala0@contoso.example']).toHaveLength(1);
    expect(r['sala0@contoso.example']![0]!.start.toISOString()).toBe('2026-10-14T08:00:00.000Z');

    const err = stub(() => ({ status: 200, body: { value: [{ scheduleId: 'x@contoso.example', error: { message: 'not found' } }] } }));
    await expect(gateway(err.fetchImpl).getSchedule({ kind: 'app' }, ['x@contoso.example'], new Date(), new Date())).rejects.toBeInstanceOf(GraphError);
  });

  it('non supera 4 richieste concorrenti sulla stessa casella', async () => {
    let active = 0;
    let peak = 0;
    const { fetchImpl } = stub(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return { status: 200, body: graphEvent() };
    });
    const g = gateway(fetchImpl);
    await Promise.all(Array.from({ length: 12 }, () => g.getEvent({ kind: 'app' }, 'sala@contoso.example', 'AAMk1')));
    expect(peak).toBe(4);
  });

  it('sottoscrizioni: risorsa events della casella, notifiche e lifecycle, clientState', async () => {
    const { calls, fetchImpl } = stub(() => ({ status: 201, body: { id: 'sub-1', expirationDateTime: '2026-10-20T07:00:00Z' } }));
    const sub = await gateway(fetchImpl).createSubscription(
      'sala@contoso.example',
      'https://ritrovo.contoso.example/api/graph/notifications',
      'https://ritrovo.contoso.example/api/graph/lifecycle',
      'segreto',
      new Date('2026-10-20T07:00:00Z'),
    );
    expect(sub.id).toBe('sub-1');
    expect(calls[0]!.url).toBe('https://graph.example/v1.0/subscriptions');
    expect(calls[0]!.headers.Authorization).toBe('Bearer app-token');
    expect(calls[0]!.body).toEqual({
      changeType: 'created,updated,deleted',
      notificationUrl: 'https://ritrovo.contoso.example/api/graph/notifications',
      lifecycleNotificationUrl: 'https://ritrovo.contoso.example/api/graph/lifecycle',
      resource: 'users/sala@contoso.example/events',
      expirationDateTime: '2026-10-20T07:00:00.000Z',
      clientState: 'segreto',
    });
  });

  it('interpreta date Graph in UTC e nei fusi Windows più comuni', () => {
    expect(parseGraphDateTime({ dateTime: '2026-10-14T08:00:00.0000000', timeZone: 'UTC' }).toISOString()).toBe('2026-10-14T08:00:00.000Z');
    expect(parseGraphDateTime({ dateTime: '2026-10-14T10:00:00.0000000', timeZone: 'W. Europe Standard Time' }).toISOString()).toBe('2026-10-14T08:00:00.000Z');
    expect(parseGraphDateTime({ dateTime: '2026-11-14T10:00:00.0000000', timeZone: 'W. Europe Standard Time' }).toISOString()).toBe('2026-11-14T09:00:00.000Z');
  });
});

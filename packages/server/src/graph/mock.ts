import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Clock } from '../domain/clock.js';
import { expandRecurrence, type GraphRecurrence } from '../domain/recurrence.js';
import { overlaps } from '../domain/time.js';
import {
  GraphError,
  type BusyInterval,
  type ChangeNotification,
  type DeltaResult,
  type EventPatch,
  type GraphAttendee,
  type GraphCaller,
  type GraphEvent,
  type GraphGateway,
  type GraphPlace,
  type GraphSubscription,
  type GraphUser,
  type NewEventInput,
  type ResponseType,
  type ShowAs,
} from './types.js';

/**
 * In-memory simulation of the parts of Exchange Online that Ritrovo relies on.
 * Used ONLY by automated tests and by the local demo (GRAPH_MODE=mock). Production uses LiveGraphGateway.
 *
 * Simulated behaviour (mirrors the documented defaults of Set-CalendarProcessing):
 * - resource mailboxes auto-accept requests that fit the booking window and maximum duration and do not conflict;
 * - with AllowConflicts=false a recurring request is declined entirely when its conflicts exceed
 *   MaximumConflictInstances / ConflictPercentageAllowed (both 0 by default), otherwise only the conflicting
 *   occurrences are declined;
 * - resource copies get the organizer's name as subject (DeleteSubject + AddOrganizerToSubject defaults);
 * - application callers may only touch resource mailboxes (Exchange RBAC for Applications scope).
 */

export type MailboxKind = 'user' | 'room' | 'equipment' | 'workspace';

export interface ResourceBookingPolicy {
  autoAccept: boolean;
  allowConflicts: boolean;
  bookingWindowDays: number;
  maximumDurationInMinutes: number;
  allowRecurringMeetings: boolean;
  maximumConflictInstances: number;
  conflictPercentageAllowed: number;
}

export const DEFAULT_RESOURCE_POLICY: ResourceBookingPolicy = {
  autoAccept: true,
  allowConflicts: false,
  bookingWindowDays: 180,
  maximumDurationInMinutes: 1440,
  allowRecurringMeetings: true,
  maximumConflictInstances: 0,
  conflictPercentageAllowed: 0,
};

export interface MailboxDef {
  email: string;
  name: string;
  kind: MailboxKind;
  department?: string;
  capacity?: number;
  policy?: Partial<ResourceBookingPolicy>;
}

interface Mailbox {
  email: string;
  name: string;
  kind: MailboxKind;
  department?: string;
  capacity?: number;
  policy: ResourceBookingPolicy;
  events: Map<string, StoredEvent>;
}

interface StoredEvent extends GraphEvent {
  /** Identifies the same meeting instance across mailboxes. */
  meetingKey: string;
  recurrence?: GraphRecurrence;
}

interface Change {
  seq: number;
  mailbox: string;
  eventId: string;
  kind: 'upsert' | 'delete';
}

interface Subscription {
  id: string;
  mailbox: string;
  clientState: string;
  notificationUrl: string;
  expiration: Date;
}

export type NotificationSink = (body: { value: ChangeNotification[] }) => Promise<void>;

const MAX_EVENT_SUBSCRIPTION_MINUTES = 10080;
const DAY_INDEX: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

export class FakeExchange implements GraphGateway {
  readonly mode = 'mock' as const;
  private mailboxes = new Map<string, Mailbox>();
  private changes: Change[] = [];
  private seq = 0;
  private subscriptions = new Map<string, Subscription>();
  private outbox: Array<{ value: ChangeNotification[] }> = [];
  private delivering: Promise<void> = Promise.resolve();
  /** Number of calls per operation, useful to assert behaviour in tests. */
  readonly calls: Record<string, number> = {};
  sink: NotificationSink | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly tz = 'Europe/Rome',
  ) {}

  // ---------------------------------------------------------------- test & demo helpers

  addMailbox(def: MailboxDef): void {
    const key = def.email.toLowerCase();
    const existing = this.mailboxes.get(key);
    if (existing) {
      existing.name = def.name;
      existing.kind = def.kind;
      existing.policy = { ...DEFAULT_RESOURCE_POLICY, ...def.policy };
      return;
    }
    this.mailboxes.set(key, {
      email: key,
      name: def.name,
      kind: def.kind,
      department: def.department,
      capacity: def.capacity,
      policy: { ...DEFAULT_RESOURCE_POLICY, ...def.policy },
      events: new Map(),
    });
  }

  hasMailbox(email: string): boolean {
    return this.mailboxes.has(email.toLowerCase());
  }

  setPolicy(email: string, policy: Partial<ResourceBookingPolicy>): void {
    const mb = this.mailbox(email);
    mb.policy = { ...mb.policy, ...policy };
  }

  /** All non-master events of a mailbox (including cancelled attendee copies). */
  eventsOf(email: string): GraphEvent[] {
    return [...this.mailbox(email).events.values()]
      .filter((e) => e.type !== 'seriesMaster')
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .map((e) => this.snapshot(e));
  }

  /** Series masters of a mailbox. */
  mastersOf(email: string): GraphEvent[] {
    return [...this.mailbox(email).events.values()].filter((e) => e.type === 'seriesMaster').map((e) => this.snapshot(e));
  }

  activeSubscriptions(): Array<{ id: string; mailbox: string; expiration: Date }> {
    return [...this.subscriptions.values()].map((s) => ({ id: s.id, mailbox: s.mailbox, expiration: s.expiration }));
  }

  /** Waits until all queued change notifications have been delivered to the sink. */
  async flush(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      this.scheduleDelivery();
      await this.delivering;
      if (this.outbox.length === 0) return;
    }
  }

  // ---------------------------------------------------------------- GraphGateway

  async getSchedule(caller: GraphCaller, mailboxes: string[], start: Date, end: Date): Promise<Record<string, BusyInterval[]>> {
    this.count('getSchedule');
    const out: Record<string, BusyInterval[]> = {};
    for (const email of mailboxes) {
      const mb = this.mailboxes.get(email.toLowerCase());
      if (!mb) {
        out[email.toLowerCase()] = [];
        continue;
      }
      this.assertCallerCanRead(caller, mb);
      out[mb.email] = [...mb.events.values()]
        .filter((e) => e.type !== 'seriesMaster' && !e.isCancelled && e.showAs !== 'free' && overlaps(e.start, e.end, start, end))
        .sort((a, b) => a.start.getTime() - b.start.getTime())
        .map((e) => ({ start: new Date(e.start), end: new Date(e.end), status: e.showAs }));
    }
    return out;
  }

  async createEvent(caller: GraphCaller, mailbox: string, input: NewEventInput): Promise<GraphEvent> {
    this.count('createEvent');
    const organizer = this.mailbox(mailbox);
    this.assertCallerCanWrite(caller, organizer);
    if (input.transactionId) {
      const dup = [...organizer.events.values()].find((e) => e.transactionId === input.transactionId);
      if (dup) return this.snapshot(dup);
    }
    const id = this.newId();
    const uid = `040000008200E00074C5B7101A82E008${randomUUID().replace(/-/g, '').toUpperCase()}`;
    const attendees: GraphAttendee[] = input.attendees.map((a) => ({
      email: a.email.toLowerCase(),
      name: a.name ?? this.mailboxes.get(a.email.toLowerCase())?.name,
      type: a.type,
      response: 'none',
    }));
    const base: StoredEvent = {
      id,
      meetingKey: id,
      iCalUId: uid,
      subject: input.subject,
      start: new Date(input.start),
      end: new Date(input.end),
      organizerEmail: organizer.email,
      organizerName: organizer.name,
      attendees,
      showAs: input.showAs ?? 'busy',
      isCancelled: false,
      type: input.recurrence ? 'seriesMaster' : 'singleInstance',
      transactionId: input.transactionId,
      responseStatus: 'organizer',
      onlineMeetingUrl: input.isOnlineMeeting ? `https://teams.microsoft.com/l/meetup-join/mock-${id}` : undefined,
      recurrence: input.recurrence,
    };
    organizer.events.set(id, base);
    this.recordChange(organizer.email, id, 'upsert');

    const instances: StoredEvent[] = [];
    if (input.recurrence) {
      const occ = this.expandGraphRecurrence(base.start, base.end, input.recurrence);
      for (const o of occ) {
        const oid = this.newId();
        const stamp = DateTime.fromJSDate(o.start, { zone: 'utc' }).toFormat("yyyyMMdd'T'HHmm");
        const inst: StoredEvent = {
          ...base,
          id: oid,
          meetingKey: `${id}#${stamp}`,
          iCalUId: `${uid}-${stamp}`,
          start: o.start,
          end: o.end,
          type: 'occurrence',
          seriesMasterId: id,
          recurrence: undefined,
          attendees: attendees.map((a) => ({ ...a })),
        };
        organizer.events.set(oid, inst);
        this.recordChange(organizer.email, oid, 'upsert');
        instances.push(inst);
      }
    } else {
      instances.push(base);
    }

    for (const att of attendees) {
      const target = this.mailboxes.get(att.email);
      if (!target || target.email === organizer.email) continue;
      if (target.kind === 'user') {
        for (const inst of instances) this.addAttendeeCopy(target, inst, 'notResponded', 'tentative');
      } else {
        this.processResourceRequest(target, base, instances);
      }
    }
    this.scheduleDelivery();
    return this.snapshot(organizer.events.get(id)!);
  }

  async getEvent(caller: GraphCaller, mailbox: string, id: string): Promise<GraphEvent | null> {
    this.count('getEvent');
    const mb = this.mailbox(mailbox);
    this.assertCallerCanRead(caller, mb);
    const ev = mb.events.get(id);
    return ev ? this.snapshot(ev) : null;
  }

  async updateEvent(caller: GraphCaller, mailbox: string, id: string, patch: EventPatch): Promise<GraphEvent> {
    this.count('updateEvent');
    const mb = this.mailbox(mailbox);
    this.assertCallerCanWrite(caller, mb);
    const ev = mb.events.get(id);
    if (!ev) throw new GraphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.');
    if (patch.subject !== undefined) ev.subject = patch.subject;
    if (patch.start) ev.start = new Date(patch.start);
    if (patch.end) ev.end = new Date(patch.end);
    if (patch.showAs) ev.showAs = patch.showAs;
    this.recordChange(mb.email, id, 'upsert');
    if (ev.organizerEmail === mb.email) {
      // Propagate to attendee copies; resources re-evaluate the request.
      for (const other of this.mailboxes.values()) {
        if (other.email === mb.email) continue;
        const copy = this.findCopy(other, ev.meetingKey);
        const att = ev.attendees.find((a) => a.email === other.email);
        if (!att) continue;
        if (other.kind === 'user') {
          if (copy) {
            copy.subject = ev.subject;
            copy.start = new Date(ev.start);
            copy.end = new Date(ev.end);
            this.recordChange(other.email, copy.id, 'upsert');
          }
        } else {
          if (copy) {
            other.events.delete(copy.id);
            this.recordChange(other.email, copy.id, 'delete');
          }
          this.processResourceRequest(other, ev, [ev]);
        }
      }
    }
    this.scheduleDelivery();
    return this.snapshot(ev);
  }

  async deleteEvent(caller: GraphCaller, mailbox: string, id: string): Promise<void> {
    this.count('deleteEvent');
    const mb = this.mailbox(mailbox);
    this.assertCallerCanWrite(caller, mb);
    const ev = mb.events.get(id);
    if (!ev) throw new GraphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.');
    if (ev.organizerEmail !== mb.email) {
      // Attendee removes its own copy: no message to the organizer.
      mb.events.delete(id);
      this.recordChange(mb.email, id, 'delete');
      this.scheduleDelivery();
      return;
    }
    const targets = ev.type === 'seriesMaster' ? [...mb.events.values()].filter((e) => e.seriesMasterId === ev.id) : [];
    for (const inst of [ev, ...targets]) this.cancelForAttendees(mb, inst);
    for (const inst of targets) {
      mb.events.delete(inst.id);
      this.recordChange(mb.email, inst.id, 'delete');
    }
    mb.events.delete(id);
    this.recordChange(mb.email, id, 'delete');
    this.scheduleDelivery();
  }

  async cancelEvent(caller: GraphCaller, mailbox: string, id: string, _comment: string): Promise<void> {
    this.count('cancelEvent');
    const mb = this.mailbox(mailbox);
    const ev = mb.events.get(id);
    if (ev && ev.organizerEmail !== mb.email) {
      throw new GraphError(400, 'ErrorInvalidRequest', 'Only the organizer can cancel the meeting.');
    }
    await this.deleteEvent(caller, mailbox, id);
  }

  async declineEvent(caller: GraphCaller, mailbox: string, id: string, _comment: string): Promise<void> {
    this.count('declineEvent');
    const mb = this.mailbox(mailbox);
    this.assertCallerCanWrite(caller, mb);
    const ev = mb.events.get(id);
    if (!ev) throw new GraphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.');
    if (ev.organizerEmail === mb.email) {
      throw new GraphError(400, 'ErrorInvalidRequest', 'The organizer cannot decline its own meeting.');
    }
    mb.events.delete(id);
    this.recordChange(mb.email, id, 'delete');
    const organizer = this.mailboxes.get(ev.organizerEmail);
    const orgCopy = organizer ? this.findCopy(organizer, ev.meetingKey) : undefined;
    if (organizer && orgCopy) {
      this.setResponse(orgCopy, mb.email, 'declined');
      this.recordChange(organizer.email, orgCopy.id, 'upsert');
    }
    this.scheduleDelivery();
  }

  async listInstances(caller: GraphCaller, mailbox: string, seriesMasterId: string, start: Date, end: Date): Promise<GraphEvent[]> {
    this.count('listInstances');
    const mb = this.mailbox(mailbox);
    this.assertCallerCanRead(caller, mb);
    return [...mb.events.values()]
      .filter((e) => e.seriesMasterId === seriesMasterId && overlaps(e.start, e.end, start, end))
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .map((e) => this.snapshot(e));
  }

  async listCalendarView(caller: GraphCaller, mailbox: string, start: Date, end: Date): Promise<GraphEvent[]> {
    this.count('listCalendarView');
    const mb = this.mailbox(mailbox);
    this.assertCallerCanRead(caller, mb);
    return [...mb.events.values()]
      .filter((e) => e.type !== 'seriesMaster' && overlaps(e.start, e.end, start, end))
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .map((e) => this.snapshot(e));
  }

  async calendarViewDelta(
    caller: GraphCaller,
    mailbox: string,
    state: { deltaLink: string } | { start: Date; end: Date },
  ): Promise<DeltaResult> {
    this.count('calendarViewDelta');
    const mb = this.mailbox(mailbox);
    this.assertCallerCanRead(caller, mb);
    if ('start' in state) {
      const events = await this.listCalendarView(caller, mailbox, state.start, state.end);
      return { events, removedIds: [], deltaLink: this.deltaLink(mb.email, this.seq, state.start, state.end), full: true };
    }
    const url = new URL(state.deltaLink);
    if (url.protocol !== 'mock-delta:' || url.searchParams.get('mailbox') !== mb.email) {
      throw new GraphError(400, 'InvalidDeltaToken', 'Invalid delta token.');
    }
    const since = Number(url.searchParams.get('seq'));
    const wStart = new Date(url.searchParams.get('start')!);
    const wEnd = new Date(url.searchParams.get('end')!);
    const last = new Map<string, Change>();
    for (const c of this.changes) if (c.mailbox === mb.email && c.seq > since) last.set(c.eventId, c);
    const events: GraphEvent[] = [];
    const removedIds: string[] = [];
    for (const c of last.values()) {
      const ev = mb.events.get(c.eventId);
      if (c.kind === 'delete' || !ev) {
        removedIds.push(c.eventId);
      } else if (ev.type !== 'seriesMaster' && overlaps(ev.start, ev.end, wStart, wEnd)) {
        events.push(this.snapshot(ev));
      }
    }
    return { events, removedIds, deltaLink: this.deltaLink(mb.email, this.seq, wStart, wEnd), full: false };
  }

  async createSubscription(
    mailbox: string,
    notificationUrl: string,
    _lifecycleUrl: string,
    clientState: string,
    expiration: Date,
  ): Promise<GraphSubscription> {
    this.count('createSubscription');
    const mb = this.mailbox(mailbox);
    this.assertCallerCanRead({ kind: 'app' }, mb);
    this.assertExpiration(expiration);
    const id = randomUUID();
    this.subscriptions.set(id, { id, mailbox: mb.email, clientState, notificationUrl, expiration: new Date(expiration) });
    return { id, expirationDateTime: new Date(expiration) };
  }

  async renewSubscription(id: string, expiration: Date): Promise<GraphSubscription> {
    this.count('renewSubscription');
    const sub = this.subscriptions.get(id);
    if (!sub || sub.expiration <= this.clock.now()) {
      throw new GraphError(404, 'ResourceNotFound', 'The object was not found.');
    }
    this.assertExpiration(expiration);
    sub.expiration = new Date(expiration);
    return { id, expirationDateTime: new Date(expiration) };
  }

  async deleteSubscription(id: string): Promise<void> {
    this.count('deleteSubscription');
    this.subscriptions.delete(id);
  }

  async listPlaces(_caller: GraphCaller, kind: 'room' | 'roomList' | 'workspace'): Promise<GraphPlace[]> {
    this.count('listPlaces');
    if (kind !== 'room' && kind !== 'workspace') return [];
    return [...this.mailboxes.values()]
      .filter((m) => (kind === 'room' ? m.kind === 'room' : m.kind === 'workspace'))
      .map((m) => ({
        kind,
        displayName: m.name,
        emailAddress: m.email,
        capacity: m.capacity ?? null,
        building: null,
        floorLabel: null,
        tags: [],
        isWheelChairAccessible: false,
        hasVideo: false,
        hasDisplay: false,
      }));
  }

  async searchUsers(_caller: GraphCaller, query: string): Promise<GraphUser[]> {
    this.count('searchUsers');
    const q = query.toLowerCase();
    return [...this.mailboxes.values()]
      .filter((m) => m.kind === 'user' && (m.name.toLowerCase().includes(q) || m.email.includes(q)))
      .slice(0, 10)
      .map((m) => ({ displayName: m.name, email: m.email, department: m.department ?? null, jobTitle: null }));
  }

  // ---------------------------------------------------------------- internals

  private count(op: string) {
    this.calls[op] = (this.calls[op] ?? 0) + 1;
  }

  private mailbox(email: string): Mailbox {
    const mb = this.mailboxes.get(email.toLowerCase());
    if (!mb) throw new GraphError(404, 'ErrorInvalidUser', `The requested user '${email}' is invalid.`);
    return mb;
  }

  /** Delegated callers act on their own mailbox; application callers only on resource mailboxes (RBAC scope). */
  private assertCallerCanWrite(caller: GraphCaller, mb: Mailbox) {
    if (caller.kind === 'user') {
      if (caller.email.toLowerCase() !== mb.email) {
        throw new GraphError(403, 'ErrorAccessDenied', 'Access is denied. Check credentials and try again.');
      }
    } else if (mb.kind === 'user') {
      throw new GraphError(403, 'ErrorAccessDenied', 'Access to OData is disabled: mailbox outside the application RBAC scope.');
    }
  }

  private assertCallerCanRead(caller: GraphCaller, mb: Mailbox) {
    if (caller.kind === 'app' && mb.kind === 'user') {
      throw new GraphError(403, 'ErrorAccessDenied', 'Access to OData is disabled: mailbox outside the application RBAC scope.');
    }
  }

  private assertExpiration(expiration: Date) {
    const max = this.clock.now().getTime() + MAX_EVENT_SUBSCRIPTION_MINUTES * 60_000;
    if (expiration.getTime() > max) {
      throw new GraphError(400, 'ExtensionError', 'Subscription expiration can only be 10080 minutes in the future.');
    }
  }

  private newId(): string {
    return `AAMkAG${randomUUID().replace(/-/g, '')}`;
  }

  private snapshot(e: StoredEvent): GraphEvent {
    return {
      id: e.id,
      iCalUId: e.iCalUId,
      subject: e.subject,
      start: new Date(e.start),
      end: new Date(e.end),
      organizerEmail: e.organizerEmail,
      organizerName: e.organizerName,
      attendees: e.attendees.map((a) => ({ ...a })),
      showAs: e.showAs,
      isCancelled: e.isCancelled,
      type: e.type,
      seriesMasterId: e.seriesMasterId,
      onlineMeetingUrl: e.onlineMeetingUrl,
      transactionId: e.transactionId,
      responseStatus: e.responseStatus,
    };
  }

  private findCopy(mb: Mailbox, meetingKey: string): StoredEvent | undefined {
    for (const e of mb.events.values()) if (e.meetingKey === meetingKey) return e;
    return undefined;
  }

  private setResponse(ev: StoredEvent, email: string, response: ResponseType) {
    const att = ev.attendees.find((a) => a.email === email);
    if (att) att.response = response;
  }

  private addAttendeeCopy(target: Mailbox, inst: StoredEvent, response: ResponseType, showAs?: ShowAs): StoredEvent {
    const copy: StoredEvent = {
      ...inst,
      id: this.newId(),
      attendees: inst.attendees.map((a) => ({ ...a })),
      responseStatus: response,
      showAs: showAs ?? inst.showAs,
      transactionId: undefined,
      recurrence: undefined,
      seriesMasterId: inst.seriesMasterId ? `copy-${inst.seriesMasterId}` : undefined,
    };
    if (target.kind !== 'user') {
      // DeleteSubject=$true and AddOrganizerToSubject=$true are the Exchange defaults for resource mailboxes.
      copy.subject = inst.organizerName ?? inst.organizerEmail;
    }
    target.events.set(copy.id, copy);
    this.recordChange(target.email, copy.id, 'upsert');
    return copy;
  }

  private resourceProblem(resource: Mailbox, inst: StoredEvent): 'conflict' | 'window' | 'duration' | null {
    const p = resource.policy;
    const now = this.clock.now();
    if (p.bookingWindowDays >= 0 && inst.start.getTime() > now.getTime() + p.bookingWindowDays * 86_400_000) return 'window';
    const minutes = (inst.end.getTime() - inst.start.getTime()) / 60_000;
    if (p.maximumDurationInMinutes > 0 && minutes > p.maximumDurationInMinutes) return 'duration';
    if (!p.allowConflicts) {
      for (const e of resource.events.values()) {
        if (e.type === 'seriesMaster' || e.isCancelled || e.showAs === 'free' || e.meetingKey === inst.meetingKey) continue;
        if (overlaps(e.start, e.end, inst.start, inst.end)) return 'conflict';
      }
    }
    return null;
  }

  private processResourceRequest(resource: Mailbox, master: StoredEvent, instances: StoredEvent[]) {
    const organizer = this.mailboxes.get(master.organizerEmail)!;
    const respond = (inst: StoredEvent, response: ResponseType) => {
      const orgCopy = organizer.events.get(inst.id) ?? this.findCopy(organizer, inst.meetingKey);
      if (orgCopy) {
        this.setResponse(orgCopy, resource.email, response);
        this.recordChange(organizer.email, orgCopy.id, 'upsert');
      }
    };
    if (!resource.policy.autoAccept) {
      // Requests wait for a delegate: the resource stays tentative and nothing is booked.
      return;
    }
    const isSeries = master.type === 'seriesMaster';
    if (isSeries && !resource.policy.allowRecurringMeetings) {
      for (const inst of instances) respond(inst, 'declined');
      respond(master, 'declined');
      return;
    }
    const problems = instances.map((i) => this.resourceProblem(resource, i));
    const failing = problems.filter(Boolean).length;
    if (isSeries) {
      const pct = instances.length ? (failing / instances.length) * 100 : 0;
      const nonConflictProblems = problems.some((p) => p === 'window' || p === 'duration');
      const tooMany =
        !resource.policy.allowConflicts &&
        (failing > resource.policy.maximumConflictInstances || pct > resource.policy.conflictPercentageAllowed);
      if (nonConflictProblems || tooMany) {
        for (const inst of instances) respond(inst, 'declined');
        respond(master, 'declined');
        return;
      }
      instances.forEach((inst, i) => {
        if (problems[i]) {
          respond(inst, 'declined');
        } else {
          this.addAttendeeCopy(resource, inst, 'accepted');
          respond(inst, 'accepted');
        }
      });
      respond(master, 'accepted');
      return;
    }
    const inst = instances[0]!;
    if (problems[0]) {
      respond(inst, 'declined');
    } else {
      this.addAttendeeCopy(resource, inst, 'accepted');
      respond(inst, 'accepted');
    }
  }

  private cancelForAttendees(organizer: Mailbox, inst: StoredEvent) {
    for (const other of this.mailboxes.values()) {
      if (other.email === organizer.email) continue;
      const copy = this.findCopy(other, inst.meetingKey);
      if (!copy) continue;
      if (other.kind === 'user') {
        copy.isCancelled = true;
        copy.subject = `Annullato: ${copy.subject}`;
        this.recordChange(other.email, copy.id, 'upsert');
      } else {
        other.events.delete(copy.id);
        this.recordChange(other.email, copy.id, 'delete');
      }
    }
  }

  private expandGraphRecurrence(start: Date, end: Date, rec: GraphRecurrence): Array<{ start: Date; end: Date }> {
    const duration = Math.round((end.getTime() - start.getTime()) / 60_000);
    return expandRecurrence(
      start,
      duration,
      {
        type: rec.pattern.type,
        interval: rec.pattern.interval,
        daysOfWeek: rec.pattern.daysOfWeek?.map((d) => DAY_INDEX[d]!),
        until: rec.range.endDate,
      },
      this.tz,
      520,
    );
  }

  private deltaLink(mailbox: string, seq: number, start: Date, end: Date): string {
    const u = new URL('mock-delta://graph/calendarView/delta');
    u.searchParams.set('mailbox', mailbox);
    u.searchParams.set('seq', String(seq));
    u.searchParams.set('start', start.toISOString());
    u.searchParams.set('end', end.toISOString());
    return u.toString();
  }

  private recordChange(mailbox: string, eventId: string, kind: 'upsert' | 'delete') {
    this.seq += 1;
    this.changes.push({ seq: this.seq, mailbox, eventId, kind });
    const now = this.clock.now();
    const subs = [...this.subscriptions.values()].filter((s) => s.mailbox === mailbox && s.expiration > now);
    for (const s of subs) {
      this.outbox.push({
        value: [
          {
            subscriptionId: s.id,
            clientState: s.clientState,
            changeType: kind === 'delete' ? 'deleted' : 'updated',
            resource: `Users/${mailbox}/Events/${eventId}`,
          },
        ],
      });
    }
  }

  private scheduleDelivery() {
    if (!this.sink || this.outbox.length === 0) return;
    const sink = this.sink;
    this.delivering = this.delivering.then(async () => {
      while (this.outbox.length) {
        const batch = this.outbox.splice(0, this.outbox.length);
        // Graph batches notifications; merge them like the service does.
        await sink({ value: batch.flatMap((b) => b.value) }).catch(() => undefined);
      }
    });
  }
}

import type {
  BookingDto,
  BookingSource,
  BookingStatus,
  ConflictPayload,
  ProposalDto,
  ReleaseReason,
  ResourceKind,
  Role,
} from '@ritrovo/shared';
import { hasRole } from '@ritrovo/shared';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Db, Queryable } from '../db/db.js';
import {
  GraphError,
  findEventByICalUId,
  type GraphCaller,
  type GraphEvent,
  type GraphGateway,
  type NewEventInput,
} from '../graph/types.js';
import { audit } from './audit.js';
import { alternatives, busyIntervals, conflictsIn, validatePolicy } from './availability.js';
import type { Clock } from './clock.js';
import {
  ConflictError,
  ExternalServiceError,
  ForbiddenError,
  NotFoundError,
  StateError,
  ValidationError,
} from './errors.js';
import {
  expandRecurrence,
  splitIntoSegments,
  toGraphRecurrence,
  type Occurrence,
  type RecurrencePattern,
} from './recurrence.js';
import { effectivePolicy, getResource, getResourceByQr, type ResourceRow } from './resources.js';
import { getSettings, type Settings } from './settings.js';
import { addMinutes, formatIt, formatTimeIt, roundDownToMinutes } from './time.js';
import { ensureUserByEmail, getUserById, type UserRow } from './users.js';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface Services {
  db: Db;
  graph: GraphGateway;
  clock: Clock;
  config: AppConfig;
  log: Logger;
  /** How many times to re-read the organizer's event waiting for the resource's answer (live Exchange is asynchronous). */
  acceptancePolls: number;
  acceptancePollMs: number;
}

export interface Actor {
  user: UserRow;
  role: Role;
  /** Raw access token for Ritrovo's API, used for the on-behalf-of flow. */
  token?: string;
}

export type Operator =
  | { kind: 'user'; actor: Actor }
  | { kind: 'kiosk'; deviceId: string; resourceId: string | null; buildingId: string | null }
  | { kind: 'system' };

export interface BookingRow {
  id: string;
  resource_id: string;
  organizer_id: string | null;
  organizer_email: string | null;
  booked_for_id: string | null;
  created_by_id: string | null;
  title: string | null;
  start_at: Date;
  end_at: Date;
  effective_end_at: Date | null;
  status: BookingStatus;
  source: BookingSource;
  attendee_count: number;
  is_online_meeting: boolean;
  online_meeting_url: string | null;
  series_id: string | null;
  proposal_id: string | null;
  ical_uid: string | null;
  organizer_event_id: string | null;
  resource_event_id: string | null;
  user_event_id: string | null;
  checked_in_at: Date | null;
  checked_out_at: Date | null;
  released_at: Date | null;
  release_reason: ReleaseReason | null;
  exchange_released: boolean;
  anonymized: boolean;
  created_at: Date;
  // joined
  resource_name: string;
  resource_kind: ResourceKind;
  mailbox_email: string | null;
  check_in_required: boolean;
  check_in_grace_minutes: number | null;
  organizer_name: string | null;
  booked_for_name: string | null;
}

export const BOOKING_SELECT = `select b.*, r.name as resource_name, r.kind as resource_kind, r.mailbox_email, r.check_in_required,
  r.check_in_grace_minutes, coalesce(o.display_name, b.organizer_email) as organizer_name, bf.display_name as booked_for_name
  from booking b join resource r on r.id = b.resource_id
  left join app_user o on o.id = b.organizer_id left join app_user bf on bf.id = b.booked_for_id`;

export const CreateBookingSchema = z.object({
  resourceId: z.string().uuid(),
  start: z.coerce.date(),
  end: z.coerce.date(),
  title: z.string().trim().max(200).optional(),
  bookedForEmail: z.string().trim().email().optional(),
  bookedForName: z.string().trim().max(200).optional(),
  isOnlineMeeting: z.boolean().optional(),
  attendeeEmails: z.array(z.string().trim().email()).max(50).optional(),
  attendeeCount: z.number().int().min(1).max(500).optional(),
  source: z.enum(['web', 'addin', 'qr', 'reception']).default('web'),
});
export type CreateBookingInput = z.infer<typeof CreateBookingSchema>;

export const RecurringBookingSchema = CreateBookingSchema.extend({
  recurrence: z.object({
    type: z.enum(['daily', 'weekly']),
    interval: z.number().int().min(1).max(12).default(1),
    daysOfWeek: z.array(z.number().int().min(1).max(7)).optional(),
    until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    count: z.number().int().min(1).max(260).optional(),
  }),
  conflictStrategy: z.enum(['ask', 'skip']).default('ask'),
  /** For conflicting occurrences: ISO start -> alternative resource id. */
  alternatives: z.record(z.string(), z.string().uuid()).optional(),
});
export type RecurringBookingInput = z.infer<typeof RecurringBookingSchema>;

export const ProposalSchema = z.object({
  title: z.string().trim().min(1).max(200),
  options: z
    .array(z.object({ resourceId: z.string().uuid(), start: z.coerce.date(), end: z.coerce.date() }))
    .min(2)
    .max(3),
  isOnlineMeeting: z.boolean().optional(),
  source: z.enum(['web', 'addin']).default('web'),
});
export type ProposalInput = z.infer<typeof ProposalSchema>;

const TERMINAL: BookingStatus[] = ['completed', 'released', 'cancelled', 'declined'];

interface InternalCreate {
  finalStatus?: 'confirmed' | 'tentative';
  proposalId?: string;
  subjectPrefix?: string;
  showAs?: 'busy' | 'tentative';
  checkInNow?: boolean;
}

export class BookingService {
  constructor(private readonly s: Services) {}

  private get tz() {
    return this.s.config.timezone;
  }

  private userCaller(actor: Actor): GraphCaller {
    return { kind: 'user', email: actor.user.email, token: actor.token };
  }

  // ------------------------------------------------------------------ reads

  async getBooking(id: string, q: Queryable = this.s.db): Promise<BookingRow> {
    const row = (await q.query<BookingRow>(`${BOOKING_SELECT} where b.id = $1`, [id])).rows[0];
    if (!row) throw new NotFoundError('Prenotazione non trovata.');
    return row;
  }

  isParticipant(actor: Actor, b: BookingRow): boolean {
    return [b.organizer_id, b.booked_for_id, b.created_by_id].includes(actor.user.id);
  }

  canManage(actor: Actor, b: BookingRow): boolean {
    return this.isParticipant(actor, b) || hasRole(actor.role, 'reception');
  }

  checkInWindow(b: BookingRow, settings: Settings): { opens: Date; closes: Date } {
    const grace = b.check_in_grace_minutes ?? settings.checkInGraceMinutes;
    const effEnd = b.effective_end_at ?? b.end_at;
    return {
      opens: addMinutes(b.start_at, -settings.checkInOpensMinutesBefore),
      closes: b.check_in_required ? new Date(Math.min(addMinutes(b.start_at, grace).getTime(), effEnd.getTime())) : effEnd,
    };
  }

  toDto(b: BookingRow, settings: Settings, actor?: Actor | null, kiosk = false): BookingDto {
    const now = this.s.clock.now();
    const effEnd = b.effective_end_at ?? b.end_at;
    const allowed = kiosk || (actor ? this.canManage(actor, b) : false);
    const win = this.checkInWindow(b, settings);
    const live = b.status === 'pending' || b.status === 'confirmed';
    return {
      id: b.id,
      resourceId: b.resource_id,
      resourceName: b.resource_name,
      resourceKind: b.resource_kind,
      title: b.title,
      start: b.start_at.toISOString(),
      end: b.end_at.toISOString(),
      effectiveEnd: b.effective_end_at?.toISOString() ?? null,
      status: b.status,
      source: b.source,
      organizerEmail: b.organizer_email,
      organizerName: b.organizer_name,
      bookedForId: b.booked_for_id,
      bookedForName: b.booked_for_name,
      createdById: b.created_by_id,
      isOnlineMeeting: b.is_online_meeting,
      onlineMeetingUrl: b.online_meeting_url,
      seriesId: b.series_id,
      proposalId: b.proposal_id,
      checkedInAt: b.checked_in_at?.toISOString() ?? null,
      checkedOutAt: b.checked_out_at?.toISOString() ?? null,
      releasedAt: b.released_at?.toISOString() ?? null,
      releaseReason: b.release_reason,
      canCheckIn: allowed && live && !b.checked_in_at && now >= win.opens && now <= win.closes,
      canCheckOut: allowed && live && !!b.checked_in_at && !b.checked_out_at && now < effEnd,
      canCancel:
        !kiosk && allowed && ['pending', 'confirmed', 'tentative'].includes(b.status) && !b.checked_in_at && effEnd > now,
    };
  }

  async listForUser(actor: Actor, from: Date, to: Date): Promise<BookingRow[]> {
    await this.refreshPending(actor);
    return (
      await this.s.db.query<BookingRow>(
        `${BOOKING_SELECT} where (b.organizer_id = $1 or b.booked_for_id = $1 or b.created_by_id = $1)
         and b.end_at > $2 and b.start_at < $3 order by b.start_at`,
        [actor.user.id, from, to],
      )
    ).rows;
  }

  async listForResource(resourceId: string, from: Date, to: Date, includeInactive = false): Promise<BookingRow[]> {
    return (
      await this.s.db.query<BookingRow>(
        `${BOOKING_SELECT} where b.resource_id = $1 and coalesce(b.effective_end_at, b.end_at) > $2 and b.start_at < $3
         ${includeInactive ? '' : `and b.status in ('pending','confirmed','tentative','completed')`}
         order by b.start_at`,
        [resourceId, from, to],
      )
    ).rows;
  }

  /**
   * Live Exchange answers meeting requests asynchronously: when the organizer looks at their bookings,
   * re-read pending ones with their own (delegated) token to pick up the resource's response.
   */
  async refreshPending(actor: Actor): Promise<void> {
    const pending = (
      await this.s.db.query<BookingRow>(
        `${BOOKING_SELECT} where b.organizer_id = $1 and b.status = 'pending' and b.organizer_event_id is not null and b.end_at > $2`,
        [actor.user.id, this.s.clock.now()],
      )
    ).rows;
    for (const b of pending) {
      try {
        const ev = await this.s.graph.getEvent(this.userCaller(actor), actor.user.email, b.organizer_event_id!);
        if (ev) await this.applyResourceResponse(b, ev);
      } catch (err) {
        this.s.log.warn({ err: String(err), bookingId: b.id }, 'Aggiornamento stato prenotazione non riuscito');
      }
    }
  }

  // ------------------------------------------------------------------ create

  private defaultTitle(r: ResourceRow): string {
    if (r.kind === 'desk') return `Postazione ${r.name}`;
    if (r.kind === 'asset') return `Prenotazione ${r.name}`;
    return 'Riunione';
  }

  private bodyText(bookingId: string, r: ResourceRow, policyGrace: number, checkIn: boolean): string {
    const lines = [
      `Prenotazione gestita con ${this.s.config.appName}: ${r.name}.`,
      `Dettagli e check-in: ${this.s.config.publicBaseUrl}/prenotazioni/${bookingId}`,
    ];
    if (checkIn) {
      lines.push(`Se nessuno effettua il check-in entro ${policyGrace} minuti dall'inizio, la prenotazione viene rilasciata automaticamente.`);
    }
    return lines.join('\n');
  }

  private async resolveBeneficiary(actor: Actor, email?: string, name?: string): Promise<UserRow> {
    if (!email || email.toLowerCase() === actor.user.email.toLowerCase()) return actor.user;
    if (!hasRole(actor.role, 'reception')) {
      throw new ForbiddenError('Solo la reception e gli amministratori possono prenotare per conto di altri.');
    }
    return ensureUserByEmail(this.s.db, email, name);
  }

  private async assertAvailable(
    actor: Actor | null,
    resource: ResourceRow,
    start: Date,
    end: Date,
    settings: Settings,
    attendeeCount: number,
    caller: GraphCaller | null,
  ): Promise<void> {
    const busy = (await busyIntervals(this.s.db, this.s.graph, [resource], start, end, caller)).get(resource.id)!;
    const hit = conflictsIn(busy, start, end);
    if (hit.length === 0) return;
    const alts = await alternatives(this.s.db, this.s.graph, resource, start, end, caller, settings, this.tz, this.s.clock.now(), attendeeCount);
    throw new ConflictError({
      code: 'CONFLICT',
      message: `${resource.name} è già occupata dalle ${formatTimeIt(hit[0]!.start, this.tz)} alle ${formatTimeIt(hit[0]!.end, this.tz)}.`,
      conflicts: hit.map((h) => ({ start: h.start.toISOString(), end: h.end.toISOString(), source: h.source })),
      alternatives: alts,
    });
    void actor;
  }

  /** Inserts the booking after re-checking Ritrovo's own bookings while holding a lock on the resource. */
  private async reserve(
    resource: ResourceRow,
    rows: Array<{ start: Date; end: Date }>,
    values: {
      organizerId: string | null;
      organizerEmail: string | null;
      bookedForId: string | null;
      createdById: string | null;
      title: string;
      status: BookingStatus;
      source: BookingSource;
      attendeeCount: number;
      isOnlineMeeting: boolean;
      seriesId?: string | null;
      proposalId?: string | null;
      checkedInAt?: Date | null;
      exchangeReleased?: boolean;
    },
  ): Promise<string[]> {
    return this.s.db.tx(async (q) => {
      await q.query('select id from resource where id = $1 for update', [resource.id]);
      const ids: string[] = [];
      for (const r of rows) {
        const clash = (
          await q.query<{ id: string }>(
            `select id from booking where resource_id = $1 and status in ('pending','confirmed','tentative','completed')
             and start_at < $3 and coalesce(effective_end_at, end_at) > $2 limit 1`,
            [resource.id, r.start, r.end],
          )
        ).rows[0];
        if (clash) {
          throw new ConflictError({
            code: 'CONFLICT',
            message: `${resource.name} è stata appena prenotata da qualcun altro.`,
            conflicts: [{ start: r.start.toISOString(), end: r.end.toISOString(), source: 'ritrovo' }],
            alternatives: { resources: [], times: [] },
          });
        }
        const inserted = (
          await q.query<{ id: string }>(
            `insert into booking(resource_id, organizer_id, organizer_email, booked_for_id, created_by_id, title, start_at, end_at, status,
               source, attendee_count, is_online_meeting, series_id, proposal_id, checked_in_at, exchange_released)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
            [
              resource.id,
              values.organizerId,
              values.organizerEmail,
              values.bookedForId,
              values.createdById,
              values.title,
              r.start,
              r.end,
              values.status,
              values.source,
              values.attendeeCount,
              values.isOnlineMeeting,
              values.seriesId ?? null,
              values.proposalId ?? null,
              values.checkedInAt ?? null,
              values.exchangeReleased ?? true,
            ],
          )
        ).rows[0]!;
        ids.push(inserted.id);
      }
      return ids;
    });
  }

  private buildEvent(
    bookingId: string,
    resource: ResourceRow,
    organizer: UserRow,
    beneficiary: UserRow,
    start: Date,
    end: Date,
    title: string,
    settings: Settings,
    opts: { isOnlineMeeting?: boolean; attendeeEmails?: string[]; showAs?: 'busy' | 'tentative' | 'free' },
  ): NewEventInput {
    const policy = effectivePolicy(resource, settings);
    const attendees: NewEventInput['attendees'] = [];
    if (resource.mailbox_email) attendees.push({ email: resource.mailbox_email, name: resource.name, type: 'resource' });
    if (beneficiary.id !== organizer.id) attendees.push({ email: beneficiary.email, name: beneficiary.display_name, type: 'required' });
    for (const e of opts.attendeeEmails ?? []) {
      const lower = e.toLowerCase();
      if (lower !== organizer.email.toLowerCase() && !attendees.some((a) => a.email.toLowerCase() === lower)) {
        attendees.push({ email: lower, type: 'required' });
      }
    }
    const place = [resource.name, resource.floor_name, resource.building_name].filter(Boolean).join(' – ');
    return {
      subject: title,
      start,
      end,
      attendees,
      location: { displayName: place, email: resource.mailbox_email ?? undefined, isRoom: resource.kind === 'room' },
      showAs: opts.showAs ?? 'busy',
      isOnlineMeeting: opts.isOnlineMeeting,
      bodyText: this.bodyText(bookingId, resource, policy.checkInGraceMinutes, policy.checkInRequired),
      transactionId: bookingId,
    };
  }

  async createBooking(actor: Actor, input: CreateBookingInput, internal: InternalCreate = {}): Promise<BookingRow> {
    const now = this.s.clock.now();
    const resource = await getResource(this.s.db, input.resourceId);
    if (!resource.is_active) throw new ValidationError('Questa risorsa non è prenotabile.');
    const settings = await getSettings(this.s.db);
    const policy = effectivePolicy(resource, settings);
    validatePolicy(policy, input.start, input.end, now, this.tz);
    const beneficiary = await this.resolveBeneficiary(actor, input.bookedForEmail, input.bookedForName);
    const attendeeCount = input.attendeeCount ?? 1 + (input.attendeeEmails?.length ?? 0) + (beneficiary.id !== actor.user.id ? 1 : 0);
    const caller = this.userCaller(actor);
    await this.assertAvailable(actor, resource, input.start, input.end, settings, attendeeCount, caller);

    const finalStatus = internal.finalStatus ?? 'confirmed';
    const title = `${internal.subjectPrefix ?? ''}${input.title?.trim() || this.defaultTitle(resource)}`;
    const [id] = await this.reserve(resource, [{ start: input.start, end: input.end }], {
      organizerId: actor.user.id,
      organizerEmail: actor.user.email,
      bookedForId: beneficiary.id,
      createdById: actor.user.id,
      title,
      status: resource.mailbox_email ? 'pending' : finalStatus,
      source: input.source,
      attendeeCount,
      isOnlineMeeting: Boolean(input.isOnlineMeeting),
      proposalId: internal.proposalId,
      checkedInAt: internal.checkInNow ? now : null,
    });

    const ev = this.buildEvent(id!, resource, actor.user, beneficiary, input.start, input.end, title, settings, {
      isOnlineMeeting: input.isOnlineMeeting,
      attendeeEmails: input.attendeeEmails,
      showAs: resource.mailbox_email ? internal.showAs ?? 'busy' : 'free',
    });
    if (!resource.mailbox_email && !settings.calendarEntryForUnmanaged) {
      await this.logCreate(actor, id!, resource);
      return this.getBooking(id!);
    }
    let created: GraphEvent;
    try {
      created = await this.s.graph.createEvent(caller, actor.user.email, ev);
    } catch (err) {
      await this.s.db.query(`update booking set status = 'cancelled', updated_at = now() where id = $1`, [id]);
      throw this.exchangeError(err);
    }
    if (resource.mailbox_email) {
      await this.s.db.query(
        `update booking set organizer_event_id = $2, ical_uid = $3, online_meeting_url = $4, updated_at = now() where id = $1`,
        [id, created.id, created.iCalUId, created.onlineMeetingUrl ?? null],
      );
      const settled = await this.waitForResource(actor, await this.getBooking(id!), created);
      if (settled.status === 'declined') {
        const alts = await alternatives(this.s.db, this.s.graph, resource, input.start, input.end, caller, settings, this.tz, now, attendeeCount);
        throw new ConflictError({
          code: 'RESOURCE_DECLINED',
          message: `${resource.name} ha rifiutato la richiesta (conflitto o regole della casella Exchange).`,
          conflicts: [{ start: input.start.toISOString(), end: input.end.toISOString(), source: 'exchange' }],
          alternatives: alts,
        });
      }
    } else {
      await this.s.db.query(
        `update booking set user_event_id = $2, online_meeting_url = $3, updated_at = now() where id = $1`,
        [id, created.id, created.onlineMeetingUrl ?? null],
      );
    }
    await this.logCreate(actor, id!, resource);
    return this.getBooking(id!);
  }

  private async logCreate(actor: Actor, id: string, resource: ResourceRow) {
    if (hasRole(actor.role, 'reception')) {
      await audit(this.s.db, { id: actor.user.id, label: actor.user.email }, 'booking.create', 'booking', id, { resource: resource.name });
    }
  }

  private exchangeError(err: unknown): ExternalServiceError {
    if (err instanceof GraphError) {
      return new ExternalServiceError(`Exchange non ha accettato l'operazione (${err.status} ${err.code}): ${err.message}`, {
        status: err.status,
        code: err.code,
      });
    }
    return new ExternalServiceError(`Errore durante la comunicazione con Exchange: ${String((err as Error)?.message ?? err)}`);
  }

  /** Reads the resource's answer from the organizer's event and links the resource's copy of the event. */
  private async waitForResource(actor: Actor, b: BookingRow, created: GraphEvent): Promise<BookingRow> {
    let ev: GraphEvent | null = created;
    for (let i = 0; ; i++) {
      const response = ev?.attendees.find((a) => a.email === b.mailbox_email?.toLowerCase())?.response;
      if (response === 'accepted' || response === 'declined' || i >= this.s.acceptancePolls) break;
      await new Promise((r) => setTimeout(r, this.s.acceptancePollMs));
      ev = await this.s.graph.getEvent(this.userCaller(actor), actor.user.email, created.id);
    }
    if (ev) await this.applyResourceResponse(b, ev, actor);
    return this.getBooking(b.id);
  }

  /** Applies the resource attendee's response found on the organizer's event. */
  async applyResourceResponse(b: BookingRow, organizerEvent: GraphEvent, actor?: Actor): Promise<void> {
    if (!b.mailbox_email || b.status !== 'pending') return;
    const response = organizerEvent.attendees.find((a) => a.email === b.mailbox_email!.toLowerCase())?.response;
    const finalStatus: BookingStatus = b.proposal_id ? 'tentative' : 'confirmed';
    if (response === 'declined') {
      await this.s.db.query(`update booking set status = 'declined', updated_at = now() where id = $1 and status = 'pending'`, [b.id]);
      if (actor && b.organizer_event_id) {
        // The organizer's event without the room is useless: remove it from the organizer's calendar.
        await this.s.graph.deleteEvent(this.userCaller(actor), actor.user.email, b.organizer_event_id).catch(() => undefined);
      }
      return;
    }
    let copy: GraphEvent | null = null;
    if (b.ical_uid) {
      copy = await findEventByICalUId(this.s.graph, { kind: 'app' }, b.mailbox_email, b.ical_uid, b.start_at).catch(() => null);
    }
    if (copy || response === 'accepted') {
      await this.s.db.query(
        `update booking set status = $2, resource_event_id = coalesce($3, resource_event_id), last_synced_at = now(), updated_at = now()
         where id = $1 and status = 'pending'`,
        [b.id, finalStatus, copy?.id ?? null],
      );
    }
  }

  // ------------------------------------------------------------------ multi-day (desks)

  async createMultiDay(
    actor: Actor,
    input: { resourceId: string; dates: string[]; startTime: string; endTime: string; title?: string; source: CreateBookingInput['source'] },
    localToUtc: (date: string, time: string) => Date,
  ): Promise<{ created: BookingRow[]; failed: Array<{ date: string; message: string }> }> {
    const created: BookingRow[] = [];
    const failed: Array<{ date: string; message: string }> = [];
    for (const date of input.dates) {
      try {
        created.push(
          await this.createBooking(actor, {
            resourceId: input.resourceId,
            start: localToUtc(date, input.startTime),
            end: localToUtc(date, input.endTime),
            title: input.title,
            source: input.source,
          }),
        );
      } catch (err) {
        failed.push({ date, message: (err as Error).message });
      }
    }
    return { created, failed };
  }

  // ------------------------------------------------------------------ recurring

  async createRecurring(
    actor: Actor,
    input: RecurringBookingInput,
  ): Promise<{ seriesId: string; bookings: BookingRow[]; skipped: Occurrence[]; alternatives: BookingRow[]; failedAlternatives: string[] }> {
    const now = this.s.clock.now();
    const resource = await getResource(this.s.db, input.resourceId);
    const settings = await getSettings(this.s.db);
    const policy = effectivePolicy(resource, settings);
    const pattern = input.recurrence as RecurrencePattern;
    if (!pattern.until && !pattern.count) throw new ValidationError('Indica una data di fine o un numero di occorrenze.');
    if (pattern.type === 'weekly' && !pattern.daysOfWeek?.length) throw new ValidationError('Indica almeno un giorno della settimana.');
    const duration = Math.round((input.end.getTime() - input.start.getTime()) / 60_000);
    const occurrences = expandRecurrence(input.start, duration, pattern, this.tz, settings.recurrenceMaxOccurrences);
    if (occurrences.length < 2) throw new ValidationError('La ricorrenza deve avere almeno due occorrenze.');
    for (const o of occurrences) validatePolicy(policy, o.start, o.end, now, this.tz);

    const beneficiary = await this.resolveBeneficiary(actor, input.bookedForEmail, input.bookedForName);
    const caller = this.userCaller(actor);
    const first = occurrences[0]!;
    const last = occurrences[occurrences.length - 1]!;
    const busy = (await busyIntervals(this.s.db, this.s.graph, [resource], first.start, last.end, caller)).get(resource.id)!;
    const conflictIdx = new Set<number>();
    occurrences.forEach((o, i) => {
      if (conflictsIn(busy, o.start, o.end).length) conflictIdx.add(i);
    });

    if (conflictIdx.size > 0 && input.conflictStrategy === 'ask') {
      const occ: NonNullable<ConflictPayload['occurrences']> = [];
      for (const [i, o] of occurrences.entries()) {
        const conflict = conflictIdx.has(i);
        const alts = conflict
          ? (await alternatives(this.s.db, this.s.graph, resource, o.start, o.end, caller, settings, this.tz, now, input.attendeeCount ?? 1))
              .resources
          : [];
        occ.push({ start: o.start.toISOString(), end: o.end.toISOString(), conflict, alternatives: alts });
      }
      throw new ConflictError({
        code: 'RECURRENCE_CONFLICT',
        message: `${conflictIdx.size} occorrenz${conflictIdx.size === 1 ? 'a è' : 'e sono'} in conflitto. Puoi saltarle o scegliere una risorsa alternativa.`,
        conflicts: [...conflictIdx].map((i) => ({
          start: occurrences[i]!.start.toISOString(),
          end: occurrences[i]!.end.toISOString(),
          source: 'exchange' as const,
        })),
        alternatives: { resources: [], times: [] },
        occurrences: occ,
      });
    }
    if (conflictIdx.size > settings.recurrenceMaxConflicts) {
      throw new ValidationError(
        `Troppe occorrenze in conflitto (${conflictIdx.size}, massimo ${settings.recurrenceMaxConflicts}): scegli un'altra risorsa o un altro orario.`,
      );
    }

    const title = input.title?.trim() || this.defaultTitle(resource);
    const seriesId = (
      await this.s.db.query<{ id: string }>(
        `insert into booking_series(resource_id, organizer_id, booked_for_id, created_by_id, title, pattern) values ($1,$2,$3,$4,$5,$6::jsonb) returning id`,
        [resource.id, actor.user.id, beneficiary.id, actor.user.id, title, JSON.stringify(pattern)],
      )
    ).rows[0]!.id;

    const keep = occurrences.filter((_, i) => !conflictIdx.has(i));
    const ids = await this.reserve(resource, keep, {
      organizerId: actor.user.id,
      organizerEmail: actor.user.email,
      bookedForId: beneficiary.id,
      createdById: actor.user.id,
      title,
      status: resource.mailbox_email ? 'pending' : 'confirmed',
      source: input.source,
      attendeeCount: input.attendeeCount ?? 1,
      isOnlineMeeting: Boolean(input.isOnlineMeeting),
      seriesId,
    });
    const idByStart = new Map(keep.map((o, i) => [o.start.getTime(), ids[i]!]));

    const segments = splitIntoSegments(occurrences, conflictIdx);
    const masterIds: string[] = [];
    const createUserEvents = Boolean(resource.mailbox_email) || settings.calendarEntryForUnmanaged;
    try {
      for (const seg of segments) {
        if (!createUserEvents) break;
        const segFirst = seg[0]!;
        const segLast = seg[seg.length - 1]!;
        const ev = this.buildEvent(idByStart.get(segFirst.start.getTime())!, resource, actor.user, beneficiary, segFirst.start, segFirst.end, title, settings, {
          isOnlineMeeting: input.isOnlineMeeting,
          attendeeEmails: input.attendeeEmails,
          showAs: resource.mailbox_email ? 'busy' : 'free',
        });
        if (seg.length > 1) {
          ev.recurrence = toGraphRecurrence(pattern, segFirst, segLast, this.tz, this.s.config.windowsTimeZone);
          ev.transactionId = `${seriesId}-${masterIds.length}`;
        }
        const created = await this.s.graph.createEvent(caller, actor.user.email, ev);
        masterIds.push(created.id);
        const instances =
          seg.length > 1
            ? await this.s.graph.listInstances(caller, actor.user.email, created.id, addMinutes(segFirst.start, -60), addMinutes(segLast.end, 60))
            : [created];
        for (const inst of instances) {
          const bookingId = idByStart.get(inst.start.getTime());
          if (!bookingId) continue;
          if (resource.mailbox_email) {
            await this.s.db.query(
              `update booking set organizer_event_id = $2, ical_uid = $3, online_meeting_url = $4, updated_at = now() where id = $1`,
              [bookingId, inst.id, inst.iCalUId, inst.onlineMeetingUrl ?? null],
            );
          } else {
            await this.s.db.query(`update booking set user_event_id = $2, updated_at = now() where id = $1`, [bookingId, inst.id]);
          }
        }
      }
    } catch (err) {
      await this.s.db.query(`update booking set status = 'cancelled', updated_at = now() where series_id = $1 and organizer_event_id is null and user_event_id is null`, [seriesId]);
      throw this.exchangeError(err);
    }
    await this.s.db.query('update booking_series set graph_master_ids = $2 where id = $1', [seriesId, masterIds]);

    if (resource.mailbox_email) {
      // Link the resource's copies and apply its answers.
      const roomEvents = await this.s.graph
        .listCalendarView({ kind: 'app' }, resource.mailbox_email, addMinutes(first.start, -60), addMinutes(last.end, 60))
        .catch(() => [] as GraphEvent[]);
      const byUid = new Map(roomEvents.map((e) => [e.iCalUId, e]));
      const rows = (await this.s.db.query<BookingRow>(`${BOOKING_SELECT} where b.series_id = $1`, [seriesId])).rows;
      for (const b of rows) {
        const copy = b.ical_uid ? byUid.get(b.ical_uid) : undefined;
        if (copy) {
          await this.s.db.query(
            `update booking set status = 'confirmed', resource_event_id = $2, last_synced_at = now(), updated_at = now() where id = $1 and status = 'pending'`,
            [b.id, copy.id],
          );
        } else if (b.organizer_event_id) {
          const orgEv = await this.s.graph.getEvent(caller, actor.user.email, b.organizer_event_id).catch(() => null);
          if (orgEv) await this.applyResourceResponse(b, orgEv);
        }
      }
    }

    const altCreated: BookingRow[] = [];
    const altFailed: string[] = [];
    for (const i of conflictIdx) {
      const o = occurrences[i]!;
      const altId = input.alternatives?.[o.start.toISOString()];
      if (!altId) continue;
      try {
        const alt = await this.createBooking(actor, {
          resourceId: altId,
          start: o.start,
          end: o.end,
          title,
          bookedForEmail: input.bookedForEmail,
          isOnlineMeeting: input.isOnlineMeeting,
          attendeeEmails: input.attendeeEmails,
          source: input.source,
        });
        await this.s.db.query('update booking set series_id = $2 where id = $1', [alt.id, seriesId]);
        altCreated.push(await this.getBooking(alt.id));
      } catch (err) {
        altFailed.push(`${formatIt(o.start, this.tz)}: ${(err as Error).message}`);
      }
    }
    await audit(this.s.db, { id: actor.user.id, label: actor.user.email }, 'series.create', 'booking_series', seriesId, {
      occurrences: occurrences.length,
      skipped: conflictIdx.size,
    });
    const bookings = (await this.s.db.query<BookingRow>(`${BOOKING_SELECT} where b.series_id = $1 and b.resource_id = $2 order by b.start_at`, [seriesId, resource.id])).rows;
    return {
      seriesId,
      bookings,
      skipped: [...conflictIdx].map((i) => occurrences[i]!),
      alternatives: altCreated,
      failedAlternatives: altFailed,
    };
  }

  // ------------------------------------------------------------------ proposals

  async createProposal(actor: Actor, input: ProposalInput): Promise<ProposalDto> {
    const settings = await getSettings(this.s.db);
    const now = this.s.clock.now();
    const earliest = new Date(Math.min(...input.options.map((o) => o.start.getTime())));
    const expires = new Date(Math.min(addMinutes(now, settings.proposalHoldMinutes).getTime(), earliest.getTime()));
    const proposalId = (
      await this.s.db.query<{ id: string }>(`insert into proposal(user_id, title, expires_at) values ($1, $2, $3) returning id`, [
        actor.user.id,
        input.title,
        expires,
      ])
    ).rows[0]!.id;
    const created: BookingRow[] = [];
    try {
      for (const opt of input.options) {
        created.push(
          await this.createBooking(
            actor,
            { resourceId: opt.resourceId, start: opt.start, end: opt.end, title: input.title, isOnlineMeeting: false, source: input.source },
            { finalStatus: 'tentative', proposalId, subjectPrefix: '[Proposta] ', showAs: 'tentative' },
          ),
        );
      }
    } catch (err) {
      for (const b of created) await this.cancelBooking({ kind: 'user', actor }, b.id, 'Proposta annullata').catch(() => undefined);
      await this.s.db.query(`update proposal set status = 'cancelled' where id = $1`, [proposalId]);
      throw err;
    }
    return this.getProposal(proposalId, actor);
  }

  async getProposal(id: string, actor: Actor): Promise<ProposalDto> {
    const p = (await this.s.db.query<any>('select * from proposal where id = $1', [id])).rows[0];
    if (!p) throw new NotFoundError('Proposta non trovata.');
    if (p.user_id !== actor.user.id && !hasRole(actor.role, 'reception')) throw new ForbiddenError();
    const settings = await getSettings(this.s.db);
    const options = (await this.s.db.query<BookingRow>(`${BOOKING_SELECT} where b.proposal_id = $1 order by b.start_at`, [id])).rows;
    return {
      id: p.id,
      title: p.title,
      status: p.status,
      expiresAt: new Date(p.expires_at).toISOString(),
      confirmedBookingId: p.confirmed_booking_id,
      options: options.map((o) => this.toDto(o, settings, actor)),
    };
  }

  async listProposals(actor: Actor): Promise<ProposalDto[]> {
    const ids = (
      await this.s.db.query<{ id: string }>(`select id from proposal where user_id = $1 order by created_at desc limit 50`, [actor.user.id])
    ).rows;
    return Promise.all(ids.map((r) => this.getProposal(r.id, actor)));
  }

  async confirmProposal(actor: Actor, proposalId: string, bookingId: string): Promise<ProposalDto> {
    const proposal = await this.getProposal(proposalId, actor);
    if (proposal.status !== 'open') throw new StateError('La proposta non è più aperta.');
    const options = (await this.s.db.query<BookingRow>(`${BOOKING_SELECT} where b.proposal_id = $1`, [proposalId])).rows;
    const chosen = options.find((o) => o.id === bookingId);
    if (!chosen) throw new NotFoundError("L'opzione scelta non appartiene alla proposta.");
    if (chosen.status !== 'tentative' && chosen.status !== 'pending') throw new StateError("L'opzione scelta non è più disponibile.");
    const caller = this.userCaller(actor);
    const title = (chosen.title ?? '').replace(/^\[Proposta\]\s*/, '');
    const eventId = chosen.organizer_event_id ?? chosen.user_event_id;
    if (eventId) {
      try {
        await this.s.graph.updateEvent(caller, actor.user.email, eventId, { subject: title, showAs: 'busy' });
      } catch (err) {
        throw this.exchangeError(err);
      }
    }
    await this.s.db.query(`update booking set status = 'confirmed', title = $2, updated_at = now() where id = $1`, [chosen.id, title]);
    for (const other of options.filter((o) => o.id !== chosen.id && ['tentative', 'pending'].includes(o.status))) {
      const otherEvent = other.organizer_event_id ?? other.user_event_id;
      if (otherEvent) {
        await this.s.graph
          .cancelEvent(caller, actor.user.email, otherEvent, 'Proposta non scelta: la risorsa torna disponibile.')
          .catch(async () => this.s.graph.deleteEvent(caller, actor.user.email, otherEvent).catch(() => undefined));
      }
      await this.s.db.query(
        `update booking set status = 'released', released_at = $2, release_reason = 'proposal_not_chosen', updated_at = now() where id = $1`,
        [other.id, this.s.clock.now()],
      );
    }
    await this.s.db.query(`update proposal set status = 'confirmed', confirmed_booking_id = $2 where id = $1`, [proposalId, chosen.id]);
    return this.getProposal(proposalId, actor);
  }

  async cancelProposal(actor: Actor, proposalId: string): Promise<ProposalDto> {
    const proposal = await this.getProposal(proposalId, actor);
    if (proposal.status !== 'open') throw new StateError('La proposta non è più aperta.');
    for (const o of proposal.options) {
      if (o.status === 'tentative' || o.status === 'pending') await this.cancelBooking({ kind: 'user', actor }, o.id, 'Proposta annullata');
    }
    await this.s.db.query(`update proposal set status = 'cancelled' where id = $1`, [proposalId]);
    return this.getProposal(proposalId, actor);
  }

  /** Job: proposals not confirmed in time release their holds (from the resource side, no user token needed). */
  async expireProposals(): Promise<number> {
    const now = this.s.clock.now();
    const expired = (
      await this.s.db.query<{ id: string }>(`select id from proposal where status = 'open' and expires_at <= $1`, [now])
    ).rows;
    for (const p of expired) {
      const options = (
        await this.s.db.query<BookingRow>(`${BOOKING_SELECT} where b.proposal_id = $1 and b.status in ('tentative','pending')`, [p.id])
      ).rows;
      for (const o of options) {
        await this.s.db.query(
          `update booking set status = 'released', released_at = $2, release_reason = 'proposal_expired', exchange_released = $3, updated_at = now() where id = $1`,
          [o.id, now, !o.mailbox_email],
        );
        if (o.mailbox_email) await this.releaseInExchange(o.id, 'Proposta di prenotazione scaduta: la risorsa torna disponibile.');
      }
      await this.s.db.query(`update proposal set status = 'expired' where id = $1`, [p.id]);
    }
    return expired.length;
  }

  // ------------------------------------------------------------------ cancel / check-in / check-out

  private assertOperator(op: Operator, b: BookingRow) {
    if (op.kind === 'system') return;
    if (op.kind === 'kiosk') {
      if (op.resourceId !== b.resource_id) throw new ForbiddenError('Questo pannello non gestisce questa risorsa.');
      return;
    }
    if (!this.canManage(op.actor, b)) throw new ForbiddenError('Puoi gestire solo le tue prenotazioni.');
  }

  async cancelBooking(op: Operator, bookingId: string, comment = 'Prenotazione annullata.'): Promise<BookingRow> {
    const b = await this.getBooking(bookingId);
    if (op.kind === 'kiosk') throw new ForbiddenError('Dal pannello non si possono annullare prenotazioni.');
    this.assertOperator(op, b);
    const now = this.s.clock.now();
    if (!['pending', 'confirmed', 'tentative'].includes(b.status)) throw new StateError('La prenotazione non è più attiva.');
    if (b.checked_in_at) throw new StateError('Check-in già effettuato: usa il check-out per liberare la risorsa.');
    if ((b.effective_end_at ?? b.end_at) <= now) throw new StateError('La prenotazione è già terminata.');

    const actor = op.kind === 'user' ? op.actor : null;
    const isOrganizer = actor && b.organizer_id === actor.user.id;
    let exchangeDone = !b.mailbox_email;
    if (isOrganizer && (b.organizer_event_id || b.user_event_id)) {
      const caller = this.userCaller(actor!);
      const evId = (b.organizer_event_id ?? b.user_event_id)!;
      try {
        if (b.mailbox_email) await this.s.graph.cancelEvent(caller, actor!.user.email, evId, comment);
        else await this.s.graph.deleteEvent(caller, actor!.user.email, evId);
        exchangeDone = true;
      } catch (err) {
        if (b.mailbox_email) {
          try {
            await this.s.graph.deleteEvent(caller, actor!.user.email, evId);
            exchangeDone = true;
          } catch {
            this.s.log.warn({ err: String(err), bookingId }, 'Annullamento in Outlook non riuscito, rilascio lato risorsa');
          }
        }
      }
    }
    await this.s.db.query(
      `update booking set status = 'cancelled', exchange_released = $2, updated_at = now() where id = $1`,
      [b.id, exchangeDone],
    );
    if (!exchangeDone) await this.releaseInExchange(b.id, comment);
    if (actor && !this.isParticipant(actor, b)) {
      await audit(this.s.db, { id: actor.user.id, label: actor.user.email }, 'booking.cancel', 'booking', b.id, { resource: b.resource_name });
    }
    return this.getBooking(b.id);
  }

  async checkIn(op: Operator, bookingId: string): Promise<BookingRow> {
    const b = await this.getBooking(bookingId);
    this.assertOperator(op, b);
    const settings = await getSettings(this.s.db);
    const now = this.s.clock.now();
    if (b.status !== 'confirmed' && b.status !== 'pending') throw new StateError('La prenotazione non è attiva: check-in non possibile.');
    if (b.checked_in_at) return b;
    const win = this.checkInWindow(b, settings);
    if (now < win.opens) {
      throw new StateError(`Il check-in apre alle ${formatTimeIt(win.opens, this.tz)}.`);
    }
    if (now > win.closes) throw new StateError('Il tempo per il check-in è scaduto.');
    await this.s.db.query(`update booking set checked_in_at = $2, updated_at = now() where id = $1`, [b.id, now]);
    return this.getBooking(b.id);
  }

  async checkOut(op: Operator, bookingId: string): Promise<BookingRow> {
    const b = await this.getBooking(bookingId);
    this.assertOperator(op, b);
    const now = this.s.clock.now();
    if (!b.checked_in_at) throw new StateError('Check-out possibile solo dopo il check-in.');
    if (b.checked_out_at) return b;
    const effEnd = b.effective_end_at ?? b.end_at;
    if (now >= effEnd) throw new StateError('La prenotazione è già terminata.');
    const endAt = new Date(Math.max(roundDownToMinutes(now, 1).getTime(), addMinutes(b.start_at, 1).getTime()));
    await this.s.db.query(
      `update booking set checked_out_at = $2, effective_end_at = $3, status = 'completed', release_reason = 'early_checkout',
         exchange_released = $4, updated_at = now() where id = $1`,
      [b.id, now, endAt, !b.mailbox_email],
    );
    if (b.mailbox_email) {
      await this.releaseInExchange(b.id, `Check-out anticipato alle ${formatTimeIt(now, this.tz)}: la risorsa è di nuovo disponibile.`);
    } else if (b.user_event_id && op.kind === 'user' && b.organizer_id === op.actor.user.id) {
      await this.s.graph
        .updateEvent(this.userCaller(op.actor), op.actor.user.email, b.user_event_id, { end: endAt })
        .catch((err) => this.s.log.warn({ err: String(err) }, 'Aggiornamento voce di calendario non riuscito'));
    }
    return this.getBooking(b.id);
  }

  /** Job: releases bookings without check-in after the grace period ("no-show"). */
  async releaseNoShows(): Promise<number> {
    const settings = await getSettings(this.s.db);
    const now = this.s.clock.now();
    const due = (
      await this.s.db.query<BookingRow>(
        `${BOOKING_SELECT} where b.status in ('pending','confirmed') and b.checked_in_at is null and r.check_in_required
         and b.start_at + make_interval(mins => coalesce(r.check_in_grace_minutes, $2::int)) <= $1
         order by b.start_at limit 500`,
        [now, settings.checkInGraceMinutes],
      )
    ).rows;
    for (const b of due) {
      const needsExchange = Boolean(b.mailbox_email) && b.end_at > now;
      await this.s.db.query(
        `update booking set status = 'released', released_at = $2, release_reason = 'no_show', exchange_released = $3, updated_at = now()
         where id = $1 and status in ('pending','confirmed') and checked_in_at is null`,
        [b.id, now, !needsExchange],
      );
      if (needsExchange) {
        const grace = b.check_in_grace_minutes ?? settings.checkInGraceMinutes;
        await this.releaseInExchange(b.id, `Prenotazione rilasciata automaticamente: nessun check-in entro ${grace} minuti dall'inizio.`);
      }
      this.s.log.info({ bookingId: b.id, resource: b.resource_name }, 'Prenotazione rilasciata per mancato check-in');
    }
    return due.length;
  }

  /** Job: retries Exchange releases that failed earlier (for example because of throttling). */
  async retryExchangeReleases(): Promise<number> {
    const now = this.s.clock.now();
    const rows = (
      await this.s.db.query<{ id: string; status: BookingStatus }>(
        `select b.id, b.status from booking b where b.exchange_released = false and b.status in ('released','completed','cancelled')
         and b.end_at > $1 limit 100`,
        [now],
      )
    ).rows;
    for (const r of rows) await this.releaseInExchange(r.id, 'Prenotazione rilasciata: la risorsa torna disponibile.');
    return rows.length;
  }

  /**
   * Frees the resource's calendar from the resource side (application permission scoped to resource mailboxes):
   * the resource declines the meeting, the organizer is notified. Same pattern Microsoft uses for room auto-release.
   */
  async releaseInExchange(bookingId: string, comment: string): Promise<boolean> {
    const b = await this.getBooking(bookingId);
    if (!b.mailbox_email) return true;
    const app: GraphCaller = { kind: 'app' };
    try {
      let ev: GraphEvent | null = null;
      if (b.resource_event_id) ev = await this.s.graph.getEvent(app, b.mailbox_email, b.resource_event_id);
      if (!ev && b.ical_uid) ev = await findEventByICalUId(this.s.graph, app, b.mailbox_email, b.ical_uid, b.start_at);
      if (ev && !ev.isCancelled) {
        if (ev.organizerEmail === b.mailbox_email.toLowerCase()) {
          await this.s.graph.deleteEvent(app, b.mailbox_email, ev.id);
        } else {
          await this.s.graph.declineEvent(app, b.mailbox_email, ev.id, comment);
          const still = await this.s.graph.getEvent(app, b.mailbox_email, ev.id);
          if (still && !still.isCancelled) await this.s.graph.deleteEvent(app, b.mailbox_email, ev.id);
        }
      }
      await this.s.db.query('update booking set exchange_released = true, updated_at = now() where id = $1', [b.id]);
      return true;
    } catch (err) {
      this.s.log.warn({ err: String(err), bookingId }, 'Rilascio in Exchange non riuscito: verrà ritentato');
      await this.s.db.query('update booking set exchange_released = false, updated_at = now() where id = $1', [b.id]);
      return false;
    }
  }

  // ------------------------------------------------------------------ QR and kiosk

  async findCurrentForResource(resourceId: string, userId: string | null): Promise<BookingRow | null> {
    const settings = await getSettings(this.s.db);
    const now = this.s.clock.now();
    const rows = (
      await this.s.db.query<BookingRow>(
        `${BOOKING_SELECT} where b.resource_id = $1 and b.status in ('pending','confirmed')
         and b.start_at - make_interval(mins => $3::int) <= $2 and coalesce(b.effective_end_at, b.end_at) > $2
         ${userId ? 'and (b.organizer_id = $4 or b.booked_for_id = $4 or b.created_by_id = $4)' : ''}
         order by b.start_at limit 1`,
        userId ? [resourceId, now, settings.checkInOpensMinutesBefore, userId] : [resourceId, now, settings.checkInOpensMinutesBefore],
      )
    ).rows;
    return rows[0] ?? null;
  }

  /** "Prenota ora" from a QR code: books from now for the given minutes and checks in (the user is on site). */
  async quickBookByQr(actor: Actor, token: string, minutes: number, title?: string): Promise<BookingRow> {
    const resource = await getResourceByQr(this.s.db, token);
    const start = roundDownToMinutes(this.s.clock.now(), 5);
    const end = addMinutes(start, minutes);
    return this.createBooking(
      actor,
      { resourceId: resource.id, start, end, title, source: 'qr' },
      { checkInNow: true },
    );
  }

  /** "Prenota ora" from the room panel: the room itself is the organizer (application permission). */
  async kioskBookNow(resourceId: string, minutes: number): Promise<BookingRow> {
    const resource = await getResource(this.s.db, resourceId);
    const settings = await getSettings(this.s.db);
    const now = this.s.clock.now();
    const start = roundDownToMinutes(now, 5);
    const end = addMinutes(start, minutes);
    validatePolicy(effectivePolicy(resource, settings), start, end, now, this.tz);
    const app: GraphCaller = { kind: 'app' };
    await this.assertAvailable(null, resource, start, end, settings, 1, resource.mailbox_email ? app : null);
    const title = 'Prenotazione immediata dal pannello';
    const [id] = await this.reserve(resource, [{ start, end }], {
      organizerId: null,
      organizerEmail: resource.mailbox_email,
      bookedForId: null,
      createdById: null,
      title,
      status: 'confirmed',
      source: 'kiosk',
      attendeeCount: 1,
      isOnlineMeeting: false,
      checkedInAt: now,
    });
    if (resource.mailbox_email) {
      try {
        const ev = await this.s.graph.createEvent(app, resource.mailbox_email, {
          subject: title,
          start,
          end,
          attendees: [],
          showAs: 'busy',
          transactionId: id,
          bodyText: `Creata dal pannello fuori-porta di ${this.s.config.appName}.`,
        });
        await this.s.db.query(
          `update booking set resource_event_id = $2, ical_uid = $3, updated_at = now() where id = $1`,
          [id, ev.id, ev.iCalUId],
        );
      } catch (err) {
        await this.s.db.query(`update booking set status = 'cancelled', updated_at = now() where id = $1`, [id]);
        throw this.exchangeError(err);
      }
    }
    return this.getBooking(id!);
  }

  async ownerOf(b: BookingRow): Promise<UserRow | null> {
    return b.organizer_id ? getUserById(this.s.db, b.organizer_id) : null;
  }

  isTerminal(status: BookingStatus): boolean {
    return TERMINAL.includes(status);
  }
}

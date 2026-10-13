import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { BookingStatus } from '@ritrovo/shared';
import { GraphError, type ChangeNotification, type GraphCaller, type GraphEvent } from '../graph/types.js';
import { BOOKING_SELECT, type BookingRow, type Services } from './bookings.js';
import { listResources, type ResourceRow } from './resources.js';
import { addLocalDays, addMinutes, startOfLocalDay } from './time.js';
import { getUserByEmail } from './users.js';

/** Subscriptions to Outlook events last at most 10,080 minutes: renew well before. */
const SUBSCRIPTION_MINUTES = 10_000;
const RENEW_BEFORE_MINUTES = 24 * 60;
const WINDOW_PAST_DAYS = 1;
const WINDOW_FUTURE_DAYS = 180;

interface SyncStateRow {
  resource_id: string;
  delta_link: string | null;
  window_start: Date | null;
  window_end: Date | null;
  last_sync_at: Date | null;
  last_error: string | null;
}

export interface SyncReport {
  resourceId: string;
  upserted: number;
  created: number;
  removed: number;
  full: boolean;
  error?: string;
}

/**
 * Keeps Ritrovo aligned with the calendars of resource mailboxes (Outlook -> Ritrovo).
 * Exchange is the source of truth: bookings made directly in Outlook appear in Ritrovo,
 * events removed in Outlook are cancelled in Ritrovo.
 */
export class SyncService {
  private queue = new Set<string>();
  private running: Promise<void> = Promise.resolve();

  constructor(private readonly s: Services) {}

  private get app(): GraphCaller {
    return { kind: 'app' };
  }

  async mailboxResources(): Promise<ResourceRow[]> {
    return (await listResources(this.s.db)).filter((r) => r.mailbox_email);
  }

  // ---------------------------------------------------------------- subscriptions

  async ensureSubscriptions(): Promise<{ created: number; renewed: number; failed: number }> {
    const result = { created: 0, renewed: 0, failed: 0 };
    if (!this.s.config.webhooksEnabled && this.s.graph.mode === 'live') return result;
    const now = this.s.clock.now();
    const resources = await this.mailboxResources();
    for (const r of resources) {
      const sub = (
        await this.s.db.query<{ id: string; subscription_id: string; expires_at: Date }>(
          'select * from graph_subscription where resource_id = $1 order by expires_at desc limit 1',
          [r.id],
        )
      ).rows[0];
      const expiration = addMinutes(now, SUBSCRIPTION_MINUTES);
      try {
        if (sub && sub.expires_at > addMinutes(now, RENEW_BEFORE_MINUTES)) continue;
        if (sub && sub.expires_at > now) {
          try {
            const renewed = await this.s.graph.renewSubscription(sub.subscription_id, expiration);
            await this.s.db.query('update graph_subscription set expires_at = $2 where id = $1', [sub.id, renewed.expirationDateTime]);
            result.renewed++;
            continue;
          } catch (err) {
            if (!(err instanceof GraphError && err.status === 404)) throw err;
          }
        }
        if (sub) await this.s.db.query('delete from graph_subscription where id = $1', [sub.id]);
        const clientState = randomBytes(24).toString('base64url');
        const created = await this.s.graph.createSubscription(
          r.mailbox_email!,
          `${this.s.config.publicBaseUrl}/api/graph/notifications`,
          `${this.s.config.publicBaseUrl}/api/graph/lifecycle`,
          clientState,
          expiration,
        );
        await this.s.db.query(
          'insert into graph_subscription(resource_id, subscription_id, client_state, expires_at) values ($1,$2,$3,$4)',
          [r.id, created.id, clientState, created.expirationDateTime],
        );
        result.created++;
      } catch (err) {
        result.failed++;
        this.s.log.warn({ err: String(err), resource: r.name }, 'Sottoscrizione Graph non creata/rinnovata');
      }
    }
    return result;
  }

  /** Validates change notifications (clientState) and queues a delta sync for the affected resources. */
  async handleNotifications(items: ChangeNotification[]): Promise<number> {
    let accepted = 0;
    for (const n of items) {
      const sub = (
        await this.s.db.query<{ resource_id: string; client_state: string }>(
          'select resource_id, client_state from graph_subscription where subscription_id = $1',
          [n.subscriptionId],
        )
      ).rows[0];
      if (!sub || !n.clientState || !safeEqual(sub.client_state, n.clientState)) {
        this.s.log.warn({ subscriptionId: n.subscriptionId }, 'Notifica Graph ignorata: sottoscrizione o clientState non validi');
        continue;
      }
      accepted++;
      if (n.lifecycleEvent === 'subscriptionRemoved' || n.lifecycleEvent === 'reauthorizationRequired') {
        await this.s.db.query('update graph_subscription set expires_at = $2 where subscription_id = $1', [n.subscriptionId, this.s.clock.now()]);
        void this.ensureSubscriptions();
      }
      this.enqueue(sub.resource_id);
    }
    return accepted;
  }

  enqueue(resourceId: string): void {
    this.queue.add(resourceId);
    this.running = this.running.then(() => this.drain()).catch(() => undefined);
  }

  /** Resolves when queued syncs have completed (used by tests and graceful shutdown). */
  async idle(): Promise<void> {
    await this.running;
  }

  private async drain(): Promise<void> {
    while (this.queue.size) {
      const [id] = this.queue;
      this.queue.delete(id!);
      await this.syncResource(id!).catch((err) => this.s.log.warn({ err: String(err) }, 'Sincronizzazione non riuscita'));
    }
  }

  // ---------------------------------------------------------------- delta

  async syncAll(): Promise<SyncReport[]> {
    const out: SyncReport[] = [];
    for (const r of await this.mailboxResources()) out.push(await this.syncResource(r.id));
    return out;
  }

  async syncResource(resourceId: string): Promise<SyncReport> {
    const resource = (await this.mailboxResources()).find((r) => r.id === resourceId);
    const report: SyncReport = { resourceId, upserted: 0, created: 0, removed: 0, full: false };
    if (!resource) return report;
    const now = this.s.clock.now();
    const state = (await this.s.db.query<SyncStateRow>('select * from sync_state where resource_id = $1', [resourceId])).rows[0];
    const windowStart = addLocalDays(startOfLocalDay(now, this.s.config.timezone), -WINDOW_PAST_DAYS, this.s.config.timezone);
    const windowEnd = addLocalDays(windowStart, WINDOW_FUTURE_DAYS + WINDOW_PAST_DAYS, this.s.config.timezone);
    // The calendarView window is fixed for a delta token: start a fresh round every day.
    const reuse = state?.delta_link && state.window_start && state.window_start.getTime() === windowStart.getTime();
    try {
      let result;
      try {
        result = await this.s.graph.calendarViewDelta(
          this.app,
          resource.mailbox_email!,
          reuse ? { deltaLink: state!.delta_link! } : { start: windowStart, end: windowEnd },
        );
      } catch (err) {
        if (reuse && err instanceof GraphError && (err.status === 410 || err.status === 400)) {
          result = await this.s.graph.calendarViewDelta(this.app, resource.mailbox_email!, { start: windowStart, end: windowEnd });
        } else {
          throw err;
        }
      }
      report.full = result.full;
      for (const ev of result.events) {
        const r = await this.upsertFromResourceEvent(resource, ev);
        if (r === 'created') report.created++;
        else if (r === 'updated') report.upserted++;
      }
      for (const id of result.removedIds) {
        if (await this.markRemoved(resource, id)) report.removed++;
      }
      if (result.full) report.removed += await this.reconcileMissing(resource, result.events, windowStart, windowEnd);
      await this.s.db.query(
        `insert into sync_state(resource_id, delta_link, window_start, window_end, last_sync_at, last_error)
         values ($1,$2,$3,$4,$5,null)
         on conflict (resource_id) do update set delta_link = excluded.delta_link, window_start = excluded.window_start,
           window_end = excluded.window_end, last_sync_at = excluded.last_sync_at, last_error = null`,
        [resourceId, result.deltaLink, windowStart, windowEnd, now],
      );
    } catch (err) {
      report.error = String((err as Error).message ?? err);
      await this.s.db.query(
        `insert into sync_state(resource_id, last_error, last_sync_at) values ($1,$2,$3)
         on conflict (resource_id) do update set last_error = excluded.last_error`,
        [resourceId, report.error, now],
      );
    }
    return report;
  }

  /** Creates or updates the Ritrovo booking that corresponds to an event in the resource's calendar. */
  async upsertFromResourceEvent(resource: ResourceRow, ev: GraphEvent): Promise<'created' | 'updated' | 'ignored'> {
    if (ev.type === 'seriesMaster' || !ev.iCalUId) return 'ignored';
    const mailbox = resource.mailbox_email!.toLowerCase();
    let b = (
      await this.s.db.query<BookingRow>(`${BOOKING_SELECT} where b.resource_id = $1 and b.ical_uid = $2`, [resource.id, ev.iCalUId])
    ).rows[0];
    if (!b) {
      // A booking just created by Ritrovo may not have its iCalUId stored yet: match it by time and organizer.
      b = (
        await this.s.db.query<BookingRow>(
          `${BOOKING_SELECT} where b.resource_id = $1 and b.ical_uid is null and b.status = 'pending'
           and b.start_at = $2 and b.end_at = $3 and lower(b.organizer_email) = $4 limit 1`,
          [resource.id, ev.start, ev.end, ev.organizerEmail],
        )
      ).rows[0];
    }
    // The row may change between the read above and the writes below (check-out, release, cancellation by the user):
    // every write is conditional on the booking still being active, so a sync never resurrects a terminal state.
    if (ev.isCancelled) {
      if (b && ['pending', 'confirmed', 'tentative'].includes(b.status)) {
        const r = await this.s.db.query(
          `update booking set status = 'cancelled', updated_at = now(), last_synced_at = now()
           where id = $1 and status in ('pending','confirmed','tentative')`,
          [b.id],
        );
        return r.rowCount ? 'updated' : 'ignored';
      }
      return 'ignored';
    }
    if (b) {
      if (['released', 'cancelled', 'declined', 'completed'].includes(b.status)) return 'ignored';
      const accepted: BookingStatus = b.proposal_id ? 'tentative' : 'confirmed';
      const r = await this.s.db.query(
        `update booking set start_at = $2, end_at = $3, status = case when status = 'pending' then $4 else status end,
           resource_event_id = $5, ical_uid = $6, last_synced_at = now(), updated_at = now()
         where id = $1 and status in ('pending','confirmed','tentative')`,
        [b.id, ev.start, ev.end, accepted, ev.id, ev.iCalUId],
      );
      return r.rowCount ? 'updated' : 'ignored';
    }
    // Booked directly in Outlook (or on another channel): Ritrovo adopts it with the same rules.
    const organizerEmail = ev.organizerEmail || mailbox;
    const organizer = organizerEmail === mailbox ? null : await getUserByEmail(this.s.db, organizerEmail);
    await this.s.db.query(
      `insert into booking(resource_id, organizer_id, organizer_email, booked_for_id, created_by_id, title, start_at, end_at, status, source,
         ical_uid, resource_event_id, attendee_count, last_synced_at)
       values ($1,$2,$3,$2,$2,$4,$5,$6,'confirmed','outlook',$7,$8,$9, now())
       on conflict do nothing`,
      [
        resource.id,
        organizer?.id ?? null,
        organizerEmail,
        ev.subject || ev.organizerName || 'Riunione',
        ev.start,
        ev.end,
        ev.iCalUId,
        ev.id,
        Math.max(1, ev.attendees.filter((a) => a.type !== 'resource').length + 1),
      ],
    );
    return 'created';
  }

  private async markRemoved(resource: ResourceRow, eventId: string): Promise<boolean> {
    const res = await this.s.db.query(
      `update booking set status = 'cancelled', updated_at = now(), last_synced_at = now()
       where resource_id = $1 and resource_event_id = $2 and status in ('pending','confirmed','tentative')`,
      [resource.id, eventId],
    );
    return res.rowCount > 0;
  }

  /** On a full round, active bookings whose event no longer exists in the resource's calendar are cancelled. */
  private async reconcileMissing(resource: ResourceRow, events: GraphEvent[], from: Date, to: Date): Promise<number> {
    const present = new Set(events.map((e) => e.iCalUId));
    const grace = addMinutes(this.s.clock.now(), -15);
    const rows = (
      await this.s.db.query<{ id: string; ical_uid: string | null; status: string; created_at: Date }>(
        `select id, ical_uid, status, created_at from booking where resource_id = $1 and status in ('confirmed','tentative','pending')
         and start_at >= $2 and start_at < $3 and ical_uid is not null`,
        [resource.id, from, to],
      )
    ).rows;
    let n = 0;
    for (const r of rows) {
      if (present.has(r.ical_uid!)) continue;
      // Exchange may still be processing a fresh request.
      if (r.status === 'pending' && r.created_at > grace) continue;
      const res = await this.s.db.query(
        `update booking set status = 'cancelled', updated_at = now() where id = $1 and status in ('confirmed','tentative','pending')`,
        [r.id],
      );
      n += res.rowCount ? 1 : 0;
    }
    return n;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

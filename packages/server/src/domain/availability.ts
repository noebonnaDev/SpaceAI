import type { AlternativeSlot, ConflictPayload } from '@ritrovo/shared';
import { ACTIVE_STATUSES } from '@ritrovo/shared';
import type { Queryable } from '../db/db.js';
import type { GraphCaller, GraphGateway } from '../graph/types.js';
import { ValidationError } from './errors.js';
import { listResources, type EffectivePolicy, type ResourceRow } from './resources.js';
import type { Settings } from './settings.js';
import { addMinutes, formatIt, localDate, localToUtc, minutesBetween, overlaps } from './time.js';

export interface BusySlot {
  start: Date;
  end: Date;
  source: 'ritrovo' | 'exchange';
  bookingId?: string;
}

/** Busy time per resource, from Ritrovo bookings and (for mailbox resources) Exchange free/busy. */
export async function busyIntervals(
  q: Queryable,
  graph: GraphGateway,
  resources: ResourceRow[],
  start: Date,
  end: Date,
  caller: GraphCaller | null,
  excludeBookingIds: string[] = [],
): Promise<Map<string, BusySlot[]>> {
  const out = new Map<string, BusySlot[]>(resources.map((r) => [r.id, []]));
  if (resources.length === 0) return out;
  const rows = (
    await q.query<{ id: string; resource_id: string; start_at: Date; end_at: Date }>(
      `select id, resource_id, start_at, coalesce(effective_end_at, end_at) as end_at from booking
       where resource_id = any($1::uuid[]) and status = any($2::text[]) and start_at < $4 and coalesce(effective_end_at, end_at) > $3
         and not (id = any($5::uuid[]))`,
      [resources.map((r) => r.id), ACTIVE_STATUSES, start, end, excludeBookingIds],
    )
  ).rows;
  for (const r of rows) out.get(r.resource_id)!.push({ start: r.start_at, end: r.end_at, source: 'ritrovo', bookingId: r.id });

  const withMailbox = resources.filter((r) => r.mailbox_email);
  if (caller && withMailbox.length) {
    const schedule = await graph.getSchedule(
      caller,
      withMailbox.map((r) => r.mailbox_email!),
      start,
      end,
    );
    for (const r of withMailbox) {
      for (const b of schedule[r.mailbox_email!.toLowerCase()] ?? []) {
        out.get(r.id)!.push({ start: b.start, end: b.end, source: 'exchange' });
      }
    }
  }
  return out;
}

export function conflictsIn(slots: BusySlot[], start: Date, end: Date): BusySlot[] {
  return slots.filter((s) => overlaps(s.start, s.end, start, end));
}

/** Validates duration, booking window and start time against the resource rules. */
export function validatePolicy(policy: EffectivePolicy, start: Date, end: Date, now: Date, tz: string): void {
  if (!(end > start)) throw new ValidationError("L'orario di fine deve essere successivo all'inizio.");
  const minutes = minutesBetween(start, end);
  if (minutes > policy.maxDurationMinutes) {
    throw new ValidationError(`Durata massima per questa risorsa: ${policy.maxDurationMinutes} minuti.`);
  }
  if (end <= now) throw new ValidationError('Non è possibile prenotare nel passato.');
  if (start < addMinutes(now, -15)) throw new ValidationError("L'inizio è già passato: scegli un orario futuro.");
  const limit = addMinutes(now, policy.bookingWindowDays * 24 * 60);
  if (start > limit) {
    throw new ValidationError(`Si può prenotare al massimo fino al ${formatIt(limit, tz).slice(0, 10)} (${policy.bookingWindowDays} giorni).`);
  }
}

/** Free alternatives: other resources at the same time, and the same resource at the nearest free times. */
export async function alternatives(
  q: Queryable,
  graph: GraphGateway,
  resource: ResourceRow,
  start: Date,
  end: Date,
  caller: GraphCaller | null,
  settings: Settings,
  tz: string,
  now: Date,
  attendeeCount = 1,
): Promise<ConflictPayload['alternatives']> {
  const duration = minutesBetween(start, end);
  const all = await listResources(q, { kind: resource.kind });
  let candidates = all.filter((r) => r.id !== resource.id && duration <= r.max_duration_minutes);
  if (resource.kind === 'room') candidates = candidates.filter((r) => r.capacity >= Math.max(1, attendeeCount));
  if (resource.kind === 'asset' && resource.category) {
    const same = candidates.filter((r) => r.category === resource.category);
    if (same.length) candidates = same;
  }
  candidates.sort((a, b) => {
    const fa = a.floor_id === resource.floor_id ? 0 : 1;
    const fb = b.floor_id === resource.floor_id ? 0 : 1;
    return fa - fb || a.capacity - b.capacity || a.name.localeCompare(b.name);
  });
  candidates = candidates.slice(0, 40);
  const busy = await busyIntervals(q, graph, candidates, start, end, caller);
  const resources: AlternativeSlot[] = candidates
    .filter((r) => conflictsIn(busy.get(r.id)!, start, end).length === 0)
    .slice(0, 5)
    .map((r) => ({ resourceId: r.id, resourceName: r.name, start: start.toISOString(), end: end.toISOString() }));

  // Same resource, nearest free slots on the same day within working hours.
  const day = localDate(start, tz);
  const dayStart = localToUtc(day, settings.workingHours.start, tz);
  const dayEnd = localToUtc(day, settings.workingHours.end, tz);
  const own = (await busyIntervals(q, graph, [resource], dayStart, dayEnd, caller)).get(resource.id)!;
  const times: AlternativeSlot[] = [];
  const offsets: number[] = [];
  for (let m = 15; m <= 12 * 60; m += 15) offsets.push(m, -m);
  for (const off of offsets) {
    const s = addMinutes(start, off);
    const e = addMinutes(s, duration);
    if (s < dayStart || e > dayEnd || s < now) continue;
    if (conflictsIn(own, s, e).length) continue;
    times.push({ resourceId: resource.id, resourceName: resource.name, start: s.toISOString(), end: e.toISOString() });
    if (times.length >= 3) break;
  }
  times.sort((a, b) => a.start.localeCompare(b.start));
  return { resources, times };
}

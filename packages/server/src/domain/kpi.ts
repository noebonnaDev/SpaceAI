import type { KpiReport, KpiResourceRow, ResourceKind } from '@ritrovo/shared';
import { DateTime } from 'luxon';
import type { Queryable } from '../db/db.js';
import { listResources } from './resources.js';
import type { Settings } from './settings.js';
import { overlapMinutes, workingWindows } from './time.js';

interface KpiBookingRow {
  resource_id: string;
  start_at: Date;
  end_at: Date;
  effective_end_at: Date | null;
  status: string;
  release_reason: string | null;
  checked_in_at: Date | null;
  check_in_required: boolean;
  check_in_grace_minutes: number | null;
}

/**
 * KPI definitions (documented in docs/04-uso.md):
 * - available minutes: working hours of the period x number of resources;
 * - booked minutes: time booked (in working hours) by bookings that were not cancelled, declined or proposal holds;
 * - occupied minutes: time actually used = checked-in bookings (until check-out) and bookings of resources
 *   that do not require check-in; released no-shows count zero;
 * - occupancy rate = occupied / available; booking rate = booked / available;
 * - no-show rate = no-show releases / bookings that required a check-in and whose check-in window has closed;
 * - peak hours: average share of resources occupied during each hour of the working day.
 * All figures are aggregated per resource: no personal data.
 */
export async function computeKpi(
  q: Queryable,
  params: { from: Date; to: Date; kind?: ResourceKind | null; resourceId?: string | null; now: Date },
  settings: Settings,
  tz: string,
): Promise<KpiReport> {
  let resources = await listResources(q, { kind: params.kind ?? undefined, includeInactive: false });
  if (params.resourceId) resources = resources.filter((r) => r.id === params.resourceId);
  const ids = resources.map((r) => r.id);
  const windows = workingWindows(params.from, params.to, tz, settings.workingHours);
  const availablePerResource = windows.reduce((acc, [s, e]) => acc + (e.getTime() - s.getTime()) / 60_000, 0);

  const rows = ids.length
    ? (
        await q.query<KpiBookingRow>(
          `select b.resource_id, b.start_at, b.end_at, b.effective_end_at, b.status, b.release_reason, b.checked_in_at,
             r.check_in_required, r.check_in_grace_minutes
           from booking b join resource r on r.id = b.resource_id
           where b.resource_id = any($1::uuid[]) and b.start_at < $3 and b.end_at > $2
             and b.status in ('pending','confirmed','completed','released')
             and (b.release_reason is null or b.release_reason in ('no_show','early_checkout'))`,
          [ids, params.from, params.to],
        )
      ).rows
    : [];

  const per = new Map<string, KpiResourceRow>(
    resources.map((r) => [
      r.id,
      {
        resourceId: r.id,
        resourceName: r.name,
        kind: r.kind,
        bookings: 0,
        availableMinutes: availablePerResource,
        bookedMinutes: 0,
        occupiedMinutes: 0,
        occupancyRate: 0,
        noShows: 0,
        noShowRate: 0,
      },
    ]),
  );
  const eligible = new Map<string, number>();
  const wh = settings.workingHours;
  const startHour = Number(wh.start.slice(0, 2));
  const endHour = Math.ceil(Number(wh.end.slice(0, 2)) + Number(wh.end.slice(3, 5)) / 60);
  const hourBuckets = new Map<number, number>();

  const inWorking = (s: Date, e: Date) => windows.reduce((acc, [ws, we]) => acc + overlapMinutes(s, e, ws, we), 0);

  for (const b of rows) {
    const p = per.get(b.resource_id)!;
    if (b.start_at >= params.from) p.bookings++;
    p.bookedMinutes += inWorking(b.start_at, b.end_at);
    const used = b.status !== 'released' && (b.checked_in_at !== null || !b.check_in_required);
    if (used) {
      const usedStart = b.start_at;
      const usedEnd = b.effective_end_at ?? b.end_at;
      p.occupiedMinutes += inWorking(usedStart, usedEnd);
      for (const [ws, we] of windows) {
        const day = DateTime.fromJSDate(ws, { zone: tz }).startOf('day');
        for (let h = startHour; h < endHour; h++) {
          const hs = day.set({ hour: h }).toJSDate();
          const he = day.set({ hour: h + 1 }).toJSDate();
          const m = overlapMinutes(usedStart, usedEnd, new Date(Math.max(hs.getTime(), ws.getTime())), new Date(Math.min(he.getTime(), we.getTime())));
          if (m > 0) hourBuckets.set(h, (hourBuckets.get(h) ?? 0) + m);
        }
      }
    }
    const grace = b.check_in_grace_minutes ?? settings.checkInGraceMinutes;
    const windowClosed = b.start_at.getTime() + grace * 60_000 <= params.now.getTime();
    if (b.check_in_required && windowClosed && b.start_at >= params.from) {
      eligible.set(b.resource_id, (eligible.get(b.resource_id) ?? 0) + 1);
      if (b.status === 'released' && b.release_reason === 'no_show') p.noShows++;
    }
  }

  const round = (x: number) => Math.round(x * 10000) / 10000;
  let totalBooked = 0;
  let totalOccupied = 0;
  let totalNoShows = 0;
  let totalEligible = 0;
  let totalBookings = 0;
  for (const p of per.values()) {
    const el = eligible.get(p.resourceId) ?? 0;
    p.bookedMinutes = Math.round(p.bookedMinutes);
    p.occupiedMinutes = Math.round(p.occupiedMinutes);
    p.occupancyRate = p.availableMinutes ? round(p.occupiedMinutes / p.availableMinutes) : 0;
    p.noShowRate = el ? round(p.noShows / el) : 0;
    totalBooked += p.bookedMinutes;
    totalOccupied += p.occupiedMinutes;
    totalNoShows += p.noShows;
    totalEligible += el;
    totalBookings += p.bookings;
  }
  const totalAvailable = availablePerResource * resources.length;
  const workingDays = new Set(windows.map(([s]) => DateTime.fromJSDate(s, { zone: tz }).toISODate())).size;
  const peakHours: KpiReport['peakHours'] = [];
  for (let h = startHour; h < endHour; h++) {
    const capacityMinutes = 60 * resources.length * workingDays;
    peakHours.push({ hour: h, averageOccupancy: capacityMinutes ? round((hourBuckets.get(h) ?? 0) / capacityMinutes) : 0 });
  }

  return {
    from: params.from.toISOString(),
    to: params.to.toISOString(),
    kind: params.kind ?? null,
    workingHours: wh,
    totals: {
      resources: resources.length,
      bookings: totalBookings,
      availableMinutes: Math.round(totalAvailable),
      bookedMinutes: totalBooked,
      occupiedMinutes: totalOccupied,
      bookingRate: totalAvailable ? round(totalBooked / totalAvailable) : 0,
      occupancyRate: totalAvailable ? round(totalOccupied / totalAvailable) : 0,
      checkInEligible: totalEligible,
      noShows: totalNoShows,
      noShowRate: totalEligible ? round(totalNoShows / totalEligible) : 0,
    },
    peakHours,
    perResource: [...per.values()].sort((a, b) => b.occupancyRate - a.occupancyRate || a.resourceName.localeCompare(b.resourceName)),
  };
}

const KIND_IT: Record<ResourceKind, string> = { room: 'Sala riunioni', desk: 'Postazione', asset: 'Risorsa condivisa' };

function num(n: number, decimals = 1): string {
  return n.toLocaleString('it-IT', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function csvCell(v: string): string {
  return /[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** CSV for Excel in Italian locale: semicolon separator, decimal comma, UTF-8 BOM. */
export function kpiToCsv(report: KpiReport, tz: string): string {
  const fmt = (iso: string) => DateTime.fromISO(iso, { zone: tz }).toFormat('dd/MM/yyyy');
  const lines: string[] = [];
  lines.push(['Periodo', `${fmt(report.from)} - ${fmt(DateTime.fromISO(report.to).minus({ minutes: 1 }).toISO()!)}`].join(';'));
  lines.push('');
  lines.push(
    [
      'Risorsa',
      'Tipo',
      'Prenotazioni',
      'Minuti disponibili',
      'Minuti prenotati',
      'Minuti occupati',
      'Tasso di occupazione (%)',
      'No-show',
      'Tasso di no-show (%)',
    ].join(';'),
  );
  for (const r of report.perResource) {
    lines.push(
      [
        csvCell(r.resourceName),
        KIND_IT[r.kind],
        String(r.bookings),
        String(Math.round(r.availableMinutes)),
        String(r.bookedMinutes),
        String(r.occupiedMinutes),
        num(r.occupancyRate * 100),
        String(r.noShows),
        num(r.noShowRate * 100),
      ].join(';'),
    );
  }
  const t = report.totals;
  lines.push(
    [
      'Totale',
      '',
      String(t.bookings),
      String(t.availableMinutes),
      String(t.bookedMinutes),
      String(t.occupiedMinutes),
      num(t.occupancyRate * 100),
      String(t.noShows),
      num(t.noShowRate * 100),
    ].join(';'),
  );
  lines.push('');
  lines.push(['Ora', 'Occupazione media (%)'].join(';'));
  for (const h of report.peakHours) lines.push([`${String(h.hour).padStart(2, '0')}:00`, num(h.averageOccupancy * 100)].join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}

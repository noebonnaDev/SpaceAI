import { DateTime } from 'luxon';

export interface WorkingHours {
  /** ISO weekdays, 1 = Monday ... 7 = Sunday. */
  days: number[];
  start: string; // HH:mm
  end: string; // HH:mm
}

export const MINUTE = 60_000;

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * MINUTE);
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MINUTE);
}

export function overlapMinutes(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): number {
  const s = Math.max(aStart.getTime(), bStart.getTime());
  const e = Math.min(aEnd.getTime(), bEnd.getTime());
  return e > s ? (e - s) / MINUTE : 0;
}

export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && bStart.getTime() < aEnd.getTime();
}

function parseHm(hm: string): { hour: number; minute: number } {
  const [h, m] = hm.split(':').map((x) => Number(x));
  return { hour: h ?? 0, minute: m ?? 0 };
}

/** Builds a UTC instant from a local calendar date ("2026-10-14") and time ("09:30") in the given zone. */
export function localToUtc(date: string, time: string, tz: string): Date {
  const { hour, minute } = parseHm(time);
  const dt = DateTime.fromISO(date, { zone: tz }).set({ hour, minute, second: 0, millisecond: 0 });
  if (!dt.isValid) throw new Error(`Data/ora non valida: ${date} ${time}`);
  return dt.toJSDate();
}

export function localDate(d: Date, tz: string): string {
  return DateTime.fromJSDate(d, { zone: tz }).toISODate()!;
}

export function localTime(d: Date, tz: string): string {
  return DateTime.fromJSDate(d, { zone: tz }).toFormat('HH:mm');
}

export function startOfLocalDay(d: Date, tz: string): Date {
  return DateTime.fromJSDate(d, { zone: tz }).startOf('day').toJSDate();
}

export function addLocalDays(d: Date, days: number, tz: string): Date {
  return DateTime.fromJSDate(d, { zone: tz }).plus({ days }).toJSDate();
}

export function isoWeekday(d: Date, tz: string): number {
  return DateTime.fromJSDate(d, { zone: tz }).weekday;
}

/** Formats a date for Italian messages, e.g. "14/10/2026 09:30". */
export function formatIt(d: Date, tz: string): string {
  return DateTime.fromJSDate(d, { zone: tz }).toFormat('dd/MM/yyyy HH:mm');
}

export function formatTimeIt(d: Date, tz: string): string {
  return DateTime.fromJSDate(d, { zone: tz }).toFormat('HH:mm');
}

/** Local wall-clock representation used by Graph together with a Windows time zone name. */
export function toGraphLocal(d: Date, tz: string): string {
  return DateTime.fromJSDate(d, { zone: tz }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

export function toGraphUtc(d: Date): string {
  return DateTime.fromJSDate(d, { zone: 'utc' }).toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS");
}

/** Parses a Graph dateTime (UTC when requested with Prefer: outlook.timezone="UTC"). */
export function fromGraphUtc(dateTime: string): Date {
  const clean = dateTime.endsWith('Z') ? dateTime : `${dateTime}Z`;
  const d = new Date(clean);
  if (Number.isNaN(d.getTime())) throw new Error(`Data Graph non valida: ${dateTime}`);
  return d;
}

/** The working-hour windows (UTC instants) that fall within [from, to). */
export function workingWindows(from: Date, to: Date, tz: string, wh: WorkingHours): Array<[Date, Date]> {
  const out: Array<[Date, Date]> = [];
  const s = parseHm(wh.start);
  const e = parseHm(wh.end);
  let day = DateTime.fromJSDate(from, { zone: tz }).startOf('day');
  const last = DateTime.fromJSDate(to, { zone: tz });
  while (day < last) {
    if (wh.days.includes(day.weekday)) {
      const ws = day.set({ hour: s.hour, minute: s.minute }).toJSDate();
      const we = day.set({ hour: e.hour, minute: e.minute }).toJSDate();
      const cs = new Date(Math.max(ws.getTime(), from.getTime()));
      const ce = new Date(Math.min(we.getTime(), to.getTime()));
      if (ce > cs) out.push([cs, ce]);
    }
    day = day.plus({ days: 1 });
  }
  return out;
}

export function roundDownToMinutes(d: Date, step: number): Date {
  const ms = step * MINUTE;
  return new Date(Math.floor(d.getTime() / ms) * ms);
}

export function roundUpToMinutes(d: Date, step: number): Date {
  const ms = step * MINUTE;
  return new Date(Math.ceil(d.getTime() / ms) * ms);
}

import { DateTime } from 'luxon';

/** All dates are stored in UTC and shown in the office time zone (Europe/Rome), Italian format. */
export const TZ = 'Europe/Rome';

const dt = (iso: string | Date) =>
  (typeof iso === 'string' ? DateTime.fromISO(iso) : DateTime.fromJSDate(iso)).setZone(TZ).setLocale('it');

export const fmtDate = (iso: string | Date) => dt(iso).toFormat('dd/MM/yyyy');
export const fmtTime = (iso: string | Date) => dt(iso).toFormat('HH:mm');
export const fmtDateTime = (iso: string | Date) => dt(iso).toFormat('dd/MM/yyyy HH:mm');
export const fmtDayLong = (iso: string | Date) => {
  const s = dt(iso).toFormat('cccc d LLLL yyyy');
  return s.charAt(0).toUpperCase() + s.slice(1);
};
export const fmtRange = (start: string, end: string) =>
  fmtDate(start) === fmtDate(end) ? `${fmtDate(start)} ${fmtTime(start)}–${fmtTime(end)}` : `${fmtDateTime(start)} – ${fmtDateTime(end)}`;

/** "2026-10-14" + "09:30" in Europe/Rome -> ISO UTC string. */
export function localToIso(date: string, time: string): string {
  return DateTime.fromISO(`${date}T${time}`, { zone: TZ }).toUTC().toISO()!;
}

/** Calendar date (yyyy-MM-dd) of an instant in Europe/Rome. */
export function localDateOf(iso: string | Date): string {
  return dt(iso).toISODate()!;
}

export function todayLocal(): string {
  return DateTime.now().setZone(TZ).toISODate()!;
}

export function addDaysLocal(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: TZ }).plus({ days }).toISODate()!;
}

export function isoWeekday(date: string): number {
  return DateTime.fromISO(date, { zone: TZ }).weekday;
}

/** Next quarter hour from now, local "HH:mm". */
export function nextQuarter(): string {
  const now = DateTime.now().setZone(TZ);
  const m = Math.ceil((now.minute + 1) / 15) * 15;
  return now.startOf('hour').plus({ minutes: m }).toFormat('HH:mm');
}

export function addMinutesToTime(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = Math.min((h ?? 0) * 60 + (m ?? 0) + minutes, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const pct = new Intl.NumberFormat('it-IT', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 });
const num = new Intl.NumberFormat('it-IT');
export const fmtPercent = (v: number) => pct.format(v);
export const fmtNumber = (v: number) => num.format(v);

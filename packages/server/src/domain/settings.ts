import { z } from 'zod';
import type { Queryable } from '../db/db.js';

export const SettingsSchema = z.object({
  /** Minutes after the start without check-in before the automatic release. */
  checkInGraceMinutes: z.number().int().min(1).max(240),
  /** How many minutes before the start check-in opens. */
  checkInOpensMinutesBefore: z.number().int().min(0).max(120),
  workingHours: z.object({
    days: z.array(z.number().int().min(1).max(7)).min(1),
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  }),
  /** Personal data in bookings is anonymised after this many days. */
  retentionDays: z.number().int().min(30).max(3650),
  auditRetentionDays: z.number().int().min(30).max(3650),
  /** Tentative holds of a booking proposal expire after this many minutes. */
  proposalHoldMinutes: z.number().int().min(15).max(10080),
  /** Create an Outlook entry in the user's calendar for resources without an Exchange mailbox (desks). */
  calendarEntryForUnmanaged: z.boolean(),
  /** Show who booked a desk on the floor map ("trova un collega"). */
  showOccupantNames: z.boolean(),
  kioskShowSubject: z.boolean(),
  kioskShowOrganizer: z.boolean(),
  recurrenceMaxOccurrences: z.number().int().min(2).max(260),
  recurrenceMaxConflicts: z.number().int().min(0).max(20),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  checkInGraceMinutes: 10,
  checkInOpensMinutesBefore: 10,
  workingHours: { days: [1, 2, 3, 4, 5], start: '08:00', end: '19:00' },
  retentionDays: 180,
  auditRetentionDays: 365,
  proposalHoldMinutes: 1440,
  calendarEntryForUnmanaged: true,
  showOccupantNames: true,
  kioskShowSubject: false,
  kioskShowOrganizer: true,
  recurrenceMaxOccurrences: 52,
  recurrenceMaxConflicts: 3,
};

export async function getSettings(q: Queryable): Promise<Settings> {
  const rows = (await q.query<{ key: string; value: unknown }>('select key, value from setting')).rows;
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) merged[r.key] = r.value;
  const parsed = SettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function updateSettings(q: Queryable, patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings(q);
  const next = SettingsSchema.parse({ ...current, ...patch });
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS)) continue;
    await q.query(
      `insert into setting(key, value, updated_at) values ($1, $2::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, JSON.stringify((next as Record<string, unknown>)[key])],
    );
  }
  return next;
}

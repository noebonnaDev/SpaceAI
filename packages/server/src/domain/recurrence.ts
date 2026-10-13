import { DateTime } from 'luxon';
import { z } from 'zod';

export const RecurrencePatternSchema = z
  .object({
    type: z.enum(['daily', 'weekly']),
    interval: z.number().int().min(1).max(12).default(1),
    /** ISO weekdays (1 = Monday). Required for weekly patterns. */
    daysOfWeek: z.array(z.number().int().min(1).max(7)).optional(),
    until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    count: z.number().int().min(1).max(260).optional(),
  })
  .refine((p) => p.until || p.count, { message: 'Indica una data di fine o un numero di occorrenze.' })
  .refine((p) => p.type !== 'weekly' || (p.daysOfWeek && p.daysOfWeek.length > 0), {
    message: 'Per una ricorrenza settimanale indica almeno un giorno.',
  });

export type RecurrencePattern = z.infer<typeof RecurrencePatternSchema>;

export interface Occurrence {
  start: Date;
  end: Date;
}

const GRAPH_DAYS = ['', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/**
 * Expands a recurrence starting at `firstStart` (local wall-clock time in `tz` is preserved across DST changes).
 * The first occurrence is `firstStart` itself when it matches the pattern.
 */
export function expandRecurrence(
  firstStart: Date,
  durationMinutes: number,
  pattern: RecurrencePattern,
  tz: string,
  maxOccurrences: number,
): Occurrence[] {
  const start = DateTime.fromJSDate(firstStart, { zone: tz });
  const until = pattern.until ? DateTime.fromISO(pattern.until, { zone: tz }).endOf('day') : null;
  const limit = Math.min(pattern.count ?? Number.MAX_SAFE_INTEGER, maxOccurrences);
  const out: Occurrence[] = [];
  const push = (dt: DateTime) => {
    const s = dt.toJSDate();
    out.push({ start: s, end: new Date(s.getTime() + durationMinutes * 60_000) });
  };

  if (pattern.type === 'daily') {
    for (let i = 0; out.length < limit; i++) {
      const dt = start.plus({ days: i * pattern.interval });
      if (until && dt > until) break;
      push(dt);
      if (i > 5000) break;
    }
    return out;
  }

  // Weekly: weeks are counted from the week (Monday-based) that contains the first occurrence.
  const days = [...new Set(pattern.daysOfWeek ?? [])].sort((a, b) => a - b);
  const weekStart = start.startOf('week');
  for (let w = 0; out.length < limit && w < 5000; w += pattern.interval) {
    for (const d of days) {
      const dt = weekStart.plus({ weeks: w, days: d - 1 }).set({ hour: start.hour, minute: start.minute, second: 0, millisecond: 0 });
      if (dt < start) continue;
      if (until && dt > until) return out;
      push(dt);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export interface GraphRecurrence {
  pattern: {
    type: 'daily' | 'weekly';
    interval: number;
    daysOfWeek?: string[];
    firstDayOfWeek?: string;
  };
  range: {
    type: 'endDate';
    startDate: string;
    endDate: string;
    recurrenceTimeZone: string;
  };
}

/** Graph recurrence for a contiguous segment of occurrences (first..last) of the same pattern. */
export function toGraphRecurrence(
  pattern: RecurrencePattern,
  first: Occurrence,
  last: Occurrence,
  tz: string,
  windowsTimeZone: string,
): GraphRecurrence {
  return {
    pattern: {
      type: pattern.type,
      interval: pattern.interval,
      ...(pattern.type === 'weekly'
        ? { daysOfWeek: (pattern.daysOfWeek ?? []).map((d) => GRAPH_DAYS[d]!), firstDayOfWeek: 'monday' }
        : {}),
    },
    range: {
      type: 'endDate',
      startDate: DateTime.fromJSDate(first.start, { zone: tz }).toISODate()!,
      endDate: DateTime.fromJSDate(last.start, { zone: tz }).toISODate()!,
      recurrenceTimeZone: windowsTimeZone,
    },
  };
}

/**
 * Splits occurrences into contiguous segments that exclude the skipped indices.
 * Each segment becomes one Outlook series, so the resource never sees a conflicting occurrence.
 */
export function splitIntoSegments(occurrences: Occurrence[], skip: Set<number>): Occurrence[][] {
  const segments: Occurrence[][] = [];
  let current: Occurrence[] = [];
  occurrences.forEach((o, i) => {
    if (skip.has(i)) {
      if (current.length) segments.push(current);
      current = [];
    } else {
      current.push(o);
    }
  });
  if (current.length) segments.push(current);
  return segments;
}

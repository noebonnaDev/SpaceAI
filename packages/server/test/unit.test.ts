import { describe, expect, it } from 'vitest';
import { expandRecurrence, splitIntoSegments, toGraphRecurrence } from '../src/domain/recurrence.js';
import { localToUtc, workingWindows } from '../src/domain/time.js';

const TZ = 'Europe/Rome';

describe('Ricorrenze', () => {
  it('settimanale su più giorni con ora locale costante attraverso il cambio dell\'ora', () => {
    const occ = expandRecurrence(localToUtc('2026-10-19', '09:00', TZ), 30, { type: 'weekly', interval: 1, daysOfWeek: [1, 3], count: 5 }, TZ, 52);
    expect(occ.map((o) => o.start.toISOString())).toEqual([
      '2026-10-19T07:00:00.000Z', // Mon (CEST)
      '2026-10-21T07:00:00.000Z', // Wed
      '2026-10-26T08:00:00.000Z', // Mon (CET, after 25/10)
      '2026-10-28T08:00:00.000Z',
      '2026-11-02T08:00:00.000Z',
    ]);
    expect(occ[0]!.end.getTime() - occ[0]!.start.getTime()).toBe(30 * 60_000);
  });

  it('settimanale ogni 2 settimane fino a una data, giornaliera con intervallo', () => {
    const weekly = expandRecurrence(localToUtc('2026-10-15', '10:00', TZ), 60, { type: 'weekly', interval: 2, daysOfWeek: [4], until: '2026-11-30' }, TZ, 52);
    expect(weekly.map((o) => o.start.toISOString().slice(0, 10))).toEqual(['2026-10-15', '2026-10-29', '2026-11-12', '2026-11-26']);
    const daily = expandRecurrence(localToUtc('2026-10-14', '10:00', TZ), 60, { type: 'daily', interval: 3, count: 3 }, TZ, 52);
    expect(daily.map((o) => o.start.toISOString().slice(0, 10))).toEqual(['2026-10-14', '2026-10-17', '2026-10-20']);
  });

  it('il primo giorno non nel pattern viene saltato e il limite massimo è rispettato', () => {
    const occ = expandRecurrence(localToUtc('2026-10-14', '10:00', TZ), 60, { type: 'weekly', interval: 1, daysOfWeek: [1], count: 100 }, TZ, 10);
    expect(occ).toHaveLength(10);
    expect(occ[0]!.start.toISOString().slice(0, 10)).toBe('2026-10-19');
  });

  it('divide in segmenti attorno alle occorrenze in conflitto e genera la ricorrenza Graph', () => {
    const occ = expandRecurrence(localToUtc('2026-10-15', '11:00', TZ), 60, { type: 'weekly', interval: 1, daysOfWeek: [4], count: 6 }, TZ, 52);
    const segs = splitIntoSegments(occ, new Set([0, 3]));
    expect(segs.map((s) => s.length)).toEqual([2, 2]);
    const rec = toGraphRecurrence({ type: 'weekly', interval: 1, daysOfWeek: [4], count: 6 }, segs[0]![0]!, segs[0]![1]!, TZ, 'W. Europe Standard Time');
    expect(rec).toEqual({
      pattern: { type: 'weekly', interval: 1, daysOfWeek: ['thursday'], firstDayOfWeek: 'monday' },
      range: { type: 'endDate', startDate: '2026-10-22', endDate: '2026-10-29', recurrenceTimeZone: 'W. Europe Standard Time' },
    });
  });
});

describe('Orario di lavoro', () => {
  it('calcola le finestre lavorative escludendo il fine settimana', () => {
    const w = workingWindows(localToUtc('2026-10-16', '00:00', TZ), localToUtc('2026-10-20', '00:00', TZ), TZ, { days: [1, 2, 3, 4, 5], start: '08:00', end: '19:00' });
    expect(w.map(([s, e]) => [s.toISOString(), e.toISOString()])).toEqual([
      ['2026-10-16T06:00:00.000Z', '2026-10-16T17:00:00.000Z'],
      ['2026-10-19T06:00:00.000Z', '2026-10-19T17:00:00.000Z'],
    ]);
  });
});

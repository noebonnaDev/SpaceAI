import type { BookingDto } from '@ritrovo/shared';
import { hasRole } from '@ritrovo/shared';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import type { Actor, BookingRow } from '../domain/bookings.js';
import { ValidationError } from '../domain/errors.js';
import type { Settings } from '../domain/settings.js';
import { addLocalDays, startOfLocalDay } from '../domain/time.js';

export const DateRangeQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

/** Resolves ?date=YYYY-MM-DD (local day) or ?from&to into a UTC range. */
export function resolveRange(ctx: AppContext, q: unknown, defaultDays = 1): { from: Date; to: Date } {
  const p = DateRangeQuery.parse(q ?? {});
  const tz = ctx.config.timezone;
  if (p.date) {
    const from = startOfLocalDay(new Date(`${p.date}T12:00:00Z`), tz);
    return { from, to: addLocalDays(from, 1, tz) };
  }
  if (p.from && p.to) {
    if (p.to <= p.from) throw new ValidationError('Intervallo di date non valido.');
    if (p.to.getTime() - p.from.getTime() > 400 * 86_400_000) throw new ValidationError('Intervallo massimo: 400 giorni.');
    return { from: p.from, to: p.to };
  }
  const from = startOfLocalDay(ctx.clock.now(), tz);
  return { from, to: addLocalDays(from, defaultDays, tz) };
}

/**
 * Agenda entries of other people are minimised: times and state only, the organizer's name only for
 * reception/admin (or when the settings allow it on the room panel). Owners see everything.
 */
export function maskedDto(
  ctx: AppContext,
  b: BookingRow,
  settings: Settings,
  viewer: Actor | null,
  opts: { kiosk?: boolean } = {},
): BookingDto {
  const d = ctx.bookings.toDto(b, settings, viewer, opts.kiosk);
  const owner = viewer ? ctx.bookings.isParticipant(viewer, b) : false;
  const staff = viewer ? hasRole(viewer.role, 'reception') : false;
  if (owner || staff) return d;
  const showOrganizer = opts.kiosk ? settings.kioskShowOrganizer : false;
  const showSubject = opts.kiosk ? settings.kioskShowSubject : false;
  return {
    ...d,
    title: showSubject ? d.title : null,
    organizerEmail: null,
    organizerName: showOrganizer ? d.organizerName : null,
    bookedForName: showOrganizer ? d.bookedForName : null,
    bookedForId: null,
    createdById: null,
    onlineMeetingUrl: null,
  };
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { BOOKING_SELECT, type BookingRow } from '../domain/bookings.js';
import { ForbiddenError, NotFoundError } from '../domain/errors.js';
import { getResource, listResources, resourceDto } from '../domain/resources.js';
import { getSettings } from '../domain/settings.js';
import { addLocalDays, startOfLocalDay } from '../domain/time.js';
import { liveState } from './admin.js';
import { maskedDto } from './helpers.js';

/** Room door panels and lobby totems authenticate with a device token (header "Authorization: Kiosk <token>"). */
export async function registerKioskRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const today = () => {
    const from = startOfLocalDay(ctx.clock.now(), ctx.config.timezone);
    return { from, to: addLocalDays(from, 1, ctx.config.timezone) };
  };

  app.get('/api/kiosk/state', async (req) => {
    const device = await ctx.auth.requireKiosk(req);
    const settings = await getSettings(ctx.db);
    const { from, to } = today();
    if (device.kind === 'panel') {
      const r = await getResource(ctx.db, device.resource_id!);
      // Refresh from Exchange at most on demand of the panel (cheap delta round).
      if (r.mailbox_email) ctx.sync.enqueue(r.id);
      const agenda = await ctx.bookings.listForResource(r.id, from, to);
      const state = liveState(ctx, r, agenda, settings, null, true);
      const current = agenda.find((b) => b.id === state.currentBooking?.id) ?? null;
      const checkInCandidate = await ctx.bookings.findCurrentForResource(r.id, null);
      return {
        kind: 'panel',
        deviceName: device.name,
        now: ctx.clock.now().toISOString(),
        resource: resourceDto(r, settings),
        state: state.state,
        current: current ? maskedDto(ctx, current, settings, null, { kiosk: true }) : null,
        checkInCandidate: checkInCandidate ? maskedDto(ctx, checkInCandidate, settings, null, { kiosk: true }) : null,
        agenda: agenda.map((b) => maskedDto(ctx, b, settings, null, { kiosk: true })),
      };
    }
    const resources = (await listResources(ctx.db, { buildingId: device.building_id! })).filter((r) => r.kind === 'room');
    const bookings = resources.length
      ? (
          await ctx.db.query<BookingRow>(
            `${BOOKING_SELECT} where b.resource_id = any($1::uuid[]) and b.start_at < $3 and coalesce(b.effective_end_at, b.end_at) > $2`,
            [resources.map((r) => r.id), from, to],
          )
        ).rows
      : [];
    const desks = (await listResources(ctx.db, { buildingId: device.building_id!, kind: 'desk' })).length;
    const now = ctx.clock.now();
    const desksBusy = Number(
      (
        await ctx.db.query<{ n: number }>(
          `select count(distinct b.resource_id)::int as n from booking b join resource r on r.id = b.resource_id
           where r.kind = 'desk' and r.building_id = $1 and b.status in ('pending','confirmed','completed')
           and b.start_at <= $2 and coalesce(b.effective_end_at, b.end_at) > $2`,
          [device.building_id, now],
        )
      ).rows[0]!.n,
    );
    return {
      kind: 'totem',
      deviceName: device.name,
      now: now.toISOString(),
      rooms: resources.map((r) => {
        const s = liveState(ctx, r, bookings, settings, null, true);
        const strip = (d: typeof s.currentBooking) =>
          d ? { ...d, title: settings.kioskShowSubject ? d.title : null, organizerName: settings.kioskShowOrganizer ? d.organizerName : null, organizerEmail: null } : null;
        return { ...s, currentBooking: strip(s.currentBooking), nextBooking: strip(s.nextBooking), capacity: r.capacity };
      }),
      desks: { total: desks, busy: desksBusy },
    };
  });

  app.post('/api/kiosk/check-in', async (req) => {
    const device = await ctx.auth.requireKiosk(req);
    if (device.kind !== 'panel') throw new ForbiddenError();
    const b = await ctx.bookings.findCurrentForResource(device.resource_id!, null);
    if (!b) throw new NotFoundError('Nessuna prenotazione da confermare in questo momento.');
    await ctx.bookings.checkIn({ kind: 'kiosk', deviceId: device.id, resourceId: device.resource_id, buildingId: null }, b.id);
    return { ok: true };
  });

  app.post('/api/kiosk/check-out', async (req) => {
    const device = await ctx.auth.requireKiosk(req);
    if (device.kind !== 'panel') throw new ForbiddenError();
    const b = await ctx.bookings.findCurrentForResource(device.resource_id!, null);
    if (!b || !b.checked_in_at) throw new NotFoundError('Nessuna riunione in corso con check-in.');
    await ctx.bookings.checkOut({ kind: 'kiosk', deviceId: device.id, resourceId: device.resource_id, buildingId: null }, b.id);
    return { ok: true };
  });

  app.post('/api/kiosk/book-now', async (req, reply) => {
    const device = await ctx.auth.requireKiosk(req);
    if (device.kind !== 'panel') throw new ForbiddenError();
    const { minutes } = z.object({ minutes: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)]) }).parse(req.body);
    const b = await ctx.bookings.kioskBookNow(device.resource_id!, minutes);
    return reply.code(201).send({ id: b.id, start: b.start_at.toISOString(), end: b.end_at.toISOString() });
  });
}

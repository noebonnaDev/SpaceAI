import type { BuildingDto, DeskMapEntry, ResourceDto } from '@ritrovo/shared';
import { hasRole } from '@ritrovo/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { busyIntervals, conflictsIn } from '../domain/availability.js';
import {
  BOOKING_SELECT,
  CreateBookingSchema,
  ProposalSchema,
  RecurringBookingSchema,
  type Actor,
  type BookingRow,
} from '../domain/bookings.js';
import { createRequest, getRequestOwner, listRequests, NewRequestSchema, updateRequest, UpdateRequestSchema } from '../domain/care.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../domain/errors.js';
import { getResource, getResourceByQr, listResources, resourceDto } from '../domain/resources.js';
import { getSettings } from '../domain/settings.js';
import { addLocalDays, localToUtc, startOfLocalDay } from '../domain/time.js';
import { searchLocalUsers, userDto, type UserRow } from '../domain/users.js';
import type { GraphCaller } from '../graph/types.js';
import { maskedDto, resolveRange } from './helpers.js';

const IdParam = z.object({ id: z.string().uuid() });

export async function registerUserRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const caller = (actor: Actor): GraphCaller => ({ kind: 'user', email: actor.user.email, token: actor.token });
  const dtoList = async (rows: BookingRow[], actor: Actor) => {
    const settings = await getSettings(ctx.db);
    return rows.map((b) => ctx.bookings.toDto(b, settings, actor));
  };

  // ---------------------------------------------------------------- profile

  app.get('/api/me', async (req) => {
    const actor = await ctx.auth.require(req);
    return userDto(actor.user, actor.role);
  });

  app.patch('/api/me', async (req) => {
    const actor = await ctx.auth.require(req);
    const body = z.object({ hideFromColleagues: z.boolean() }).parse(req.body);
    const u = (
      await ctx.db.query<UserRow>('update app_user set hide_from_colleagues = $2 where id = $1 returning *', [actor.user.id, body.hideFromColleagues])
    ).rows[0]!;
    return userDto(u, actor.role);
  });

  app.get('/api/users/search', async (req) => {
    const actor = await ctx.auth.require(req);
    const { q } = z.object({ q: z.string().trim().min(2).max(80) }).parse(req.query);
    const local = await searchLocalUsers(ctx.db, q, 10);
    const out = new Map(local.map((u) => [u.email.toLowerCase(), { displayName: u.display_name, email: u.email, department: u.department }]));
    try {
      for (const u of await ctx.graph.searchUsers(caller(actor), q)) {
        if (u.email && !out.has(u.email)) out.set(u.email, { displayName: u.displayName, email: u.email, department: u.department });
      }
    } catch (err) {
      ctx.log.warn({ err: String(err) }, 'Ricerca utenti in Microsoft 365 non riuscita');
    }
    return [...out.values()].slice(0, 15);
  });

  // ---------------------------------------------------------------- buildings, resources, maps

  app.get('/api/buildings', async (req): Promise<BuildingDto[]> => {
    await ctx.auth.require(req);
    const buildings = (await ctx.db.query<any>('select * from building order by name')).rows;
    const floors = (
      await ctx.db.query<any>('select id, building_id, name, sort_order, map_mime is not null as has_map, map_updated_at from floor order by sort_order, name')
    ).rows;
    return buildings.map((b) => ({
      id: b.id,
      name: b.name,
      address: b.address,
      floors: floors
        .filter((f) => f.building_id === b.id)
        .map((f) => ({
          id: f.id,
          buildingId: f.building_id,
          name: f.name,
          sortOrder: f.sort_order,
          hasMap: f.has_map,
          mapVersion: f.map_updated_at ? new Date(f.map_updated_at).getTime().toString(36) : null,
        })),
    }));
  });

  // Floor maps are served without authentication headers so <img> tags can load them; ids are unguessable UUIDs.
  app.get('/api/floors/:id/map', async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const f = (await ctx.db.query<{ map_mime: string | null; map_data: Uint8Array | null }>('select map_mime, map_data from floor where id = $1', [id])).rows[0];
    if (!f?.map_mime || !f.map_data) throw new NotFoundError('Planimetria non disponibile.');
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    reply.header('Cache-Control', 'private, max-age=300');
    return reply.type(f.map_mime).send(Buffer.from(f.map_data));
  });

  const ResourceQuery = z.object({
    kind: z.enum(['room', 'desk', 'asset']).optional(),
    buildingId: z.string().uuid().optional(),
    floorId: z.string().uuid().optional(),
    minCapacity: z.coerce.number().int().min(1).optional(),
    features: z.string().optional(),
    start: z.coerce.date().optional(),
    end: z.coerce.date().optional(),
    onlyAvailable: z.enum(['true', 'false']).optional(),
  });

  app.get('/api/resources', async (req): Promise<ResourceDto[]> => {
    const actor = await ctx.auth.require(req);
    const q = ResourceQuery.parse(req.query);
    const settings = await getSettings(ctx.db);
    const rows = await listResources(ctx.db, {
      kind: q.kind,
      buildingId: q.buildingId,
      floorId: q.floorId,
      minCapacity: q.minCapacity,
      features: q.features ? q.features.split(',').filter(Boolean) : undefined,
    });
    const favs = new Set(
      (await ctx.db.query<{ resource_id: string }>('select resource_id from user_favorite where user_id = $1', [actor.user.id])).rows.map((r) => r.resource_id),
    );
    let available: Map<string, boolean> | null = null;
    if (q.start && q.end) {
      if (q.end <= q.start) throw new ValidationError("L'orario di fine deve essere successivo all'inizio.");
      const busy = await busyIntervals(ctx.db, ctx.graph, rows, q.start, q.end, caller(actor));
      available = new Map(rows.map((r) => [r.id, conflictsIn(busy.get(r.id)!, q.start!, q.end!).length === 0]));
    }
    const out = rows.map((r) =>
      resourceDto(r, settings, { isFavorite: favs.has(r.id), ...(available ? { available: available.get(r.id) } : {}) }),
    );
    return q.onlyAvailable === 'true' ? out.filter((r) => r.available !== false) : out;
  });

  app.get('/api/resources/:id', async (req) => {
    const actor = await ctx.auth.require(req);
    const { id } = IdParam.parse(req.params);
    const r = await getResource(ctx.db, id);
    const settings = await getSettings(ctx.db);
    const { from, to } = resolveRange(ctx, req.query);
    const agenda = await ctx.bookings.listForResource(r.id, from, to);
    return {
      resource: resourceDto(r, settings),
      agenda: agenda.map((b) => maskedDto(ctx, b, settings, actor)),
    };
  });

  app.get('/api/floors/:id/desks', async (req): Promise<DeskMapEntry[]> => {
    const actor = await ctx.auth.require(req);
    const { id } = IdParam.parse(req.params);
    const q = z.object({ start: z.coerce.date(), end: z.coerce.date() }).parse(req.query);
    const settings = await getSettings(ctx.db);
    const desks = (await listResources(ctx.db, { floorId: id })).filter((r) => r.kind === 'desk' || r.map_x !== null);
    const favs = new Set(
      (await ctx.db.query<{ resource_id: string }>('select resource_id from user_favorite where user_id = $1', [actor.user.id])).rows.map((r) => r.resource_id),
    );
    const bookings = desks.length
      ? (
          await ctx.db.query<BookingRow & { hide: boolean }>(
            `${BOOKING_SELECT.replace('from booking b', ', bf.hide_from_colleagues as hide from booking b')}
             where b.resource_id = any($1::uuid[]) and b.status in ('pending','confirmed','tentative','completed')
             and b.start_at < $3 and coalesce(b.effective_end_at, b.end_at) > $2`,
            [desks.map((d) => d.id), q.start, q.end],
          )
        ).rows
      : [];
    const busy = await busyIntervals(ctx.db, ctx.graph, desks.filter((d) => d.mailbox_email), q.start, q.end, caller(actor));
    return desks.map((d) => {
      const b = bookings.find((x) => x.resource_id === d.id);
      const exchangeBusy = (busy.get(d.id) ?? []).some((s) => s.source === 'exchange');
      const mine = b ? ctx.bookings.isParticipant(actor, b) : false;
      const showName = b && settings.showOccupantNames && !b.hide;
      return {
        resource: resourceDto(d, settings, { isFavorite: favs.has(d.id) }),
        state: mine ? 'mine' : b || exchangeBusy ? 'booked' : 'free',
        occupantName: b ? (mine || showName ? b.booked_for_name ?? b.organizer_name : null) : null,
        bookingId: mine && b ? b.id : null,
      };
    });
  });

  app.get('/api/colleagues', async (req) => {
    await ctx.auth.require(req);
    const settings = await getSettings(ctx.db);
    if (!settings.showOccupantNames) return [];
    const p = z.object({ q: z.string().trim().min(2).max(80), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
    const from = startOfLocalDay(new Date(`${p.date}T12:00:00Z`), ctx.config.timezone);
    const to = addLocalDays(from, 1, ctx.config.timezone);
    const like = `%${p.q.toLowerCase()}%`;
    const rows = (
      await ctx.db.query<any>(
        `select u.id as user_id, u.display_name, r.id as resource_id, r.name as resource_name, r.floor_id, f.name as floor_name,
           b.start_at, b.end_at
         from booking b join resource r on r.id = b.resource_id join app_user u on u.id = b.booked_for_id
         left join floor f on f.id = r.floor_id
         where r.kind = 'desk' and not u.hide_from_colleagues and b.status in ('pending','confirmed','completed')
           and b.start_at < $2 and b.end_at > $1 and (lower(u.display_name) like $3 or lower(u.email) like $3)
         order by u.display_name, b.start_at limit 30`,
        [from, to, like],
      )
    ).rows;
    return rows.map((r) => ({
      userId: r.user_id,
      displayName: r.display_name,
      resourceId: r.resource_id,
      resourceName: r.resource_name,
      floorId: r.floor_id,
      floorName: r.floor_name,
      start: new Date(r.start_at).toISOString(),
      end: new Date(r.end_at).toISOString(),
    }));
  });

  app.put('/api/favorites/:id', async (req) => {
    const actor = await ctx.auth.require(req);
    const { id } = IdParam.parse(req.params);
    await getResource(ctx.db, id);
    await ctx.db.query('insert into user_favorite(user_id, resource_id) values ($1, $2) on conflict do nothing', [actor.user.id, id]);
    return { ok: true };
  });

  app.delete('/api/favorites/:id', async (req) => {
    const actor = await ctx.auth.require(req);
    const { id } = IdParam.parse(req.params);
    await ctx.db.query('delete from user_favorite where user_id = $1 and resource_id = $2', [actor.user.id, id]);
    return { ok: true };
  });

  // ---------------------------------------------------------------- bookings

  app.get('/api/bookings/mine', async (req) => {
    const actor = await ctx.auth.require(req);
    const { from, to } = resolveRange(ctx, req.query, 30);
    return dtoList(await ctx.bookings.listForUser(actor, from, to), actor);
  });

  app.get('/api/bookings/:id', async (req) => {
    const actor = await ctx.auth.require(req);
    const { id } = IdParam.parse(req.params);
    const b = await ctx.bookings.getBooking(id);
    const settings = await getSettings(ctx.db);
    return maskedDto(ctx, b, settings, actor);
  });

  app.post('/api/bookings', async (req, reply) => {
    const actor = await ctx.auth.require(req);
    const input = CreateBookingSchema.parse(req.body);
    if (input.source === 'reception' && !hasRole(actor.role, 'reception')) throw new ForbiddenError();
    const b = await ctx.bookings.createBooking(actor, input);
    const settings = await getSettings(ctx.db);
    return reply.code(201).send(ctx.bookings.toDto(b, settings, actor));
  });

  app.post('/api/bookings/multi-day', async (req, reply) => {
    const actor = await ctx.auth.require(req);
    const input = z
      .object({
        resourceId: z.string().uuid(),
        dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(31),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        endTime: z.string().regex(/^\d{2}:\d{2}$/),
        title: z.string().trim().max(200).optional(),
        source: z.enum(['web', 'addin']).default('web'),
      })
      .parse(req.body);
    const result = await ctx.bookings.createMultiDay(actor, input, (d, t) => localToUtc(d, t, ctx.config.timezone));
    return reply.code(result.created.length ? 201 : 409).send({
      created: await dtoList(result.created, actor),
      failed: result.failed,
    });
  });

  app.post('/api/bookings/recurring', async (req, reply) => {
    const actor = await ctx.auth.require(req);
    const input = RecurringBookingSchema.parse(req.body);
    const r = await ctx.bookings.createRecurring(actor, input);
    return reply.code(201).send({
      seriesId: r.seriesId,
      bookings: await dtoList(r.bookings, actor),
      skipped: r.skipped.map((o) => ({ start: o.start.toISOString(), end: o.end.toISOString() })),
      alternatives: await dtoList(r.alternatives, actor),
      failedAlternatives: r.failedAlternatives,
    });
  });

  app.post('/api/bookings/:id/cancel', async (req) => {
    const actor = await ctx.auth.require(req);
    const { id } = IdParam.parse(req.params);
    const b = await ctx.bookings.cancelBooking({ kind: 'user', actor }, id);
    return ctx.bookings.toDto(b, await getSettings(ctx.db), actor);
  });

  app.post('/api/series/:id/cancel', async (req) => {
    const actor = await ctx.auth.require(req);
    const { id } = IdParam.parse(req.params);
    const rows = (
      await ctx.db.query<{ id: string }>(
        `select id from booking where series_id = $1 and status in ('pending','confirmed','tentative') and checked_in_at is null and start_at > $2`,
        [id, ctx.clock.now()],
      )
    ).rows;
    let cancelled = 0;
    for (const r of rows) {
      await ctx.bookings.cancelBooking({ kind: 'user', actor }, r.id, 'Serie annullata.');
      cancelled++;
    }
    return { cancelled };
  });

  app.post('/api/bookings/:id/check-in', async (req) => {
    const actor = await ctx.auth.require(req);
    const { id } = IdParam.parse(req.params);
    const b = await ctx.bookings.checkIn({ kind: 'user', actor }, id);
    return ctx.bookings.toDto(b, await getSettings(ctx.db), actor);
  });

  app.post('/api/bookings/:id/check-out', async (req) => {
    const actor = await ctx.auth.require(req);
    const { id } = IdParam.parse(req.params);
    const b = await ctx.bookings.checkOut({ kind: 'user', actor }, id);
    return ctx.bookings.toDto(b, await getSettings(ctx.db), actor);
  });

  // ---------------------------------------------------------------- proposals

  app.post('/api/proposals', async (req, reply) => {
    const actor = await ctx.auth.require(req);
    const input = ProposalSchema.parse(req.body);
    return reply.code(201).send(await ctx.bookings.createProposal(actor, input));
  });

  app.get('/api/proposals/mine', async (req) => {
    const actor = await ctx.auth.require(req);
    return ctx.bookings.listProposals(actor);
  });

  app.post('/api/proposals/:id/confirm', async (req) => {
    const actor = await ctx.auth.require(req);
    const { id } = IdParam.parse(req.params);
    const { bookingId } = z.object({ bookingId: z.string().uuid() }).parse(req.body);
    return ctx.bookings.confirmProposal(actor, id, bookingId);
  });

  app.post('/api/proposals/:id/cancel', async (req) => {
    const actor = await ctx.auth.require(req);
    const { id } = IdParam.parse(req.params);
    return ctx.bookings.cancelProposal(actor, id);
  });

  // ---------------------------------------------------------------- QR codes (and NFC tags with the same URL)

  const QrParam = z.object({ token: z.string().min(10).max(64) });

  app.get('/api/qr/:token', async (req) => {
    const actor = await ctx.auth.require(req);
    const { token } = QrParam.parse(req.params);
    const r = await getResourceByQr(ctx.db, token);
    const settings = await getSettings(ctx.db);
    const { from, to } = resolveRange(ctx, {});
    const agenda = await ctx.bookings.listForResource(r.id, from, to);
    const mine = await ctx.bookings.findCurrentForResource(r.id, actor.user.id);
    const now = ctx.clock.now();
    const occupiedNow = agenda.some((b) => b.start_at <= now && (b.effective_end_at ?? b.end_at) > now);
    return {
      resource: resourceDto(r, settings),
      agenda: agenda.map((b) => maskedDto(ctx, b, settings, actor)),
      myBooking: mine ? ctx.bookings.toDto(mine, settings, actor) : null,
      freeNow: !occupiedNow,
    };
  });

  app.post('/api/qr/:token/book', async (req, reply) => {
    const actor = await ctx.auth.require(req);
    const { token } = QrParam.parse(req.params);
    const body = z.object({ durationMinutes: z.number().int().min(15).max(1440), title: z.string().trim().max(200).optional() }).parse(req.body);
    const b = await ctx.bookings.quickBookByQr(actor, token, body.durationMinutes, body.title);
    return reply.code(201).send(ctx.bookings.toDto(b, await getSettings(ctx.db), actor));
  });

  app.post('/api/qr/:token/check-in', async (req) => {
    const actor = await ctx.auth.require(req);
    const { token } = QrParam.parse(req.params);
    const r = await getResourceByQr(ctx.db, token);
    const mine = await ctx.bookings.findCurrentForResource(r.id, actor.user.id);
    if (!mine) throw new NotFoundError('Nessuna tua prenotazione da confermare qui in questo momento.');
    const b = await ctx.bookings.checkIn({ kind: 'user', actor }, mine.id);
    return ctx.bookings.toDto(b, await getSettings(ctx.db), actor);
  });

  app.post('/api/qr/:token/check-out', async (req) => {
    const actor = await ctx.auth.require(req);
    const { token } = QrParam.parse(req.params);
    const r = await getResourceByQr(ctx.db, token);
    const mine = await ctx.bookings.findCurrentForResource(r.id, actor.user.id);
    if (!mine || !mine.checked_in_at) throw new NotFoundError('Nessuna tua prenotazione in corso qui.');
    const b = await ctx.bookings.checkOut({ kind: 'user', actor }, mine.id);
    return ctx.bookings.toDto(b, await getSettings(ctx.db), actor);
  });

  // ---------------------------------------------------------------- reception

  app.get('/api/reception/bookings', async (req) => {
    const actor = await ctx.auth.require(req, 'reception');
    const { from, to } = resolveRange(ctx, req.query);
    const rows = (
      await ctx.db.query<BookingRow>(
        `${BOOKING_SELECT} where b.start_at < $2 and coalesce(b.effective_end_at, b.end_at) > $1 order by b.start_at, r.name`,
        [from, to],
      )
    ).rows;
    return dtoList(rows, actor);
  });

  // ---------------------------------------------------------------- facility requests (Care)

  app.post('/api/requests', async (req, reply) => {
    const actor = await ctx.auth.require(req);
    const input = NewRequestSchema.parse(req.body);
    return reply.code(201).send(await createRequest(ctx.db, actor.user.id, input));
  });

  app.get('/api/requests/mine', async (req) => {
    const actor = await ctx.auth.require(req);
    return listRequests(ctx.db, { requesterId: actor.user.id });
  });

  app.get('/api/requests', async (req) => {
    await ctx.auth.require(req, 'reception');
    const { status } = z.object({ status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional() }).parse(req.query);
    return listRequests(ctx.db, { status });
  });

  app.patch('/api/requests/:id', async (req) => {
    const actor = await ctx.auth.require(req);
    const { id } = IdParam.parse(req.params);
    const patch = UpdateRequestSchema.parse(req.body);
    if (!hasRole(actor.role, 'reception')) {
      // The requester may only close their own request.
      const owner = await getRequestOwner(ctx.db, id);
      if (owner !== actor.user.id || patch.status !== 'closed' || patch.assigneeId !== undefined) throw new ForbiddenError();
    }
    return updateRequest(ctx.db, id, patch);
  });
}

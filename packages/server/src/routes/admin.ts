import type { LiveResourceState } from '@ritrovo/shared';
import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import { audit } from '../domain/audit.js';
import { BOOKING_SELECT, type Actor, type BookingRow } from '../domain/bookings.js';
import { ValidationError, NotFoundError } from '../domain/errors.js';
import { createKiosk, listKiosks, NewKioskSchema, revokeKiosk } from '../domain/kiosk.js';
import { computeKpi, kpiToCsv } from '../domain/kpi.js';
import {
  createResource,
  exchangePowerShell,
  getResource,
  listResources,
  regenerateQr,
  resourceDto,
  ResourceInputSchema,
  updateResource,
  type ResourceRow,
} from '../domain/resources.js';
import { getSettings, SettingsSchema, updateSettings, type Settings } from '../domain/settings.js';
import { addLocalDays, localToUtc, startOfLocalDay } from '../domain/time.js';
import { userDto, type UserRow } from '../domain/users.js';
import { resolveRange } from './helpers.js';

const IdParam = z.object({ id: z.string().uuid() });
const MAP_MIME = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'];

export function liveState(ctx: AppContext, r: ResourceRow, bookings: BookingRow[], settings: Settings, viewer: Actor | null, kiosk = false): LiveResourceState {
  const now = ctx.clock.now();
  const mine = bookings.filter((b) => b.resource_id === r.id && ['pending', 'confirmed', 'completed', 'tentative'].includes(b.status));
  const current = mine.find((b) => b.start_at <= now && (b.effective_end_at ?? b.end_at) > now) ?? null;
  const next = mine.filter((b) => b.start_at > now).sort((a, b) => a.start_at.getTime() - b.start_at.getTime())[0] ?? null;
  let state: LiveResourceState['state'] = 'free';
  if (current) state = current.checked_in_at ? 'occupied' : r.check_in_required ? 'awaiting_check_in' : 'booked';
  const dto = (b: BookingRow | null) => (b ? ctx.bookings.toDto(b, settings, viewer, kiosk) : null);
  return {
    resourceId: r.id,
    resourceName: r.name,
    kind: r.kind,
    floorName: r.floor_name ?? null,
    state,
    currentBooking: dto(current),
    nextBooking: dto(next),
  };
}

export async function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const admin = (req: any) => ctx.auth.require(req, 'amministratore');
  const actorRef = (a: Actor) => ({ id: a.user.id, label: a.user.email });

  // ---------------------------------------------------------------- resources

  app.get('/api/admin/resources', async (req) => {
    await admin(req);
    const settings = await getSettings(ctx.db);
    const rows = await listResources(ctx.db, { includeInactive: true });
    return rows.map((r) => ({ ...resourceDto(r, settings), qrUrl: `${ctx.config.publicBaseUrl}/q/${r.qr_token}`, powershell: exchangePowerShell(r) }));
  });

  app.post('/api/admin/resources', async (req, reply) => {
    const actor = await admin(req);
    const input = ResourceInputSchema.parse(req.body);
    const r = await createResource(ctx.db, input);
    await audit(ctx.db, actorRef(actor), 'resource.create', 'resource', r.id, { name: r.name });
    if (r.mailbox_email) void ctx.sync.ensureSubscriptions().then(() => ctx.sync.enqueue(r.id));
    return reply.code(201).send(resourceDto(r, await getSettings(ctx.db)));
  });

  app.patch('/api/admin/resources/:id', async (req) => {
    const actor = await admin(req);
    const { id } = IdParam.parse(req.params);
    const patch = ResourceInputSchema.partial().parse(req.body);
    const r = await updateResource(ctx.db, id, patch);
    await audit(ctx.db, actorRef(actor), 'resource.update', 'resource', id, { fields: Object.keys(patch) });
    return resourceDto(r, await getSettings(ctx.db));
  });

  app.post('/api/admin/resources/:id/regenerate-qr', async (req) => {
    const actor = await admin(req);
    const { id } = IdParam.parse(req.params);
    const r = await regenerateQr(ctx.db, id);
    await audit(ctx.db, actorRef(actor), 'resource.qr', 'resource', id);
    return { qrUrl: `${ctx.config.publicBaseUrl}/q/${r.qr_token}` };
  });

  app.get('/api/admin/resources/:id/qr.svg', async (req, reply) => {
    await admin(req);
    const { id } = IdParam.parse(req.params);
    const r = await getResource(ctx.db, id);
    const svg = await QRCode.toString(`${ctx.config.publicBaseUrl}/q/${r.qr_token}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return reply.type('image/svg+xml').send(svg);
  });

  app.post('/api/admin/import/places', async (req) => {
    const actor = await admin(req);
    const places = await ctx.graph.listPlaces({ kind: 'user', email: actor.user.email, token: actor.token }, 'room');
    let created = 0;
    let skipped = 0;
    for (const p of places) {
      if (!p.emailAddress) continue;
      const exists = (await ctx.db.query('select 1 from resource where lower(mailbox_email) = lower($1)', [p.emailAddress])).rows.length;
      if (exists) {
        skipped++;
        continue;
      }
      const features: string[] = [];
      if (p.hasVideo) features.push('videoconferenza');
      if (p.hasDisplay) features.push('schermo');
      if (p.isWheelChairAccessible) features.push('accessibile');
      await createResource(ctx.db, ResourceInputSchema.parse({
        kind: 'room',
        name: p.displayName,
        mailboxEmail: p.emailAddress,
        capacity: p.capacity && p.capacity > 0 ? p.capacity : 4,
        features,
        description: [p.building, p.floorLabel].filter(Boolean).join(' – ') || null,
      }));
      created++;
    }
    await audit(ctx.db, actorRef(actor), 'resource.import', 'resource', null, { created, skipped });
    if (created) void ctx.sync.ensureSubscriptions().then(() => ctx.sync.syncAll());
    return { found: places.length, created, skipped };
  });

  // ---------------------------------------------------------------- buildings and floors

  app.post('/api/admin/buildings', async (req, reply) => {
    const actor = await admin(req);
    const b = z.object({ name: z.string().trim().min(1).max(120), address: z.string().trim().max(300).optional() }).parse(req.body);
    const row = (await ctx.db.query('insert into building(name, address) values ($1, $2) returning *', [b.name, b.address ?? null])).rows[0];
    await audit(ctx.db, actorRef(actor), 'building.create', 'building', row.id);
    return reply.code(201).send(row);
  });

  app.patch('/api/admin/buildings/:id', async (req) => {
    await admin(req);
    const { id } = IdParam.parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(120), address: z.string().trim().max(300).nullish() }).parse(req.body);
    const row = (await ctx.db.query('update building set name = $2, address = $3 where id = $1 returning *', [id, b.name, b.address ?? null])).rows[0];
    if (!row) throw new NotFoundError();
    return row;
  });

  app.post('/api/admin/floors', async (req, reply) => {
    const actor = await admin(req);
    const f = z.object({ buildingId: z.string().uuid(), name: z.string().trim().min(1).max(120), sortOrder: z.number().int().default(0) }).parse(req.body);
    const row = (
      await ctx.db.query('insert into floor(building_id, name, sort_order) values ($1, $2, $3) returning id, building_id, name, sort_order', [
        f.buildingId,
        f.name,
        f.sortOrder,
      ])
    ).rows[0];
    await audit(ctx.db, actorRef(actor), 'floor.create', 'floor', row.id);
    return reply.code(201).send(row);
  });

  app.put('/api/admin/floors/:id/map', async (req) => {
    const actor = await admin(req);
    const { id } = IdParam.parse(req.params);
    const body = z.object({ mime: z.string(), dataBase64: z.string().min(10) }).parse(req.body);
    if (!MAP_MIME.includes(body.mime)) throw new ValidationError('Formato non supportato: usa SVG, PNG, JPEG o WebP.');
    const data = Buffer.from(body.dataBase64, 'base64');
    if (data.length > 2 * 1024 * 1024) throw new ValidationError('La planimetria non può superare 2 MB.');
    const res = await ctx.db.query('update floor set map_mime = $2, map_data = $3, map_updated_at = now() where id = $1', [id, body.mime, data]);
    if (res.rowCount === 0) throw new NotFoundError('Piano non trovato.');
    await audit(ctx.db, actorRef(actor), 'floor.map', 'floor', id, { bytes: data.length });
    return { ok: true };
  });

  // ---------------------------------------------------------------- users and roles

  app.get('/api/admin/users', async (req) => {
    await admin(req);
    const rows = (await ctx.db.query<UserRow>('select * from app_user order by display_name')).rows;
    return rows.map((u) => ({ ...userDto(u), isActive: u.is_active, lastLoginAt: u.last_login_at?.toISOString() ?? null }));
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const actor = await admin(req);
    const { id } = IdParam.parse(req.params);
    const body = z.object({ role: z.enum(['utente', 'reception', 'amministratore']).optional(), isActive: z.boolean().optional() }).parse(req.body);
    if (id === actor.user.id && (body.role && body.role !== 'amministratore' || body.isActive === false)) {
      throw new ValidationError('Non puoi togliere a te stesso il ruolo di amministratore.');
    }
    const row = (
      await ctx.db.query<UserRow>(
        'update app_user set role = coalesce($2, role), is_active = coalesce($3, is_active) where id = $1 returning *',
        [id, body.role ?? null, body.isActive ?? null],
      )
    ).rows[0];
    if (!row) throw new NotFoundError('Utente non trovato.');
    await audit(ctx.db, actorRef(actor), 'user.update', 'app_user', id, body);
    return userDto(row);
  });

  // ---------------------------------------------------------------- settings

  app.get('/api/admin/settings', async (req) => {
    await admin(req);
    return getSettings(ctx.db);
  });

  app.put('/api/admin/settings', async (req) => {
    const actor = await admin(req);
    const patch = SettingsSchema.partial().parse(req.body);
    const s = await updateSettings(ctx.db, patch);
    await audit(ctx.db, actorRef(actor), 'settings.update', 'setting', null, { keys: Object.keys(patch) });
    return s;
  });

  // ---------------------------------------------------------------- kiosks (room panels and totems)

  app.get('/api/admin/kiosks', async (req) => {
    await admin(req);
    return (await listKiosks(ctx.db)).map((k) => ({
      id: k.id,
      name: k.name,
      kind: k.kind,
      resourceId: k.resource_id,
      resourceName: k.resource_name,
      buildingId: k.building_id,
      buildingName: k.building_name,
      createdAt: k.created_at.toISOString(),
      lastSeenAt: k.last_seen_at?.toISOString() ?? null,
      revokedAt: k.revoked_at?.toISOString() ?? null,
    }));
  });

  app.post('/api/admin/kiosks', async (req, reply) => {
    const actor = await admin(req);
    const input = NewKioskSchema.parse(req.body);
    const { device, token } = await createKiosk(ctx.db, actor.user.id, input);
    await audit(ctx.db, actorRef(actor), 'kiosk.create', 'kiosk_device', device.id, { kind: device.kind });
    const page = device.kind === 'panel' ? 'pannello' : 'totem';
    // The token travels in the URL fragment, which browsers never send to the server.
    return reply.code(201).send({ id: device.id, pairingUrl: `${ctx.config.publicBaseUrl}/${page}#t=${token}` });
  });

  app.post('/api/admin/kiosks/:id/revoke', async (req) => {
    const actor = await admin(req);
    const { id } = IdParam.parse(req.params);
    await revokeKiosk(ctx.db, id);
    await audit(ctx.db, actorRef(actor), 'kiosk.revoke', 'kiosk_device', id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- KPI and live state

  const KpiQuery = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    kind: z.enum(['room', 'desk', 'asset']).optional(),
    resourceId: z.string().uuid().optional(),
  });

  const kpi = async (query: unknown) => {
    const q = KpiQuery.parse(query);
    const tz = ctx.config.timezone;
    const from = localToUtc(q.from, '00:00', tz);
    const to = addLocalDays(localToUtc(q.to, '00:00', tz), 1, tz);
    if (to <= from) throw new ValidationError('Intervallo di date non valido.');
    if (to.getTime() - from.getTime() > 400 * 86_400_000) throw new ValidationError('Intervallo massimo: 400 giorni.');
    const settings = await getSettings(ctx.db);
    return computeKpi(ctx.db, { from, to, kind: q.kind ?? null, resourceId: q.resourceId ?? null, now: ctx.clock.now() }, settings, tz);
  };

  app.get('/api/admin/kpi', async (req) => {
    await admin(req);
    return kpi(req.query);
  });

  app.get('/api/admin/kpi.csv', async (req, reply) => {
    await admin(req);
    const report = await kpi(req.query);
    const q = KpiQuery.parse(req.query);
    reply.header('Content-Disposition', `attachment; filename="ritrovo-kpi-${q.from}_${q.to}.csv"`);
    return reply.type('text/csv; charset=utf-8').send(kpiToCsv(report, ctx.config.timezone));
  });

  app.get('/api/admin/live', async (req) => {
    const actor = await admin(req);
    const settings = await getSettings(ctx.db);
    const now = ctx.clock.now();
    const from = startOfLocalDay(now, ctx.config.timezone);
    const to = addLocalDays(from, 1, ctx.config.timezone);
    const resources = await listResources(ctx.db);
    const bookings = (
      await ctx.db.query<BookingRow>(`${BOOKING_SELECT} where b.start_at < $2 and coalesce(b.effective_end_at, b.end_at) > $1`, [from, to])
    ).rows;
    const states = resources.map((r) => liveState(ctx, r, bookings, settings, actor));
    const today = bookings.filter((b) => b.start_at >= from);
    return {
      states,
      today: {
        bookings: today.filter((b) => !['cancelled', 'declined'].includes(b.status) && !b.proposal_id).length,
        checkedIn: today.filter((b) => b.checked_in_at).length,
        noShows: today.filter((b) => b.release_reason === 'no_show').length,
        openRequests: Number(
          (await ctx.db.query<{ n: number }>("select count(*)::int as n from facility_request where status in ('open','in_progress')")).rows[0]!.n,
        ),
      },
    };
  });

  // ---------------------------------------------------------------- Microsoft Graph sync

  app.get('/api/admin/sync', async (req) => {
    await admin(req);
    const rows = (
      await ctx.db.query<any>(
        `select r.id, r.name, r.mailbox_email, s.last_sync_at, s.last_error, gs.expires_at as subscription_expires_at
         from resource r left join sync_state s on s.resource_id = r.id
         left join lateral (select expires_at from graph_subscription g where g.resource_id = r.id order by expires_at desc limit 1) gs on true
         where r.mailbox_email is not null and r.is_active order by r.name`,
      )
    ).rows;
    return {
      graphMode: ctx.graph.mode,
      webhooksEnabled: ctx.config.webhooksEnabled,
      deltaIntervalSeconds: ctx.config.deltaIntervalSeconds,
      resources: rows.map((r) => ({
        resourceId: r.id,
        name: r.name,
        mailbox: r.mailbox_email,
        lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : null,
        lastError: r.last_error,
        subscriptionExpiresAt: r.subscription_expires_at ? new Date(r.subscription_expires_at).toISOString() : null,
      })),
    };
  });

  app.post('/api/admin/sync/run', async (req) => {
    const actor = await admin(req);
    const subs = await ctx.sync.ensureSubscriptions();
    const reports = await ctx.sync.syncAll();
    await audit(ctx.db, actorRef(actor), 'sync.run', null, null, { resources: reports.length });
    return { subscriptions: subs, reports };
  });

  app.get('/api/admin/audit', async (req) => {
    await admin(req);
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return (await ctx.db.query('select id, at, actor_label, action, entity, entity_id, details from audit_log order by at desc limit $1', [limit])).rows;
  });

  app.get('/api/admin/bookings', async (req) => {
    const actor = await admin(req);
    const { from, to } = resolveRange(ctx, req.query, 7);
    const settings = await getSettings(ctx.db);
    const rows = (
      await ctx.db.query<BookingRow>(`${BOOKING_SELECT} where b.start_at < $2 and b.end_at > $1 order by b.start_at`, [from, to])
    ).rows;
    return rows.map((b) => ctx.bookings.toDto(b, settings, actor));
  });
}

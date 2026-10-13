import { DateTime } from 'luxon';
import type { Db, Queryable } from '../db/db.js';
import type { Actor, BookingService } from '../domain/bookings.js';
import { newQrToken } from '../domain/resources.js';
import type { UserRow } from '../domain/users.js';
import type { FakeExchange } from '../graph/mock.js';
import { floorPlanSvg, PLAN_H, PLAN_W, type PlanRoom } from './floorplan.js';

/** Demo e-mail domain: ".example" is reserved (RFC 2606) and never reaches a real tenant. */
export const DEMO_DOMAIN = 'ufficio.example';

export const DEMO_USERS: Array<{ email: string; name: string; role: UserRow['role']; department: string }> = [
  { email: `giulia.rinaldi@${DEMO_DOMAIN}`, name: 'Giulia Rinaldi', role: 'amministratore', department: 'IT' },
  { email: `paolo.ferri@${DEMO_DOMAIN}`, name: 'Paolo Ferri', role: 'reception', department: 'Servizi generali' },
  { email: `marco.esposito@${DEMO_DOMAIN}`, name: 'Marco Esposito', role: 'utente', department: 'Commerciale' },
  { email: `sara.colombo@${DEMO_DOMAIN}`, name: 'Sara Colombo', role: 'utente', department: 'Marketing' },
  { email: `luca.bianchi@${DEMO_DOMAIN}`, name: 'Luca Bianchi', role: 'utente', department: 'Amministrazione' },
  { email: `elena.ricci@${DEMO_DOMAIN}`, name: 'Elena Ricci', role: 'utente', department: 'Risorse umane' },
  { email: `davide.gallo@${DEMO_DOMAIN}`, name: 'Davide Gallo', role: 'utente', department: 'Commerciale' },
  { email: `chiara.moretti@${DEMO_DOMAIN}`, name: 'Chiara Moretti', role: 'utente', department: 'Progetti' },
];

interface SeedResource {
  key: string;
  kind: 'room' | 'desk' | 'asset';
  name: string;
  floor: 0 | 1 | null;
  capacity: number;
  features: string[];
  mailbox?: string;
  category?: string;
  description?: string;
  mapX?: number;
  mapY?: number;
  checkInRequired: boolean;
  grace?: number;
  maxDuration: number;
  windowDays: number;
}

const ROOMS_F0: PlanRoom[] = [
  { label: 'Sala Volta', x: 30, y: 70, w: 300, h: 220 },
  { label: 'Sala Fermi', x: 30, y: 330, w: 220, h: 230 },
];
const ROOMS_F1: PlanRoom[] = [
  { label: 'Sala Montalcini', x: 680, y: 70, w: 290, h: 260 },
  { label: 'Sala Galilei', x: 680, y: 370, w: 290, h: 190 },
];
const center = (r: PlanRoom) => ({ mapX: (r.x + r.w / 2) / PLAN_W, mapY: (r.y + r.h / 2) / PLAN_H });

function deskGridF0(): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const y of [0.32, 0.58]) for (const x of [0.46, 0.58, 0.7, 0.82]) out.push({ x, y });
  return out;
}

function deskGridF1(): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (const y of [0.25, 0.5, 0.75]) for (const x of [0.1, 0.22, 0.38, 0.5]) out.push({ x, y });
  return out;
}

export function demoResources(): SeedResource[] {
  const list: SeedResource[] = [
    { key: 'volta', kind: 'room', name: 'Sala Volta', floor: 0, capacity: 8, features: ['videoconferenza', 'schermo', 'lavagna'], mailbox: `sala.volta@${DEMO_DOMAIN}`, ...center(ROOMS_F0[0]!), checkInRequired: true, maxDuration: 480, windowDays: 180 },
    { key: 'fermi', kind: 'room', name: 'Sala Fermi', floor: 0, capacity: 4, features: ['schermo'], mailbox: `sala.fermi@${DEMO_DOMAIN}`, ...center(ROOMS_F0[1]!), checkInRequired: true, maxDuration: 480, windowDays: 180 },
    { key: 'montalcini', kind: 'room', name: 'Sala Montalcini', floor: 1, capacity: 12, features: ['videoconferenza', 'proiettore', 'accessibile'], mailbox: `sala.montalcini@${DEMO_DOMAIN}`, ...center(ROOMS_F1[0]!), checkInRequired: true, maxDuration: 480, windowDays: 180 },
    { key: 'galilei', kind: 'room', name: 'Sala Galilei', floor: 1, capacity: 6, features: ['videoconferenza', 'lavagna'], mailbox: `sala.galilei@${DEMO_DOMAIN}`, ...center(ROOMS_F1[1]!), checkInRequired: true, maxDuration: 480, windowDays: 180 },
  ];
  deskGridF0().forEach((p, i) =>
    list.push({
      key: `p0-${i + 1}`,
      kind: 'desk',
      name: `P0-${String(i + 1).padStart(2, '0')}`,
      floor: 0,
      capacity: 1,
      features: i % 2 === 0 ? ['monitor', 'docking'] : ['monitor'],
      mapX: p.x,
      mapY: p.y,
      checkInRequired: true,
      grace: 60,
      maxDuration: 720,
      windowDays: 30,
    }),
  );
  deskGridF1().forEach((p, i) =>
    list.push({
      key: `p1-${i + 1}`,
      kind: 'desk',
      name: `P1-${String(i + 1).padStart(2, '0')}`,
      floor: 1,
      capacity: 1,
      features: i % 3 === 0 ? ['monitor', 'docking', 'scrivania_regolabile'] : i % 3 === 1 ? ['monitor', 'finestra'] : ['monitor'],
      mapX: p.x,
      mapY: p.y,
      checkInRequired: true,
      grace: 60,
      maxDuration: 720,
      windowDays: 30,
    }),
  );
  list.push(
    { key: 'auto1', kind: 'asset', name: 'Auto aziendale 1', floor: null, capacity: 5, features: [], category: 'veicolo', mailbox: `auto1@${DEMO_DOMAIN}`, description: 'Chiavi alla reception. Check-in = ritiro chiavi, check-out = riconsegna.', checkInRequired: true, grace: 30, maxDuration: 4320, windowDays: 90 },
    { key: 'proiettore', kind: 'asset', name: 'Proiettore portatile', floor: null, capacity: 1, features: [], category: 'proiettore', mailbox: `proiettore@${DEMO_DOMAIN}`, description: 'Armadio della reception.', checkInRequired: false, maxDuration: 1440, windowDays: 90 },
    { key: 'kitvideo', kind: 'asset', name: 'Kit videoconferenza mobile', floor: null, capacity: 1, features: ['videoconferenza'], category: 'videoconferenza', mailbox: `kit.video@${DEMO_DOMAIN}`, description: 'Telecamera, microfono e cavi.', checkInRequired: false, maxDuration: 1440, windowDays: 90 },
  );
  return list;
}

export interface SeedIds {
  users: Record<string, UserRow>;
  resources: Record<string, string>;
  buildingId: string;
  floors: [string, string];
}

/** Base data: users, building, floors with plans, resources. Idempotent: does nothing when users exist. */
export async function seedBase(db: Db): Promise<SeedIds> {
  const existing = (await db.query<{ n: number }>('select count(*)::int as n from app_user')).rows[0]!.n;
  if (existing > 0) return loadSeedIds(db);
  return db.tx(async (q) => {
    for (const u of DEMO_USERS) {
      await q.query('insert into app_user(email, display_name, role, department) values ($1,$2,$3,$4)', [u.email, u.name, u.role, u.department]);
    }
    const buildingId = (
      await q.query<{ id: string }>(`insert into building(name, address) values ('Sede principale', 'Via dell''Esempio 1, 20100 Milano (MI)') returning id`)
    ).rows[0]!.id;
    const resources = demoResources();
    const plan = (floor: 0 | 1, title: string, rooms: PlanRoom[]) =>
      floorPlanSvg(
        title,
        rooms,
        resources.filter((r) => r.kind === 'desk' && r.floor === floor).map((r) => ({ x: r.mapX!, y: r.mapY! })),
      );
    const f0 = (
      await q.query<{ id: string }>(
        `insert into floor(building_id, name, sort_order, map_mime, map_data, map_updated_at) values ($1, 'Piano terra', 0, 'image/svg+xml', $2, now()) returning id`,
        [buildingId, Buffer.from(plan(0, 'Piano terra', ROOMS_F0))],
      )
    ).rows[0]!.id;
    const f1 = (
      await q.query<{ id: string }>(
        `insert into floor(building_id, name, sort_order, map_mime, map_data, map_updated_at) values ($1, 'Primo piano', 1, 'image/svg+xml', $2, now()) returning id`,
        [buildingId, Buffer.from(plan(1, 'Primo piano', ROOMS_F1))],
      )
    ).rows[0]!.id;
    for (const r of resources) {
      await q.query(
        `insert into resource(kind, name, description, category, mailbox_email, building_id, floor_id, capacity, features, map_x, map_y, qr_token,
           check_in_required, check_in_grace_minutes, max_duration_minutes, booking_window_days)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          r.kind,
          r.name,
          r.description ?? null,
          r.category ?? null,
          r.mailbox ?? null,
          buildingId,
          r.floor === null ? null : r.floor === 0 ? f0 : f1,
          r.capacity,
          r.features,
          r.mapX ?? null,
          r.mapY ?? null,
          newQrToken(),
          r.checkInRequired,
          r.grace ?? null,
          r.maxDuration,
          r.windowDays,
        ],
      );
    }
    return loadSeedIds(q);
  });
}

export async function loadSeedIds(q: Queryable): Promise<SeedIds> {
  const users = (await q.query<UserRow>('select * from app_user')).rows;
  const resources = (await q.query<{ id: string; name: string }>('select id, name from resource')).rows;
  const building = (await q.query<{ id: string }>('select id from building order by created_at limit 1')).rows[0];
  const floors = (await q.query<{ id: string }>('select id from floor order by sort_order limit 2')).rows;
  const byName = new Map(resources.map((r) => [r.name, r.id]));
  const keyed: Record<string, string> = {};
  for (const r of demoResources()) if (byName.has(r.name)) keyed[r.key] = byName.get(r.name)!;
  return {
    users: Object.fromEntries(users.map((u) => [u.email.split('@')[0]!, u])),
    resources: keyed,
    buildingId: building?.id ?? '',
    floors: [floors[0]?.id ?? '', floors[1]?.id ?? ''],
  };
}

/** Registers users and resource mailboxes in the simulated Exchange (mock mode only). */
export async function registerMailboxes(fake: FakeExchange, db: Queryable): Promise<void> {
  for (const u of (await db.query<UserRow>('select * from app_user')).rows) {
    fake.addMailbox({ email: u.email, name: u.display_name, kind: 'user', department: u.department ?? undefined });
  }
  const res = (
    await db.query<{ name: string; kind: string; mailbox_email: string | null; capacity: number; booking_window_days: number; max_duration_minutes: number }>(
      'select name, kind, mailbox_email, capacity, booking_window_days, max_duration_minutes from resource where mailbox_email is not null',
    )
  ).rows;
  for (const r of res) {
    fake.addMailbox({
      email: r.mailbox_email!,
      name: r.name,
      kind: r.kind === 'room' ? 'room' : r.kind === 'desk' ? 'workspace' : 'equipment',
      capacity: r.capacity,
    });
  }
}

/** The working day before `reference` (Monday-Friday) in the given zone. */
export function previousWorkingDay(reference: Date, tz: string): string {
  let d = DateTime.fromJSDate(reference, { zone: tz }).startOf('day').minus({ days: 1 });
  while (d.weekday > 5) d = d.minus({ days: 1 });
  return d.toISODate()!;
}

interface PastBooking {
  resource: string;
  user: string;
  day: string;
  start: string;
  end: string;
  outcome: 'checked_in' | 'no_show' | 'cancelled' | 'early_checkout' | 'no_check_in_needed';
  checkInAt?: string;
  checkOutAt?: string;
  title?: string;
}

/**
 * Fixed scenario on the working day before the reference date. The expected KPI figures are computed by hand
 * in the acceptance test (test 10) and in docs/04-uso.md.
 */
export function kpiScenario(day: string): PastBooking[] {
  return [
    { resource: 'volta', user: 'marco.esposito', day, start: '09:00', end: '10:00', outcome: 'checked_in', checkInAt: '09:02', title: 'Riunione commerciale' },
    { resource: 'volta', user: 'sara.colombo', day, start: '11:00', end: '12:00', outcome: 'no_show', title: 'Revisione campagna' },
    { resource: 'volta', user: 'luca.bianchi', day, start: '14:00', end: '16:00', outcome: 'early_checkout', checkInAt: '14:00', checkOutAt: '15:30', title: 'Chiusura mensile' },
    { resource: 'fermi', user: 'elena.ricci', day, start: '10:00', end: '11:30', outcome: 'checked_in', checkInAt: '10:05', title: 'Colloquio' },
    { resource: 'montalcini', user: 'davide.gallo', day, start: '09:30', end: '10:30', outcome: 'no_show', title: 'Formazione' },
    { resource: 'galilei', user: 'chiara.moretti', day, start: '16:00', end: '17:00', outcome: 'checked_in', checkInAt: '16:01', title: 'Stato avanzamento' },
    { resource: 'fermi', user: 'marco.esposito', day, start: '15:00', end: '16:00', outcome: 'cancelled', title: 'Chiamata cliente' },
    { resource: 'p1-1', user: 'sara.colombo', day, start: '09:00', end: '18:00', outcome: 'checked_in', checkInAt: '09:10' },
    { resource: 'p1-2', user: 'luca.bianchi', day, start: '09:00', end: '13:00', outcome: 'no_show' },
    { resource: 'p1-3', user: 'elena.ricci', day, start: '08:30', end: '17:30', outcome: 'early_checkout', checkInAt: '08:35', checkOutAt: '12:30' },
    { resource: 'auto1', user: 'davide.gallo', day, start: '08:00', end: '19:00', outcome: 'checked_in', checkInAt: '08:10', title: 'Visita cliente' },
    { resource: 'proiettore', user: 'chiara.moretti', day, start: '10:00', end: '12:00', outcome: 'no_check_in_needed', title: 'Presentazione' },
  ];
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic history for the working days before the KPI day (nicer demo dashboards). */
export function historyScenario(kpiDay: string, tz: string, days = 10): PastBooking[] {
  const rnd = mulberry32(20261013);
  const users = DEMO_USERS.slice(2).map((u) => u.email.split('@')[0]!);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)]!;
  const out: PastBooking[] = [];
  let d = DateTime.fromISO(kpiDay, { zone: tz });
  let count = 0;
  while (count < days) {
    d = d.minus({ days: 1 });
    if (d.weekday > 5) continue;
    count++;
    const day = d.toISODate()!;
    for (const room of ['volta', 'fermi', 'montalcini', 'galilei']) {
      const slots = [9, 11, 14, 16].filter(() => rnd() < 0.7);
      for (const h of slots) {
        const dur = pick([30, 60, 90]);
        const r = rnd();
        const outcome: PastBooking['outcome'] = r < 0.72 ? 'checked_in' : r < 0.88 ? 'no_show' : 'cancelled';
        const end = DateTime.fromObject({ hour: h, minute: 0 }).plus({ minutes: dur }).toFormat('HH:mm');
        out.push({ resource: room, user: pick(users), day, start: `${String(h).padStart(2, '0')}:00`, end, outcome, checkInAt: outcome === 'checked_in' ? `${String(h).padStart(2, '0')}:03` : undefined, title: 'Riunione' });
      }
    }
    for (let i = 1; i <= 12; i++) {
      if (rnd() > 0.55) continue;
      const outcome: PastBooking['outcome'] = rnd() < 0.86 ? 'checked_in' : 'no_show';
      out.push({ resource: `p1-${i}`, user: pick(users), day, start: '09:00', end: '18:00', outcome, checkInAt: outcome === 'checked_in' ? '09:15' : undefined });
    }
    for (let i = 1; i <= 8; i++) {
      if (rnd() > 0.4) continue;
      out.push({ resource: `p0-${i}`, user: pick(users), day, start: '09:00', end: '13:00', outcome: 'checked_in', checkInAt: '09:05' });
    }
  }
  return out;
}

export async function insertPastBookings(db: Db, ids: SeedIds, items: PastBooking[], tz: string): Promise<void> {
  const at = (day: string, hm: string) => DateTime.fromISO(`${day}T${hm}`, { zone: tz }).toJSDate();
  await db.tx(async (q) => {
    for (const p of items) {
      const user = ids.users[p.user]!;
      const resourceId = ids.resources[p.resource]!;
      const start = at(p.day, p.start);
      const end = at(p.day, p.end);
      let status = 'confirmed';
      let releasedAt: Date | null = null;
      let reason: string | null = null;
      let effectiveEnd: Date | null = null;
      let checkOut: Date | null = null;
      if (p.outcome === 'no_show') {
        status = 'released';
        reason = 'no_show';
        releasedAt = new Date(start.getTime() + 10 * 60_000);
      } else if (p.outcome === 'cancelled') {
        status = 'cancelled';
      } else if (p.outcome === 'early_checkout') {
        status = 'completed';
        reason = 'early_checkout';
        checkOut = at(p.day, p.checkOutAt!);
        effectiveEnd = checkOut;
      }
      await q.query(
        `insert into booking(resource_id, organizer_id, organizer_email, booked_for_id, created_by_id, title, start_at, end_at, effective_end_at,
           status, source, checked_in_at, checked_out_at, released_at, release_reason, exchange_released)
         values ($1,$2,$3,$2,$2,$4,$5,$6,$7,$8,'seed',$9,$10,$11,$12,true)`,
        [
          resourceId,
          user.id,
          user.email,
          p.title ?? null,
          start,
          end,
          effectiveEnd,
          status,
          p.checkInAt ? at(p.day, p.checkInAt) : null,
          checkOut,
          releasedAt,
          reason,
        ],
      );
    }
  });
}

export interface SeedOptions {
  referenceDate: Date;
  tz: string;
  history?: boolean;
  upcoming?: { bookings: BookingService } | null;
}

/** Full demo seed: base data, KPI scenario, deterministic history and (optionally) upcoming bookings through Exchange. */
export async function seedDemo(db: Db, opts: SeedOptions): Promise<SeedIds> {
  const existingBookings = (await db.query<{ n: number }>('select count(*)::int as n from booking')).rows[0]!.n;
  const ids = await seedBase(db);
  if (existingBookings > 0) return ids;
  const kpiDay = previousWorkingDay(opts.referenceDate, opts.tz);
  await insertPastBookings(db, ids, kpiScenario(kpiDay), opts.tz);
  if (opts.history !== false) await insertPastBookings(db, ids, historyScenario(kpiDay, opts.tz), opts.tz);
  if (opts.upcoming) await seedUpcoming(opts.upcoming.bookings, ids, opts.referenceDate, opts.tz);
  return ids;
}

/** Upcoming bookings created through the booking service, so they exist in (simulated) Exchange too. */
export async function seedUpcoming(bookings: BookingService, ids: SeedIds, reference: Date, tz: string): Promise<void> {
  const actor = (key: string): Actor => ({ user: ids.users[key]!, role: ids.users[key]!.role });
  const base = DateTime.fromJSDate(reference, { zone: tz }).startOf('day');
  const plan: Array<{ who: string; res: string; dayOffset: number; start: string; end: string; title: string }> = [
    { who: 'marco.esposito', res: 'volta', dayOffset: 1, start: '09:30', end: '10:30', title: 'Riunione settimanale vendite' },
    { who: 'sara.colombo', res: 'galilei', dayOffset: 1, start: '11:00', end: '12:00', title: 'Brainstorming campagna' },
    { who: 'elena.ricci', res: 'fermi', dayOffset: 1, start: '14:30', end: '15:30', title: 'Colloquio' },
    { who: 'chiara.moretti', res: 'montalcini', dayOffset: 2, start: '10:00', end: '12:00', title: 'Kick-off progetto' },
    { who: 'luca.bianchi', res: 'p1-4', dayOffset: 1, start: '09:00', end: '18:00', title: 'Postazione P1-04' },
    { who: 'davide.gallo', res: 'p1-5', dayOffset: 1, start: '09:00', end: '18:00', title: 'Postazione P1-05' },
    { who: 'sara.colombo', res: 'p0-2', dayOffset: 1, start: '09:00', end: '13:00', title: 'Postazione P0-02' },
    { who: 'davide.gallo', res: 'auto1', dayOffset: 2, start: '08:30', end: '13:00', title: 'Visita cliente' },
  ];
  for (const p of plan) {
    let day = base.plus({ days: p.dayOffset });
    while (day.weekday > 5) day = day.plus({ days: 1 });
    const start = DateTime.fromISO(`${day.toISODate()}T${p.start}`, { zone: tz }).toJSDate();
    const end = DateTime.fromISO(`${day.toISODate()}T${p.end}`, { zone: tz }).toJSDate();
    await bookings
      .createBooking(actor(p.who), { resourceId: ids.resources[p.res]!, start, end, title: p.title, source: 'web' })
      .catch(() => undefined);
  }
}

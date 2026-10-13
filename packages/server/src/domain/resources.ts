import { randomBytes } from 'node:crypto';
import type { ResourceDto, ResourceKind } from '@ritrovo/shared';
import { z } from 'zod';
import type { Queryable } from '../db/db.js';
import { NotFoundError } from './errors.js';
import type { Settings } from './settings.js';

export interface ResourceRow {
  id: string;
  kind: ResourceKind;
  name: string;
  description: string | null;
  category: string | null;
  mailbox_email: string | null;
  building_id: string | null;
  floor_id: string | null;
  capacity: number;
  features: string[];
  map_x: number | null;
  map_y: number | null;
  qr_token: string;
  is_active: boolean;
  check_in_required: boolean;
  check_in_grace_minutes: number | null;
  max_duration_minutes: number;
  booking_window_days: number;
  building_name?: string | null;
  floor_name?: string | null;
}

export interface EffectivePolicy {
  checkInRequired: boolean;
  checkInGraceMinutes: number;
  checkInOpensMinutesBefore: number;
  maxDurationMinutes: number;
  bookingWindowDays: number;
}

export function effectivePolicy(r: ResourceRow, s: Settings): EffectivePolicy {
  return {
    checkInRequired: r.check_in_required,
    checkInGraceMinutes: r.check_in_grace_minutes ?? s.checkInGraceMinutes,
    checkInOpensMinutesBefore: s.checkInOpensMinutesBefore,
    maxDurationMinutes: r.max_duration_minutes,
    bookingWindowDays: r.booking_window_days,
  };
}

export function resourceDto(r: ResourceRow, s: Settings, extra: Partial<ResourceDto> = {}): ResourceDto {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    description: r.description,
    category: r.category,
    mailboxEmail: r.mailbox_email,
    buildingId: r.building_id,
    buildingName: r.building_name ?? null,
    floorId: r.floor_id,
    floorName: r.floor_name ?? null,
    capacity: r.capacity,
    features: r.features ?? [],
    mapX: r.map_x,
    mapY: r.map_y,
    isActive: r.is_active,
    policy: effectivePolicy(r, s),
    ...extra,
  };
}

export const RESOURCE_SELECT = `select r.*, b.name as building_name, f.name as floor_name
  from resource r left join building b on b.id = r.building_id left join floor f on f.id = r.floor_id`;

export function newQrToken(): string {
  return randomBytes(16).toString('base64url');
}

export async function getResource(q: Queryable, id: string): Promise<ResourceRow> {
  const r = (await q.query<ResourceRow>(`${RESOURCE_SELECT} where r.id = $1`, [id])).rows[0];
  if (!r) throw new NotFoundError('Risorsa non trovata.');
  return r;
}

export async function getResourceByQr(q: Queryable, token: string): Promise<ResourceRow> {
  const r = (await q.query<ResourceRow>(`${RESOURCE_SELECT} where r.qr_token = $1 and r.is_active`, [token])).rows[0];
  if (!r) throw new NotFoundError('QR code non valido o risorsa non più attiva.');
  return r;
}

export async function getResourceByMailbox(q: Queryable, email: string): Promise<ResourceRow | null> {
  return (await q.query<ResourceRow>(`${RESOURCE_SELECT} where lower(r.mailbox_email) = lower($1)`, [email])).rows[0] ?? null;
}

export interface ResourceFilter {
  kind?: ResourceKind;
  buildingId?: string;
  floorId?: string;
  minCapacity?: number;
  features?: string[];
  includeInactive?: boolean;
}

export async function listResources(q: Queryable, f: ResourceFilter = {}): Promise<ResourceRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (!f.includeInactive) where.push('r.is_active');
  if (f.kind) add('r.kind = ?', f.kind);
  if (f.buildingId) add('r.building_id = ?', f.buildingId);
  if (f.floorId) add('r.floor_id = ?', f.floorId);
  if (f.minCapacity) add('r.capacity >= ?', f.minCapacity);
  if (f.features?.length) add('r.features @> ?::text[]', f.features);
  const sql = `${RESOURCE_SELECT} ${where.length ? `where ${where.join(' and ')}` : ''} order by r.kind, b.name nulls last, f.sort_order nulls last, r.name`;
  return (await q.query<ResourceRow>(sql, params)).rows;
}

export const ResourceInputSchema = z.object({
  kind: z.enum(['room', 'desk', 'asset']),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000).nullish(),
  category: z.string().trim().max(60).nullish(),
  mailboxEmail: z.string().trim().email().max(254).nullish(),
  buildingId: z.string().uuid().nullish(),
  floorId: z.string().uuid().nullish(),
  capacity: z.number().int().min(1).max(500).default(1),
  features: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
  mapX: z.number().min(0).max(1).nullish(),
  mapY: z.number().min(0).max(1).nullish(),
  isActive: z.boolean().default(true),
  checkInRequired: z.boolean().default(true),
  checkInGraceMinutes: z.number().int().min(1).max(240).nullish(),
  maxDurationMinutes: z.number().int().min(5).max(20160).default(480),
  bookingWindowDays: z.number().int().min(0).max(1080).default(180),
});
export type ResourceInput = z.infer<typeof ResourceInputSchema>;

export async function createResource(q: Queryable, input: ResourceInput): Promise<ResourceRow> {
  const row = (
    await q.query<{ id: string }>(
      `insert into resource(kind, name, description, category, mailbox_email, building_id, floor_id, capacity, features, map_x, map_y,
        qr_token, is_active, check_in_required, check_in_grace_minutes, max_duration_minutes, booking_window_days)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
      [
        input.kind,
        input.name,
        input.description ?? null,
        input.category ?? null,
        input.mailboxEmail?.toLowerCase() ?? null,
        input.buildingId ?? null,
        input.floorId ?? null,
        input.capacity,
        input.features,
        input.mapX ?? null,
        input.mapY ?? null,
        newQrToken(),
        input.isActive,
        input.checkInRequired,
        input.checkInGraceMinutes ?? null,
        input.maxDurationMinutes,
        input.bookingWindowDays,
      ],
    )
  ).rows[0]!;
  return getResource(q, row.id);
}

export async function updateResource(q: Queryable, id: string, patch: Partial<ResourceInput>): Promise<ResourceRow> {
  const map: Record<string, string> = {
    kind: 'kind',
    name: 'name',
    description: 'description',
    category: 'category',
    mailboxEmail: 'mailbox_email',
    buildingId: 'building_id',
    floorId: 'floor_id',
    capacity: 'capacity',
    features: 'features',
    mapX: 'map_x',
    mapY: 'map_y',
    isActive: 'is_active',
    checkInRequired: 'check_in_required',
    checkInGraceMinutes: 'check_in_grace_minutes',
    maxDurationMinutes: 'max_duration_minutes',
    bookingWindowDays: 'booking_window_days',
  };
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [k, col] of Object.entries(map)) {
    if (!(k in patch)) continue;
    let v = (patch as Record<string, unknown>)[k];
    if (k === 'mailboxEmail' && typeof v === 'string') v = v.toLowerCase();
    params.push(v ?? null);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length) {
    const res = await q.query(`update resource set ${sets.join(', ')}, updated_at = now() where id = $1`, params);
    if (res.rowCount === 0) throw new NotFoundError('Risorsa non trovata.');
  }
  return getResource(q, id);
}

export async function regenerateQr(q: Queryable, id: string): Promise<ResourceRow> {
  await q.query('update resource set qr_token = $2, updated_at = now() where id = $1', [id, newQrToken()]);
  return getResource(q, id);
}

/** Suggested Exchange Online PowerShell to align the resource mailbox with the rules configured in Ritrovo. */
export function exchangePowerShell(r: ResourceRow): string | null {
  if (!r.mailbox_email) return null;
  return [
    `# Casella: ${r.mailbox_email} (${r.name})`,
    `Set-CalendarProcessing -Identity "${r.mailbox_email}" -AutomateProcessing AutoAccept -AllowConflicts $false ` +
      `-BookingWindowInDays ${r.booking_window_days} -MaximumDurationInMinutes ${r.max_duration_minutes} ` +
      `-AllowRecurringMeetings $true -ProcessExternalMeetingMessages $false`,
    `Set-Mailbox -Identity "${r.mailbox_email}" -CustomAttribute15 "Ritrovo"`,
  ].join('\n');
}

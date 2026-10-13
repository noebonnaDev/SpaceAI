import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '../db/db.js';
import { NotFoundError, UnauthorizedError } from './errors.js';

export interface KioskRow {
  id: string;
  name: string;
  kind: 'panel' | 'totem';
  resource_id: string | null;
  building_id: string | null;
  created_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}

export const NewKioskSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(['panel', 'totem']),
    resourceId: z.string().uuid().optional(),
    buildingId: z.string().uuid().optional(),
  })
  .refine((k) => (k.kind === 'panel' ? !!k.resourceId : !!k.buildingId), {
    message: 'Un pannello va abbinato a una sala, un totem a un edificio.',
  });

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Creates a device and returns the clear token once: only its hash is stored. */
export async function createKiosk(
  q: Queryable,
  createdBy: string,
  input: z.infer<typeof NewKioskSchema>,
): Promise<{ device: KioskRow; token: string }> {
  const token = randomBytes(32).toString('base64url');
  const device = (
    await q.query<KioskRow>(
      `insert into kiosk_device(name, kind, resource_id, building_id, token_hash, created_by_id) values ($1,$2,$3,$4,$5,$6) returning *`,
      [input.name, input.kind, input.kind === 'panel' ? input.resourceId : null, input.kind === 'totem' ? input.buildingId : null, hashToken(token), createdBy],
    )
  ).rows[0]!;
  return { device, token };
}

export async function authenticateKiosk(q: Queryable, token: string): Promise<KioskRow> {
  const device = (
    await q.query<KioskRow>('select * from kiosk_device where token_hash = $1 and revoked_at is null', [hashToken(token)])
  ).rows[0];
  if (!device) throw new UnauthorizedError('Pannello non abbinato o revocato.');
  await q.query('update kiosk_device set last_seen_at = now() where id = $1', [device.id]);
  return device;
}

export async function listKiosks(q: Queryable): Promise<Array<KioskRow & { resource_name: string | null; building_name: string | null }>> {
  return (
    await q.query<KioskRow & { resource_name: string | null; building_name: string | null }>(
      `select k.*, r.name as resource_name, b.name as building_name from kiosk_device k
       left join resource r on r.id = k.resource_id left join building b on b.id = k.building_id order by k.created_at desc`,
    )
  ).rows;
}

export async function revokeKiosk(q: Queryable, id: string): Promise<void> {
  const res = await q.query('update kiosk_device set revoked_at = now() where id = $1 and revoked_at is null', [id]);
  if (res.rowCount === 0) throw new NotFoundError('Pannello non trovato o già revocato.');
}

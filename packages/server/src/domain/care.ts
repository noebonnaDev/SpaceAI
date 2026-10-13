import type { FacilityRequestDto, RequestStatus } from '@ritrovo/shared';
import { z } from 'zod';
import type { Queryable } from '../db/db.js';
import { NotFoundError } from './errors.js';

export const NewRequestSchema = z.object({
  category: z.enum(['manutenzione', 'pulizia', 'it', 'arredi', 'altro']),
  title: z.string().trim().min(3).max(160),
  description: z.string().trim().max(4000).optional(),
  resourceId: z.string().uuid().optional(),
  locationText: z.string().trim().max(200).optional(),
});

export const UpdateRequestSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'closed']).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  resolutionNote: z.string().trim().max(4000).nullable().optional(),
});

const SELECT = `select fr.*, r.name as resource_name, u.display_name as requester_name, a.display_name as assignee_name
  from facility_request fr left join resource r on r.id = fr.resource_id
  left join app_user u on u.id = fr.requester_id left join app_user a on a.id = fr.assignee_id`;

function dto(r: any): FacilityRequestDto {
  return {
    id: r.id,
    category: r.category,
    title: r.title,
    description: r.description,
    status: r.status,
    resourceId: r.resource_id,
    resourceName: r.resource_name,
    locationText: r.location_text,
    requesterName: r.requester_name,
    assigneeName: r.assignee_name,
    resolutionNote: r.resolution_note,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export async function createRequest(q: Queryable, requesterId: string, input: z.infer<typeof NewRequestSchema>): Promise<FacilityRequestDto> {
  const row = (
    await q.query<{ id: string }>(
      `insert into facility_request(requester_id, category, title, description, resource_id, location_text) values ($1,$2,$3,$4,$5,$6) returning id`,
      [requesterId, input.category, input.title, input.description ?? null, input.resourceId ?? null, input.locationText ?? null],
    )
  ).rows[0]!;
  return getRequest(q, row.id);
}

export async function getRequest(q: Queryable, id: string): Promise<FacilityRequestDto> {
  const r = (await q.query(`${SELECT} where fr.id = $1`, [id])).rows[0];
  if (!r) throw new NotFoundError('Richiesta non trovata.');
  return dto(r);
}

export async function getRequestOwner(q: Queryable, id: string): Promise<string | null> {
  const r = (await q.query<{ requester_id: string | null }>('select requester_id from facility_request where id = $1', [id])).rows[0];
  if (!r) throw new NotFoundError('Richiesta non trovata.');
  return r.requester_id;
}

export async function listRequests(q: Queryable, f: { requesterId?: string; status?: RequestStatus }): Promise<FacilityRequestDto[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.requesterId) {
    params.push(f.requesterId);
    where.push(`fr.requester_id = $${params.length}`);
  }
  if (f.status) {
    params.push(f.status);
    where.push(`fr.status = $${params.length}`);
  }
  const rows = (await q.query(`${SELECT} ${where.length ? `where ${where.join(' and ')}` : ''} order by fr.created_at desc limit 300`, params)).rows;
  return rows.map(dto);
}

export async function updateRequest(q: Queryable, id: string, patch: z.infer<typeof UpdateRequestSchema>): Promise<FacilityRequestDto> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  if (patch.status) {
    params.push(patch.status);
    sets.push(`status = $${params.length}`);
    sets.push(patch.status === 'closed' ? 'closed_at = now()' : 'closed_at = null');
  }
  if (patch.assigneeId !== undefined) {
    params.push(patch.assigneeId);
    sets.push(`assignee_id = $${params.length}`);
  }
  if (patch.resolutionNote !== undefined) {
    params.push(patch.resolutionNote);
    sets.push(`resolution_note = $${params.length}`);
  }
  if (sets.length) {
    const res = await q.query(`update facility_request set ${sets.join(', ')}, updated_at = now() where id = $1`, params);
    if (res.rowCount === 0) throw new NotFoundError('Richiesta non trovata.');
  }
  return getRequest(q, id);
}

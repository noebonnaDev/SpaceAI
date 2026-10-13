import type { Queryable } from '../db/db.js';

export async function audit(
  q: Queryable,
  actor: { id: string; label: string } | null,
  action: string,
  entity: string | null,
  entityId: string | null,
  details?: Record<string, unknown>,
): Promise<void> {
  await q.query(
    `insert into audit_log(actor_id, actor_label, action, entity, entity_id, details) values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [actor?.id ?? null, actor?.label ?? 'sistema', action, entity, entityId, details ? JSON.stringify(details) : null],
  );
}

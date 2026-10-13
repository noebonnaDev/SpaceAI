import type { Queryable } from '../db/db.js';
import type { Settings } from './settings.js';
import { addMinutes } from './time.js';

/**
 * GDPR minimisation: after `retentionDays` bookings keep only resource, times and outcome
 * (needed for aggregated KPIs); people, titles and links are removed. Old audit entries are deleted.
 */
export async function applyRetention(q: Queryable, settings: Settings, now: Date): Promise<{ bookings: number; requests: number; audit: number }> {
  const cutoff = addMinutes(now, -settings.retentionDays * 24 * 60);
  const bookings = await q.query(
    `update booking set organizer_id = null, organizer_email = null, booked_for_id = null, created_by_id = null, title = null,
       online_meeting_url = null, anonymized = true, updated_at = now()
     where end_at < $1 and not anonymized`,
    [cutoff],
  );
  const requests = await q.query(
    `update facility_request set requester_id = null, assignee_id = null, description = null, resolution_note = null, updated_at = now()
     where status = 'closed' and coalesce(closed_at, updated_at) < $1 and requester_id is not null`,
    [cutoff],
  );
  const auditCutoff = addMinutes(now, -settings.auditRetentionDays * 24 * 60);
  const auditRes = await q.query('delete from audit_log where at < $1', [auditCutoff]);
  await q.query('delete from proposal where created_at < $1 and status <> $2', [cutoff, 'open']);
  return { bookings: bookings.rowCount, requests: requests.rowCount, audit: auditRes.rowCount };
}

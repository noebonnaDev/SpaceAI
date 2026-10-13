import type { Db } from '../db/db.js';
import type { Clock } from '../domain/clock.js';
import type { FakeExchange } from '../graph/mock.js';

/**
 * Mock mode only: the simulated Exchange lives in memory, so after a restart it is rebuilt from the active
 * future bookings stored in PostgreSQL. Not used with real Microsoft Graph.
 */
export async function hydrateFakeFromDb(fake: FakeExchange, db: Db, clock: Clock): Promise<number> {
  const rows = (
    await db.query<{
      id: string;
      organizer_email: string | null;
      mailbox_email: string;
      resource_name: string;
      title: string | null;
      start_at: Date;
      end_at: Date;
      status: string;
      source: string;
    }>(
      `select b.id, b.organizer_email, r.mailbox_email, r.name as resource_name, b.title, b.start_at, coalesce(b.effective_end_at, b.end_at) as end_at,
         b.status, b.source
       from booking b join resource r on r.id = b.resource_id
       where r.mailbox_email is not null and b.status in ('pending','confirmed','tentative') and b.end_at > $1
       order by b.start_at`,
      [clock.now()],
    )
  ).rows;
  let n = 0;
  for (const b of rows) {
    const organizer = (b.organizer_email ?? b.mailbox_email).toLowerCase();
    if (!fake.hasMailbox(organizer)) continue;
    const isRoomOrganizer = organizer === b.mailbox_email.toLowerCase();
    const ev = await fake.createEvent(isRoomOrganizer ? { kind: 'app' } : { kind: 'user', email: organizer }, organizer, {
      subject: b.title ?? 'Riunione',
      start: b.start_at,
      end: b.end_at,
      attendees: isRoomOrganizer ? [] : [{ email: b.mailbox_email, name: b.resource_name, type: 'resource' }],
      showAs: b.status === 'tentative' ? 'tentative' : 'busy',
      transactionId: b.id,
    });
    const copy = isRoomOrganizer ? ev : fake.eventsOf(b.mailbox_email).find((e) => e.iCalUId === ev.iCalUId);
    await db.query(
      `update booking set organizer_event_id = $2, ical_uid = $3, resource_event_id = $4, status = case when status = 'pending' then 'confirmed' else status end
       where id = $1`,
      [b.id, isRoomOrganizer ? null : ev.id, ev.iCalUId, copy?.id ?? null],
    );
    n++;
  }
  return n;
}

/**
 * Outlook -> Ritrovo direction: bookings made directly in Outlook (meeting with the room as resource)
 * reach Ritrovo through change notifications (webhook) and delta queries.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/db.js';
import { getResource } from '../src/domain/resources.js';
import { SyncService } from '../src/domain/sync.js';
import { createHarness, local, type Harness } from './harness.js';

const TODAY = '2026-10-14';
const mailbox = (name: string) => `${name}@ufficio.example`;

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

async function bookingsOf(resourceKey: string) {
  return (
    await h.db.query<any>(
      `select b.*, u.display_name as organizer from booking b left join app_user u on u.id = b.organizer_id
       where b.resource_id = $1 and b.start_at >= $2 order by b.start_at`,
      [h.ids.resources[resourceKey], local(TODAY, '00:00')],
    )
  ).rows;
}

describe('Sincronizzazione Outlook -> Ritrovo', () => {
  it('una riunione creata in Outlook con la sala compare in Ritrovo (webhook) e segue le regole di check-in', async () => {
    const ev = await h.fake.createEvent({ kind: 'user', email: mailbox('davide.gallo') }, mailbox('davide.gallo'), {
      subject: 'Revisione offerta',
      start: local(TODAY, '11:00'),
      end: local(TODAY, '12:00'),
      attendees: [{ email: mailbox('sala.fermi'), type: 'resource' }],
    });
    await h.settle();
    const rows = await bookingsOf('fermi');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'outlook', status: 'confirmed', ical_uid: ev.iCalUId, organizer: 'Davide Gallo' });

    // Visible in the organizer's agenda in Ritrovo, with check-in available.
    h.clock.set(local(TODAY, '10:55').toISOString());
    const mine = await h.api('davide.gallo').get(`/api/bookings/mine?date=${TODAY}`);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].canCheckIn).toBe(true);

    // Rescheduled in Outlook -> updated in Ritrovo.
    await h.fake.updateEvent({ kind: 'user', email: mailbox('davide.gallo') }, mailbox('davide.gallo'), ev.id, {
      start: local(TODAY, '16:00'),
      end: local(TODAY, '17:00'),
    });
    await h.settle();
    const moved = await bookingsOf('fermi');
    expect(moved).toHaveLength(1);
    expect(moved[0].start_at.toISOString()).toBe(local(TODAY, '16:00').toISOString());

    // No check-in -> released also for bookings made in Outlook.
    h.clock.set(local(TODAY, '16:11').toISOString());
    await h.ctx.bookings.releaseNoShows();
    await h.settle();
    expect((await bookingsOf('fermi'))[0].status).toBe('released');
    expect(h.fake.eventsOf(mailbox('sala.fermi'))).toHaveLength(0);
  });

  it('una riunione annullata in Outlook viene annullata in Ritrovo', async () => {
    const res = await h.api('marco.esposito').post('/api/bookings', {
      resourceId: h.ids.resources.galilei,
      start: local(TODAY, '14:00').toISOString(),
      end: local(TODAY, '15:00').toISOString(),
    });
    expect(res.status).toBe(201);
    const ev = h.fake.eventsOf(mailbox('marco.esposito'))[0]!;
    await h.fake.deleteEvent({ kind: 'user', email: mailbox('marco.esposito') }, mailbox('marco.esposito'), ev.id);
    await h.settle();
    expect((await h.api('marco.esposito').get(`/api/bookings/${res.body.id}`)).body.status).toBe('cancelled');
  });

  it('senza webhook la delta query periodica riconcilia (server non raggiungibile da Internet)', async () => {
    h.fake.sink = null;
    await h.fake.createEvent({ kind: 'user', email: mailbox('sara.colombo') }, mailbox('sara.colombo'), {
      subject: 'Call',
      start: local(TODAY, '09:30'),
      end: local(TODAY, '10:00'),
      attendees: [{ email: mailbox('sala.volta'), type: 'resource' }],
    });
    expect(await bookingsOf('volta')).toHaveLength(0);
    const reports = await h.ctx.sync.syncAll();
    expect(reports.every((r) => !r.error)).toBe(true);
    expect(await bookingsOf('volta')).toHaveLength(1);
    // Second round is incremental and idempotent.
    const again = await h.ctx.sync.syncAll();
    expect(again.find((r) => r.resourceId === h.ids.resources.volta)).toMatchObject({ full: false, created: 0 });
    expect(await bookingsOf('volta')).toHaveLength(1);
  });

  it('le prenotazioni create da Ritrovo non vengono duplicate dalla sincronizzazione', async () => {
    for (const [i, room] of (['volta', 'fermi', 'galilei'] as const).entries()) {
      const r = await h.api('elena.ricci').post('/api/bookings', {
        resourceId: h.ids.resources[room],
        start: local(TODAY, `1${i}:00`).toISOString(),
        end: local(TODAY, `1${i}:30`).toISOString(),
      });
      expect(r.status).toBe(201);
    }
    await h.settle();
    await h.ctx.sync.syncAll();
    for (const room of ['volta', 'fermi', 'galilei']) expect(await bookingsOf(room)).toHaveLength(1);
  });

  it('una sincronizzazione concorrente al check-out non riporta la prenotazione a "confermata"', async () => {
    h.clock.set(local(TODAY, '10:55').toISOString());
    const created = await h.api('elena.ricci').post('/api/bookings', {
      resourceId: h.ids.resources.fermi,
      start: local(TODAY, '11:00').toISOString(),
      end: local(TODAY, '12:00').toISOString(),
    });
    expect(created.status).toBe(201);
    await h.settle();
    h.clock.set(local(TODAY, '11:02').toISOString());
    expect((await h.api('elena.ricci').post(`/api/bookings/${created.body.id}/check-in`)).status).toBe(200);
    const event = h.fake.eventsOf(mailbox('sala.fermi'))[0]!;
    const room = await getResource(h.db, h.ids.resources.fermi!);

    // Interleaving: the sync reads the booking (still "confirmed"), the user checks out, then the sync writes.
    for (const variant of [event, { ...event, isCancelled: true }]) {
      let interleaved = false;
      const racingDb: Db = {
        ...h.db,
        async query(text: string, params?: unknown[]) {
          const result = await h.db.query(text, params);
          if (!interleaved && text.includes('b.ical_uid = $2')) {
            interleaved = true;
            h.clock.set(local(TODAY, '11:30').toISOString());
            await h.db.query(`update booking set status = 'completed', checked_out_at = $2, effective_end_at = $2 where id = $1`, [
              created.body.id,
              local(TODAY, '11:30'),
            ]);
          }
          return result as any;
        },
      };
      const sync = new SyncService({ ...h.ctx.bookings['s'], db: racingDb });
      await sync.upsertFromResourceEvent(room, variant);
      expect(interleaved).toBe(true);
      expect((await bookingsOf('fermi'))[0].status).toBe('completed');
    }
  });

  it('webhook: risponde al validationToken e ignora notifiche con clientState errato', async () => {
    const v = await h.app.inject({ method: 'POST', url: '/api/graph/notifications?validationToken=abc%20123' });
    expect(v.statusCode).toBe(200);
    expect(v.headers['content-type']).toContain('text/plain');
    expect(v.body).toBe('abc 123');
    const sub = (await h.db.query<any>('select subscription_id from graph_subscription limit 1')).rows[0];
    const bad = await h.app.inject({
      method: 'POST',
      url: '/api/graph/notifications',
      payload: { value: [{ subscriptionId: sub.subscription_id, clientState: 'sbagliato', changeType: 'updated', resource: 'x' }] },
    });
    expect(bad.statusCode).toBe(202);
    expect(await h.ctx.sync.handleNotifications([{ subscriptionId: sub.subscription_id, clientState: 'sbagliato', changeType: 'updated', resource: 'x' }])).toBe(0);
  });

  it('rinnova le sottoscrizioni prima della scadenza (massimo 10.080 minuti per gli eventi Outlook)', async () => {
    const subs = h.fake.activeSubscriptions();
    expect(subs.length).toBe(7); // 4 rooms + 3 equipment mailboxes
    const maxExp = Math.max(...subs.map((s) => s.expiration.getTime()));
    expect(maxExp - h.clock.now().getTime()).toBeLessThanOrEqual(10080 * 60_000);
    // Six days later the subscriptions expire within 24 hours: they get renewed.
    h.clock.advanceMinutes(6 * 24 * 60 + 60);
    const r = await h.ctx.sync.ensureSubscriptions();
    expect(r).toMatchObject({ renewed: 7, created: 0, failed: 0 });
    // If one disappears (e.g. removed by Graph), it is recreated.
    h.clock.advanceMinutes(8 * 24 * 60);
    const r2 = await h.ctx.sync.ensureSubscriptions();
    expect(r2.created).toBe(7);
  });

  it("l'applicazione non può leggere o scrivere i calendari degli utenti (ambito RBAC sulle sole caselle risorsa)", async () => {
    await expect(h.fake.listCalendarView({ kind: 'app' }, mailbox('marco.esposito'), new Date(), new Date())).rejects.toMatchObject({ status: 403 });
    await expect(
      h.fake.createEvent({ kind: 'app' }, mailbox('marco.esposito'), { subject: 'x', start: new Date(), end: new Date(), attendees: [] }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

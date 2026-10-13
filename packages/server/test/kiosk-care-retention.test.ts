import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyRetention } from '../src/domain/retention.js';
import { getSettings } from '../src/domain/settings.js';
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

async function pair(kind: 'panel' | 'totem', target: string) {
  const res = await h.api('giulia.rinaldi').post('/api/admin/kiosks', {
    name: kind === 'panel' ? 'Tablet Sala Volta' : 'Totem ingresso',
    kind,
    ...(kind === 'panel' ? { resourceId: target } : { buildingId: target }),
  });
  expect(res.status).toBe(201);
  const token = new URL(res.body.pairingUrl).hash.replace('#t=', '');
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    h.app.inject({ method, url, headers: { authorization: `Kiosk ${token}` }, payload: payload as any });
  return { id: res.body.id as string, token, call };
}

describe('Pannello fuori-porta e totem', () => {
  it('mostra lo stato della sala, consente check-in, prenotazione immediata e check-out', async () => {
    const panel = await pair('panel', h.ids.resources.volta!);
    const booked = await h.api('marco.esposito').post('/api/bookings', {
      resourceId: h.ids.resources.volta,
      start: local(TODAY, '09:30').toISOString(),
      end: local(TODAY, '10:00').toISOString(),
      title: 'Riunione riservata',
    });
    expect(booked.status).toBe(201);
    h.clock.set(local(TODAY, '09:25').toISOString());
    const s1 = (await panel.call('GET', '/api/kiosk/state')).json();
    expect(s1.kind).toBe('panel');
    expect(s1.resource.name).toBe('Sala Volta');
    expect(s1.state).toBe('free');
    expect(s1.checkInCandidate).not.toBeNull();
    // Privacy: by default the panel shows the organizer but not the subject.
    expect(s1.checkInCandidate.title).toBeNull();
    expect(s1.checkInCandidate.organizerName).toBe('Marco Esposito');

    expect((await panel.call('POST', '/api/kiosk/check-in')).statusCode).toBe(200);
    h.clock.set(local(TODAY, '09:40').toISOString());
    expect((await panel.call('GET', '/api/kiosk/state')).json().state).toBe('occupied');
    expect((await panel.call('POST', '/api/kiosk/check-out')).statusCode).toBe(200);
    await h.settle();
    expect(h.fake.eventsOf(mailbox('sala.volta'))).toHaveLength(0);

    // Walk-in booking from the panel: the room itself is the organizer, already checked in.
    const now = await panel.call('POST', '/api/kiosk/book-now', { minutes: 15 });
    expect(now.statusCode).toBe(201);
    const roomEvents = h.fake.eventsOf(mailbox('sala.volta'));
    expect(roomEvents).toHaveLength(1);
    expect(roomEvents[0]!.organizerEmail).toBe(mailbox('sala.volta'));
    const s2 = (await panel.call('GET', '/api/kiosk/state')).json();
    expect(s2.state).toBe('occupied');
    // A second walk-in on the occupied room is refused.
    expect((await panel.call('POST', '/api/kiosk/book-now', { minutes: 30 })).statusCode).toBe(409);
  });

  it('un pannello non gestisce altre sale e un token revocato non funziona più', async () => {
    const panel = await pair('panel', h.ids.resources.volta!);
    const other = await h.api('marco.esposito').post('/api/bookings', {
      resourceId: h.ids.resources.fermi,
      start: local(TODAY, '09:30').toISOString(),
      end: local(TODAY, '10:00').toISOString(),
    });
    await expect(
      h.ctx.bookings.checkIn({ kind: 'kiosk', deviceId: panel.id, resourceId: h.ids.resources.volta!, buildingId: null }, other.body.id),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await h.app.inject({ method: 'GET', url: '/api/kiosk/state', headers: { authorization: 'Kiosk sbagliato' } })).statusCode).toBe(401);
    expect((await h.api('giulia.rinaldi').post(`/api/admin/kiosks/${panel.id}/revoke`)).status).toBe(200);
    expect((await panel.call('GET', '/api/kiosk/state')).statusCode).toBe(401);
    // The token is never stored in clear.
    const stored = (await h.db.query<any>('select token_hash from kiosk_device where id = $1', [panel.id])).rows[0];
    expect(stored.token_hash).not.toBe(panel.token);
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('il totem mostra lo stato di tutte le sale dell\'edificio', async () => {
    const totem = await pair('totem', h.ids.buildingId);
    await h.api('elena.ricci').post('/api/bookings', {
      resourceId: h.ids.resources.galilei,
      start: local(TODAY, '09:00').toISOString(),
      end: local(TODAY, '10:00').toISOString(),
    });
    const s = (await totem.call('GET', '/api/kiosk/state')).json();
    expect(s.kind).toBe('totem');
    expect(s.rooms).toHaveLength(4);
    expect(s.rooms.find((r: any) => r.resourceName === 'Sala Galilei').state).toBe('awaiting_check_in');
    expect(s.desks.total).toBe(20);
    expect((await totem.call('POST', '/api/kiosk/check-in')).statusCode).toBe(403);
  });
});

describe('Richieste (Care)', () => {
  it('un utente apre una richiesta, la reception la gestisce, l\'utente non può gestire quelle altrui', async () => {
    const created = await h.api('sara.colombo').post('/api/requests', {
      category: 'manutenzione',
      title: 'Lampada guasta',
      description: 'La lampada della postazione non si accende.',
      resourceId: h.ids.resources['p1-1'],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'open', resourceName: 'P1-01', requesterName: 'Sara Colombo' });
    expect((await h.api('marco.esposito').get('/api/requests')).status).toBe(403);
    expect((await h.api('marco.esposito').patch(`/api/requests/${created.body.id}`, { status: 'closed' })).status).toBe(403);
    const list = await h.api('paolo.ferri').get('/api/requests?status=open');
    expect(list.body.map((r: any) => r.id)).toContain(created.body.id);
    const upd = await h.api('paolo.ferri').patch(`/api/requests/${created.body.id}`, { status: 'resolved', resolutionNote: 'Sostituita.' });
    expect(upd.body).toMatchObject({ status: 'resolved', resolutionNote: 'Sostituita.' });
    const closed = await h.api('sara.colombo').patch(`/api/requests/${created.body.id}`, { status: 'closed' });
    expect(closed.status).toBe(200);
  });
});

describe('Conservazione dei dati (GDPR)', () => {
  it('anonimizza le prenotazioni più vecchie del periodo di conservazione mantenendo i dati per i KPI', async () => {
    const settings = await getSettings(h.db);
    const before = (await h.db.query<any>('select count(*)::int as n from booking where organizer_id is not null')).rows[0].n;
    expect(before).toBeGreaterThan(0);
    // 200 days later every seeded booking is older than 180 days.
    const later = new Date(h.clock.now().getTime() + 200 * 86_400_000);
    const r = await applyRetention(h.db, settings, later);
    expect(r.bookings).toBe(before);
    const left = (await h.db.query<any>('select count(*)::int as n from booking where organizer_id is not null or title is not null or booked_for_id is not null')).rows[0].n;
    expect(left).toBe(0);
    // Aggregated KPIs are unchanged.
    const kpi = await h.api('giulia.rinaldi').get('/api/admin/kpi?from=2026-10-13&to=2026-10-13&kind=room');
    expect(kpi.body.totals.occupiedMinutes).toBe(300);
  });

  it('agli altri utenti l\'agenda di una sala mostra solo orari, senza titolo né organizzatore', async () => {
    await h.api('marco.esposito').post('/api/bookings', {
      resourceId: h.ids.resources.volta,
      start: local(TODAY, '15:00').toISOString(),
      end: local(TODAY, '16:00').toISOString(),
      title: 'Trattativa riservata',
    });
    const other = await h.api('sara.colombo').get(`/api/resources/${h.ids.resources.volta}?date=${TODAY}`);
    const entry = other.body.agenda.find((b: any) => b.start === local(TODAY, '15:00').toISOString());
    expect(entry.title).toBeNull();
    expect(entry.organizerName).toBeNull();
    const own = await h.api('marco.esposito').get(`/api/resources/${h.ids.resources.volta}?date=${TODAY}`);
    expect(own.body.agenda.find((b: any) => b.title === 'Trattativa riservata')).toBeDefined();
  });
});

/**
 * Acceptance tests 1-11 of the specification, run against the simulated Exchange (GRAPH_MODE=mock).
 * The real HTTP routes are exercised through Fastify's inject(); Exchange behaviour (resource auto-accept,
 * conflicts, declines, change notifications) is provided by FakeExchange.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, local, type Harness } from './harness.js';

const TODAY = '2026-10-14';
const TOMORROW = '2026-10-15';
const iso = (d: string, t: string) => local(d, t).toISOString();
const mailbox = (name: string) => `${name}@ufficio.example`;

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

describe('Test di accettazione (modalità mock di Microsoft Graph)', () => {
  it("AT01 - la prenotazione di una sala libera dall'add-in crea l'evento nel calendario dell'utente e della sala", async () => {
    const res = await h.api('marco.esposito').post('/api/bookings', {
      resourceId: h.ids.resources.volta,
      start: iso(TODAY, '10:00'),
      end: iso(TODAY, '11:00'),
      title: 'Riunione dal task pane di Outlook',
      source: 'addin',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('confirmed');
    expect(res.body.source).toBe('addin');

    const userEvents = h.fake.eventsOf(mailbox('marco.esposito'));
    expect(userEvents).toHaveLength(1);
    const ev = userEvents[0]!;
    expect(ev.subject).toBe('Riunione dal task pane di Outlook');
    expect(ev.start.toISOString()).toBe(iso(TODAY, '10:00'));
    expect(ev.attendees.find((a) => a.email === mailbox('sala.volta'))).toMatchObject({ type: 'resource', response: 'accepted' });

    const roomEvents = h.fake.eventsOf(mailbox('sala.volta'));
    expect(roomEvents).toHaveLength(1);
    expect(roomEvents[0]!.iCalUId).toBe(ev.iCalUId);
    expect(roomEvents[0]!.organizerEmail).toBe(mailbox('marco.esposito'));

    const row = (await h.db.query('select ical_uid, organizer_event_id, resource_event_id from booking where id = $1', [res.body.id])).rows[0];
    expect(row.ical_uid).toBe(ev.iCalUId);
    expect(row.organizer_event_id).toBe(ev.id);
    expect(row.resource_event_id).toBe(roomEvents[0]!.id);
  });

  it('AT02 - prenotare uno slot occupato mostra il conflitto e propone alternative', async () => {
    const first = await h.api('elena.ricci').post('/api/bookings', {
      resourceId: h.ids.resources.volta,
      start: iso(TODAY, '10:00'),
      end: iso(TODAY, '11:00'),
    });
    expect(first.status).toBe(201);

    const res = await h.api('marco.esposito').post('/api/bookings', {
      resourceId: h.ids.resources.volta,
      start: iso(TODAY, '10:30'),
      end: iso(TODAY, '11:30'),
      attendeeCount: 5,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(res.body.message).toContain('Sala Volta');
    const alt = res.body.details.alternatives;
    // Other rooms free at the same time, with enough seats for 5 people.
    const names = alt.resources.map((r: any) => r.resourceName);
    expect(names).toEqual(expect.arrayContaining(['Sala Montalcini', 'Sala Galilei']));
    expect(names).not.toContain('Sala Fermi'); // 4 seats only
    // The same room at the nearest free times.
    expect(alt.times.length).toBeGreaterThan(0);
    expect(alt.times.map((t: any) => t.start)).toContain(iso(TODAY, '11:00'));
    // Nothing was written to Exchange for the rejected request.
    expect(h.fake.eventsOf(mailbox('marco.esposito'))).toHaveLength(0);

    // A conflict that exists only in Exchange (booked in Outlook, not yet synchronised) is detected too.
    const sink = h.fake.sink;
    h.fake.sink = null;
    await h.fake.createEvent({ kind: 'user', email: mailbox('davide.gallo') }, mailbox('davide.gallo'), {
      subject: 'Prenotata da Outlook',
      start: local(TODAY, '15:00'),
      end: local(TODAY, '16:00'),
      attendees: [{ email: mailbox('sala.fermi'), type: 'resource' }],
    });
    const res2 = await h.api('marco.esposito').post('/api/bookings', {
      resourceId: h.ids.resources.fermi,
      start: iso(TODAY, '15:30'),
      end: iso(TODAY, '16:30'),
    });
    expect(res2.status).toBe(409);
    expect(res2.body.details.conflicts.map((c: any) => c.source)).toEqual(['exchange']);
    h.fake.sink = sink;
  });

  it('AT03 - senza check-in entro la tolleranza la prenotazione viene rilasciata e il calendario aggiornato', async () => {
    const res = await h.api('marco.esposito').post('/api/bookings', {
      resourceId: h.ids.resources.volta,
      start: iso(TODAY, '09:30'),
      end: iso(TODAY, '10:30'),
    });
    expect(res.status).toBe(201);
    const uid = h.fake.eventsOf(mailbox('marco.esposito'))[0]!.iCalUId;

    h.clock.set(iso(TODAY, '09:39'));
    expect(await h.ctx.bookings.releaseNoShows()).toBe(0);

    h.clock.set(iso(TODAY, '09:40'));
    expect(await h.ctx.bookings.releaseNoShows()).toBe(1);
    await h.settle();

    const b = (await h.api('marco.esposito').get(`/api/bookings/${res.body.id}`)).body;
    expect(b.status).toBe('released');
    expect(b.releaseReason).toBe('no_show');
    // The room declined the meeting: it is gone from the room's calendar and the organizer sees the decline.
    expect(h.fake.eventsOf(mailbox('sala.volta')).find((e) => e.iCalUId === uid)).toBeUndefined();
    const orgEvent = h.fake.eventsOf(mailbox('marco.esposito'))[0]!;
    expect(orgEvent.attendees.find((a) => a.email === mailbox('sala.volta'))!.response).toBe('declined');
    const free = await h.fake.getSchedule({ kind: 'app' }, [mailbox('sala.volta')], local(TODAY, '09:45'), local(TODAY, '10:30'));
    expect(free[mailbox('sala.volta')]).toHaveLength(0);

    // The released time can be booked again.
    const again = await h.api('sara.colombo').post('/api/bookings', {
      resourceId: h.ids.resources.volta,
      start: iso(TODAY, '09:45'),
      end: iso(TODAY, '10:30'),
    });
    expect(again.status).toBe(201);
    // The synchronisation did not resurrect the released booking.
    expect((await h.api('marco.esposito').get(`/api/bookings/${res.body.id}`)).body.status).toBe('released');
  });

  it('AT04 - il check-out anticipato libera il tempo rimanente', async () => {
    const res = await h.api('marco.esposito').post('/api/bookings', {
      resourceId: h.ids.resources.volta,
      start: iso(TODAY, '10:00'),
      end: iso(TODAY, '11:00'),
    });
    expect(res.status).toBe(201);
    h.clock.set(iso(TODAY, '10:02'));
    const ci = await h.api('marco.esposito').post(`/api/bookings/${res.body.id}/check-in`);
    expect(ci.status).toBe(200);
    expect(ci.body.checkedInAt).not.toBeNull();

    // Before the check-out the room is busy.
    const busy = await h.api('sara.colombo').post('/api/bookings', {
      resourceId: h.ids.resources.volta,
      start: iso(TODAY, '10:30'),
      end: iso(TODAY, '11:00'),
    });
    expect(busy.status).toBe(409);

    h.clock.set(iso(TODAY, '10:30'));
    const co = await h.api('marco.esposito').post(`/api/bookings/${res.body.id}/check-out`);
    expect(co.status).toBe(200);
    expect(co.body.status).toBe('completed');
    expect(co.body.effectiveEnd).toBe(iso(TODAY, '10:30'));
    await h.settle();
    expect(h.fake.eventsOf(mailbox('sala.volta'))).toHaveLength(0);

    const free = await h.api('sara.colombo').post('/api/bookings', {
      resourceId: h.ids.resources.volta,
      start: iso(TODAY, '10:30'),
      end: iso(TODAY, '11:00'),
    });
    expect(free.status).toBe(201);
    expect(free.body.status).toBe('confirmed');
  });

  it("AT05 - una prenotazione ricorrente crea la serie e gestisce un'occorrenza in conflitto", async () => {
    // Existing booking that collides with the third Thursday (29/10, after the change from summer time).
    const blocker = await h.api('davide.gallo').post('/api/bookings', {
      resourceId: h.ids.resources.galilei,
      start: iso('2026-10-29', '11:00'),
      end: iso('2026-10-29', '12:00'),
    });
    expect(blocker.status).toBe(201);

    const request = {
      resourceId: h.ids.resources.galilei,
      start: iso(TOMORROW, '11:00'),
      end: iso(TOMORROW, '12:00'),
      title: 'Stato avanzamento settimanale',
      recurrence: { type: 'weekly', interval: 1, daysOfWeek: [4], count: 5 },
    };
    const ask = await h.api('marco.esposito').post('/api/bookings/recurring', request);
    expect(ask.status).toBe(409);
    expect(ask.body.code).toBe('RECURRENCE_CONFLICT');
    const occ = ask.body.details.occurrences;
    expect(occ).toHaveLength(5);
    expect(occ.filter((o: any) => o.conflict).map((o: any) => o.start)).toEqual([iso('2026-10-29', '11:00')]);
    const altRoom = occ[2].alternatives.find((a: any) => a.resourceName === 'Sala Montalcini');
    expect(altRoom).toBeDefined();
    expect(h.fake.eventsOf(mailbox('marco.esposito'))).toHaveLength(0);

    const res = await h.api('marco.esposito').post('/api/bookings/recurring', {
      ...request,
      conflictStrategy: 'skip',
      alternatives: { [iso('2026-10-29', '11:00')]: altRoom.resourceId },
    });
    expect(res.status).toBe(201);
    expect(res.body.bookings).toHaveLength(4);
    expect(res.body.bookings.every((b: any) => b.status === 'confirmed')).toBe(true);
    expect(res.body.skipped).toEqual([{ start: iso('2026-10-29', '11:00'), end: iso('2026-10-29', '12:00') }]);
    expect(res.body.alternatives).toHaveLength(1);
    expect(res.body.alternatives[0].resourceName).toBe('Sala Montalcini');

    // Local time is preserved across the DST change (11:00 = 09:00Z in October, 10:00Z in November).
    expect(res.body.bookings.map((b: any) => b.start)).toEqual([
      '2026-10-15T09:00:00.000Z',
      '2026-10-22T09:00:00.000Z',
      '2026-11-05T10:00:00.000Z',
      '2026-11-12T10:00:00.000Z',
    ]);
    // Outlook: two series segments around the conflicting date, both accepted by the room.
    const masters = h.fake.mastersOf(mailbox('marco.esposito'));
    expect(masters).toHaveLength(2);
    const roomOcc = h.fake.eventsOf(mailbox('sala.galilei')).filter((e) => e.organizerEmail === mailbox('marco.esposito'));
    expect(roomOcc).toHaveLength(4);
    expect(h.fake.eventsOf(mailbox('sala.montalcini')).map((e) => e.start.toISOString())).toContain('2026-10-29T10:00:00.000Z');

    // Why the segments: with the Exchange defaults (MaximumConflictInstances 0) a single series with one
    // conflicting occurrence is declined by the room as a whole.
    const raw = await h.fake.createEvent({ kind: 'user', email: mailbox('sara.colombo') }, mailbox('sara.colombo'), {
      subject: 'Serie con conflitto',
      start: local(TOMORROW, '11:00'),
      end: local(TOMORROW, '12:00'),
      attendees: [{ email: mailbox('sala.galilei'), type: 'resource' }],
      recurrence: {
        pattern: { type: 'weekly', interval: 1, daysOfWeek: ['thursday'], firstDayOfWeek: 'monday' },
        range: { type: 'endDate', startDate: TOMORROW, endDate: '2026-11-12', recurrenceTimeZone: 'W. Europe Standard Time' },
      },
    });
    expect(raw.attendees.find((a) => a.email === mailbox('sala.galilei'))!.response).toBe('declined');
  });

  it('AT06 - una proposta blocca 3 slot e ne rilascia 2 dopo la conferma', async () => {
    const res = await h.api('marco.esposito').post('/api/proposals', {
      title: 'Workshop con il cliente',
      options: [
        { resourceId: h.ids.resources.volta, start: iso(TODAY, '15:00'), end: iso(TODAY, '16:00') },
        { resourceId: h.ids.resources.fermi, start: iso(TODAY, '15:00'), end: iso(TODAY, '16:00') },
        { resourceId: h.ids.resources.galilei, start: iso(TOMORROW, '09:00'), end: iso(TOMORROW, '10:00') },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('open');
    expect(res.body.options).toHaveLength(3);
    expect(res.body.options.every((o: any) => o.status === 'tentative')).toBe(true);
    // Three tentative holds in Outlook, each accepted by its room.
    const holds = h.fake.eventsOf(mailbox('marco.esposito'));
    expect(holds).toHaveLength(3);
    expect(holds.every((e) => e.showAs === 'tentative' && e.subject.startsWith('[Proposta]'))).toBe(true);
    for (const room of ['sala.volta', 'sala.fermi', 'sala.galilei']) expect(h.fake.eventsOf(mailbox(room))).toHaveLength(1);

    // While held, the slots are not bookable by others.
    const blocked = await h.api('sara.colombo').post('/api/bookings', {
      resourceId: h.ids.resources.volta,
      start: iso(TODAY, '15:00'),
      end: iso(TODAY, '16:00'),
    });
    expect(blocked.status).toBe(409);

    const chosen = res.body.options.find((o: any) => o.resourceName === 'Sala Fermi');
    const conf = await h.api('marco.esposito').post(`/api/proposals/${res.body.id}/confirm`, { bookingId: chosen.id });
    expect(conf.status).toBe(200);
    expect(conf.body.status).toBe('confirmed');
    const byRoom = Object.fromEntries(conf.body.options.map((o: any) => [o.resourceName, o]));
    expect(byRoom['Sala Fermi'].status).toBe('confirmed');
    expect(byRoom['Sala Fermi'].title).toBe('Workshop con il cliente');
    expect(byRoom['Sala Volta'].status).toBe('released');
    expect(byRoom['Sala Volta'].releaseReason).toBe('proposal_not_chosen');
    expect(byRoom['Sala Galilei'].status).toBe('released');
    await h.settle();

    // Exchange: only the chosen event remains, now busy; the other two rooms are free again.
    const remaining = h.fake.eventsOf(mailbox('marco.esposito'));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ subject: 'Workshop con il cliente', showAs: 'busy' });
    expect(h.fake.eventsOf(mailbox('sala.fermi'))).toHaveLength(1);
    expect(h.fake.eventsOf(mailbox('sala.volta'))).toHaveLength(0);
    expect(h.fake.eventsOf(mailbox('sala.galilei'))).toHaveLength(0);
    const nowFree = await h.api('sara.colombo').post('/api/bookings', {
      resourceId: h.ids.resources.volta,
      start: iso(TODAY, '15:00'),
      end: iso(TODAY, '16:00'),
    });
    expect(nowFree.status).toBe(201);
  });

  it('AT07 - la reception prenota "per conto di" un utente', async () => {
    const res = await h.api('paolo.ferri').post('/api/bookings', {
      resourceId: h.ids.resources.montalcini,
      start: iso(TODAY, '14:00'),
      end: iso(TODAY, '15:00'),
      title: 'Incontro con fornitore',
      bookedForEmail: mailbox('chiara.moretti'),
      source: 'reception',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('confirmed');
    expect(res.body.organizerName).toBe('Paolo Ferri');
    expect(res.body.bookedForName).toBe('Chiara Moretti');
    // Reception's calendar (organizer), the beneficiary's calendar (invitation) and the room's calendar.
    expect(h.fake.eventsOf(mailbox('paolo.ferri'))).toHaveLength(1);
    const invite = h.fake.eventsOf(mailbox('chiara.moretti'));
    expect(invite).toHaveLength(1);
    expect(invite[0]!.subject).toBe('Incontro con fornitore');
    expect(h.fake.eventsOf(mailbox('sala.montalcini'))).toHaveLength(1);

    // The beneficiary sees the booking and can check in.
    const mine = await h.api('chiara.moretti').get(`/api/bookings/mine?date=${TODAY}`);
    expect(mine.body.map((b: any) => b.id)).toContain(res.body.id);
    h.clock.set(iso(TODAY, '14:03'));
    const ci = await h.api('chiara.moretti').post(`/api/bookings/${res.body.id}/check-in`);
    expect(ci.status).toBe(200);

    // A normal user cannot book on behalf of others.
    const denied = await h.api('marco.esposito').post('/api/bookings', {
      resourceId: h.ids.resources.galilei,
      start: iso(TODAY, '16:00'),
      end: iso(TODAY, '17:00'),
      bookedForEmail: mailbox('sara.colombo'),
    });
    expect(denied.status).toBe(403);
  });

  it('AT08 - la prenotazione di una postazione sulla planimetria rifiuta la doppia prenotazione', async () => {
    const floor = h.ids.floors[1];
    const range = `start=${encodeURIComponent(iso(TODAY, '09:00'))}&end=${encodeURIComponent(iso(TODAY, '18:00'))}`;
    const before = await h.api('luca.bianchi').get(`/api/floors/${floor}/desks?${range}`);
    expect(before.status).toBe(200);
    expect(before.body.filter((d: any) => d.resource.kind === 'desk')).toHaveLength(12);
    const desk = before.body.find((d: any) => d.resource.name === 'P1-06');
    expect(desk.state).toBe('free');
    expect(desk.resource.mapX).toBeGreaterThan(0);

    const booked = await h.api('luca.bianchi').post('/api/bookings', {
      resourceId: desk.resource.id,
      start: iso(TODAY, '09:30'),
      end: iso(TODAY, '18:00'),
    });
    expect(booked.status).toBe(201);
    expect(booked.body.status).toBe('confirmed');
    // The desk has no Exchange mailbox: the booking appears in the user's own Outlook calendar as "free".
    const entry = h.fake.eventsOf(mailbox('luca.bianchi'));
    expect(entry).toHaveLength(1);
    expect(entry[0]!.showAs).toBe('free');

    const forSara = await h.api('sara.colombo').get(`/api/floors/${floor}/desks?${range}`);
    const seen = forSara.body.find((d: any) => d.resource.name === 'P1-06');
    expect(seen.state).toBe('booked');
    expect(seen.occupantName).toBe('Luca Bianchi');
    const forLuca = await h.api('luca.bianchi').get(`/api/floors/${floor}/desks?${range}`);
    expect(forLuca.body.find((d: any) => d.resource.name === 'P1-06').state).toBe('mine');

    const dup = await h.api('sara.colombo').post('/api/bookings', {
      resourceId: desk.resource.id,
      start: iso(TODAY, '14:00'),
      end: iso(TODAY, '16:00'),
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('CONFLICT');
    expect(dup.body.details.alternatives.resources.length).toBeGreaterThan(0);

    // Concurrent attempts on the same free desk: exactly one wins.
    const desk7 = before.body.find((d: any) => d.resource.name === 'P1-07').resource.id;
    const attempts = await Promise.all(
      ['sara.colombo', 'davide.gallo', 'elena.ricci'].map((u) =>
        h.api(u).post('/api/bookings', { resourceId: desk7, start: iso(TOMORROW, '09:00'), end: iso(TOMORROW, '18:00') }),
      ),
    );
    expect(attempts.filter((a) => a.status === 201)).toHaveLength(1);
    expect(attempts.filter((a) => a.status === 409)).toHaveLength(2);
  });

  it('AT09 - una risorsa condivisa si prenota tramite QR code', async () => {
    const admin = await h.api('giulia.rinaldi').get('/api/admin/resources');
    const projector = admin.body.find((r: any) => r.name === 'Proiettore portatile');
    expect(projector.qrUrl).toMatch(/^https:\/\/ritrovo\.test\/q\/[A-Za-z0-9_-]{20,}$/);
    const token = projector.qrUrl.split('/q/')[1];
    const svg = await h.api('giulia.rinaldi').get(`/api/admin/resources/${projector.id}/qr.svg`);
    expect(svg.status).toBe(200);
    expect(svg.text).toContain('<svg');

    const scan = await h.api('sara.colombo').get(`/api/qr/${token}`);
    expect(scan.status).toBe(200);
    expect(scan.body.resource.name).toBe('Proiettore portatile');
    expect(scan.body.freeNow).toBe(true);

    const book = await h.api('sara.colombo').post(`/api/qr/${token}/book`, { durationMinutes: 120 });
    expect(book.status).toBe(201);
    expect(book.body.source).toBe('qr');
    expect(book.body.status).toBe('confirmed');
    expect(book.body.checkedInAt).not.toBeNull();
    expect(book.body.start).toBe(iso(TODAY, '09:00'));
    expect(book.body.end).toBe(iso(TODAY, '11:00'));
    // Equipment mailbox and user calendar.
    expect(h.fake.eventsOf(mailbox('proiettore'))).toHaveLength(1);
    expect(h.fake.eventsOf(mailbox('sara.colombo'))).toHaveLength(1);

    const again = await h.api('marco.esposito').post(`/api/qr/${token}/book`, { durationMinutes: 60 });
    expect(again.status).toBe(409);

    h.clock.set(iso(TODAY, '10:00'));
    const out = await h.api('sara.colombo').post(`/api/qr/${token}/check-out`);
    expect(out.status).toBe(200);
    expect(out.body.status).toBe('completed');
    await h.settle();
    expect(h.fake.eventsOf(mailbox('proiettore'))).toHaveLength(0);

    const invalid = await h.api('sara.colombo').get('/api/qr/token-inesistente-123');
    expect(invalid.status).toBe(404);
  });

  it('AT10 - il report KPI restituisce occupazione e no-show corretti sui dati di esempio', async () => {
    // Seed scenario on Tuesday 13/10/2026 (working hours 08:00-19:00 = 660 minutes per resource).
    const rooms = await h.api('giulia.rinaldi').get('/api/admin/kpi?from=2026-10-13&to=2026-10-13&kind=room');
    expect(rooms.status).toBe(200);
    expect(rooms.body.totals).toEqual({
      resources: 4,
      bookings: 6, // the cancelled booking is excluded
      availableMinutes: 2640, // 4 x 660
      bookedMinutes: 450, // 60 + 60 + 120 + 90 + 60 + 60
      occupiedMinutes: 300, // 60 + 90 (check-out at 15:30) + 90 + 60; the two no-shows count zero
      bookingRate: 0.1705,
      occupancyRate: 0.1136, // 300 / 2640
      checkInEligible: 6,
      noShows: 2,
      noShowRate: 0.3333, // 2 / 6
    });
    const volta = rooms.body.perResource.find((r: any) => r.resourceName === 'Sala Volta');
    expect(volta).toMatchObject({ bookings: 3, bookedMinutes: 240, occupiedMinutes: 150, noShows: 1, occupancyRate: 0.2273, noShowRate: 0.3333 });
    const peak = Object.fromEntries(rooms.body.peakHours.map((p: any) => [p.hour, p.averageOccupancy]));
    expect(peak[9]).toBe(0.25); // Volta 09-10 (Montalcini 09:30 no-show)
    expect(peak[10]).toBe(0.25); // Fermi 10-11
    expect(peak[11]).toBe(0.125); // Fermi 11:00-11:30
    expect(peak[15]).toBe(0.125); // Volta until the 15:30 check-out
    expect(peak[12]).toBe(0);

    const desks = await h.api('giulia.rinaldi').get('/api/admin/kpi?from=2026-10-13&to=2026-10-13&kind=desk');
    expect(desks.body.totals).toMatchObject({ resources: 20, occupiedMinutes: 780, availableMinutes: 13200, occupancyRate: 0.0591, noShows: 1, checkInEligible: 3, noShowRate: 0.3333 });

    const all = await h.api('giulia.rinaldi').get('/api/admin/kpi?from=2026-10-13&to=2026-10-13');
    expect(all.body.totals).toMatchObject({ resources: 27, occupiedMinutes: 1860, availableMinutes: 17820, occupancyRate: 0.1044, noShows: 3, checkInEligible: 10, noShowRate: 0.3 });

    const csv = await h.api('giulia.rinaldi').get('/api/admin/kpi.csv?from=2026-10-13&to=2026-10-13&kind=room');
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toContain('text/csv');
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    expect(csv.text).toContain('Periodo;13/10/2026 - 13/10/2026');
    expect(csv.text).toContain('Sala Volta;Sala riunioni;3;660;240;150;22,7;1;33,3');
    expect(csv.text).toContain('Totale;;6;2640;450;300;11,4;2;33,3');
  });

  it('AT11 - un utente non amministratore non accede al pannello di amministrazione', async () => {
    const endpoints = ['/api/admin/resources', '/api/admin/kpi?from=2026-10-13&to=2026-10-13', '/api/admin/users', '/api/admin/settings', '/api/admin/live'];
    for (const url of endpoints) {
      expect((await h.api('marco.esposito').get(url)).status).toBe(403);
      expect((await h.api('paolo.ferri').get(url)).status).toBe(403);
      expect((await h.api(null).get(url)).status).toBe(401);
      expect((await h.api('giulia.rinaldi').get(url)).status).toBe(200);
    }
    const write = await h.api('marco.esposito').post('/api/admin/resources', { kind: 'room', name: 'Sala abusiva' });
    expect(write.status).toBe(403);
    const msg = (await h.api('marco.esposito').get('/api/admin/resources')).body.message;
    expect(msg).toBe('Il pannello di amministrazione è riservato agli amministratori.');
    // A forged token is rejected.
    const forged = await h.app.inject({ method: 'GET', url: '/api/admin/resources', headers: { authorization: 'Bearer eyJhbGciOiJub25lIn0.e30.' } });
    expect(forged.statusCode).toBe(401);
  });
});

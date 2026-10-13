import { describe, expect, it, vi } from 'vitest';
import { addRoomToMeeting, readContext } from './office';

type Cb = (r: { status: string; value?: unknown; error?: { message: string } }) => void;
const ok = (value?: unknown) => (cb: Cb) => cb({ status: 'succeeded', value });

function fakeOffice(opts: { compose: boolean; mailbox18?: boolean; attendees?: string[] }) {
  const added: unknown[] = [];
  const locations: unknown[] = [];
  const item: any = {
    itemType: 'appointment',
    subject: opts.compose ? { getAsync: ok('Riunione progetto') } : 'Riunione progetto',
    start: opts.compose ? { getAsync: ok(new Date('2026-10-14T08:00:00Z')) } : new Date('2026-10-14T08:00:00Z'),
    end: opts.compose ? { getAsync: ok(new Date('2026-10-14T09:00:00Z')) } : new Date('2026-10-14T09:00:00Z'),
    requiredAttendees: {
      getAsync: ok((opts.attendees ?? []).map((e) => ({ emailAddress: e }))),
      addAsync: (list: unknown[], cb: Cb) => {
        added.push(...list);
        cb({ status: 'succeeded' });
      },
    },
    optionalAttendees: { getAsync: ok([]) },
    enhancedLocation: {
      addAsync: (list: unknown[], cb: Cb) => {
        locations.push(...list);
        cb({ status: 'succeeded' });
      },
    },
    location: { setAsync: vi.fn((_v: string, cb: Cb) => cb({ status: 'succeeded' })) },
  };
  const office: any = {
    context: {
      mailbox: { item },
      requirements: { isSetSupported: (_n: string, v: string) => (opts.mailbox18 ?? true) || Number(v) < 1.8 },
    },
    MailboxEnums: { ItemType: { Appointment: 'appointment', Message: 'message' }, LocationType: { Room: 'room', Custom: 'custom' } },
    EventType: { AppointmentTimeChanged: 'appointmentTimeChanged' },
  };
  return { office, added, locations, item };
}

describe('Add-in Outlook: wrapper Office.js', () => {
  it("legge orario, oggetto e numero di partecipanti della riunione in composizione (organizzatore)", async () => {
    const { office } = fakeOffice({ compose: true, attendees: ['a@x.it', 'b@x.it'] });
    const ctx = await readContext(office);
    expect(ctx).toEqual({ kind: 'organizer', start: new Date('2026-10-14T08:00:00Z'), end: new Date('2026-10-14T09:00:00Z'), subject: 'Riunione progetto', attendees: 3 });
  });

  it('riconosce lettura di riunione, messaggio e assenza di contesto', async () => {
    expect((await readContext(fakeOffice({ compose: false }).office)).kind).toBe('attendee');
    const msg = fakeOffice({ compose: false });
    msg.item.itemType = 'message';
    expect((await readContext(msg.office)).kind).toBe('message');
    expect((await readContext(undefined)).kind).toBe('none');
  });

  it('aggiunge la sala come luogo (tipo Room) e come partecipante, senza duplicati', async () => {
    const f = fakeOffice({ compose: true });
    await addRoomToMeeting(f.office, { email: 'Sala.Volta@ufficio.example', name: 'Sala Volta' });
    expect(f.locations).toEqual([{ id: 'sala.volta@ufficio.example', type: 'room' }]);
    expect(f.added).toEqual([{ displayName: 'Sala Volta', emailAddress: 'sala.volta@ufficio.example' }]);
    const g = fakeOffice({ compose: true, attendees: ['sala.volta@ufficio.example'] });
    await addRoomToMeeting(g.office, { email: 'sala.volta@ufficio.example', name: 'Sala Volta' });
    expect(g.added).toEqual([]);
  });

  it('con Mailbox < 1.8 usa il campo location testuale', async () => {
    const f = fakeOffice({ compose: true, mailbox18: false });
    await addRoomToMeeting(f.office, { email: 'sala.fermi@ufficio.example', name: 'Sala Fermi' });
    expect(f.item.location.setAsync).toHaveBeenCalledWith('Sala Fermi', expect.any(Function));
    expect(f.locations).toEqual([]);
  });

  it('propaga gli errori di Outlook', async () => {
    const f = fakeOffice({ compose: true });
    f.item.enhancedLocation.addAsync = (_l: unknown, cb: Cb) => cb({ status: 'failed', error: { message: 'Sala non valida' } });
    await expect(addRoomToMeeting(f.office, { email: 'x@y.it', name: 'X' })).rejects.toThrow('Sala non valida');
  });
});

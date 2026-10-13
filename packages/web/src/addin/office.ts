/**
 * Thin, testable wrappers around Office.js for the Outlook task pane.
 * Requirement sets: Mailbox 1.1 for basic item access, 1.7 for the time-changed event, 1.8 for enhancedLocation.
 */
export type AddinContext =
  | { kind: 'organizer'; start: Date; end: Date; subject: string; attendees: number }
  | { kind: 'attendee'; start: Date; end: Date; subject: string }
  | { kind: 'message' }
  | { kind: 'none' };

type AsyncCallback<T> = (result: { status: string; value: T; error?: { message: string } }) => void;

function call<T>(fn: (cb: AsyncCallback<T>) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((r) => (r.status === 'succeeded' ? resolve(r.value) : reject(new Error(r.error?.message ?? 'Operazione Outlook non riuscita'))));
  });
}

export async function readContext(office: typeof Office | undefined): Promise<AddinContext> {
  const item = office?.context?.mailbox?.item as any;
  if (!item) return { kind: 'none' };
  const isAppointment = item.itemType === 'appointment' || item.itemType === office?.MailboxEnums?.ItemType?.Appointment;
  if (!isAppointment) return { kind: 'message' };
  if (typeof item.start?.getAsync === 'function') {
    const [start, end, subject, required, optional] = await Promise.all([
      call<Date>((cb) => item.start.getAsync(cb)),
      call<Date>((cb) => item.end.getAsync(cb)),
      call<string>((cb) => item.subject.getAsync(cb)).catch(() => ''),
      call<unknown[]>((cb) => item.requiredAttendees.getAsync(cb)).catch(() => []),
      call<unknown[]>((cb) => item.optionalAttendees.getAsync(cb)).catch(() => []),
    ]);
    return { kind: 'organizer', start: new Date(start), end: new Date(end), subject: subject ?? '', attendees: 1 + required.length + optional.length };
  }
  return { kind: 'attendee', start: new Date(item.start), end: new Date(item.end), subject: item.subject ?? '' };
}

/**
 * Adds a room to the meeting being composed: as location (type Room, Mailbox 1.8) and as attendee, so Exchange
 * always delivers the meeting request to the room's mailbox when the organizer sends the invitation.
 */
export async function addRoomToMeeting(office: typeof Office, room: { email: string; name: string }): Promise<void> {
  const item = office.context.mailbox.item as any;
  const email = room.email.toLowerCase();
  if (office.context.requirements.isSetSupported('Mailbox', '1.8') && item.enhancedLocation) {
    await call<void>((cb) => item.enhancedLocation.addAsync([{ id: email, type: office.MailboxEnums.LocationType.Room }], cb));
  } else {
    await call<void>((cb) => item.location.setAsync(room.name, cb));
  }
  const required = await call<Array<{ emailAddress: string }>>((cb) => item.requiredAttendees.getAsync(cb)).catch(() => []);
  const optional = await call<Array<{ emailAddress: string }>>((cb) => item.optionalAttendees.getAsync(cb)).catch(() => []);
  if (![...required, ...optional].some((a) => a.emailAddress?.toLowerCase() === email)) {
    await call<void>((cb) => item.requiredAttendees.addAsync([{ displayName: room.name, emailAddress: email }], cb));
  }
}

/** Re-reads the meeting time when the organizer changes it (Mailbox 1.7). */
export function onAppointmentTimeChanged(office: typeof Office, handler: () => void): void {
  const item = office.context.mailbox.item as any;
  if (office.context.requirements.isSetSupported('Mailbox', '1.7') && item?.addHandlerAsync) {
    item.addHandlerAsync(office.EventType.AppointmentTimeChanged, handler);
  }
}

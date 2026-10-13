import type { GraphRecurrence } from '../domain/recurrence.js';

/**
 * Who performs a Graph call.
 * - user: delegated, on behalf of the signed-in user (on-behalf-of flow with the user's access token).
 * - app: application permission, limited by Exchange RBAC for Applications to resource mailboxes.
 */
export type GraphCaller = { kind: 'user'; email: string; token?: string } | { kind: 'app' };

export type AttendeeType = 'required' | 'optional' | 'resource';
export type ResponseType = 'none' | 'organizer' | 'tentativelyAccepted' | 'accepted' | 'declined' | 'notResponded';
export type ShowAs = 'free' | 'tentative' | 'busy' | 'oof' | 'workingElsewhere' | 'unknown';

export interface GraphAttendee {
  email: string;
  name?: string;
  type: AttendeeType;
  response: ResponseType;
}

export interface GraphEvent {
  id: string;
  iCalUId: string;
  subject: string;
  start: Date;
  end: Date;
  organizerEmail: string;
  organizerName?: string;
  attendees: GraphAttendee[];
  showAs: ShowAs;
  isCancelled: boolean;
  type: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster';
  seriesMasterId?: string;
  onlineMeetingUrl?: string;
  transactionId?: string;
  /** Response of the mailbox owner (for attendee copies). */
  responseStatus?: ResponseType;
}

export interface NewEventInput {
  subject: string;
  start: Date;
  end: Date;
  attendees: { email: string; name?: string; type: AttendeeType }[];
  location?: { displayName: string; email?: string; isRoom?: boolean };
  showAs?: 'busy' | 'tentative' | 'free';
  isOnlineMeeting?: boolean;
  bodyText?: string;
  /** Idempotency key: Graph does not create a second event for a retried POST with the same transactionId. */
  transactionId?: string;
  recurrence?: GraphRecurrence;
}

export interface EventPatch {
  subject?: string;
  start?: Date;
  end?: Date;
  showAs?: 'busy' | 'tentative' | 'free';
}

export interface BusyInterval {
  start: Date;
  end: Date;
  status: ShowAs;
}

export interface DeltaResult {
  events: GraphEvent[];
  removedIds: string[];
  deltaLink: string;
  /** True when this round started from scratch (initial sync or token reset). */
  full: boolean;
}

export interface GraphPlace {
  kind: 'room' | 'roomList' | 'workspace';
  displayName: string;
  emailAddress: string | null;
  capacity: number | null;
  building: string | null;
  floorLabel: string | null;
  tags: string[];
  isWheelChairAccessible: boolean;
  hasVideo: boolean;
  hasDisplay: boolean;
}

export interface GraphUser {
  displayName: string;
  email: string;
  department: string | null;
  jobTitle: string | null;
}

export interface GraphSubscription {
  id: string;
  expirationDateTime: Date;
}

export interface ChangeNotification {
  subscriptionId: string;
  clientState?: string;
  changeType: string;
  resource: string;
  lifecycleEvent?: 'reauthorizationRequired' | 'subscriptionRemoved' | 'missed';
}

/**
 * The single interface used by the domain layer. `LiveGraphGateway` performs real Microsoft Graph calls;
 * `FakeExchange` simulates Exchange Online for tests and the demo. The domain code never knows which one it uses.
 */
export interface GraphGateway {
  readonly mode: 'live' | 'mock';
  getSchedule(caller: GraphCaller, mailboxes: string[], start: Date, end: Date): Promise<Record<string, BusyInterval[]>>;
  createEvent(caller: GraphCaller, mailbox: string, input: NewEventInput): Promise<GraphEvent>;
  getEvent(caller: GraphCaller, mailbox: string, id: string): Promise<GraphEvent | null>;
  updateEvent(caller: GraphCaller, mailbox: string, id: string, patch: EventPatch): Promise<GraphEvent>;
  /** Organizer deletes the event: Exchange sends a cancellation to the attendees (resources free up). */
  deleteEvent(caller: GraphCaller, mailbox: string, id: string): Promise<void>;
  /** Organizer cancels with a message to the attendees. */
  cancelEvent(caller: GraphCaller, mailbox: string, id: string, comment: string): Promise<void>;
  /** Attendee (e.g. the room) declines: the organizer is notified and the attendee's time is freed. */
  declineEvent(caller: GraphCaller, mailbox: string, id: string, comment: string): Promise<void>;
  listInstances(caller: GraphCaller, mailbox: string, seriesMasterId: string, start: Date, end: Date): Promise<GraphEvent[]>;
  listCalendarView(caller: GraphCaller, mailbox: string, start: Date, end: Date): Promise<GraphEvent[]>;
  calendarViewDelta(
    caller: GraphCaller,
    mailbox: string,
    state: { deltaLink: string } | { start: Date; end: Date },
  ): Promise<DeltaResult>;
  createSubscription(
    mailbox: string,
    notificationUrl: string,
    lifecycleUrl: string,
    clientState: string,
    expiration: Date,
  ): Promise<GraphSubscription>;
  renewSubscription(id: string, expiration: Date): Promise<GraphSubscription>;
  deleteSubscription(id: string): Promise<void>;
  listPlaces(caller: GraphCaller, kind: 'room' | 'roomList' | 'workspace'): Promise<GraphPlace[]>;
  searchUsers(caller: GraphCaller, query: string): Promise<GraphUser[]>;
}

export class GraphError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Finds an event (or occurrence) in a mailbox by iCalUId around a known start time. */
export async function findEventByICalUId(
  graph: GraphGateway,
  caller: GraphCaller,
  mailbox: string,
  iCalUId: string,
  around: Date,
): Promise<GraphEvent | null> {
  const from = new Date(around.getTime() - 24 * 3600_000);
  const to = new Date(around.getTime() + 24 * 3600_000);
  const events = await graph.listCalendarView(caller, mailbox, from, to);
  return events.find((e) => e.iCalUId === iCalUId) ?? null;
}

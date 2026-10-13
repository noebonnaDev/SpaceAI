// Shared API contract between the Ritrovo server, the web app and the Outlook add-in.
// Only types and tiny pure helpers live here: no runtime dependencies.

export const APP_TIMEZONE = 'Europe/Rome';

export type Role = 'utente' | 'reception' | 'amministratore';
export type ResourceKind = 'room' | 'desk' | 'asset';
export type BookingStatus =
  | 'pending'
  | 'confirmed'
  | 'tentative'
  | 'completed'
  | 'released'
  | 'cancelled'
  | 'declined';
export type BookingSource = 'web' | 'addin' | 'outlook' | 'kiosk' | 'qr' | 'reception' | 'seed';
export type ReleaseReason =
  | 'no_show'
  | 'early_checkout'
  | 'proposal_not_chosen'
  | 'proposal_expired'
  | 'admin';
export type ProposalStatus = 'open' | 'confirmed' | 'expired' | 'cancelled';
export type RequestStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type RequestCategory = 'manutenzione' | 'pulizia' | 'it' | 'arredi' | 'altro';

/** Statuses that occupy a resource (used for conflict detection). */
export const ACTIVE_STATUSES: BookingStatus[] = ['pending', 'confirmed', 'tentative', 'completed'];

export const ROLE_RANK: Record<Role, number> = { utente: 0, reception: 1, amministratore: 2 };

export function hasRole(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  department: string | null;
  role: Role;
  hideFromColleagues: boolean;
}

export interface FloorDto {
  id: string;
  buildingId: string;
  name: string;
  sortOrder: number;
  hasMap: boolean;
  mapVersion: string | null;
}

export interface BuildingDto {
  id: string;
  name: string;
  address: string | null;
  floors: FloorDto[];
}

export interface ResourcePolicyDto {
  checkInRequired: boolean;
  checkInGraceMinutes: number;
  checkInOpensMinutesBefore: number;
  maxDurationMinutes: number;
  bookingWindowDays: number;
}

export interface ResourceDto {
  id: string;
  kind: ResourceKind;
  name: string;
  description: string | null;
  category: string | null;
  mailboxEmail: string | null;
  buildingId: string | null;
  buildingName: string | null;
  floorId: string | null;
  floorName: string | null;
  capacity: number;
  features: string[];
  mapX: number | null;
  mapY: number | null;
  isActive: boolean;
  isFavorite?: boolean;
  policy: ResourcePolicyDto;
  /** Present when availability for a time range was requested. */
  available?: boolean;
}

export interface BookingDto {
  id: string;
  resourceId: string;
  resourceName: string;
  resourceKind: ResourceKind;
  title: string | null;
  start: string;
  end: string;
  effectiveEnd: string | null;
  status: BookingStatus;
  source: BookingSource;
  organizerEmail: string | null;
  organizerName: string | null;
  bookedForId: string | null;
  bookedForName: string | null;
  createdById: string | null;
  isOnlineMeeting: boolean;
  onlineMeetingUrl: string | null;
  seriesId: string | null;
  proposalId: string | null;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  releasedAt: string | null;
  releaseReason: ReleaseReason | null;
  canCheckIn: boolean;
  canCheckOut: boolean;
  canCancel: boolean;
}

export interface AlternativeSlot {
  resourceId: string;
  resourceName: string;
  start: string;
  end: string;
}

export interface ConflictPayload {
  code: 'CONFLICT' | 'RESOURCE_DECLINED' | 'RECURRENCE_CONFLICT';
  message: string;
  conflicts: { start: string; end: string; source: 'ritrovo' | 'exchange' }[];
  alternatives: {
    /** Other resources free in the same time range. */
    resources: AlternativeSlot[];
    /** The same resource at the next free times. */
    times: AlternativeSlot[];
  };
  /** Only for RECURRENCE_CONFLICT: per-occurrence conflicts with suggested resources. */
  occurrences?: {
    start: string;
    end: string;
    conflict: boolean;
    alternatives: AlternativeSlot[];
  }[];
}

export interface ProposalDto {
  id: string;
  title: string;
  status: ProposalStatus;
  expiresAt: string;
  options: BookingDto[];
  confirmedBookingId: string | null;
}

export interface FacilityRequestDto {
  id: string;
  category: RequestCategory;
  title: string;
  description: string | null;
  status: RequestStatus;
  resourceId: string | null;
  resourceName: string | null;
  locationText: string | null;
  requesterName: string | null;
  assigneeName: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeskMapEntry {
  resource: ResourceDto;
  state: 'free' | 'booked' | 'mine';
  occupantName: string | null;
  bookingId: string | null;
}

export interface KpiResourceRow {
  resourceId: string;
  resourceName: string;
  kind: ResourceKind;
  bookings: number;
  availableMinutes: number;
  bookedMinutes: number;
  occupiedMinutes: number;
  occupancyRate: number;
  noShows: number;
  noShowRate: number;
}

export interface KpiReport {
  from: string;
  to: string;
  kind: ResourceKind | null;
  workingHours: { start: string; end: string; days: number[] };
  totals: {
    resources: number;
    bookings: number;
    availableMinutes: number;
    bookedMinutes: number;
    occupiedMinutes: number;
    bookingRate: number;
    occupancyRate: number;
    checkInEligible: number;
    noShows: number;
    noShowRate: number;
  };
  peakHours: { hour: number; averageOccupancy: number }[];
  perResource: KpiResourceRow[];
}

export interface LiveResourceState {
  resourceId: string;
  resourceName: string;
  kind: ResourceKind;
  floorName: string | null;
  state: 'free' | 'booked' | 'occupied' | 'awaiting_check_in';
  currentBooking: BookingDto | null;
  nextBooking: BookingDto | null;
}

export interface PublicConfig {
  appName: string;
  authMode: 'entra' | 'dev';
  graphMode: 'live' | 'mock';
  tenantId: string | null;
  clientId: string | null;
  apiScope: string | null;
  timezone: string;
  locale: string;
  publicBaseUrl: string;
}

/** Feature tags used for search filters (labels are translated in the UI). */
export const FEATURES = [
  'videoconferenza',
  'schermo',
  'proiettore',
  'lavagna',
  'telefono',
  'accessibile',
  'monitor',
  'docking',
  'scrivania_regolabile',
  'finestra',
] as const;

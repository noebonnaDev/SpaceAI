-- Ritrovo: initial schema. All timestamps are stored in UTC (timestamptz).

create table app_user (
  id uuid primary key default gen_random_uuid(),
  entra_oid text unique,
  email text not null,
  display_name text not null,
  department text,
  job_title text,
  role text not null default 'utente' check (role in ('utente', 'reception', 'amministratore')),
  hide_from_colleagues boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index app_user_email_uq on app_user (lower(email));

create table building (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  created_at timestamptz not null default now()
);

create table floor (
  id uuid primary key default gen_random_uuid(),
  building_id uuid not null references building(id) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  map_mime text,
  map_data bytea,
  map_updated_at timestamptz,
  created_at timestamptz not null default now()
);

create table resource (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('room', 'desk', 'asset')),
  name text not null,
  description text,
  category text,
  mailbox_email text,
  building_id uuid references building(id) on delete set null,
  floor_id uuid references floor(id) on delete set null,
  capacity int not null default 1 check (capacity > 0),
  features text[] not null default '{}',
  map_x double precision check (map_x is null or (map_x >= 0 and map_x <= 1)),
  map_y double precision check (map_y is null or (map_y >= 0 and map_y <= 1)),
  qr_token text not null unique,
  is_active boolean not null default true,
  check_in_required boolean not null default true,
  check_in_grace_minutes int check (check_in_grace_minutes is null or check_in_grace_minutes between 1 and 240),
  max_duration_minutes int not null default 480 check (max_duration_minutes between 5 and 20160),
  booking_window_days int not null default 180 check (booking_window_days between 0 and 1080),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index resource_mailbox_uq on resource (lower(mailbox_email)) where mailbox_email is not null;
create index resource_kind_idx on resource (kind, is_active);

create table booking_series (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references resource(id) on delete cascade,
  organizer_id uuid references app_user(id) on delete set null,
  booked_for_id uuid references app_user(id) on delete set null,
  created_by_id uuid references app_user(id) on delete set null,
  title text,
  pattern jsonb not null,
  graph_master_ids text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table proposal (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references app_user(id) on delete set null,
  title text,
  status text not null default 'open' check (status in ('open', 'confirmed', 'expired', 'cancelled')),
  expires_at timestamptz not null,
  confirmed_booking_id uuid,
  created_at timestamptz not null default now()
);

create table booking (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references resource(id) on delete cascade,
  organizer_id uuid references app_user(id) on delete set null,
  organizer_email text,
  booked_for_id uuid references app_user(id) on delete set null,
  created_by_id uuid references app_user(id) on delete set null,
  title text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  effective_end_at timestamptz,
  status text not null check (status in ('pending', 'confirmed', 'tentative', 'completed', 'released', 'cancelled', 'declined')),
  source text not null check (source in ('web', 'addin', 'outlook', 'kiosk', 'qr', 'reception', 'seed')),
  attendee_count int not null default 1,
  is_online_meeting boolean not null default false,
  online_meeting_url text,
  series_id uuid references booking_series(id) on delete set null,
  proposal_id uuid references proposal(id) on delete set null,
  ical_uid text,
  organizer_event_id text,
  resource_event_id text,
  user_event_id text,
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  released_at timestamptz,
  release_reason text check (release_reason is null or release_reason in ('no_show', 'early_checkout', 'proposal_not_chosen', 'proposal_expired', 'admin')),
  exchange_released boolean not null default true,
  anonymized boolean not null default false,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at)
);
create index booking_resource_time_idx on booking (resource_id, start_at);
create index booking_status_idx on booking (status, start_at);
create index booking_booked_for_idx on booking (booked_for_id, start_at);
create index booking_organizer_idx on booking (organizer_id, start_at);
create unique index booking_resource_ical_uq on booking (resource_id, ical_uid) where ical_uid is not null;
create index booking_resource_event_idx on booking (resource_event_id) where resource_event_id is not null;

create table facility_request (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid references app_user(id) on delete set null,
  category text not null check (category in ('manutenzione', 'pulizia', 'it', 'arredi', 'altro')),
  title text not null,
  description text,
  resource_id uuid references resource(id) on delete set null,
  location_text text,
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  assignee_id uuid references app_user(id) on delete set null,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create index facility_request_status_idx on facility_request (status, created_at);

create table kiosk_device (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('panel', 'totem')),
  resource_id uuid references resource(id) on delete cascade,
  building_id uuid references building(id) on delete cascade,
  token_hash text not null unique,
  created_by_id uuid references app_user(id) on delete set null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  check ((kind = 'panel' and resource_id is not null) or (kind = 'totem' and building_id is not null))
);

create table graph_subscription (
  id uuid primary key default gen_random_uuid(),
  resource_id uuid not null references resource(id) on delete cascade,
  subscription_id text not null unique,
  client_state text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table sync_state (
  resource_id uuid primary key references resource(id) on delete cascade,
  delta_link text,
  window_start timestamptz,
  window_end timestamptz,
  last_sync_at timestamptz,
  last_error text
);

create table user_favorite (
  user_id uuid not null references app_user(id) on delete cascade,
  resource_id uuid not null references resource(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, resource_id)
);

create table setting (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid references app_user(id) on delete set null,
  actor_label text,
  action text not null,
  entity text,
  entity_id text,
  details jsonb
);
create index audit_log_at_idx on audit_log (at);

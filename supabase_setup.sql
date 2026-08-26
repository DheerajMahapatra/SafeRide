-- SafeRide Supabase setup (NO-AUTH VERSION)
-- Run this entire script in Supabase Dashboard -> SQL Editor -> New query.
-- This drops and recreates the tables, so it is safe to re-run from scratch.

create extension if not exists "pgcrypto";

drop table if exists public.watchers cascade;
drop table if exists public.weekly_reports cascade;
drop table if exists public.alerts cascade;
drop table if exists public.trips cascade;
drop table if exists public.users cascade;

-- No foreign key to auth.users anymore: the app never calls supabase.auth.
-- Each device generates its own random id locally on first launch and
-- keeps using it forever (like a permanent "Share Code" identity).
create table public.users (
  id uuid primary key,
  name text,
  role text not null default 'driver' check (role in ('driver','guardian')),
  short_id text unique,
  push_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  latest_location jsonb,
  speed integer not null default 0,
  status text not null default 'SAFE',
  route_points jsonb not null default '[]'::jsonb
);

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  date date not null,
  points jsonb not null default '[]'::jsonb,
  distance_km double precision not null default 0,
  duration_min integer not null default 0,
  max_speed integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  type text not null check (type in ('alert','normal')),
  speed integer not null,
  location text,
  timestamp timestamptz not null default now()
);

create table public.weekly_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  week_start date not null,
  week_end date not null,
  total_distance double precision not null default 0,
  total_time integer not null default 0,
  total_trips integer not null default 0,
  max_speed integer not null default 0,
  safety_score integer not null default 100,
  daily_max_speeds jsonb not null default '[]'::jsonb,
  daily_over_events jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, week_start)
);

-- One row per (driver, guardian device) that is watching a driver's Share
-- Code. Lets a driver's app look up every guardian push token to notify
-- when an overspeed alert fires, even if the guardian's app is closed.
create table public.watchers (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.users(id) on delete cascade,
  guardian_id uuid references public.users(id) on delete cascade,
  guardian_push_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (driver_id, guardian_id)
);

alter table public.users enable row level security;
alter table public.trips enable row level security;
alter table public.alerts enable row level security;
alter table public.weekly_reports enable row level security;
alter table public.watchers enable row level security;

-- ---------------------------------------------------------------------
-- NO-AUTH POLICIES
-- This app has no login screen and no Supabase Auth session, so every
-- request comes in as the "anon" role using only the public anon key.
-- These policies open full read/write to anon, which is fine for a
-- private, 2-person family app but means anyone who obtains the anon
-- key + a Share Code could read/write that row. Do not reuse this
-- schema for anything with real strangers as users.
-- ---------------------------------------------------------------------

create policy "users_all_anon"
on public.users for all to anon
using (true) with check (true);

create policy "trips_all_anon"
on public.trips for all to anon
using (true) with check (true);

create policy "alerts_all_anon"
on public.alerts for all to anon
using (true) with check (true);

create policy "reports_all_anon"
on public.weekly_reports for all to anon
using (true) with check (true);

create policy "watchers_all_anon"
on public.watchers for all to anon
using (true) with check (true);

-- Enable Realtime for live driver location/speed updates (this is what
-- makes the guardian's screen update instantly, like a shared live sheet).
do $$
begin
  alter publication supabase_realtime add table public.users;
exception
  when duplicate_object then null;
end $$;

-- Enable Realtime for alerts too, so the guardian's phone receives the
-- driver's overspeed events instantly (and can raise local notifications).
do $$
begin
  alter publication supabase_realtime add table public.alerts;
exception
  when duplicate_object then null;
end $$;

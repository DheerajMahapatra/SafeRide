-- SafeRide Supabase setup (CLEAN RESET)
-- Run this entire script in Supabase Dashboard -> SQL Editor -> New query.
-- WARNING: This drops ALL existing tables and recreates them from scratch.
-- Uses Supabase Auth for proper email/password authentication.

create extension if not exists "pgcrypto";

drop table if exists public.watchers cascade;
drop table if exists public.weekly_reports cascade;
drop table if exists public.alerts cascade;
drop table if exists public.trips cascade;
drop table if exists public.users cascade;

-- Users table: one row per authenticated user. Linked to auth.users via id.
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text not null,
  role text not null default 'driver' check (role in ('driver','guardian')),
  short_id text unique,
  push_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  latest_location jsonb,
  speed integer not null default 0,
  status text not null default 'SAFE',
  route_points jsonb not null default '[]'::jsonb,
  tracking_active boolean not null default false
);

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  date date not null,
  points jsonb not null default '[]'::jsonb,
  distance_km double precision not null default 0,
  duration_sec integer not null default 0,
  max_speed integer not null default 0,
  avg_speed integer not null default 0,
  alerts_count integer not null default 0,
  started_at timestamptz,
  ended_at timestamptz,
  tracking_status text not null default 'completed' check (tracking_status in ('active','completed','interrupted')),
  start_location text,
  end_location text,
  guardian_notified boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  type text not null check (type in ('alert','normal')),
  speed integer not null,
  location text,
  timestamp timestamptz not null default now(),
  trip_id uuid references public.trips(id) on delete set null
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

-- Watchers: one row per (driver, guardian) pair. Used to look up guardian
-- push tokens so the driver's app can send overspeed notifications.
create table public.watchers (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.users(id) on delete cascade,
  guardian_id uuid references public.users(id) on delete cascade,
  guardian_push_token text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (driver_id, guardian_id)
);

-- Enable RLS
alter table public.users enable row level security;
alter table public.trips enable row level security;
alter table public.alerts enable row level security;
alter table public.weekly_reports enable row level security;
alter table public.watchers enable row level security;

-- Users: authenticated users can read all profiles (for guardian lookup),
-- but only update their own row.
create policy "users_select_auth"
on public.users for select to authenticated
using (true);

create policy "users_insert_own"
on public.users for insert to authenticated
with check (auth.uid() = id);

create policy "users_update_own"
on public.users for update to authenticated
using (auth.uid() = id) with check (auth.uid() = id);

-- Allow service role full access (for background tasks via anon key fallback)
create policy "users_all_anon"
on public.users for all to anon
using (true) with check (true);

-- Trips: users can see their own trips + trips of drivers they watch
create policy "trips_select_own"
on public.trips for select to authenticated
using (user_id = auth.uid());

create policy "trips_select_guardian"
on public.trips for select to authenticated
using (
  user_id IN (
    SELECT driver_id FROM public.watchers WHERE guardian_id = auth.uid()
  )
);

create policy "trips_insert_own"
on public.trips for insert to authenticated
with check (user_id = auth.uid());

create policy "trips_all_anon"
on public.trips for all to anon
using (true) with check (true);

-- Alerts: users can see their own alerts + alerts of drivers they watch
create policy "alerts_select_own"
on public.alerts for select to authenticated
using (user_id = auth.uid());

create policy "alerts_select_guardian"
on public.alerts for select to authenticated
using (
  user_id IN (
    SELECT driver_id FROM public.watchers WHERE guardian_id = auth.uid()
  )
);

create policy "alerts_insert_own"
on public.alerts for insert to authenticated
with check (user_id = auth.uid());

create policy "alerts_all_anon"
on public.alerts for all to anon
using (true) with check (true);

-- Weekly reports: users can see their own reports + reports of drivers they watch
create policy "reports_select_own"
on public.weekly_reports for select to authenticated
using (user_id = auth.uid());

create policy "reports_select_guardian"
on public.weekly_reports for select to authenticated
using (
  user_id IN (
    SELECT driver_id FROM public.watchers WHERE guardian_id = auth.uid()
  )
);

create policy "reports_insert_own"
on public.weekly_reports for insert to authenticated
with check (user_id = auth.uid());

create policy "reports_all_anon"
on public.weekly_reports for all to anon
using (true) with check (true);

-- Watchers: authenticated users can manage their own watcher relationships
create policy "watchers_select_auth"
on public.watchers for select to authenticated
using (true);

create policy "watchers_insert_auth"
on public.watchers for insert to authenticated
with check (guardian_id = auth.uid() OR driver_id = auth.uid());

create policy "watchers_delete_auth"
on public.watchers for delete to authenticated
using (guardian_id = auth.uid() OR driver_id = auth.uid());

create policy "watchers_all_anon"
on public.watchers for all to anon
using (true) with check (true);

-- Enable Realtime
do $$
begin
  alter publication supabase_realtime add table public.users;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.alerts;
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.trips;
exception
  when duplicate_object then null;
end $$;

-- SafeRide Supabase setup (CLEAN RESET)
-- Run this entire script in Supabase Dashboard -> SQL Editor -> New query.
-- WARNING: This drops ALL existing tables and recreates them from scratch.

create extension if not exists "pgcrypto";

drop table if exists public.watchers cascade;
drop table if exists public.weekly_reports cascade;
drop table if exists public.alerts cascade;
drop table if exists public.trips cascade;
drop table if exists public.users cascade;

-- Users table: one row per device/user. Name is UNIQUE so the same person
-- always gets the same row when they re-install the app.
create table public.users (
  id uuid primary key,
  name text not null unique,
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

-- Open policies for anon (no Supabase Auth used)
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

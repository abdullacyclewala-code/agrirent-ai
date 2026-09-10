-- AgriRent AI — Phase 1 schema
-- Run this in Supabase SQL Editor (Project > SQL Editor > New query)

create extension if not exists postgis;

-- ============ USERS ============
-- Supabase auth.users already exists; this is our public profile table.
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  phone text,
  name text,
  is_farmer boolean not null default true,
  is_owner boolean not null default false,
  location geography(Point, 4326),
  location_label text,
  created_at timestamptz not null default now()
);

alter table public.users enable row level security;

create policy "Users can view all profiles" on public.users
  for select using (true);

create policy "Users can update own profile" on public.users
  for update using (auth.uid() = id);

create policy "Users can insert own profile" on public.users
  for insert with check (auth.uid() = id);

-- auto-create a profile row when someone signs up
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (id, phone, name)
  values (new.id, new.phone, coalesce(new.raw_user_meta_data->>'name', ''));
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============ TAXONOMY (seeded from src/data/taxonomy.json) ============
create table if not exists public.taxonomy_crops (
  id text primary key,
  label text not null,
  icon text
);

create table if not exists public.taxonomy_operations (
  id text primary key,
  label text not null,
  description text
);

create table if not exists public.taxonomy_equipment_types (
  id text primary key,
  label text not null
);

create table if not exists public.taxonomy_compatibility (
  id bigint generated always as identity primary key,
  equipment_type text not null references public.taxonomy_equipment_types(id),
  operations text[] not null,
  crops text[] not null,
  hp_ranges jsonb not null
);

alter table public.taxonomy_crops enable row level security;
alter table public.taxonomy_operations enable row level security;
alter table public.taxonomy_equipment_types enable row level security;
alter table public.taxonomy_compatibility enable row level security;

create policy "Taxonomy readable by everyone" on public.taxonomy_crops for select using (true);
create policy "Taxonomy readable by everyone" on public.taxonomy_operations for select using (true);
create policy "Taxonomy readable by everyone" on public.taxonomy_equipment_types for select using (true);
create policy "Taxonomy readable by everyone" on public.taxonomy_compatibility for select using (true);

-- ============ EQUIPMENT ============
create table if not exists public.equipment (
  id bigint generated always as identity primary key,
  owner_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  equipment_type text not null references public.taxonomy_equipment_types(id),
  hp numeric,
  compatible_operations text[] not null default '{}',
  compatible_crops text[] not null default '{}',
  price numeric not null,
  price_unit text not null default 'hour',
  location geography(Point, 4326),
  location_label text,
  service_area_radius_km numeric not null default 15,
  images text[] not null default '{}',
  is_available boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.equipment enable row level security;

create policy "Equipment readable by everyone" on public.equipment for select using (true);
create policy "Owners can insert own equipment" on public.equipment
  for insert with check (auth.uid() = owner_id);
create policy "Owners can update own equipment" on public.equipment
  for update using (auth.uid() = owner_id);
create policy "Owners can delete own equipment" on public.equipment
  for delete using (auth.uid() = owner_id);

-- ============ AVAILABILITY SLOTS ============
create table if not exists public.availability_slots (
  id bigint generated always as identity primary key,
  equipment_id bigint not null references public.equipment(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  is_booked boolean not null default false
);

alter table public.availability_slots enable row level security;
create policy "Slots readable by everyone" on public.availability_slots for select using (true);
create policy "Owner manages own slots" on public.availability_slots
  for all using (
    exists (select 1 from public.equipment e where e.id = equipment_id and e.owner_id = auth.uid())
  );

-- ============ REQUIREMENTS ============
create table if not exists public.requirements (
  id bigint generated always as identity primary key,
  farmer_id uuid not null references public.users(id) on delete cascade,
  raw_text text,
  language text default 'en',
  parsed_json jsonb,
  created_at timestamptz not null default now()
);

alter table public.requirements enable row level security;
create policy "Farmer manages own requirements" on public.requirements
  for all using (auth.uid() = farmer_id);

-- ============ BOOKINGS ============
create table if not exists public.bookings (
  id bigint generated always as identity primary key,
  requirement_id bigint references public.requirements(id),
  equipment_id bigint not null references public.equipment(id),
  farmer_id uuid not null references public.users(id),
  owner_id uuid not null references public.users(id),
  status text not null default 'Requested', -- Requested, Confirmed, In Use, Completed, Rejected, Cancelled, Expired, Conflicted (see §4.5 in AGRIRENT_AI_MASTER.md — the last two are auto-set by src/lib/bookingLifecycle.js, not a manual action)
  start_date date,
  end_date date,
  price numeric,
  created_at timestamptz not null default now()
);

alter table public.bookings enable row level security;
create policy "Farmer or owner can view their bookings" on public.bookings
  for select using (auth.uid() = farmer_id or auth.uid() = owner_id);
create policy "Farmer can create bookings" on public.bookings
  for insert with check (auth.uid() = farmer_id);
create policy "Farmer or owner can update their bookings" on public.bookings
  for update using (auth.uid() = farmer_id or auth.uid() = owner_id);

-- ============ INDEXES ============
create index if not exists idx_equipment_owner on public.equipment(owner_id);
create index if not exists idx_equipment_type on public.equipment(equipment_type);
create index if not exists idx_bookings_farmer on public.bookings(farmer_id);
create index if not exists idx_bookings_owner on public.bookings(owner_id);
create index if not exists idx_bookings_equipment on public.bookings(equipment_id);
create index if not exists idx_slots_equipment on public.availability_slots(equipment_id);

-- ============ PHASE 4 ============

-- ---- Push notification tokens (§4.3, FCM) ----
-- One row per registered browser/device. `token` is unique so re-registering
-- the same browser (e.g. after clearing permissions) upserts instead of
-- duplicating — see src/lib/push.js's `.upsert(..., { onConflict: "token" })`.
create table if not exists public.push_tokens (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  token text not null unique,
  platform text not null default 'web',
  created_at timestamptz not null default now()
);

alter table public.push_tokens enable row level security;

-- Frontend only ever inserts/updates its OWN token (src/lib/push.js).
create policy "Users manage own push tokens" on public.push_tokens
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The backend looks up tokens by farmer_id/owner_id using the SERVICE ROLE
-- key (backend/app/notifications.py), which bypasses RLS entirely — no
-- extra "readable by everyone" policy is needed or wanted here (a token is
-- effectively a device secret; only its owner or the backend should ever
-- read it).

create index if not exists idx_push_tokens_user on public.push_tokens(user_id);

-- ---- Realtime (§2, Booking.jsx / MyBookings.jsx live status updates) ----
-- Supabase Realtime only streams `postgres_changes` for tables explicitly
-- added to the `supabase_realtime` publication. Equivalent to toggling
-- Database > Replication > bookings ON in the Supabase dashboard.
-- Wrapped in a DO block (unlike the idempotent `create table if not exists`
-- above) because `alter publication ... add table` errors on re-run if the
-- table is already a publication member, and this file is meant to be safe
-- to re-run wholesale each phase.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bookings'
  ) then
    alter publication supabase_realtime add table public.bookings;
  end if;
end $$;



-- ============ PHASE 6 (items 3+4: equipment photos + geo search) ============
-- Live equivalent: supabase/migrations/20260910_phase6_geo.sql (applied
-- 2026-09-10) + the equipment-photos bucket + storage policies below.

-- ---- Numeric coordinate columns ----
-- The app writes plain lat/lng numbers (PostgREST can't write a geography
-- value directly); the trigger below keeps `location` in sync.
alter table public.equipment
  add column if not exists latitude double precision,
  add column if not exists longitude double precision;

alter table public.users
  add column if not exists latitude double precision,
  add column if not exists longitude double precision;

-- ---- Geography sync trigger ----
create or replace function public.sync_location_geography()
returns trigger
language plpgsql
as $$
begin
  if NEW.latitude is not null and NEW.longitude is not null
     and NEW.latitude between -90 and 90
     and NEW.longitude between -180 and 180 then
    NEW.location := ST_SetSRID(ST_MakePoint(NEW.longitude, NEW.latitude), 4326)::geography;
  else
    NEW.location := null;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_equipment_location on public.equipment;
create trigger trg_equipment_location
  before insert or update of latitude, longitude on public.equipment
  for each row execute function public.sync_location_geography();

drop trigger if exists trg_users_location on public.users;
create trigger trg_users_location
  before insert or update of latitude, longitude on public.users
  for each row execute function public.sync_location_geography();

-- ---- Spatial indexes ----
create index if not exists idx_equipment_location_gist
  on public.equipment using gist (location);
create index if not exists idx_users_location_gist
  on public.users using gist (location);

-- ---- Geo search RPC (used by DescribeJob.jsx) ----
create or replace function public.nearby_equipment(
  p_lat double precision,
  p_lng double precision,
  p_radius_km double precision default 50
)
returns table (
  id bigint,
  owner_id uuid,
  name text,
  equipment_type text,
  hp numeric,
  compatible_operations text[],
  compatible_crops text[],
  price numeric,
  price_unit text,
  latitude double precision,
  longitude double precision,
  location_label text,
  service_area_radius_km numeric,
  images text[],
  is_available boolean,
  created_at timestamptz,
  owner_name text,
  distance_km double precision
)
language plpgsql
stable
as $$
declare
  farmer_point geography;
  radius_m double precision;
begin
  if p_lat is null or p_lng is null
     or p_lat < -90 or p_lat > 90
     or p_lng < -180 or p_lng > 180 then
    raise exception 'nearby_equipment: invalid farmer coordinates (lat=%, lng=%)', p_lat, p_lng;
  end if;

  farmer_point := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography;
  radius_m := least(greatest(coalesce(p_radius_km, 50), 0.5), 500) * 1000;

  return query
  select
    e.id, e.owner_id, e.name, e.equipment_type, e.hp,
    e.compatible_operations, e.compatible_crops, e.price, e.price_unit,
    e.latitude, e.longitude,
    e.location_label, e.service_area_radius_km, e.images,
    e.is_available, e.created_at,
    u.name as owner_name,
    ST_Distance(e.location, farmer_point) / 1000.0 as distance_km
  from public.equipment e
  join public.users u on u.id = e.owner_id
  where e.is_available
    and e.location is not null
    and ST_DWithin(e.location, farmer_point, radius_m)
    and ST_DWithin(e.location, farmer_point, greatest(e.service_area_radius_km, 0) * 1000)
  order by e.location <-> farmer_point
  limit 200;
end;
$$;

grant execute on function public.nearby_equipment(double precision, double precision, double precision)
  to anon, authenticated;

-- ---- Equipment photo storage (item 3) ----
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('equipment-photos', 'equipment-photos', true, 2097152,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = true,
  file_size_limit = 2097152,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "Public read equipment photos" on storage.objects;
create policy "Public read equipment photos" on storage.objects
  for select using (bucket_id = 'equipment-photos');

drop policy if exists "Owners upload own equipment photos" on storage.objects;
create policy "Owners upload own equipment photos" on storage.objects
  for insert with check (
    bucket_id = 'equipment-photos'
    and name like 'equipment/' || auth.uid()::text || '/%'
  );

drop policy if exists "Owners manage own equipment photos" on storage.objects;
create policy "Owners manage own equipment photos" on storage.objects
  for update using (
    bucket_id = 'equipment-photos'
    and name like 'equipment/' || auth.uid()::text || '/%'
  );

drop policy if exists "Owners delete own equipment photos" on storage.objects;
create policy "Owners delete own equipment photos" on storage.objects
  for delete using (
    bucket_id = 'equipment-photos'
    and name like 'equipment/' || auth.uid()::text || '/%'
  );

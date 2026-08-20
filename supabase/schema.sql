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
  status text not null default 'Requested', -- Requested, Confirmed, In Use, Completed, Rejected, Cancelled
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

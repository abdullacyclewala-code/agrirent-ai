-- AgriRent AI — Phase 6 items 3+4 migration (geo + photo storage)
-- Applied to the live project (moquzuaoldubqwasabvj) on 2026-09-10 via the
-- Supabase Management API. supabase/schema.sql carries the same statements
-- so fresh setups stay in sync — this file is the audit trail of what changed
-- on the live DB and in which order.
--
-- What it adds:
--   1. latitude/longitude numeric columns on equipment + users. The frontend
--      writes plain numbers (PostgREST cannot write a geography value
--      directly); a trigger keeps the geography `location` column in sync.
--   2. GIST indexes on both `location` columns (ST_DWithin / KNN ordering).
--   3. `nearby_equipment` RPC — the geo search used by DescribeJob.jsx:
--      enforces BOTH the farmer's search radius AND each listing's own
--      service_area_radius_km, returns distance_km per row.

-- ---------- 1. numeric coordinate columns ----------
alter table public.equipment
  add column if not exists latitude double precision,
  add column if not exists longitude double precision;

alter table public.users
  add column if not exists latitude double precision,
  add column if not exists longitude double precision;

-- ---------- 2. keep geography in sync ----------
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
    -- Missing or out-of-range coords: no point rather than a wrong point.
    -- (The frontend validates ranges before saving; this is backstop only.)
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

-- Backfill (no-op today — all existing rows have null coords — but keeps
-- this migration correct if coords ever predate the trigger).
update public.equipment set latitude = latitude where latitude is not null and longitude is not null;
update public.users set latitude = latitude where latitude is not null and longitude is not null;

-- ---------- 3. spatial indexes ----------
create index if not exists idx_equipment_location_gist
  on public.equipment using gist (location);
create index if not exists idx_users_location_gist
  on public.users using gist (location);

-- ---------- 4. geo search RPC ----------
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
  -- Clamp the search radius: negative/zero would match nothing, huge values
  -- would scan the planet. 500 km is the hard ceiling.
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
    -- Farmer's search radius …
    and ST_DWithin(e.location, farmer_point, radius_m)
    -- … AND the listing's own service area (§6.3: service_area_radius_km
    -- is now actually enforced instead of ignored).
    and ST_DWithin(e.location, farmer_point, greatest(e.service_area_radius_km, 0) * 1000)
  -- KNN operator: nearest-first using the GIST index.
  order by e.location <-> farmer_point
  limit 200;
end;
$$;

grant execute on function public.nearby_equipment(double precision, double precision, double precision)
  to anon, authenticated;

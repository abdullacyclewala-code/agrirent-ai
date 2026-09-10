-- AgriRent AI — Phase 6 item 5 migration (real availability_slots calendar)
-- Applied to the live project (moquzuaoldubqwasabvj) via the Supabase
-- Management API. Mirrored in supabase/schema.sql for fresh setups.
--
-- Slot semantics (see src/lib/availability.js):
--   · is_booked = false → an AVAILABLE window the owner offers.
--   · is_booked = true  → dates locked by a Confirmed booking (written by the
--     app on confirm, removed if that booking is cancelled).
--   · Equipment with no offered windows at all is treated as "always
--     available" (backward compatible for owners who never set slots), but
--     booked-date clashes are ALWAYS enforced.

-- Nonsense ranges are rejected at the DB, not just in the UI.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'availability_slots_valid_range'
  ) then
    alter table public.availability_slots
      add constraint availability_slots_valid_range
      check (start_date is not null and end_date is not null and start_date <= end_date);
  end if;
end $$;

create index if not exists idx_slots_equipment_dates
  on public.availability_slots (equipment_id, start_date, end_date);

-- Backfill: every live Confirmed / In Use booking locks its dates, so the
-- slot lookups replacing the old ad-hoc overlap queries stay correct for
-- pre-existing bookings. Idempotent (skips rows that already exist).
insert into public.availability_slots (equipment_id, start_date, end_date, is_booked)
select b.equipment_id, b.start_date, b.end_date, true
from public.bookings b
where b.status in ('Confirmed', 'In Use')
  and b.start_date is not null
  and b.end_date is not null
  and not exists (
    select 1 from public.availability_slots s
    where s.equipment_id = b.equipment_id
      and s.start_date = b.start_date
      and s.end_date = b.end_date
      and s.is_booked = true
  );

-- A farmer cancelling their own Confirmed booking must be able to release its
-- date lock. Tight by construction: booked rows only, matching a Cancelled
-- booking of the caller, and only when no live booking still holds the dates.
create policy "Farmer releases own cancelled locks" on public.availability_slots
  for delete using (
    is_booked = true
    and exists (
      select 1 from public.bookings b
      where b.equipment_id = availability_slots.equipment_id
        and b.start_date = availability_slots.start_date
        and b.end_date = availability_slots.end_date
        and b.farmer_id = auth.uid()
        and b.status = 'Cancelled'
        and not exists (
          select 1 from public.bookings b2
          where b2.equipment_id = b.equipment_id
            and b2.status in ('Confirmed', 'In Use')
            and b2.start_date <= b.end_date
            and b2.end_date >= b.start_date
        )
    )
  );

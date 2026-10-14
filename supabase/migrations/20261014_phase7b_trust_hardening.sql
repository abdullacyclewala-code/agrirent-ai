-- ============================================================================
-- Phase 7b — trust-layer hardening (found by the live integration test)
-- ============================================================================
-- Applied on top of 20261014_phase7_trust_layer.sql. Four fixes, each one
-- traced to something the live test actually caught (see
-- docs/PHASE7_VERIFIED_CONDITION_REPORTS.md §9.4):
--
--   1. report_photos had NO update path at all, so the AI/forensic findings
--      ("this photo duplicates an earlier one", "the location is 40 km away")
--      could never be written back — the UI showed nothing.
--   2. Nothing stopped a participant from rewriting `verdict` / `signals` /
--      `ai_summary` after the other party had signed. The analysis is now
--      writable while the report is a draft and frozen from finalize onwards.
--   3. `report_events` was append-only to the point that a booking could never
--      be deleted (the cascade hits the no-mutate trigger), which would have
--      made account/data deletion impossible later. There is now a purge
--      hatch that the app cannot reach.
--   4. "A claim of ₹2000+ needs a repair estimate" was only an app-side rule;
--      it is now a database constraint too.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1 + 2a. report_photos: findings are writable, evidence never is
-- ----------------------------------------------------------------------------
-- Column-level grants (PostgREST honours these) so a client can fill in the
-- analysis columns and nothing else.
grant update (ai, quality, flags, sha256_server, sha256_match,
              dhash_server, dhash_distance, hamming_min, dup_of)
  on public.report_photos to authenticated;

-- Findings may only be recorded while the parent report is still a draft.
-- Once it is signed/finalized the record is frozen — that is the whole promise
-- of the feature, so it is enforced here rather than in the UI.
drop policy if exists "Participants record findings on draft reports" on public.report_photos;
create policy "Participants record findings on draft reports" on public.report_photos
  for update using (
    public.is_booking_participant(booking_id)
    and exists (
      select 1 from public.condition_reports r
      where r.id = report_id and r.finalized_at is null
    )
  )
  with check (public.is_booking_participant(booking_id));

-- ...and the evidence columns themselves are immutable, whatever the grants say.
create or replace function public.guard_photo_immutability()
returns trigger
language plpgsql
as $$
begin
  if new.report_id    <> old.report_id
     or new.booking_id  <> old.booking_id
     or new.equipment_id <> old.equipment_id
     or new.slot        <> old.slot
     or new.storage_path <> old.storage_path
     or new.sha256      <> old.sha256
     or new.dhash       <> old.dhash
     or new.captured_by <> old.captured_by
     or new.captured_at_device is distinct from old.captured_at_device
     or new.watermark_text is distinct from old.watermark_text
     or new.created_at  <> old.created_at then
    raise exception 'report_photos: the evidence itself is immutable (only analysis columns may change, and only while the report is a draft)';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_photo_immutability on public.report_photos;
create trigger trg_photo_immutability
  before update on public.report_photos
  for each row execute function public.guard_photo_immutability();

-- ----------------------------------------------------------------------------
-- 2b. condition_reports: freeze the analysis once the report is signed
-- ----------------------------------------------------------------------------
create or replace function public.guard_report_immutability()
returns trigger
language plpgsql
as $$
begin
  if new.id <> old.id
     or new.booking_id <> old.booking_id
     or new.equipment_id <> old.equipment_id
     or new.kind <> old.kind
     or new.created_by <> old.created_by
     or new.created_at <> old.created_at
     or new.report_code is distinct from old.report_code then
    raise exception 'condition_reports: identity columns are immutable';
  end if;
  if old.finalized_at is not null and new.finalized_at is distinct from old.finalized_at then
    raise exception 'condition_reports: a finalized report cannot be re-finalized';
  end if;
  if old.report_hash is not null and new.report_hash is distinct from old.report_hash then
    raise exception 'condition_reports: report_hash is immutable once set (got %, was %)',
      new.report_hash, old.report_hash;
  end if;
  -- The reading of the evidence is frozen with the evidence. Both parties saw
  -- this verdict when they signed; letting it change afterwards would make the
  -- attestation meaningless. (The backend may still write before finalize, and
  -- a superseding report can always be filed as a new row.)
  if old.finalized_at is not null and (
       new.verdict     is distinct from old.verdict
    or new.signals     is distinct from old.signals
    or new.flagged     is distinct from old.flagged
    or new.ai_summary  is distinct from old.ai_summary
    or new.ai_status   is distinct from old.ai_status
    or new.ai_provider is distinct from old.ai_provider
    or new.hour_meter  is distinct from old.hour_meter
    or new.hour_meter_source is distinct from old.hour_meter_source
  ) then
    raise exception 'condition_reports: the analysis (verdict, signals, AI reading, meter) is frozen once the report is signed';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_report_immutability on public.condition_reports;
create trigger trg_report_immutability
  before update on public.condition_reports
  for each row execute function public.guard_report_immutability();

-- ----------------------------------------------------------------------------
-- 3. report_events: keep the append-only guarantee, add an unreachable purge
-- ----------------------------------------------------------------------------
-- Why a hatch at all: the table is referenced by FKs with `on delete cascade`,
-- so deleting a booking (or a user, i.e. an account-deletion request) always
-- reaches this trigger and would fail forever. The hatch unlocks DELETE **only**
-- when a direct SQL session sets a session variable AND no end-user JWT is in
-- play. PostgREST cannot set custom GUCs and exposes no SQL endpoint, so an
-- authenticated client — the threat model this table exists for — cannot use
-- it: their `auth.role()` is 'authenticated' and the variable is unset.
--
-- Purge a booking in full (e.g. an account-deletion request), as the project
-- owner, from the Supabase SQL editor or the Management API:
--   begin;
--     set local agrirent.allow_purge = 'on';
--     delete from public.bookings where id = <id>;   -- cascades
--   commit;
create or replace function public.report_events_no_mutate()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE'
     and coalesce(current_setting('agrirent.allow_purge', true), 'off') = 'on'
     and coalesce(auth.role(), 'service_role') in ('service_role', 'postgres') then
    return old;
  end if;
  raise exception 'report_events is append-only — % is not allowed', tg_op;
end;
$$;

drop trigger if exists trg_report_events_no_update on public.report_events;
create trigger trg_report_events_no_update
  before update or delete on public.report_events
  for each row execute function public.report_events_no_mutate();

-- ----------------------------------------------------------------------------
-- 4. damage_claims: the repair-estimate rule, in the database
-- ----------------------------------------------------------------------------
-- Mirrors POLICY in src/lib/depositPolicy.js (claimNeedsEstimate) and the
-- policy version stamped on every claim. A big number with no paper trail is
-- exactly what deposit disputes turn on, so the rule is not client-side only.
alter table public.damage_claims
  drop constraint if exists damage_claims_estimate_required;
alter table public.damage_claims
  add constraint damage_claims_estimate_required
  check (amount_claimed < 2000 or repair_estimate_photo_id is not null);

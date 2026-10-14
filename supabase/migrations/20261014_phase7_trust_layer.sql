-- AgriRent AI — Phase 7 migration: Trust Layer (Verified Condition Reports)
-- Applied to the live project (moquzuaoldubqwasabvj) on 2026-10-14 via the
-- Supabase Management API. supabase/schema.sql carries the same statements so
-- fresh setups stay in sync — this file is the audit trail of what changed on
-- the live DB and in which order (same convention as 20260910_phase6_geo.sql).
--
-- Design notes (read docs/PHASE7_VERIFIED_CONDITION_REPORTS.md for the product
-- reasoning):
--   * Evidence is append-only. report_photos / report_signatures /
--     report_events have SELECT + INSERT policies and NO update/delete policy,
--     so once filed, a photo or an attestation cannot be altered or removed by
--     anyone — including the person who filed it.
--   * Every report carries a SHA-256 hash chain, computed IN THE DATABASE by a
--     trigger (pgcrypto), not by a client or by the FastAPI backend. That means
--     the integrity guarantee holds no matter who wrote the row, and it can be
--     re-verified years later with nothing but the code on this report page.
--   * Storage bucket `inspection-photos` is PRIVATE (equipment-photos is
--     public — listing photos and evidence photos have opposite requirements).
--     Reads are restricted to the two parties on the booking; access is via
--     short-lived signed URLs.
--   * Nothing existing is dropped or renamed. All additions are additive;
--     existing rows get safe defaults.

create extension if not exists pgcrypto;

-- ============================================================================
-- 0. Helpers
-- ============================================================================

-- Is the current user one of the two parties on this booking?
create or replace function public.is_booking_participant(p_booking_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.bookings b
    where b.id = p_booking_id
      and (b.farmer_id = auth.uid() or b.owner_id = auth.uid())
  );
$$;

-- Is the current user a party on the booking that owns this report?
-- NOTE: plpgsql (not sql) on purpose — `language sql` bodies are validated at
-- CREATE time, and this helper lives above the `condition_reports` table it
-- reads. plpgsql defers body resolution to first call, which also keeps this
-- section order-independent.
create or replace function public.is_report_participant(p_report_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return exists (
    select 1
    from public.condition_reports r
    where r.id = p_report_id
      and public.is_booking_participant(r.booking_id)
  );
end;
$$;

-- Safe text -> bigint (used by storage policies, where a malformed path
-- segment must mean "deny", never "error out the whole request").
create or replace function public.safe_bigint(t text)
returns bigint
language plpgsql
immutable
as $$
begin
  return t::bigint;
exception when others then
  return null;
end;
$$;

grant execute on function public.is_booking_participant(bigint) to authenticated, anon;
grant execute on function public.is_report_participant(uuid) to authenticated, anon;
grant execute on function public.safe_bigint(text) to authenticated, anon;

-- ============================================================================
-- 1. Bookings — deposit + verification state
-- ============================================================================

alter table public.bookings
  add column if not exists verification_state text not null default 'not_started',
  add column if not exists deposit_amount numeric,
  add column if not exists handover_report_id uuid,
  add column if not exists return_report_id uuid;

comment on column public.bookings.verification_state is
  'Phase 7 trust layer: not_started | handover_due | handover_signed |
   handover_unilateral | return_due | return_filed | claim_open | disputed |
   settled | closed_clean. Transitions are driven by src/lib/trustFlow.js and
   the /verification/* backend routes.';
comment on column public.bookings.deposit_amount is
  'Refundable security deposit for this rental, in ₹. Null = no deposit
   arranged through the app (settlement then records a decision only).';

-- ============================================================================
-- 2. condition_reports — one per handover / return event
-- ============================================================================

create table if not exists public.condition_reports (
  id uuid primary key default gen_random_uuid(),
  booking_id bigint not null references public.bookings(id) on delete cascade,
  equipment_id bigint not null references public.equipment(id) on delete cascade,
  kind text not null check (kind in ('handover', 'return')),
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'signed', 'superseded', 'cancelled')),
  created_by uuid not null references public.users(id),
  created_by_role text not null check (created_by_role in ('owner', 'farmer', 'system')),
  -- A unilateral report is one party's own record when the other party didn't
  -- file theirs (see master doc §7 gates). It is never presented as agreement.
  unilateral boolean not null default false,
  supersedes_id uuid references public.condition_reports(id),
  report_code text unique,
  report_hash text,
  chain_head text,
  finalized_at timestamptz,
  -- AI reading of the evidence (provider, per-photo findings, summary,
  -- confidence). Shape is documented in backend/app/vision/analyze.py.
  ai_summary jsonb,
  ai_provider text,
  ai_status text not null default 'pending'
    check (ai_status in ('pending', 'ok', 'partial', 'unavailable', 'disabled')),
  -- Deterministic honesty signals + rolled-up verdict: verified |
  -- verified_with_flags | unverified. Never a black box: `signals` holds every
  -- reason, and the UI shows them.
  signals jsonb not null default '{}'::jsonb,
  verdict text not null default 'unverified'
    check (verdict in ('verified', 'verified_with_flags', 'unverified')),
  flagged boolean not null default false,
  hour_meter numeric,
  hour_meter_source text,
  policy_version text not null default '2026-10-1',
  renter_response text not null default 'pending'
    check (renter_response in ('pending', 'agreed', 'disagreed', 'silent')),
  renter_responded_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);

alter table public.bookings
  drop constraint if exists bookings_handover_report_fk,
  add constraint bookings_handover_report_fk
    foreign key (handover_report_id) references public.condition_reports(id) on delete set null;

alter table public.bookings
  drop constraint if exists bookings_return_report_fk,
  add constraint bookings_return_report_fk
    foreign key (return_report_id) references public.condition_reports(id) on delete set null;

-- Human-readable code for the report (shown on the printed report + QR):
-- AR-XXXXXXXX, derived from the row id so it is unique and stable.
create or replace function public.set_report_code()
returns trigger
language plpgsql
as $$
begin
  if new.report_code is null then
    new.report_code := 'AR-' || upper(substr(replace(new.id::text, '-', ''), 1, 8));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_report_code on public.condition_reports;
create trigger trg_report_code
  before insert on public.condition_reports
  for each row execute function public.set_report_code();

-- Evidence is immutable: a report's identity, its evidence and its final hash
-- can never be edited afterwards. App-level updates may only move status /
-- response fields.
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
  return new;
end;
$$;

drop trigger if exists trg_report_immutability on public.condition_reports;
create trigger trg_report_immutability
  before update on public.condition_reports
  for each row execute function public.guard_report_immutability();

-- Auto-create the booking's handover report row when the booking is confirmed?
-- No — the report is created by whoever captures first (owner at handover,
-- or the renter at return), so that a booking with no capture has no empty
-- report cluttering the audit trail. See src/lib/trustFlow.js.

-- ============================================================================
-- 3. report_photos — the evidence itself
-- ============================================================================

create table if not exists public.report_photos (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.condition_reports(id) on delete cascade,
  booking_id bigint not null references public.bookings(id) on delete cascade,
  equipment_id bigint not null references public.equipment(id) on delete cascade,
  slot text not null,                 -- full_left | full_right | meter | work_area | extra
  storage_path text not null,
  captured_by uuid not null references public.users(id),
  captured_by_role text not null check (captured_by_role in ('owner', 'farmer')),
  -- Fingerprints. sha256 = exact bytes; dhash = perceptual (survives resize /
  -- re-encode). Client-computed values are verified server-side and BOTH are
  -- stored so a mismatch is visible instead of silently trusted.
  sha256 text not null,
  sha256_server text,
  sha256_match boolean,
  dhash text not null,
  dhash_server text,
  dhash_distance integer,
  dup_of uuid references public.report_photos(id),
  hamming_min integer,
  -- Capture context (client-reported, then cross-checked by the backend).
  captured_at_device timestamptz,
  received_at timestamptz not null default now(),
  exif jsonb,                          -- {make, model, datetime_original, software, gps_lat, gps_lng}
  gps_lat double precision,
  gps_lng double precision,
  gps_source text,                     -- 'exif' | 'live' | 'none'
  device text,
  watermark_text text,
  -- AI reading of this single photo (quality gate + damage observations).
  ai jsonb,
  quality jsonb,                       -- {sharpness, exposure, framing, verdict}
  damage_labels text[] not null default '{}',
  damage_severity text,
  flags text[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_report_photos_report on public.report_photos(report_id);
create index if not exists idx_report_photos_equipment on public.report_photos(equipment_id);
create index if not exists idx_report_photos_sha on public.report_photos(sha256);
create index if not exists idx_report_photos_dhash on public.report_photos(dhash);
create index if not exists idx_report_photos_booking on public.report_photos(booking_id);

-- ============================================================================
-- 4. report_signatures — the two attestations (never merged into one row)
-- ============================================================================

create table if not exists public.report_signatures (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.condition_reports(id) on delete cascade,
  booking_id bigint not null references public.bookings(id) on delete cascade,
  user_id uuid not null references public.users(id),
  role text not null check (role in ('owner', 'farmer')),
  statement_version text not null default '2026-10-1',
  statement_text text not null,
  signature_png_path text,
  content_hash text,        -- sha256 of the report content the signer saw
  signed_at timestamptz not null default now(),
  unique (report_id, user_id, role)
);

create index if not exists idx_report_signatures_report on public.report_signatures(report_id);

-- ============================================================================
-- 5. report_events — append-only audit trail with a SHA-256 hash chain
-- ============================================================================
-- The chain is what turns this from "a screenshot" into "a record". Each row
-- commits to the previous row's hash, so removing or editing any historical
-- event is detectable later (verify_report() below recomputes the whole chain).

create table if not exists public.report_events (
  id bigint generated always as identity primary key,
  report_id uuid not null references public.condition_reports(id) on delete cascade,
  booking_id bigint not null references public.bookings(id) on delete cascade,
  actor_id uuid references public.users(id),
  actor_role text not null default 'system'
    check (actor_role in ('owner', 'farmer', 'system')),
  event text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  prev_hash text not null default 'genesis',
  row_hash text not null default ''
);

create index if not exists idx_report_events_report on public.report_events(report_id, id);

-- Canonical hash of one event, chained to its predecessor.
create or replace function public.report_event_hash(p_payload jsonb, p_prev text)
returns text
language sql
immutable
as $$
  -- Postgres core sha256() (PG11+), not pgcrypto's digest(): core lives in
  -- pg_catalog so it can never be shadowed or left unresolvable by schema /
  -- search_path differences between the SQL editor, the API roles and the
  -- Storage service. Verified against the live DB — `digest(text, unknown)`
  -- does not resolve there.
  select encode(
    sha256(convert_to(coalesce(p_prev, 'genesis') || '|' || coalesce(p_payload, '{}'::jsonb)::text, 'UTF8')),
    'hex'
  );
$$;

create or replace function public.report_events_chain()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  prev text;
begin
  -- Serialize appends per report so two concurrent writers can't chain off the
  -- same predecessor. Cheap and scoped to one transaction.
  perform pg_advisory_xact_lock(hashtext('report_events:' || new.report_id::text));

  select e.row_hash into prev
  from public.report_events e
  where e.report_id = new.report_id
  order by e.id desc
  limit 1;

  new.prev_hash := coalesce(prev, 'genesis');
  new.row_hash := public.report_event_hash(new.payload, new.prev_hash);
  return new;
end;
$$;

drop trigger if exists trg_report_events_chain on public.report_events;
create trigger trg_report_events_chain
  before insert on public.report_events
  for each row execute function public.report_events_chain();

-- The chain must be append-only at the DB level, not just by policy.
create or replace function public.report_events_no_mutate()
returns trigger
language plpgsql
as $$
begin
  raise exception 'report_events is append-only — % is not allowed', tg_op;
end;
$$;

drop trigger if exists trg_report_events_no_update on public.report_events;
create trigger trg_report_events_no_update
  before update or delete on public.report_events
  for each row execute function public.report_events_no_mutate();

-- Convenience: append an event from SQL or the frontend (RLS-checked by the
-- caller's insert). The trigger fills prev_hash/row_hash.
create or replace function public.log_report_event(
  p_report_id uuid,
  p_event text,
  p_payload jsonb default '{}'::jsonb,
  p_actor_role text default 'system'
)
returns public.report_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking bigint;
  v_row public.report_events;
  v_uid uuid := auth.uid();
  v_jwt_role text := coalesce(auth.role(), '');
begin
  select booking_id into v_booking from public.condition_reports where id = p_report_id;
  if v_booking is null then
    raise exception 'log_report_event: no such report %', p_report_id;
  end if;

  -- Two legitimate callers: (a) the FastAPI backend holding the service-role
  -- key — no JWT, so auth.uid() is null — and (b) a signed-in party on the
  -- booking (the frontend calls this via RPC). An anonymous REST caller with
  -- the anon key gets through neither branch.
  if v_uid is null then
    if v_jwt_role <> 'service_role' then
      raise exception 'log_report_event: this call needs a signed-in user or the service role';
    end if;
  elsif not public.is_report_participant(p_report_id) then
    raise exception 'log_report_event: not a participant on this report';
  end if;

  insert into public.report_events (report_id, booking_id, actor_id, actor_role, event, payload)
  values (
    p_report_id,
    v_booking,
    v_uid,
    case when v_uid is null then 'system' else p_actor_role end,
    p_event,
    coalesce(p_payload, '{}'::jsonb)
  )
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.log_report_event(uuid, text, jsonb, text) to authenticated;

-- Finalize: freeze the report's content hash. Called by the backend (service
-- role) at sign time, or by a participant via RPC when the backend has no
-- service key configured. Everything that defines "this report" goes in.
create or replace function public.finalize_report(p_report_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report public.condition_reports;
  v_photos jsonb;
  v_sigs jsonb;
  v_chain text;
  v_hash text;
begin
  select * into v_report from public.condition_reports where id = p_report_id;
  if v_report is null then
    raise exception 'finalize_report: no such report %', p_report_id;
  end if;
  if not public.is_report_participant(p_report_id) and auth.role() <> 'service_role' then
    raise exception 'finalize_report: not a participant on this report';
  end if;
  if v_report.report_hash is not null then
    return v_report.report_hash;   -- idempotent
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'slot', p.slot,
           'sha256', p.sha256,
           'dhash', p.dhash,
           'by', p.captured_by,
           'at', p.captured_at_device
         ) order by p.slot, p.created_at), '[]'::jsonb)
    into v_photos
  from public.report_photos p
  where p.report_id = p_report_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'role', s.role, 'user', s.user_id, 'at', s.signed_at,
           'statement', s.statement_version
         ) order by s.signed_at), '[]'::jsonb)
    into v_sigs
  from public.report_signatures s
  where s.report_id = p_report_id;

  select e.row_hash into v_chain
  from public.report_events e
  where e.report_id = p_report_id
  order by e.id desc limit 1;

  v_hash := encode(sha256(convert_to(
    jsonb_build_object(
      'report_code', v_report.report_code,
      'booking_id', v_report.booking_id,
      'equipment_id', v_report.equipment_id,
      'kind', v_report.kind,
      'created_by', v_report.created_by,
      'created_at', v_report.created_at,
      'policy_version', v_report.policy_version,
      'verdict', v_report.verdict,
      'hour_meter', v_report.hour_meter,
      'photos', v_photos,
      'signatures', v_sigs,
      'chain_head', coalesce(v_chain, 'genesis')
    )::text, 'UTF8')), 'hex');

  update public.condition_reports
     set report_hash = v_hash,
         chain_head = coalesce(v_chain, 'genesis'),
         finalized_at = now()
   where id = p_report_id;

  perform public.log_report_event(
    p_report_id,
    'report_finalized',
    jsonb_build_object('report_hash', v_hash, 'verdict', v_report.verdict),
    'system'
  );

  return v_hash;
end;
$$;

grant execute on function public.finalize_report(uuid) to authenticated;

-- Public integrity check used by the /verify page and the QR code. Returns a
-- verdict + the minimum needed to be useful to a third party (bank, insurer,
-- panchayat, court) — never the photos, never either party's phone/email.
create or replace function public.verify_report(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_report public.condition_reports;
  v_prev text := 'genesis';
  v_evt record;
  v_recomputed text;
  v_ok boolean := true;
  v_broken_at bigint := null;
  v_count int := 0;
  v_photo_count int;
  v_signers jsonb;
begin
  select * into v_report
  from public.condition_reports
  where upper(report_code) = upper(p_code) or report_hash = p_code;

  if v_report is null then
    return jsonb_build_object('found', false);
  end if;

  -- Walk the chain and recompute every link.
  for v_evt in
    select * from public.report_events
    where report_id = v_report.id
    order by id asc
  loop
    v_count := v_count + 1;
    v_recomputed := public.report_event_hash(v_evt.payload, v_prev);
    if v_recomputed <> v_evt.row_hash or v_evt.prev_hash <> v_prev then
      v_ok := false;
      if v_broken_at is null then
        v_broken_at := v_evt.id;
      end if;
    end if;
    v_prev := v_evt.row_hash;
  end loop;

  select count(*) into v_photo_count from public.report_photos where report_id = v_report.id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'role', s.role, 'signed_at', s.signed_at
         ) order by s.signed_at), '[]'::jsonb)
    into v_signers
  from public.report_signatures s
  where s.report_id = v_report.id;

  return jsonb_build_object(
    'found', true,
    'report_code', v_report.report_code,
    'report_hash', v_report.report_hash,
    'chain_intact', v_ok,
    'chain_broken_at', v_broken_at,
    'event_count', v_count,
    'chain_head', v_prev,
    'kind', v_report.kind,
    'status', v_report.status,
    'verdict', v_report.verdict,
    'flagged', v_report.flagged,
    'unilateral', v_report.unilateral,
    'renter_response', v_report.renter_response,
    'ai_status', v_report.ai_status,
    'photo_count', v_photo_count,
    'hour_meter', v_report.hour_meter,
    'finalized_at', v_report.finalized_at,
    'created_at', v_report.created_at,
    'signers', v_signers,
    'signals', v_report.signals
  );
end;
$$;

grant execute on function public.verify_report(text) to authenticated, anon;

-- ============================================================================
-- 6. damage_claims — the owner's claim and the renter's answer
-- ============================================================================

create table if not exists public.damage_claims (
  id uuid primary key default gen_random_uuid(),
  booking_id bigint not null references public.bookings(id) on delete cascade,
  return_report_id uuid not null references public.condition_reports(id) on delete cascade,
  handover_report_id uuid references public.condition_reports(id),
  filed_by uuid not null references public.users(id),
  amount_claimed numeric not null check (amount_claimed >= 0),
  description text not null,
  parts text[] not null default '{}',
  severity text not null default 'moderate' check (severity in ('minor', 'moderate', 'major')),
  evidence_photo_ids uuid[] not null default '{}',
  repair_estimate_photo_id uuid references public.report_photos(id),
  status text not null default 'open'
    check (status in ('open', 'agreed', 'disputed', 'withdrawn', 'resolved', 'expired_no_response')),
  response_deadline timestamptz not null default (now() + interval '24 hours'),
  renter_response text,
  renter_responded_at timestamptz,
  resolution_note text,
  resolved_amount numeric,
  resolved_by uuid references public.users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_damage_claims_booking on public.damage_claims(booking_id);
create index if not exists idx_damage_claims_status on public.damage_claims(status);

-- ============================================================================
-- 7. deposit_settlements — the money outcome (decision + offline reference)
-- ============================================================================
-- Payments are still a later phase in this app, so this records the DECISION
-- and an offline payment reference (UPI ref entered by the payer, confirmable
-- by the payee). The shape is deliberately what a gateway/escrow integration
-- will need later, so switching to real money movement is additive.

create table if not exists public.deposit_settlements (
  id uuid primary key default gen_random_uuid(),
  booking_id bigint not null references public.bookings(id) on delete cascade,
  deposit_amount numeric not null default 0,
  released_amount numeric not null default 0,
  withheld_amount numeric not null default 0,
  status text not null default 'pending'
    check (status in ('pending', 'partial', 'released', 'withheld', 'disputed_hold', 'no_deposit')),
  reason text not null default 'no_claim'
    check (reason in ('no_claim', 'agreed_claim', 'resolved_claim', 'dispute_hold', 'no_deposit', 'unilateral_default')),
  claim_id uuid references public.damage_claims(id),
  decided_by uuid references public.users(id),
  offline_ref text,
  offline_ref_confirmed_by uuid references public.users(id),
  offline_ref_confirmed_at timestamptz,
  policy_version text not null default '2026-10-1',
  policy_snapshot jsonb not null default '{}'::jsonb,
  notes text,
  settled_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_settlements_booking on public.deposit_settlements(booking_id);

-- ============================================================================
-- 8. equipment_damage_log — the carry-forward baseline (the quiet superpower)
-- ============================================================================
-- A damage accepted at the end of booking N becomes the known state of the
-- machine for booking N+1. "It was already like that" stops being an argument,
-- because the machine has a file. Only a later report can mark an entry
-- repaired.

create table if not exists public.equipment_damage_log (
  id uuid primary key default gen_random_uuid(),
  equipment_id bigint not null references public.equipment(id) on delete cascade,
  first_seen_report_id uuid references public.condition_reports(id) on delete set null,
  booking_id bigint references public.bookings(id) on delete set null,
  part text not null,
  kind text not null default 'other'
    check (kind in ('scratch', 'dent', 'crack', 'tyre', 'leak', 'rust', 'missing_part', 'other')),
  severity text not null default 'minor' check (severity in ('minor', 'moderate', 'major')),
  status text not null default 'open' check (status in ('open', 'repaired', 'disputed', 'written_off')),
  notes text,
  photo_ids uuid[] not null default '{}',
  repaired_report_id uuid references public.condition_reports(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_damage_log_equipment on public.equipment_damage_log(equipment_id, status);

-- ============================================================================
-- 9. RLS
-- ============================================================================

alter table public.condition_reports enable row level security;
alter table public.report_photos enable row level security;
alter table public.report_signatures enable row level security;
alter table public.report_events enable row level security;
alter table public.damage_claims enable row level security;
alter table public.deposit_settlements enable row level security;
alter table public.equipment_damage_log enable row level security;

-- ---- condition_reports ----
drop policy if exists "Participants read reports" on public.condition_reports;
create policy "Participants read reports" on public.condition_reports
  for select using (public.is_booking_participant(booking_id));

drop policy if exists "Participants create reports" on public.condition_reports;
create policy "Participants create reports" on public.condition_reports
  for insert with check (
    public.is_booking_participant(booking_id)
    and created_by = auth.uid()
    and created_by_role in ('owner', 'farmer')
    and (
      (created_by_role = 'owner' and exists (
        select 1 from public.bookings b where b.id = booking_id and b.owner_id = auth.uid()
      ))
      or
      (created_by_role = 'farmer' and exists (
        select 1 from public.bookings b where b.id = booking_id and b.farmer_id = auth.uid()
      ))
    )
  );

-- Updates are allowed (status, verdict, AI summary backfill, renter response)
-- but the immutability trigger above blocks any change to identity or hash.
drop policy if exists "Participants update reports" on public.condition_reports;
create policy "Participants update reports" on public.condition_reports
  for update using (public.is_booking_participant(booking_id))
  with check (public.is_booking_participant(booking_id));

-- No delete policy: a report is never deleted, even by its author.

-- ---- report_photos ----
drop policy if exists "Participants read report photos" on public.report_photos;
create policy "Participants read report photos" on public.report_photos
  for select using (public.is_booking_participant(booking_id));

drop policy if exists "Participants add report photos" on public.report_photos;
create policy "Participants add report photos" on public.report_photos
  for insert with check (
    public.is_booking_participant(booking_id)
    and captured_by = auth.uid()
  );
-- No update/delete policy: evidence is immutable.

-- ---- report_signatures ----
drop policy if exists "Participants read signatures" on public.report_signatures;
create policy "Participants read signatures" on public.report_signatures
  for select using (public.is_booking_participant(booking_id));

drop policy if exists "Users sign their own attestation" on public.report_signatures;
create policy "Users sign their own attestation" on public.report_signatures
  for insert with check (
    public.is_booking_participant(booking_id)
    and user_id = auth.uid()
    and (
      (role = 'owner' and exists (
        select 1 from public.bookings b where b.id = booking_id and b.owner_id = auth.uid()
      ))
      or
      (role = 'farmer' and exists (
        select 1 from public.bookings b where b.id = booking_id and b.farmer_id = auth.uid()
      ))
    )
  );
-- No update/delete policy: you cannot unsign, and you cannot sign as someone else.

-- ---- report_events ----
drop policy if exists "Participants read report events" on public.report_events;
create policy "Participants read report events" on public.report_events
  for select using (public.is_booking_participant(booking_id));

drop policy if exists "Participants append report events" on public.report_events;
create policy "Participants append report events" on public.report_events
  for insert with check (public.is_booking_participant(booking_id));
-- Append-only enforced by trigger (no update/delete possible).

-- ---- damage_claims ----
drop policy if exists "Participants read claims" on public.damage_claims;
create policy "Participants read claims" on public.damage_claims
  for select using (public.is_booking_participant(booking_id));

drop policy if exists "Owner files claim" on public.damage_claims;
create policy "Owner files claim" on public.damage_claims
  for insert with check (
    filed_by = auth.uid()
    and exists (
      select 1 from public.bookings b
      where b.id = booking_id and b.owner_id = auth.uid()
    )
  );

drop policy if exists "Participants update claims" on public.damage_claims;
create policy "Participants update claims" on public.damage_claims
  for update using (public.is_booking_participant(booking_id))
  with check (public.is_booking_participant(booking_id));
-- A claim can never be deleted — only withdrawn (status) — so there is a
-- permanent trace of every claim ever made, including withdrawn ones.

-- ---- deposit_settlements ----
drop policy if exists "Participants read settlements" on public.deposit_settlements;
create policy "Participants read settlements" on public.deposit_settlements
  for select using (public.is_booking_participant(booking_id));

drop policy if exists "Participants create settlements" on public.deposit_settlements;
create policy "Participants create settlements" on public.deposit_settlements
  for insert with check (public.is_booking_participant(booking_id));

drop policy if exists "Participants update settlements" on public.deposit_settlements;
create policy "Participants update settlements" on public.deposit_settlements
  for update using (public.is_booking_participant(booking_id))
  with check (public.is_booking_participant(booking_id));

-- ---- equipment_damage_log ----
-- Readable by everyone: a machine's known condition is exactly the thing a
-- renter should be able to see before booking. (Photos stay private.)
drop policy if exists "Damage log readable by everyone" on public.equipment_damage_log;
create policy "Damage log readable by everyone" on public.equipment_damage_log
  for select using (true);

drop policy if exists "Equipment owner manages damage log" on public.equipment_damage_log;
create policy "Equipment owner manages damage log" on public.equipment_damage_log
  for all using (
    exists (select 1 from public.equipment e where e.id = equipment_id and e.owner_id = auth.uid())
  ) with check (
    exists (select 1 from public.equipment e where e.id = equipment_id and e.owner_id = auth.uid())
  );

drop policy if exists "Booking parties add damage log entries" on public.equipment_damage_log;
create policy "Booking parties add damage log entries" on public.equipment_damage_log
  for insert with check (
    booking_id is not null
    and public.is_booking_participant(booking_id)
    and exists (
      select 1 from public.bookings b
      where b.id = booking_id and b.equipment_id = equipment_id
    )
  );

-- ============================================================================
-- 10. Storage — private evidence bucket
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('inspection-photos', 'inspection-photos', false, 4194304,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = false,
  file_size_limit = 4194304,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

-- Path convention: inspections/<booking_id>/<report_id>/<slot>-<rand>.jpg
drop policy if exists "Booking parties read inspection photos" on storage.objects;
create policy "Booking parties read inspection photos" on storage.objects
  for select using (
    bucket_id = 'inspection-photos'
    and public.is_booking_participant(public.safe_bigint((storage.foldername(name))[2]))
  );

drop policy if exists "Booking parties upload inspection photos" on storage.objects;
create policy "Booking parties upload inspection photos" on storage.objects
  for insert with check (
    bucket_id = 'inspection-photos'
    and auth.uid() is not null
    and public.is_booking_participant(public.safe_bigint((storage.foldername(name))[2]))
  );

-- No update/delete policy: filed evidence cannot be swapped or removed. (An
-- abandoned capture leaves an orphan file; that is the intentional trade-off —
-- see docs/PHASE7 §4 privacy note.)

-- ============================================================================
-- 11. Trust roll-up view (read-only convenience for badges)
-- ============================================================================
-- security_invoker so the caller's RLS still applies to the underlying tables.

create or replace view public.user_trust_summary
with (security_invoker = true) as
with reports as (
  select
    r.created_by as user_id,
    count(*) as reports_filed,
    count(*) filter (where r.renter_response = 'agreed') as reports_agreed,
    count(*) filter (where r.renter_response = 'disagreed') as reports_disagreed,
    count(*) filter (where r.flagged) as reports_flagged,
    max(r.created_at) as last_report_at
  from public.condition_reports r
  where r.created_by_role <> 'system'
  group by r.created_by
),
claims as (
  select
    c.filed_by as user_id,
    count(*) as claims_filed,
    count(*) filter (where c.status in ('agreed', 'resolved')) as claims_upheld,
    count(*) filter (where c.status in ('disputed', 'expired_no_response')) as claims_contested
  from public.damage_claims c
  group by c.filed_by
)
select
  u.id as user_id,
  u.name,
  coalesce(r.reports_filed, 0) as reports_filed,
  coalesce(r.reports_agreed, 0) as reports_agreed,
  coalesce(r.reports_disagreed, 0) as reports_disagreed,
  coalesce(r.reports_flagged, 0) as reports_flagged,
  coalesce(c.claims_filed, 0) as claims_filed,
  coalesce(c.claims_upheld, 0) as claims_upheld,
  coalesce(c.claims_contested, 0) as claims_contested,
  r.last_report_at,
  case
    when coalesce(r.reports_disagreed, 0) >= 2 then 'flagged'
    when coalesce(r.reports_agreed, 0) >= 5 and coalesce(r.reports_flagged, 0) = 0 then 'trusted'
    when coalesce(r.reports_agreed, 0) >= 3 then 'established'
    else 'new'
  end as badge
from public.users u
left join reports r on r.user_id = u.id
left join claims c on c.user_id = u.id;

grant select on public.user_trust_summary to authenticated, anon;


-- ============================================================================
-- 11b. Perceptual-hash history (lets the FRONTEND do reuse detection too)
-- ============================================================================
-- Photos are private, but their perceptual hashes are not sensitive — and
-- handing them out means the browser can flag "this photo was already used in
-- another booking on this machine" even on a deployment whose backend has no
-- service key. Defined as SECURITY DEFINER so it can read across bookings
-- without widening report_photos' RLS.

create or replace function public.equipment_photo_hashes(p_equipment_id bigint, p_limit int default 400)
returns table (photo_id uuid, booking_id bigint, slot text, dhash text, sha256 text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.booking_id, p.slot, p.dhash, p.sha256, p.created_at
  from public.report_photos p
  where p.equipment_id = p_equipment_id
  order by p.created_at desc
  limit least(greatest(coalesce(p_limit, 400), 1), 1000);
$$;

grant execute on function public.equipment_photo_hashes(bigint, int) to authenticated;

-- ============================================================================
-- 12. Backfill — every existing booking starts from a known state
-- ============================================================================

update public.bookings
   set verification_state = 'not_started'
 where verification_state is null;

-- Indexes the new flows lean on.
create index if not exists idx_bookings_verification on public.bookings(verification_state);
create index if not exists idx_reports_booking on public.condition_reports(booking_id, kind);
create index if not exists idx_reports_code on public.condition_reports(report_code);

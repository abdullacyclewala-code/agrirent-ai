# Phase 7 — Trust Layer: Verified Condition Reports

> **Status:** BUILT (Phase 7 shipped — see §9 below for what was actually
> implemented, the disclosures, and what is still human work). Read with
> `AGRIRENT_AI_MASTER.md` §0 STATUS.
> **Goal:** make lying expensive and detectable for *both* parties, and leave a
> record that a third person (a bank, a panchayat, a police complaint, a court)
> can independently verify. Policy defines the rules; the app enforces and
> records them.

---

## 1. The honest premise (read this first)

**No app can force honesty.** A determined liar with two phones, a friend, or a
photo editor can beat any single check. What software *can* do — and what this
phase builds — is four things:

1. **Raise the cost of lying** — faking evidence means defeating several
   independent signals at once (time, place, pixels, hashes, a witnessed
   countersignature), not just one.
2. **Remove the information asymmetry** — "it was already like that" stops being
   an argument once a signed, timestamped, photo-backed baseline exists for that
   specific machine, carried forward across every rental.
3. **Record what each party attested, and when** — separately, immutably, and
   attributably. Nobody can silently change the record afterwards, including us.
4. **Never decide alone** — AI flags, humans decide. Same conclusion the mature
   rental-fleet tools reached (Record360 markets it as "AI-assisted,
   human-approved"; CloudRent Pro compares dispatch vs. return photos and
   surfaces only what needs attention).

The research grounds this: in Indian deposit disputes, the documented cause of
failure is almost always *undocumented* deductions and unclear
damage-vs-wear-and-tear boundaries — courts/tribunals expect photographs from
both ends of the tenancy plus an itemised breakdown. On the technical side,
photo authenticity work agrees that EXIF alone is spoofable, so the recognised
approach is multiple weak signals (metadata consistency, perceptual-hash
duplicate detection, compression/edit traces) combined into a judgement — never
one "lie detector".

So the deliverable is a **Verified Condition Report**: an evidence pack, an AI
reading of it, two separate attestations, and a tamper-evident chain — not a
black box that calls people liars.

---

## 2. What each party experiences (this is the whole product)

### Steps for an owner, a handover — target: **60 seconds, zero typing**
1. Tap **Start condition report** on the booking.
2. Tap **4 guided photos** (each shows a one-line instruction + a ghost overlay):
   | Slot | Instruction (surface text) |
   |---|---|
   | `full_left` | Whole machine, front-left, 3–4 m away |
   | `full_right` | Whole machine, rear-right |
   | `meter` | Hour meter / odometer, close up (proof of usage) |
   | `work_area` | Implement, tyres, usual damage spots |
   Optional: **+ Add a photo** with one-tap labels for damage that already
   exists (scratch / dent / crack / tyre / leak / other) + a severity chip.
3. **Confirm** — written summary of the AI's reading ("2 pre-existing damages
   noted, hour meter 1,240") with one **Fix/Edit** row per item if it's wrong.
4. **Sign** with a finger on the canvas + one statement line ("I confirm this
   report matches the machine as handed over"). Done.

Renter side at handover: a notification → opens the same report → sees the same
photos → **Agrees** or **Disagrees** (with a photo of their own, optional) or
does nothing (silence is recorded as silence, never as agreement, after 24 h).

### Steps at return — target: **45 seconds, zero typing**
Renter taps through the same 4 slots → the app shows the AI's before/after diff
→ renter taps **Request completion**. Owner then either taps **Machine is fine**
(claim window closes, deposit releases) or **Report damage** (photos + amount +
optional repair estimate photo).

### If damage is claimed
Renter sees: owner's claim, the amount, the repair-estimate photo, and the AI's
*new damage* diff with confidence. They tap:
- **Agree** → settlement records the withheld amount.
- **Dispute** — pick a reason chip (Not new damage · Pre-existing · Not caused by
  me · Amount too high · Machine wasn't as described) + optional text/photos.
  Booking enters **Disputed**. Nothing is deducted while disputed.

### Resolution
Offer / counter-offer → accept, or escalate to AgriRent review, or apply the
published rule (below). Undisputed amounts are releasable while a disputed
portion stays held — "release any undisputed amount where the payment
arrangement permits".

---

## 3. Architecture

```
Owner phone (capture)                 Backend (Render, FastAPI)            Supabase
─────────────────────                 ─────────────────────────            ────────
guided 4-shot capture   ──upload──►   POST /verification/analyze      ──►  condition_reports
 • watermark burned into pixels        vision chain:                        report_photos
   (booking, IST time, GPS, code)      Gemini vision → Groq vision          report_signatures
 • dHash (perceptual) per photo         → Cloudflare Workers AI             report_events (chain)
 • sha256 of bytes                      → deterministic fallback            damage_claims
 • EXIF + live GPS                     POST /verification/compare      ──►  deposit_settlements
 • EXIF stripped of PII? no — kept      (slot-matched before/after diff)    equipment_damage_log
   for evidence, bucket is private     POST /verification/verify-chain      trust_scores
                                       GET  /verification/report/:id
```

Everything reuses the project's existing patterns: same fallback-chain
philosophy as `llm_service.py`, same "always works" degradation, same
frontend-direct-to-Supabase CRUD + RLS, backend only for the things that need a
server (secrets, AI calls, hash-chain verification).

**No new vendor.** The vision chain uses the three providers this project
*already* has keys for on Render — Gemini (`GEMINI_API_KEY`), Groq
(`GROQ_API_KEY`), Cloudflare Workers AI (`CF_ACCOUNT_ID`/`CF_API_TOKEN`). If
none are configured, the feature still works end to end on deterministic
signals alone (§5) and simply reports `ai: unavailable` — the same graceful
degradation as the LLM parse and the push notifications.

### Why the AI is genuinely load-bearing (and not decoration)
- **Before/after diff, slot by slot** — the single most decisive artefact in a
  damage dispute, produced without asking a farmer to compare JPEGs on a phone.
- **Hour-meter OCR** — turns "how long did you actually use it?" from a
  he-said/she-said into a number read off the machine's own dial, at both ends.
- **Quality gate at capture time** — "this shot is blurry / too dark / the
  machine isn't in frame, retake it" *before* upload, while the user is still
  standing at the machine. This is what makes the 60-second flow reliable.
- **Native-language narrative** — the report explains itself in en/hi/mr.

---

## 4. Data model (all new, additive — nothing existing is altered destructively)

Migration: `supabase/migrations/20261014_phase7_trust_layer.sql`, mirrored into
`supabase/schema.sql` so fresh setups stay in sync (project convention).

| Table | Purpose | Key columns |
|---|---|---|
| `condition_reports` | one per handover/return | `booking_id, equipment_id, kind('handover'\|'return'), status, created_by, unilateral bool, ai_summary jsonb, ai_provider, verdict, signals jsonb, policy_version, report_hash, chain_index, supersedes_id` |
| `report_photos` | evidence | `report_id, slot, storage_path, sha256, dhash, captured_at_device, received_at, exif jsonb, gps_lat, gps_lng, gps_source, ai jsonb, flags text[]` |
| `report_signatures` | the two attestations | `report_id, user_id, role, signed_at, signature_png_path, statement_version, content_hash` |
| `report_events` | append-only audit + hash chain | `report_id, actor_id, actor_role, event, payload jsonb, created_at, prev_hash, row_hash` |
| `damage_claims` | owner's claim | `booking_id, report_id, filed_by, amount_claimed, description, evidence_photo_ids uuid[], status, response_deadline, resolved_amount, resolution_note, decided_at` |
| `deposit_settlements` | money outcome | `booking_id, deposit_amount, released_amount, withheld_amount, status, policy_snapshot jsonb, offline_ref, settled_at` |
| `equipment_damage_log` | **the carry-forward baseline** | `equipment_id, first_seen_report_id, part, kind, severity, status('open'\|'repaired'\|'disputed'), photo_ids uuid[]` |
| `trust_scores` | incentive layer | `user_id, reports_completed, reports_flagged, claims_filed, claims_upheld, claims_rejected, disputes_lost, badge` |

**`equipment_damage_log` + `supersedes_id` are the quiet superpower:** handover
report N becomes the baseline for booking N+1. A damage the owner already
accepted can never be billed again; a damage the renter accepted stays on the
machine's record until a later report marks it repaired. "It was already like
that" is answered by the machine's own file, not by memory.

**Privacy** (deliberate, and disclosed): photos are evidence, not marketing —
bucket `inspection-photos` is **private**, served by short-lived signed URLs,
RLS-restricted to the two booking parties. GPS is stored because it is the point
of the feature; the capture screen states this in one plain line, and a retention
policy (default: keep N years, then purge photos, keep the report + hashes) is
recorded in the policy snapshot.

---

## 5. Honesty signals — cheap, deterministic, and the real backbone

Every photo and report carries a signal pack. AI is the *third* layer, not the
first; these run even with no AI keys, no network, and no budget.

| # | Signal | Catches | Computed |
|---|---|---|---|
| 1 | **Burned-in watermark** (booking id, IST timestamp, GPS, report code) | reuse of an unrelated photo; screenshots; staged vs. filed time | client (pixels) |
| 2 | **dHash perceptual duplicate match** (Hamming ≤ 6/64) across the equipment's entire photo history | the same photo filed twice — reuse of a handover photo as return evidence, another booking's photo, collusion | client, re-verified server |
| 3 | **sha256 of exact bytes** | byte-identical resubmission; later tampering with a stored file | client → server |
| 4 | **EXIF `DateTimeOriginal` vs. server receipt time vs. booking window** | backdated/stock photos | server |
| 5 | **Photo GPS vs. equipment location vs. the other party's photos** (haversine) | photos taken somewhere else | server |
| 6 | **Watermark text read back by the vision model** vs. stored metadata | edited/forged composites | AI layer |
| 7 | **shot-sequence plausibility** (4 shots within a plausible window, capture path is in-app camera) | desktop uploads posing as field captures | client + server |
| 8 | **Hour-meter delta over the rental** vs. the booked window/usage claimed | "it was barely used" / inflated usage claims | AI + arithmetic |

Verdict per report: `verified` · `verified_with_flags` · `unverified`, always
shown with the *reason*, to both parties. Flags never silently block — they
inform, and they are attached to the record permanently.

---

## 6. Enforcement — the gates (the "policy" part)

Booking gains `verification_state`:
```
Awaiting handover report → Handover signed → In use
  → Awaiting return report → Return filed
      → No claim within window (default 24 h) → Deposit release  [auto, recorded as "no claim filed"]
      → Claim filed → Renter: Agree → Settlement
                              Renter: Dispute → Disputed → Resolution → Settlement
```

| Gate | Rule | Why it's fair |
|---|---|---|
| `Confirmed → In Use` | Owner is prompted to file the handover report. If they don't, the booking can still start — a **unilateral** report is created from whatever exists, flagged `unilateral: true`, and the renter has 24 h to countersign or object. | Hard-blocking a farmer's machine because a landlord didn't open the app would punish the wrong party. |
| `In Use → Completed` | A return report is required to settle a deposit. If the renter won't file, the owner may file alone (also flagged unilateral). | No evidence, no deduction. Both directions. |
| Claim window | 24 h (per-policy, versioned) after the return report is acknowledged; no claim → auto-release, event logged as *"auto: no claim filed within window"*. | Mirrors the existing §4.5 stale-request auto-expiry pattern already in `bookingLifecycle.js` (evaluated lazily, no new cron infra needed). |
| Dispute | Booking enters `Disputed`; **nothing is withheld while disputed**; the evidence pack freezes. | Matches the plan: "release any undisputed amount where the payment arrangement permits". |
| Settlement | `released = deposit − withheld`. Partial release supported. Since payments are still a later phase in this app, the settlement records the decision + an offline reference (UPI ref entered by the payer, confirmable by the payee) — clearly labelled as manual. | Honest about what the app can and cannot do today. |
| Repeat abuse | `trust_scores` badge + claim outcomes visible on listings/profiles ("Verified handover · 12 reports · 0 disputed claims"). | Turns honesty into a marketplace advantage — the strongest anti-lying force there is. |

---

## 7. The artefact both parties walk away with

A shareable, printable report page (browser print → PDF, no new dependency, no
server-side PDF stack on Render's free tier):

- Equipment identity + booking + policy version.
- Every photo, timestamped and geolocated, in a before/after slider.
- AI findings, quality scores, and every honesty signal with its verdict.
- Both attestations with signature images, names, IST timestamps.
- **Verification code (`report_hash` prefix) + QR** → public
  `/verify/<hash>` page → *"This report is intact. Not altered since signing."*
  recomputed live from the hash chain.

That QR is the answer to "who do I show this to?" — an insurer, a bank, a
village elder, a lawyer, a court. It is also why the hash chain is not
decoration: it is the difference between a screenshot and a record.

---

## 8. Build plan (each step independently shippable)

| Step | Scope | Files |
|---|---|---|
| **7.1** | Schema + storage bucket + RLS + hash-chain triggers | `supabase/migrations/20261014_phase7_trust_layer.sql`, `supabase/schema.sql` |
| **7.2** | Capture engine: watermark baking, dHash, sha256, EXIF/GPS, offline queue | `src/lib/inspectionCapture.js`, `src/lib/trustSignals.js` |
| **7.3** | Guided capture UI (4 slots, zero typing, quality gate) | `src/components/inspection/GuidedCapture.jsx`, `PhotoGrid.jsx` |
| **7.4** | Vision service with 3-provider chain + caching + deterministic fallback | `backend/app/vision/{__init__,analyze,compare,signals}.py`, routes in `backend/app/main.py` |
| **7.5** | Report page: before/after slider, findings, sign/countersign, hash verify | `src/pages/ConditionReport.jsx`, `src/pages/VerifyReport.jsx`, `src/lib/trustClient.js` |
| **7.6** | Claim → dispute → settlement flow + gates on the booking state machine | `src/pages/DamageClaim.jsx`, `src/lib/depositPolicy.js`, `Booking.jsx` integration |
| **7.7** | Carry-forward baseline, equipment condition history, trust badges | `equipment_damage_log` wiring, `EquipmentDetails.jsx`, `Profile.jsx` |
| **7.8** | i18n (en/hi/mr, every string), docs, master-doc STATUS update | `src/i18n/locales/*.json`, `AGRIRENT_AI_MASTER.md`, `README.md`, `backend/README.md` |

---

## 9. Disclosed deviations & risks (project convention)

1. **AI is a triage layer, never an adjudicator.** Vision models hallucinate;
   an unverified AI claim must never move money. Findings are shown with
   confidence, the human decides, and the record keeps both.
2. **Deterministic signals are the backbone, AI is the accelerator** — the
   feature degrades to §5-only when no vision key is set (Render free tier,
   no new spend).
3. **Metadata is spoofable** — there is no anti-spoof silver bullet; signals 1–3
   and 6 are the ones that raise the bar meaningfully (pixels and hashes, not
   metadata alone).
4. **Payments are still out of scope** (per `Profile.jsx`'s existing note) — the
   settlement records decisions and offline references; it does not move money.
   When the payments phase lands, `deposit_settlements` is already the ledger
   shape a gateway/escrow needs.
5. **Cost control:** images are downscaled to ~768 px long edge before analysis,
   results cached by image `sha256` (re-opening a report never re-bills), and
   4 × 2 images per booking is a hard ceiling.
6. **A genuinely determined fraudster** with a rooted device can still fake some
   signals. The design accepts this and optimises for *making casual lying
   unprofitable* and *making the rare hard case legible*, which is what real
   dispute processes actually need.


---

## 9. What was actually built (post-implementation notes)

This section exists so the spec above is not mistaken for the implementation.
Where the two differ, the code and this section win.

### 9.1 Files

| Layer | Files |
|---|---|
| Database | `supabase/migrations/20261014_phase7_trust_layer.sql` + `..._phase7b_trust_hardening.sql` (both applied live and verified; both mirrored into `supabase/schema.sql`) |
| Capture / forensics (client) | `src/lib/inspectionCapture.js` — watermark baking, EXIF read + re-inject, sha256, dHash, quality gate, offline queue, private-bucket upload |
| Policy | `src/lib/depositPolicy.js` — `POLICY`, `POLICY_VERSION`, `verdictFor()`, `settlementSplit()`, `WEAR_AND_TEAR`, `CHARGEABLE_DAMAGE`, `FLAGS` |
| Flow (pure) | `src/lib/trustFlow.js` — `deriveVerificationState()`, `nextAction()`, `claimWindowState()`, label maps |
| Backend client | `src/lib/trustClient.js` — `analyzeReport()`, `verifyReportCode()`, `localSignals()` fallback |
| Data access | `src/lib/reportDb.js` — reports, photos, signatures, claims, settlements, damage log, RPC calls |
| Screens | `src/pages/ConditionReport.jsx`, `src/pages/DamageClaim.jsx`, `src/pages/VerifyReport.jsx` |
| Components | `src/components/inspection/{GuidedCapture,SignaturePad,ReportBits,TrustPanel,EquipmentCondition}.jsx` |
| Backend | `backend/app/vision/{signals,providers,analyze,routes}.py`, registered in `backend/app/main.py` (`/verification/*`, health reports `phase: 7`) |
| Tests | `scripts/test-trust.mjs` (39 assertions, zero deps, pure logic), `backend/tests/test_vision.py` (31 tests, AI always mocked), `scripts/test-trust-live.mjs` (**43 assertions against the real database**, real users, real RLS, self-purging), `scripts/make-fixtures.py` (synthetic before/after evidence) |
| Backend test/live helpers | `scripts/env-shim-loader.mjs` (lets plain node run the Vite-style `src/` modules so the live test exercises the shipped code, not a copy) |

### 9.2 Deviations from the spec, and why

1. **The hash chain is computed in Postgres, not in the web app.** The spec
   assumed a client-signed chain. A client can be modified; a trigger cannot.
   `report_event_hash()` + `report_events_chain()` run inside the database on
   every append (advisory-locked per report, so concurrent writers cannot chain
   off the same predecessor), and `verify_report(code)` recomputes the entire
   walk. This also made public verification possible: the RPC is granted to
   `anon`, so the `/verify/:code` page works with no login and no backend.
2. **`sha256()`, not pgcrypto's `digest()`.** `digest(text, unknown)` does not
   resolve for the API roles on this project (`42883`, hit live). Core
   `sha256(convert_to(x,'UTF8'))` is in `pg_catalog`, cannot be shadowed, and
   was verified against the live database.
3. **The backend is an enhancement, not a dependency.** Every screen works with
   the Render service asleep, retired, or without a Supabase service key: the
   deterministic signals are computed in the browser by the same rules the
   server uses (`localSignals()`), the AI reading is an addition
   (`ai_status: 'unavailable'` is a normal, signable state), and the report is
   still recorded, signed and verifiable. Two transport modes exist for the
   evidence itself and `GET /verification/config` reports which one is active.
4. **Signatures are drawn marks *plus* stored statements.** The binding part is
   `report_signatures.statement_text` — a sentence naming the report code and
   what it records — because that survives a lost PNG, a dead bucket or a
   printed photocopy. The drawn image is stored too, but nothing depends on it.
5. **`aiCanMoveMoney: false` is enforced by shape, not by trust.** AI output
   cannot set an amount, cannot change a status, and cannot write a settlement:
   `deposit_settlements` rows come only from a party's explicit agree/dispute
   action, and a disputed claim withholds rather than deducts.
6. **No native speaker has read the new hi/mr copy yet** — same open item as the
   Phase 6 i18n row, now including the `trust.*` namespace (272 keys per
   language, parity-checked in CI-by-hand).

### 9.4 What the live integration test caught (and what it changed)

`scripts/test-trust-live.mjs` signs up real users, creates a real booking, uploads
real evidence, and exercises the shipped modules against the live database under
real RLS. It found four things that unit tests could not:

1. **The AI/forensic findings had nowhere to land.** `report_photos` had no UPDATE
   policy at all (append-only, deliberately), so per-photo flags like
   `duplicate_photo` were computed, returned by the backend, and then silently
   dropped. Fixed in migration 7b with column-level grants (analysis columns
   only) + a policy restricted to unsent reports, and in `updateReportAnalysis()`,
   which now asks for the row back and **throws** instead of reporting success
   for a write that matched zero rows — the failure mode that hid the bug.
2. **Nothing stopped a signatory rewriting the verdict afterwards.** A participant
   could still UPDATE `verdict`, `signals` or `ai_summary` on a report the other
   party had already signed. Now frozen by the immutability trigger from finalize
   onwards (draft → writable, signed → frozen), which is the guarantee the
   signature is supposed to mean.
3. **Append-only made deletion impossible.** `report_events` is referenced by
   cascading foreign keys, so deleting a booking — or a user, i.e. an
   account-deletion request — hit the no-mutate trigger and failed forever. The
   trigger now allows DELETE only when a direct SQL session sets
   `agrirent.allow_purge = 'on'` *and* there is no end-user JWT in play. PostgREST
   cannot set custom GUCs, so the app cannot reach that path; the documentation
   for the operation is in the migration file.
4. **"₹2000+ needs a repair estimate" was only a UI rule.** The database accepted
   any number. It is now a CHECK constraint (`damage_claims_estimate_required`),
   and the claim form actually lets the owner attach the estimate — through the
   same camera + watermark + fingerprint pipeline as everything else, because a
   repair estimate is precisely the document someone would otherwise edit.

A fifth change was structural rather than a bug: `deposit_settlements` was being
written with `upsert(onConflict: booking_id)` against a column that has no unique
constraint (so it threw), and a single row per booking would have been wrong
anyway — a disputed booking legitimately produces a *hold* and then a *release*.
It is now an append-only ledger (`recordSettlement()` inserts, `getSettlement()`
returns the latest), which is both what a receipt should be and what the dispute
flow needs.

### 9.3 Known limits (deliberate, disclosed)

- A determined liar with two phones and a photo editor can still defeat any
  single signal. The design goal was never "catch everyone"; it was **make
  faking more expensive than telling the truth, and make the record prove what
  each side attested**. The flags say what is *unusual*, not what is *false* —
  which is why every flag is shown with its reason and a human decides.
- GPS and clock come from the device. They are cross-checked against each other,
  against the server receipt time, against the machine's registered location and
  against the other party's photos, but they are not independently witnessed.
- The claim window and the "silence is not agreement" rule are enforced lazily
  (evaluated when a party opens the booking), matching §4.5 — there is no cron
  on Render's free tier.
- Payment is still off-platform. This phase records the settlement decision; it
  cannot transfer money, and it says so on-screen.
- **Account deletion / data purge needs the SQL hatch** (migration 7b) because
  the audit trail is append-only by construction. This is intentional — the
  record is supposed to outlive arguments — but it means a future phase should
  wrap the purge in an admin-only RPC so it is a product feature rather than an
  operational runbook entry.
- The `trust-live` suite creates and deletes real rows. Point it only at a
  project where that is acceptable, and never at production data you care about.

### 9.5 A third layer of verification: the deployed endpoint, with real photos

Unit tests mock the AI and the integration test stops at the database, so neither
covers the thing this project has actually been burned by before: **model names**.
Two probes were run against the live Render service — real JWT, real booking, real
JPEGs, then cleanup.

*Probe 1 (synthetic fixtures, deliberately inconsistent)* — every honesty signal
fired exactly as intended:

```
HTTP 200 · ai_status=ok · ai_provider=gemini · auth_checked=true · storage=service
flags: sha_mismatch, capture_clock_skew, watermark_unreadable, no_camera_exif, unilateral_report
```

(a deliberately wrong client hash, a fabricated watermark, an EXIF-less photo, a
capture time disagreeing with the server's receipt, and only one attestation).

*Probe 2 (real photographs, one of them not machinery)* — the AI reading is real
and restrained:

```
HTTP 200 in 2.4s (cached on the second run by image hash)
ai_status=ok · ai_provider=gemini · 4/4 photos read
summary: "4 photo(s) recorded; 4 pre-existing damage item(s) noted;
          no new damage found against the handover photos."
damage_found: body panel rust major 0.95 · dashboard panel rust major 0.95
              cab frame crack major 0.90 · dashboard housing rust minor 0.80
```

The one photo that showed a car panel rather than a tractor came back
`shows_equipment: false` with no damage invented — which is the whole point of the
prompt's "only report what you can actually see, use low confidence instead of
inventing detail". `/verification/config` on the live service reports
`providers_configured: [gemini, groq]` and `storage_access: true`, so the full
path — private-bucket download, Pillow re-measurement, AI reading, signal pack,
verdict — is live in production, with no new vendor and no paid tier.

Probe 1 also caught a vocabulary drift that no test had: the backend emitted
`unilateral` while the UI knows only `unilateral_report` (and `missing_slots`
vs. `missing_required_slots`). A farmer would have seen a raw identifier instead
of a sentence. Both are fixed, the vocabulary is now declared once in
`signals.py`, `_add()` refuses anything outside it, and a test compares it
against `src/lib/depositPolicy.js`'s `FLAGS` so the two languages cannot drift
again silently.

### 9.6 Running everything

```bash
# pure logic (no network, no credentials)
python3 scripts/make-fixtures.py && node scripts/test-trust.mjs     # 39 assertions
cd backend && python3 -m pytest tests/ -q                           # 31 tests
cd .. && npx vite build && npx oxlint                                # build + lint

# live integration (creates + purges its own rows; see the script header)
SUPABASE_URL=... ANON_KEY=... SERVICE_KEY=... \
SUPABASE_REF=... SUPABASE_PAT=... node scripts/test-trust-live.mjs   # 43 assertions
```

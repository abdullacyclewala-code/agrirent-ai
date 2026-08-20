# AgriRent AI — Master Reference Doc

> **How to use this doc (read this first, every time):**
> This is the single source of truth for the project. Before building anything, read `## 0. STATUS` to see what's done and what's next. Then jump ONLY to the section relevant to the current task — you don't need to read the whole file. Sections are self-contained. After finishing a task, update `## 0. STATUS` (mark item done, move the "Currently building" pointer).

---

## 0. STATUS *(update this every session)*

**Phase:** 3 — LLM free-text parsing + semantic matching
**Currently building:** Phase 3 done — next up is Phase 4 (LightGBM ranking + realtime/FCM)

| Phase | Item | Status |
|---|---|---|
| 1 | Knowledge base (crops/ops/equipment taxonomy) | ✅ `src/data/taxonomy.json` + `supabase/seed_taxonomy.sql` |
| 1 | DB schema created (Supabase/Postgres) | ✅ `supabase/schema.sql` (run in Supabase SQL editor, then seed_taxonomy.sql) |
| 1 | Auth + role switching (farmer↔owner) | ✅ Email/password auth (Supabase Auth) + role toggle in navbar. NOTE: doc originally specced phone/OTP — switched to email/password for MVP since OTP needs a paid SMS provider (Twilio) wired into Supabase. Swap later if needed. |
| 2 | Equipment CRUD (owner side) | ✅ `AddEquipment.jsx` (create/edit) + "My Listings" tab in `Profile.jsx` (list/pause/delete). Deviation: no image upload yet — Supabase Storage bucket isn't set up; equipment shows illustrated art instead of photos. |
| 2 | Rules-based filter (hard compatibility) | ✅ `src/lib/rulesFilter.js` implements §6.3 (equipment_type, operation, crop, HP range, availability, excludes own listings). Deviation: no geo distance filtering yet — Mapbox/PostGIS isn't wired up, so `service_area_radius_km` isn't enforced. Matching/ranking score is a simple rules-based heuristic, explicitly a placeholder for the real Phase 4 LightGBM ranker. |
| 2 | Basic booking flow (no ML/LLM yet, manual form input) | ✅ `DescribeJob.jsx` → real `requirements` row → `Recommendations.jsx` (real filtered equipment) → `EquipmentDetails.jsx` (real booking creation, with availability + double-booking re-check per §4.5) → `Booking.jsx` (real status tracking + owner accept/reject/mark-in-use/complete, farmer cancel) → `MyBookings.jsx` (new — also fixes a dead `/bookings` nav link from Phase 1). Deviation: no `availability_slots` calendar yet — booking conflict check is a simple date-overlap query against existing Confirmed/In Use bookings on the same equipment, not a full slot system. |
| 3 | FastAPI backend stood up | ✅ `/backend` (FastAPI, deploy via `backend/render.yaml` on Render free tier). First backend service in the project — Phases 1–2 were Supabase-direct from the frontend. |
| 3 | LLM requirement parsing (fallback chain) | ✅ `backend/app/llm_service.py` — `POST /requirements/parse`. **Deviation (disclosed):** provider order flipped from the doc's Gemini→Groq to **Groq→Gemini**. As of the Dec 2025 Gemini free-tier cuts, Gemini free tier dropped to 5–15 req/min / 100–1,000 req/day, while Groq's free tier gives ~30 req/min, high TPM, and very low latency (LPU inference) — a better fit for a small JSON-extraction task that shouldn't get stuck behind rate limits. Gemini is kept as the second, independent-infra fallback. Final fallback is still the Phase 2 manual form (`DescribeJob.jsx`), always available per §4.5. **Model names updated post-deploy:** initial testing against the live Render deployment hit two 404s — Groq had deprecated `llama-3.1-8b-instant` (now `openai/gpt-oss-20b`, Groq's own recommended replacement) and Google had retired `gemini-2.5-flash-lite` (now `gemini-3.5-flash-lite`, per the live API error). Both are env-var driven (`GROQ_MODEL`/`GEMINI_MODEL`) so future renames don't need a code change — check Render logs for `ERROR:agrirent.llm_service:[groq|gemini]` if this recurs. |
| 3 | Semantic matching (vocabulary-mismatch fallback) | ✅ `backend/app/semantic_match.py`. **Deviation (disclosed):** uses the taxonomy's existing synonym map + stdlib `difflib` lexical similarity instead of `sentence-transformers`/`all-MiniLM-L6-v2` — the real embedding model needs `torch` (~800MB+), which doesn't fit Render's 512MB free-tier RAM and would cause slow/failing cold starts (the exact "stuck" failure mode this phase is trying to avoid). Upgrade path documented in the file for when a bigger instance is available. |
| 3 | Frontend free-text input wired into Phase 2 filter | ✅ New "freetext" step at the top of `DescribeJob.jsx` (`src/lib/llmClient.js` calls the backend) — pre-fills crop/operation/land, farmer reviews/edits in the existing wizard steps, then flows into the same `runRulesFilter` (§6.3) as before. Skipping the free-text step or any LLM failure drops straight into the unchanged manual wizard. |
| 4 | LightGBM ranking model (synthetic data) | ⬜ |
| 4 | Realtime booking status + FCM notifications | ⬜ |
| 5 | Polish, retrain on real data, deploy | ⬜ |

**Phase 3 setup required before this works end-to-end (not yet done by the AI session, needs human action):**
1. Get a free Groq API key (https://console.groq.com/keys) and optionally a Gemini key (https://aistudio.google.com/apikey).
2. Deploy `/backend` to Render (see `backend/README.md`) — free tier, using `backend/render.yaml` as a Blueprint.
3. Set `VITE_BACKEND_URL` in the frontend (`.env.local` for dev, Vercel env vars for prod) to the deployed Render URL.
Until step 2–3 are done, the free-text step gracefully no-ops (see `llmClient.js`) and the app behaves exactly as it did at the end of Phase 2.

**Rule:** Don't start a phase-N item until all phase-(N-1) items are ⬜→✅. This keeps each AI session scoped to one working slice.

**Architecture deviation (Phases 1–2, resolved in Phase 3):** No FastAPI backend existed for Phases 1–2 — the frontend talked directly to Supabase (Postgres + Auth) via the JS client, relying on Postgres RLS. That's still true for all CRUD + rules-filtering (equipment, bookings, requirements rows) — those are unchanged and still go straight to Supabase from the frontend. Phase 3 added the **first** backend route (`/backend`, FastAPI on Render free tier) but scoped it to exactly one job: `POST /requirements/parse` for LLM free-text parsing, since that's the one thing that genuinely needs a server (API keys can't live in frontend code). The rest of the §5.3 endpoint table is still not implemented as literal routes — Phase 4's LightGBM model will be the next thing that needs the backend to grow.

---

## 1. CORE IDEA (read once, always relevant)

AgriRent AI is a multilingual (English/Hindi/Marathi + Hinglish) equipment rental marketplace for farmers. A farmer describes a farming job in plain language ("5 acre cotton ploughing"); the system extracts structured meaning, filters technically compatible equipment, ranks the best matches, and lets the farmer book. Any account can be **both** a renter and a lister (a farmer who rents a tractor can also list their own harvester).

**Non-negotiable design principle:** LLM understands language → Rules determine hard compatibility → ML ranks what's left → DB checks availability → Booking connects farmer + owner. Never let the LLM or ML make a hard compatibility decision — rules do that.

---

## 2. TECH STACK (read once, always relevant)

| Layer | Choice |
|---|---|
| Frontend | React + Vite + TypeScript, Tailwind CSS, i18next, Zustand, vite-plugin-pwa |
| Backend | FastAPI + SQLAlchemy + Alembic + Pydantic |
| DB / Auth / Storage / Realtime | Supabase (Postgres + PostGIS, Auth via phone/OTP, Storage for images, Realtime for booking updates) |
| LLM | Gemini API → Groq API fallback → manual structured form fallback |
| ML ranking | LightGBM Ranker (LambdaMART) over rule-filtered candidates |
| Semantic matching | sentence-transformers (`all-MiniLM-L6-v2`) |
| Location | Mapbox (geocoding, distance) + PostGIS (geo queries) |
| Notifications | Firebase Cloud Messaging |
| Hosting | Frontend → Vercel · Backend → Render (free tier) · DB/Auth/Storage → Supabase |

Images: compress client-side to ~150–200KB before upload to Supabase Storage (1GB free limit, separate from 500MB DB limit).

---

## 3. AGRICULTURE KNOWLEDGE BASE *(build this FIRST — everything else depends on it)*

This is the shared vocabulary both equipment listings and farmer requirements get mapped into. It must exist before schema, LLM prompts, dropdowns, or filter queries are built.

### 3.1 Structure needed
- **Crops list** — starter set: cotton, wheat, sugarcane, rice/paddy, soybean, groundnut, maize, onion, tur/pigeon pea, gram/chickpea. (Expand based on target region.)
- **Operations list** — starter set: ploughing, tilling, harrowing, sowing/seeding, spraying, harvesting, threshing, transportation, land leveling, irrigation.
- **Equipment types list** — starter set: tractor, rotavator, cultivator, harvester (combine), seed drill, sprayer, thresher, trailer, plough (disc/mould board), leveler.
- **Compatibility matrix** — for each equipment type: which operations it performs, which crops it's typically used for, and a required-HP range (e.g. tractor for cotton ploughing on <10 acres needs ~35–50HP; >10 acres needs 50HP+).
- **Synonym/alias map** — informal or regional terms mapped to canonical taxonomy terms (e.g. "jotai" → ploughing, "katai" → harvesting). This feeds the semantic-matching fallback in section 6.

### 3.2 Deliverable
A single structured file (JSON or seed SQL) — e.g. `taxonomy.json` — with three arrays (crops, operations, equipment_types) and one compatibility table (equipment_type × operation × crop × hp_range). This file is imported into: (a) the DB as lookup/seed tables, (b) the frontend as dropdown options, (c) the LLM system prompt as the allowed output vocabulary.

**Action for the AI building this phase:** Generate the taxonomy.json with at least the starter lists above, expanded to be realistic for Indian farming, plus the compatibility matrix. Mark this STATUS item done once `taxonomy.json` exists and is seeded into the DB.

---

## 4. REQUIREMENTS & SCOPE

### 4.1 Roles
- **Farmer** — describe requirement, get recommendations, compare, book, track bookings.
- **Owner** — list equipment, manage availability/pricing, accept/reject bookings.
- **Single account = both roles**, toggled via UI, not separate signups.
- Admin is optional / post-MVP.

### 4.2 MVP feature scope (build in this order)
1. Auth + role toggle
2. Equipment CRUD (owner)
3. Manual structured requirement form (farmer) — **no LLM yet**
4. Rules-based filter → results list
5. Booking flow with status states
6. LLM free-text requirement input (replaces/augments the form)
7. Semantic matching fallback
8. ML ranking of filtered results
9. Realtime status + push notifications

### 4.3 Booking status states
`Requested → Confirmed → In Use → Completed` (also: `Rejected`, `Cancelled`)

### 4.4 Core user flows

**Farmer flow:** Enter requirement → confirm parsed requirement → view filtered+ranked equipment → compare → select → choose date/time → book → track status → complete rental.

**Owner flow:** Add equipment (structured form using taxonomy) → set price/availability → receive booking request → accept/reject → mark in-use/completed.

### 4.5 Edge cases to handle explicitly (don't skip these)
- **Owner doesn't respond to a booking request** → auto-expire the request after a set window (e.g. 24–48h), notify farmer, suggest next-ranked alternative.
- **Equipment becomes unavailable after being shown in results but before booking confirmed** → re-check availability at booking-confirm time, not just at search time; show a "no longer available" message and re-run the filter.
- **Both LLM providers fail** → fall back to the manual structured form (section 6.1); this path must always work independently of LLM uptime.
- **Farmer requirement matches zero equipment** → relax non-critical filters first (e.g. widen service area) before showing "no results," and tell the farmer what was relaxed.
- **Double-booking conflict** (two farmers request same equipment/date) → first accepted booking locks the slot; other pending requests on that slot auto-notify farmer of conflict.
- **Farmer or owner using both roles on the same equipment** — a user can't book their own listed equipment; filter it out of their own search results.

---

## 5. SYSTEM ARCHITECTURE

### 5.1 Data flow
```
Farmer input (text)
   → LLM (extract) → structured JSON
        [if LLM fails] → manual form → same structured JSON shape
   → Rules engine (hard filter against taxonomy + availability + service area)
   → ML ranking (LightGBM, on filtered candidates only)
   → Results shown to farmer → booking created
   → Realtime status updates + push notifications to both parties
```

### 5.2 Core DB tables (Postgres, via Supabase)
- `users` — id, phone, name, roles (farmer/owner flags), location (PostGIS point)
- `equipment` — id, owner_id, equipment_type, hp, compatible_operations[], compatible_crops[], price, location, service_area_radius, images[], is_available
- `availability_slots` — id, equipment_id, date_range, is_booked
- `requirements` — id, farmer_id, raw_text, language, parsed_json (crop, area_acres, operation, equipment_type), created_at
- `bookings` — id, requirement_id, equipment_id, farmer_id, owner_id, status, start_date, end_date, price
- `taxonomy_crops`, `taxonomy_operations`, `taxonomy_equipment_types`, `taxonomy_compatibility` — seeded from section 3

### 5.3 Core API endpoints (FastAPI)
| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/auth/otp/request`, `/auth/otp/verify` | Auth via Supabase |
| POST | `/requirements` | Submit farmer requirement (text) → returns parsed JSON |
| POST | `/requirements/manual` | Submit structured form (fallback path) |
| GET | `/equipment/search` | Run filter+rank, given a parsed requirement id |
| POST | `/equipment` | Owner creates listing |
| PATCH | `/equipment/{id}` | Owner updates listing/availability |
| POST | `/bookings` | Farmer creates booking request |
| PATCH | `/bookings/{id}` | Owner accepts/rejects; status transitions |
| GET | `/bookings/mine` | List bookings for current user (either role) |

---

## 6. AI/ML SPECIFICATION

### 6.1 LLM layer
- **Providers:** Gemini API (primary) → Groq API (fallback) → manual structured form (final fallback, always available, uses same output shape).
- **Prompt design:** System prompt includes the full allowed vocabulary from `taxonomy.json` (crop list, operation list, equipment type list) and instructs the model to output **only** JSON matching this exact shape, using only terms from the provided lists:
```json
{
  "crop": "string (from allowed crop list, or null)",
  "area_acres": "number or null",
  "operation": "string (from allowed operation list)",
  "equipment_type": "string (from allowed equipment type list, or null if inferable from operation)"
}
```
- If the LLM outputs a term not in the taxonomy, run it through the semantic matcher (6.2) before rejecting.

### 6.2 Semantic matching (fallback for vocabulary mismatch)
- Use `sentence-transformers` (`all-MiniLM-L6-v2`) to embed the taxonomy's canonical terms once (cache these embeddings).
- When LLM output or farmer's raw term doesn't exactly match taxonomy, embed the term and cosine-match to the nearest canonical term above a similarity threshold (e.g. 0.75); below threshold, treat as unmatched and ask farmer to clarify.

### 6.3 Rules engine (hard filter)
Filters equipment where ALL must hold: `equipment_type` matches, `operation` in equipment's `compatible_operations`, `crop` in equipment's `compatible_crops` (if crop-specific), `hp` within required range, `is_available` true for requested dates, farmer location within `service_area_radius`.

### 6.4 LightGBM ranking (only ranks what passed 6.3)
**Feature list per candidate (requirement, equipment) pair:**
- HP delta (|required − actual|)
- Distance (via PostGIS/Mapbox)
- Price
- Availability match quality (exact date fit vs. partial)
- Equipment rating/history (0 until real data exists)
- Semantic match confidence score (from 6.2, if relevant)

**Cold-start strategy:** No real booking history at launch. Generate synthetic training data using rule-based heuristics (e.g. closer+cheaper+better-HP-match = higher synthetic label) plus randomness, and **clearly label it synthetic** in code/docs. Retrain periodically (e.g. weekly cron) once real booking outcomes accumulate — replace synthetic labels with real ones as they become available, don't mix silently.

### 6.5 Model serving
Train offline (script, not real-time), export via `joblib`, load into FastAPI at startup, serve inference synchronously per search request (candidate sets are small post-filtering, so this is fast).

---

## 7. BUILD PLAN — phase by phase

Each phase below is what ONE AI session should be given as scope. Point it to `## 0. STATUS` plus the ONE numbered section it needs.

1. **Phase 1 (needs §3, §5.2):** Build `taxonomy.json`, seed DB schema in Supabase, set up auth + role toggle.
2. **Phase 2 (needs §4, §5.2, §5.3, §6.3):** Equipment CRUD, rules-engine filter endpoint, manual-form booking flow end-to-end (no LLM/ML yet — prove the pipeline works with dummy structured input).
3. **Phase 3 (needs §6.1, §6.2):** Add LLM free-text parsing with fallback chain; wire into existing filter endpoint from Phase 2.
4. **Phase 4 (needs §6.4, §6.5, §4.3):** Add LightGBM ranking on top of filtered results; add realtime status + FCM notifications.
5. **Phase 5:** Polish edge cases (§4.5), deploy (Vercel/Render/Supabase), retrain ranking model plan on real data once bookings exist.

**When starting a new AI session:** paste this whole doc (it's short by design), say which Phase/item you're on per STATUS, and only that section's detail needs deep attention — the rest is context.

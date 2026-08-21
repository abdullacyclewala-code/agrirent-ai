# AgriRent AI — Master Reference Doc

> **How to use this doc (read this first, every time):**
> This is the single source of truth for the project. Before building anything, read `## 0. STATUS` to see what's done and what's next. Then jump ONLY to the section relevant to the current task — you don't need to read the whole file. Sections are self-contained. After finishing a task, update `## 0. STATUS` (mark item done, move the "Currently building" pointer).

---

## 0. STATUS *(update this every session)*

**Phase:** 6 — closing deviations found in a post-MVP audit (see table below)
**Currently building:** Phase 6, item-by-item, in this order: (1) i18n (English/Hindi/Marathi) — ✅ done, see item 1 in the table below, (2) multilingual semantic double-check via Cloudflare Workers AI (BGE-M3) — ✅ done, see item 2 in the table below (originally shipped on a self-hosted Hugging Face Space, then migrated to Cloudflare Workers AI in a follow-up pass — see that row's changelog), (3) equipment image upload — next up, (4) geo distance filtering, (5) real availability_slots calendar, (6) PWA install/offline. TypeScript and Zustand from the original §2 stack are intentionally NOT being adopted — plain JS/JSX and React Context are staying as-is; this is a deliberate, permanent decision, not a pending item.

| Phase | Item | Status |
|---|---|---|
| 1 | Knowledge base (crops/ops/equipment taxonomy) | ✅ `src/data/taxonomy.json` + `supabase/seed_taxonomy.sql` |
| 1 | DB schema created (Supabase/Postgres) | ✅ `supabase/schema.sql` (run in Supabase SQL editor, then seed_taxonomy.sql) |
| 1 | Auth + role switching (farmer↔owner) | ✅ Email/password auth (Supabase Auth) + role toggle in navbar. NOTE: doc originally specced phone/OTP — switched to email/password for MVP since OTP needs a paid SMS provider (Twilio) wired into Supabase. Swap later if needed. |
| 2 | Equipment CRUD (owner side) | ✅ `AddEquipment.jsx` (create/edit) + "My Listings" tab in `Profile.jsx` (list/pause/delete). Deviation: no image upload yet — Supabase Storage bucket isn't set up; equipment shows illustrated art instead of photos. |
| 2 | Rules-based filter (hard compatibility) | ✅ `src/lib/rulesFilter.js` implements §6.3 (equipment_type, operation, crop, HP range, availability, excludes own listings). Deviation: no geo distance filtering yet — Mapbox/PostGIS isn't wired up, so `service_area_radius_km` isn't enforced. Still runs client-side, unchanged since Phase 2 — Phase 4 only replaced the *score* it computes, not the filter itself (see Phase 4 ranking row below). |
| 2 | Basic booking flow (no ML/LLM yet, manual form input) | ✅ `DescribeJob.jsx` → real `requirements` row → `Recommendations.jsx` (real filtered equipment) → `EquipmentDetails.jsx` (real booking creation, with availability + double-booking re-check per §4.5) → `Booking.jsx` (real status tracking + owner accept/reject/mark-in-use/complete, farmer cancel) → `MyBookings.jsx` (new — also fixes a dead `/bookings` nav link from Phase 1). Deviation: no `availability_slots` calendar yet — booking conflict check is a simple date-overlap query against existing Confirmed/In Use bookings on the same equipment, not a full slot system. |
| 3 | FastAPI backend stood up | ✅ `/backend` (FastAPI, deploy via `backend/render.yaml` on Render free tier). First backend service in the project — Phases 1–2 were Supabase-direct from the frontend. |
| 3 | LLM requirement parsing (fallback chain) | ✅ `backend/app/llm_service.py` — `POST /requirements/parse`. **Deviation (disclosed):** provider order flipped from the doc's Gemini→Groq to **Groq→Gemini**. As of the Dec 2025 Gemini free-tier cuts, Gemini free tier dropped to 5–15 req/min / 100–1,000 req/day, while Groq's free tier gives ~30 req/min, high TPM, and very low latency (LPU inference) — a better fit for a small JSON-extraction task that shouldn't get stuck behind rate limits. Gemini is kept as the second, independent-infra fallback. Final fallback is still the Phase 2 manual form (`DescribeJob.jsx`), always available per §4.5. **Model names updated post-deploy:** initial testing against the live Render deployment hit two 404s — Groq had deprecated `llama-3.1-8b-instant` (now `openai/gpt-oss-20b`, Groq's own recommended replacement) and Google had retired `gemini-2.5-flash-lite` (now `gemini-3.5-flash-lite`, per the live API error). Both are env-var driven (`GROQ_MODEL`/`GEMINI_MODEL`) so future renames don't need a code change — check Render logs for `ERROR:agrirent.llm_service:[groq|gemini]` if this recurs. |
| 3 | Semantic matching (vocabulary-mismatch fallback) | ✅ `backend/app/semantic_match.py`. **Deviation (disclosed):** uses the taxonomy's existing synonym map + stdlib `difflib` lexical similarity instead of `sentence-transformers`/`all-MiniLM-L6-v2` — the real embedding model needs `torch` (~800MB+), which doesn't fit Render's 512MB free-tier RAM and would cause slow/failing cold starts (the exact "stuck" failure mode this phase is trying to avoid). Upgrade path documented in the file for when a bigger instance is available. |
| 3 | Frontend free-text input wired into Phase 2 filter | ✅ New "freetext" step at the top of `DescribeJob.jsx` (`src/lib/llmClient.js` calls the backend) — pre-fills crop/operation/land, farmer reviews/edits in the existing wizard steps, then flows into the same `runRulesFilter` (§6.3) as before. Skipping the free-text step or any LLM failure drops straight into the unchanged manual wizard. |
| 4 | LightGBM ranking model (synthetic data) | ✅ `backend/app/ranking/` (`features.py`, `train_ranker.py`, `ranker_service.py`) — `POST /equipment/rank`, called from `src/lib/rankClient.js` after the Phase 2 `runRulesFilter` (rules engine, unchanged, still client-side). Trained on clearly-labeled **synthetic** data per §6.4's cold-start strategy (rule-based heuristic labels + randomness — no real bookings exist yet). Lazily trained once at process start and cached to `model.joblib`, not committed to git. **Deviations (disclosed, same pattern as Phase 2/3):** `distance` feature is a constant placeholder (no Mapbox/PostGIS yet, same gap as `rulesFilter.js`); `equipment_rating` is always 0 (no ratings system in the DB yet, exactly as §6.4 specs for cold start); `semantic_confidence` defaults to 1.0 (nothing upstream currently passes a lower value end-to-end — Phase 3's semantic matcher score isn't wired through to this endpoint yet). `availability_quality` IS real: `DescribeJob.jsx` checks existing Confirmed/In Use bookings against the farmer's requested date before ranking. If the ranking endpoint is unreachable, the frontend silently keeps the Phase 2 heuristic score (`rulesFilter.js`) — same always-works fallback pattern as Phase 3's LLM parse. |
| 4 | Realtime booking status + FCM notifications | ✅ **Realtime:** `src/lib/realtime.js` (Supabase Realtime `postgres_changes`) — `Booking.jsx` live-updates the tracking page the instant status changes (with a small "Updated just now" badge), `MyBookings.jsx` live-updates the whole list (new bookings appear, status changes update in place). Requires `bookings` added to the `supabase_realtime` publication — done in `supabase/schema.sql`'s Phase 4 section. **FCM:** `src/lib/firebase.js` + `src/lib/push.js` (token registration, foreground message toast in `App.jsx`) + `public/firebase-messaging-sw.js` (background messages) + a "Turn on notifications" toggle in `Profile.jsx` → Settings. Backend: `backend/app/notifications.py` + `POST /notifications/booking-webhook`, called by a Postgres `pg_net` trigger (or a dashboard-created Supabase Database Webhook — same payload shape, both work) on `bookings` INSERT and UPDATE. **INSERT** (new booking request) notifies the owner only: "`<farmer>` has requested your `<equipment>`" (falls back to a generic message if either name lookup fails). **UPDATE** (status change — Confirmed/Rejected/In Use/Completed/Cancelled) notifies both parties, per the original design note below. **Verified working end-to-end** (real two-device test: laptop owner + phone farmer, real Firebase project) — confirmed iOS Safari doesn't support web push at all (no service worker + Notification API support), which is a platform limitation, not a bug; Android/desktop browsers work. **Setup required before push actually delivers (needs human action — see `backend/README.md`):** a Firebase project + Web Push (VAPID) key, the Firebase service-account JSON in Render, and wiring the trigger/webhook. Until then, everything no-ops safely — realtime status updates work regardless, since they don't depend on Firebase at all. |
| 5 | Polish, retrain on real data, deploy | ✅ **Deploy:** already live from earlier work — Render backend (`agrirent-ai-backend.onrender.com`) + Vercel frontend, confirmed working via real two-device push-notification testing in Phase 4. **§4.5 edge cases closed this phase:** (1) *stale request auto-expiry* — `src/lib/bookingLifecycle.js`'s `expireStaleRequests()`, checked lazily whenever `Booking.jsx`/`MyBookings.jsx` loads a "Requested" booking older than 48h, flips it to a new `Expired` status. Disclosed simplification: this is lazy (fires when someone looks), not a guaranteed-SLA cron — Render's free tier has no built-in scheduler; a real fix needs new infra (Render Cron Job / GitHub Actions), noted as a follow-up. (2) *double-booking conflict* — `Booking.jsx`'s Accept action now re-checks for Confirmed/In Use conflicts immediately before confirming (not just at original booking-creation time), and on success calls `conflictOutOverlappingRequests()`, which auto-flips every other still-"Requested" booking on the same equipment/overlapping dates to a new `Conflicted` status — reusing the existing pg_net webhook (no new plumbing) to notify those farmers automatically. Both new statuses have accurate `Booking.jsx` copy, a "Search again" CTA back to `/describe-job`, and their own push-notification message in `backend/app/notifications.py`. **Bug fix enabling real retraining:** `bookings.requirement_id` was silently NULL on every booking ever created (`EquipmentDetails.jsx` never set it) — now threaded through `Recommendations.jsx` → (query param) → `EquipmentDetails.jsx`'s insert, so future bookings can actually be traced back to the requirement/candidate-set that produced them. **Retrain plan:** `backend/app/ranking/retrain_from_bookings.py` — a manually-run script (`python -m app.ranking.retrain_from_bookings`) that pulls real resolved bookings (Completed/Confirmed/In Use/Rejected/Cancelled/Conflicted/Expired, excluding still-open `Requested`), groups them by `requirement_id`, and retrains the LightGBM ranker — but only if there are enough *multi-outcome* groups (>= 5 groups, >= 30 rows) to actually teach LambdaMART something; below that threshold it logs why and leaves the Phase 4 synthetic model untouched, rather than silently overfitting to a handful of test bookings. Verified with fabricated data covering all three cases (too little data, single-outcome groups, enough varied data). |

**Phase 4 setup required before this works end-to-end (not yet done by the AI session, needs human action):**
1. Redeploy `/backend` on Render (same service as Phase 3) — the new `lightgbm`/`numpy`/`joblib`/`firebase-admin` deps in `requirements.txt` will install automatically on the next build; no new Render service needed.
2. **Push notifications (optional — realtime status updates work without this):**
   - Create a Firebase project (free) at https://console.firebase.google.com, enable Cloud Messaging.
   - Firebase Console → Project Settings → General → "Your apps" → add a Web app → copy the config into the frontend's `VITE_FIREBASE_*` env vars (`.env.local` / Vercel).
   - Firebase Console → Project Settings → Cloud Messaging → "Web configuration" → generate a Web Push certificate (VAPID key) → `VITE_FIREBASE_VAPID_KEY`.
   - Fill the same config values (they're public, safe to commit) into `public/firebase-messaging-sw.js`'s `REPLACE_WITH_*` placeholders.
   - Firebase Console → Project Settings → Service Accounts → "Generate new private key" → paste the whole JSON as one line into Render's `FIREBASE_SERVICE_ACCOUNT_JSON` env var.
   - Pick any random string for `WEBHOOK_SECRET`, set it in Render's env vars.
   - Supabase Dashboard → Database → Webhooks → new webhook: table `bookings`, event `Update`, URL `https://<your-render-url>/notifications/booking-webhook`, HTTP header `X-Webhook-Secret: <same value as WEBHOOK_SECRET>`.
   - Supabase Dashboard → Database → Replication → toggle `bookings` on for realtime (the schema.sql migration does this via SQL too — either path works, running it twice is harmless).
   - Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (Project Settings → API → `service_role` secret — never put this in frontend code) in Render.

**Phase 5 setup (optional, only matters once real bookings accumulate):** no new env vars — `retrain_from_bookings.py` reuses `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` already set up for push notifications above. Just redeploy `/backend` to pick up the new file, then run `python -m app.ranking.retrain_from_bookings` manually (e.g. via `render exec` / Render Shell, or locally with those two env vars set) whenever you want to check if there's enough real data yet — see `backend/README.md` "Retraining the ranker on real data" for the exact command and what the thresholds mean. It's a no-op / declines cleanly if there isn't enough data, so it's safe to run speculatively.

**Phase 6 item 2 setup required before this works end-to-end (not yet done by the AI session, needs human action):**
1. Create a free Cloudflare account at https://dash.cloudflare.com/sign-up (if you don't have one) — no Space, no Docker, no separate deploy needed.
2. Find your **Account ID** in the Cloudflare dashboard (Workers & Pages → Overview, or the sidebar of any domain).
3. Create an API token: dashboard → My Profile → API Tokens → Create Token → **"Workers AI" template** (or custom token with `Account.Workers AI: Read`/`Edit`) → copy the token (shown once).
4. Redeploy `/backend` on Render (same service as Phases 3-5) with two new env vars: `CF_ACCOUNT_ID` (from step 2) and `CF_API_TOKEN` (from step 3).
Until steps 1-4 are done, nothing breaks — `semantic_match.py` keeps using its Phase 3 difflib fallback exactly as before; this is purely additive.

**Rule:** Don't start a phase-N item until all phase-(N-1) items are ⬜→✅. This keeps each AI session scoped to one working slice.

### Phase 6 — closing deviations (post-MVP audit)

A review of the live repo against this doc found several undisclosed or partially-disclosed gaps in addition to the ones already logged inline in the Phase 1–5 STATUS rows above. This table is the tracker for closing them. Each item stays ⬜ until actually built — don't mark done from this doc edit alone.

| # | Deviation found | Decision | Status |
|---|---|---|---|
| 1 | §1/§2: multilingual UI (English/Hindi/Marathi + Hinglish) via i18next — never implemented. `index.html` hardcoded `lang="en"`, no locale files, no language switcher. | **Fix.** Add `i18next` + `react-i18next` (free/OSS). Extract all UI strings into `en.json` / `hi.json` / `mr.json`. Seed hi/mr via free MT (Google Translate / DeepL free tier / LLM draft), then have a native speaker review farmer-facing copy specifically — highest-risk strings since farmers are the primary users. Add a language toggle in the navbar. | ✅ Done. `i18next` + `react-i18next` + `i18next-browser-languagedetector` added (`src/i18n/index.js`). All UI chrome strings across every page/component (`NavBar`, `RoleToggle`, `Auth`, `Dashboard`, `DescribeJob` incl. the free-text/scanning steps, `Recommendations`, `EquipmentDetails`, `AddEquipment`, `Booking`, `MyBookings`, `Profile`) now use `t(...)` against `src/i18n/locales/{en,hi,mr}.json`. Language toggle (`LanguageSwitcher.jsx`) is in the navbar (desktop + mobile) and in Profile → Settings; choice persists to `localStorage` and syncs `<html lang>`. **Known gap, disclosed:** the *taxonomy data itself* (crop/operation/equipment-type names in `src/data/taxonomy.json`, e.g. "Cotton", "Ploughing") is still English-only — that's structured data feeding dropdowns, not UI chrome, and localizing it means restructuring `taxonomy.json` into per-locale labels; out of scope for this pass, left for a follow-up. **Manual step still required (per this row's own decision):** hi/mr copy is LLM-drafted, not yet reviewed by a native Hindi/Marathi speaker — do that review before treating this as farmer-ready. |
| 2 | §6.2: semantic matching fallback uses `difflib` + synonym map only (English-oriented). Doesn't help with Hindi/Marathi dialectal variance the LLM sometimes mis-maps. | **Fix, with a specific role — see §6.2a below.** Call **Cloudflare Workers AI**'s hosted `@cf/baai/bge-m3` model directly from the Render backend (free allowance, no separate service to deploy or keep warm). BGE-M3 gives stronger multilingual embeddings for English/Hindi/Marathi/Hinglish than the original plan. This does **not** replace the LLM — see §6.2a for exact role. | ✅ Done. `backend/app/cloudflare_client.py` calls Cloudflare Workers AI's `@cf/baai/bge-m3` model over HTTP using its built-in query/contexts similarity mode (the model scores `term` against every candidate directly, no separate embedding math needed locally). Wired into `backend/app/semantic_match.py`'s fallback chain as step 3 of 4 (exact match → synonym map → **Cloudflare semantic call** → difflib last resort), matching §6.2a's "double-check on every non-exact LLM field, not just total failure" framing. Degrades safely: `CF_ACCOUNT_ID`/`CF_API_TOKEN` unset (or the call failing/timing out) falls straight through to the pre-existing difflib path — same logic and contract as before. **Changelog:** this item originally shipped (same session) as a self-hosted Hugging Face Space (`hf-space-semantic/`, Docker SDK, `paraphrase-multilingual-MiniLM-L12-v2`) called via `backend/app/multilingual_client.py`. That extra service — its own Dockerfile, git remote, deploy step, and free-tier cold-start/sleep behaviour — has since been **removed entirely** and replaced with this direct Cloudflare Workers AI call: same fallback position in the chain, same (match, score) contract, no separate infrastructure to deploy, no cold starts, and a stronger multilingual model. **Manual step still required (per this row's own decision — cannot be done from a repo commit alone):** create a free Cloudflare account, create a Workers AI API token, and set `CF_ACCOUNT_ID` + `CF_API_TOKEN` in Render — full steps in `backend/README.md` "Multilingual semantic double-check". Until that's done, this phase item is code-complete but not yet *live* — the app keeps working exactly as before (difflib fallback) in the meantime. |
| 3 | §4.2/§2: equipment photo upload — Supabase Storage bucket never created; listings show illustrated art instead of real photos. | **Fix.** Create a public Supabase Storage bucket (1GB free), compress client-side to ~150–200KB before upload (per §2's original note), wire into `AddEquipment.jsx`. | ⬜ Not started |
| 4 | §6.3/§6.4: geo distance filtering/ranking — Mapbox/PostGIS never wired up. `service_area_radius_km` not enforced; `distance` ranking feature is a constant placeholder. | **Fix, free-tier path.** Supabase Postgres already ships PostGIS (free, no separate service) — enable the extension, store `users.location`/`equipment.location` as `geography(Point)`, use `ST_DWithin`/`ST_Distance` directly in the existing Supabase queries. Skip Mapbox's paid geocoding API for now — take lat/lng from the browser's free Geolocation API (farmer/owner already on their device) or a manual pin-on-map (e.g. free `react-leaflet` + OpenStreetMap tiles, no API key needed) instead of address-string geocoding. | ⬜ Not started |
| 5 | §5.2: `availability_slots` table — never built; booking conflicts checked via ad-hoc date-overlap query against `bookings` instead. | **Fix.** Build the real `availability_slots` table per §5.2, replace the ad-hoc overlap query in `EquipmentDetails.jsx`/`Booking.jsx` with slot lookups. No new infra — same Supabase Postgres. | ⬜ Not started |
| 6 | §2: `vite-plugin-pwa` — never installed. No manifest, no installable/offline app shell (the FCM service worker is push-only, not a full PWA). | **Fix.** `npm i -D vite-plugin-pwa`, add manifest using existing `public/icons.svg` assets. Directly supports the "mobile, no registration" goal — installable home-screen app, offline caching, zero cost. | ⬜ Not started |
| 7 | §2: TypeScript and Zustand — spec'd, never adopted (plain `.jsx` + React Context throughout). | **Won't fix — deliberate.** Most of the webapp is already built in plain JS/JSX with Context; rewriting now isn't worth the churn. §2's tech stack table below is updated to reflect this as the actual, final choice rather than a pending gap. | ✅ Accepted as-is (not a bug) |
| 8 | Phone/OTP auth → email/password; no image upload; no geo filter — already disclosed inline in Phase 1/2/4 STATUS rows above. | **No change requested.** Left as-is per existing disclosure (OTP needs paid Twilio/SMS). | Unchanged |

### 6.2a Role of the multilingual model — LLM stays primary, model is a verifier/corrector

To be explicit about the intended division of labor (this is a change from the original §6.1/§6.2 fallback-chain framing):

- The LLM (Groq→Gemini) remains the **primary** extractor for crop/operation/area from free text, in all languages, same as §6.1.
- The multilingual embedding model is **not** a replacement path used only when the LLM totally fails — it runs as a **double-check/correction step** on every LLM output before it's shown to the farmer for review:
  1. LLM extracts `crop`/`operation`/`equipment_type` as usual.
  2. Each extracted term is sent to Cloudflare Workers AI (BGE-M3) and scored against the taxonomy's canonical terms.
  3. If the LLM's term already matches a canonical term with high confidence → keep it, no change.
  4. If confidence is low (LLM likely mis-mapped a dialectal/regional term) but the semantic match against a *different* canonical term is high-confidence → **silently correct** to that term.
  5. If neither the LLM's term nor the semantic match clears the confidence threshold → leave it for the farmer to fix in the existing review step (§6.1's manual-review UI), same as today.
- Order of cheap-to-expensive fallback stays: exact synonym-map lookup (instant, free) → Cloudflare Workers AI (BGE-M3) semantic call (adds a little latency, only for terms that need it) → farmer manual review (always available, per §4.5).
- This means Cloudflare is called on most requests (as a checker), not just on total LLM failure. Unlike the free-Space approach this replaced, Cloudflare Workers AI is a hosted, always-on service with no cold starts to plan around — the per-call latency is just the model call itself, not a wake-up penalty.

**Architecture note (grown again in Phase 4, unchanged in Phase 5):** Phase 3 scoped the backend to one job (LLM parsing). Phase 4 added two more things that genuinely need a server: (1) the LightGBM model itself — Python-only, can't run in the browser, and (2) sending FCM push — needs a Firebase service-account secret that can't live in frontend code. Phase 5 didn't add a new endpoint — both remaining §4.5 edge cases (stale-request expiry, double-booking conflict) are ordinary `bookings` UPDATEs that RLS already lets either party make, so they're handled entirely client-side (`src/lib/bookingLifecycle.js`), reusing the existing webhook for notification. Equipment/booking CRUD, the rules-engine hard filter, Realtime subscriptions, and now the Phase 5 lifecycle updates are all still frontend-to-Supabase directly (unchanged since Phase 1/2) — this backend only ever grows for the pieces that need a secret or a heavier runtime than a browser can offer.

---

## 1. CORE IDEA (read once, always relevant)

AgriRent AI is a multilingual (English/Hindi/Marathi + Hinglish) equipment rental marketplace for farmers. A farmer describes a farming job in plain language ("5 acre cotton ploughing"); the system extracts structured meaning, filters technically compatible equipment, ranks the best matches, and lets the farmer book. Any account can be **both** a renter and a lister (a farmer who rents a tractor can also list their own harvester).

**Non-negotiable design principle:** LLM understands language → Rules determine hard compatibility → ML ranks what's left → DB checks availability → Booking connects farmer + owner. Never let the LLM or ML make a hard compatibility decision — rules do that.

---

## 2. TECH STACK (read once, always relevant)

| Layer | Choice |
|---|---|
| Frontend | React + Vite + **plain JS/JSX** (TypeScript intentionally not adopted — see Phase 6 table), Tailwind CSS, i18next *(Phase 6, planned)*, React Context *(Zustand intentionally not adopted)*, vite-plugin-pwa *(Phase 6, planned)* |
| Backend | FastAPI + Pydantic (SQLAlchemy/Alembic not used — Supabase client handles DB access directly) |
| DB / Auth / Storage / Realtime | Supabase (Postgres + PostGIS *(Phase 6, planned — enable extension for geo)*, Auth via email/password — see Phase 1 disclosure, Storage for images *(Phase 6, planned)*, Realtime for booking updates) |
| LLM | Groq API (primary) → Gemini API (fallback) → manual structured form fallback — see Phase 3 disclosure for why the doc's original Gemini→Groq order was flipped |
| ML ranking | LightGBM Ranker (LambdaMART) over rule-filtered candidates |
| Semantic matching | Exact synonym-map lookup → **Cloudflare Workers AI (`@cf/baai/bge-m3`)**, called directly from the Render backend (`backend/app/cloudflare_client.py`, free allowance, no separate service) as an LLM double-check/corrector across English/Hindi/Marathi/Hinglish, not just an outage fallback — see §6.2a → `difflib` lexical similarity as last resort |
| Location | Browser Geolocation API / manual map pin (`react-leaflet` + OpenStreetMap, free, no API key) + Supabase's built-in PostGIS *(Phase 6, planned — Mapbox's paid geocoding dropped in favor of this)* |
| Notifications | Firebase Cloud Messaging |
| Hosting | Frontend → Vercel · Backend → Render (free tier) · Semantic-match model → Cloudflare Workers AI (hosted by Cloudflare, free allowance, no separate deploy — just an account + API token, see `backend/README.md`) · DB/Auth/Storage → Supabase |

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

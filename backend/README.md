# AgriRent AI — Backend (Phase 5)

FastAPI service. First backend in the project (Phase 1–2 were frontend-only,
talking directly to Supabase). See `AGRIRENT_AI_MASTER.md` §0 STATUS for why.

## What's here

**Phase 3:**
- `POST /requirements/parse` — free-text farmer input → structured JSON, using
  the LLM fallback chain (Groq → Gemini → error). See `app/llm_service.py` for
  the full reasoning on provider order and `app/semantic_match.py` for the
  §6.2 vocabulary-correction fallback.

**Phase 4:**
- `POST /equipment/rank` — §6.4/§6.5 LightGBM ranking. Takes a requirement +
  an already rules-filtered candidate list (client-side `rulesFilter.js`,
  unchanged) and returns real ML-ranked scores. See `app/ranking/` — the
  model is trained on clearly-labeled *synthetic* data (no real bookings
  exist yet) and cached to `app/ranking/model.joblib` on first request
  (not committed to git).
- `POST /notifications/booking-webhook` — receiver for a Postgres trigger
  (pg_net) or a dashboard-created Supabase Database Webhook on `bookings`
  INSERT (new request → notifies the owner) and UPDATE (status change →
  notifies both parties), sends an FCM push via `app/notifications.py`.
  Safe to call even before Firebase is configured — it just no-ops (see
  "Setting up push notifications" below).

- `GET /health` — trivial liveness check.

**Phase 5:** no new endpoint — added `app/ranking/retrain_from_bookings.py`,
a manually-run script (not an HTTP route) that retrains the ranker on real
booking outcomes once enough exist. See "Retraining the ranker on real
data" below. The two remaining §4.5 edge cases (stale-request expiry,
double-booking auto-conflict) are handled entirely client-side
(`src/lib/bookingLifecycle.js`) since they're just ordinary `bookings`
UPDATEs — no backend involvement needed.

**Phase 6 item 2:** no new endpoint either — `app/multilingual_client.py`
is a new internal HTTP client, called from `app/semantic_match.py`, that
reaches a separate service (`/hf-space-semantic`, deployed to a free
Hugging Face Space) for §6.2a's multilingual double-check. See
"Multilingual semantic double-check" below.

This backend reads two things (`push_tokens` for notifications,
`bookings`+`requirements` for retraining), both via the Supabase REST API
using the service-role key — still no Postgres driver/ORM, no auth of its
own. Everything else (equipment/booking CRUD, the rules filter, Realtime
subscriptions, the Phase 5 lifecycle updates) is still frontend-to-Supabase
directly.

## Local dev

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then fill in GROQ_API_KEY (and optionally GEMINI_API_KEY)
uvicorn app.main:app --reload --port 8000
```

Test it:
```bash
curl -X POST http://localhost:8000/requirements/parse \
  -H "Content-Type: application/json" \
  -d '{"raw_text": "5 acre kapas ki jotai chahiye agle hafte", "language": "hinglish"}'

curl -X POST http://localhost:8000/equipment/rank \
  -H "Content-Type: application/json" \
  -d '{"requirement": {"crop": "cotton", "area_acres": 5, "operation": "ploughing", "equipment_type": "tractor"}, "candidates": [{"id": 1, "equipment_type": "tractor", "hp": 45, "price": 800}]}'
```

## Getting API keys (both free, no credit card needed for the tiers this project uses)

- **Groq** (primary): https://console.groq.com/keys — free tier, ~30 req/min,
  fast LPU inference, rarely rate-limited for a small JSON-extraction task like this.
  Default model `openai/gpt-oss-20b` (Groq's recommended replacement for the
  now-deprecated `llama-3.1-8b-instant`).
- **Gemini** (fallback): https://aistudio.google.com/apikey — free tier as of
  early 2026 is 5–15 req/min depending on model; used only as the second
  provider in the chain, not primary (see `llm_service.py` docstring for why
  this is flipped from the master doc's original Gemini-first spec). Default
  model `gemini-3.5-flash-lite` (Google retired `gemini-2.5-flash-lite`).

**Model names drift over time** — both providers deprecate models on their
own schedule. If either provider starts returning 404s, check the Render
logs for `ERROR:agrirent.llm_service:[groq|gemini]` — the error body from
the provider names the current replacement model. Update `GROQ_MODEL` /
`GEMINI_MODEL` in Render's env vars (no code change needed).

## Setting up push notifications (Phase 4, optional)

Realtime in-app status updates (Supabase Realtime, `src/lib/realtime.js`)
work with **zero** setup below — they're a separate, already-working
mechanism. This section is only for actual device push notifications.

1. Create a free Firebase project: https://console.firebase.google.com →
   Add project → (Google Analytics optional, skip it).
2. Enable Cloud Messaging: it's on by default for new projects — nothing to
   toggle.
3. Register a web app: Project Settings (gear icon) → General → "Your apps"
   → add a Web app (`</>`) → copy the `firebaseConfig` values into the
   frontend's env vars (`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
   `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`,
   `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`).
4. Generate a Web Push certificate: Project Settings → Cloud Messaging →
   "Web configuration" → "Generate key pair" → copy it into
   `VITE_FIREBASE_VAPID_KEY`.
5. These same values (all public, safe to commit) also need to go into
   `public/firebase-messaging-sw.js`, replacing the `REPLACE_WITH_*` placeholders
   — that file can't read Vite env vars since the browser fetches it as a
   static file, not a bundled module.
6. Generate backend credentials: Project Settings → Service Accounts →
   "Generate new private key" → downloads a JSON file. Open it, copy the
   entire contents as one line, paste into Render's `FIREBASE_SERVICE_ACCOUNT_JSON`
   env var.
7. Pick any random string (e.g. `openssl rand -hex 32`) and set it as
   `WEBHOOK_SECRET` in Render's env vars.
8. Set `SUPABASE_URL` (same as `VITE_SUPABASE_URL`) and
   `SUPABASE_SERVICE_ROLE_KEY` (Supabase Dashboard → Project Settings → API
   → `service_role` **secret** key — never put this in frontend code) in
   Render's env vars.
9. Wire the webhook — the endpoint handles both `INSERT` (new booking
   request → notifies the owner) and `UPDATE` (status change → notifies
   both parties), so fire on both events. Two ways to do this, functionally
   identical (Supabase's dashboard webhook is itself just a UI over
   `pg_net` + a trigger):
   - **Dashboard webhook:** Supabase Dashboard → Database → Webhooks →
     Create a new webhook → table `bookings`, events: `Insert` **and**
     `Update` → URL `https://<your-render-url>/notifications/booking-webhook`
     → HTTP Headers: `X-Webhook-Secret: <same value as WEBHOOK_SECRET>`.
   - **Manual `pg_net` trigger:** a Postgres function + trigger that calls
     `net.http_post()` on `bookings` `INSERT OR UPDATE`, POSTing
     `{type, table, record, old_record}` (an extra `schema` field is fine —
     the backend ignores unknown fields) with the same `X-Webhook-Secret`
     header. Only fire on `UPDATE` when `status` actually changed if you
     want to avoid a wasted (harmless) call on every column touch — the
     backend already no-ops on an unchanged status either way.
10. Confirm Realtime is on for `bookings`: Supabase Dashboard → Database →
    Replication → toggle `bookings` on (the schema.sql migration already
    does this via SQL — either path is fine, running both is harmless).

**Known platform limitation:** iOS Safari does not support the Web Push /
Notification APIs FCM's web SDK relies on (as of the iOS versions in common
use) — a phone on iOS Safari simply won't register a token, and
`push_tokens` will have no row for it. This isn't a bug in this codebase;
Android and desktop browsers work normally. If iOS support becomes a
priority later, the fix is a native/PWA-installed app, not a code change
here.

Until steps 1–9 are done, `Turn on notifications` in Profile > Settings will
say notifications aren't configured yet, and the webhook endpoint silently
returns `{"sent": 0}` — nothing else in the booking flow depends on this.

## Multilingual semantic double-check (Phase 6, optional)

§6.2's vocabulary-mismatch fallback (`app/semantic_match.py`) originally
shipped in Phase 3 with exact taxonomy match → synonym map → `difflib`
lexical similarity only — no real embedding model, since
`sentence-transformers` needs `torch` (~800MB+) and doesn't fit this
service's 512MB Render free tier. Phase 6 closes that gap without changing
that constraint: the real model
(`paraphrase-multilingual-MiniLM-L12-v2`, 50+ languages incl. Hindi/Marathi)
runs in a **separate** service — `/hf-space-semantic` at the repo root,
deployed to a free Hugging Face Space (Docker SDK, 16GB free CPU RAM) — and
this backend calls it over HTTP via `app/multilingual_client.py`.

Per §6.2a, this isn't just an outage fallback for the LLM — it runs as a
double-check/corrector on every `crop`/`operation`/`equipment_type` field
the LLM produces that didn't already resolve via the free exact-match/
synonym-map lookup, catching dialectal Hindi/Marathi/Hinglish terms the LLM
mis-maps. See `app/semantic_match.py`'s docstring for the exact fallback
order and `hf-space-semantic/README.md` for the service's own API and
cold-start behaviour.

**This is entirely optional and degrades gracefully, same as every other
external call in this project:** with `HF_SPACE_URL` unset,
`semantic_match.py` skips straight to its `difflib` last resort — nothing
breaks, vocabulary correction just isn't multilingual-embedding-based that
session (same as the Phase 3 baseline).

**Manual setup required (cannot be done from a repo commit alone):** a
Hugging Face Space has to be created through a Hugging Face account and the
`hf-space-semantic/` folder pushed to *that* Space's own git remote — full
step-by-step instructions are in `hf-space-semantic/README.md` "Deploying
this". Once deployed, set these on this Render service:

- `HF_SPACE_URL` — the Space's URL, e.g.
  `https://<your-username>-agrirent-ai-semantic.hf.space`.
- `HF_SPACE_API_TOKEN` — optional, only needed if you set an `API_TOKEN`
  secret on the Space itself (recommended, since free Spaces are public).
- `HF_SPACE_TIMEOUT_S` — optional, defaults to `45` (seconds). Free Spaces
  sleep after inactivity; this covers the documented 30–60s cold-start
  window before falling back to `difflib`.

Test it once `HF_SPACE_URL` is set (redeploy this backend after adding the
env var):
```bash
curl -X POST http://localhost:8000/requirements/parse \
  -H "Content-Type: application/json" \
  -d '{"raw_text": "5 acre kapas ki nangar chalani hai", "language": "hinglish"}'
```
Check the response's `confidence_notes` — a corrected field will say
`"... matched to '...' (semantic fallback, score 0.XX)"`; a score that
looks like a cosine similarity (typically 0.55–0.95) came from the HF
Space, a score that looks like a difflib ratio came from the local
fallback. Render logs also show which path was taken — search for
`agrirent.multilingual_client` (HF Space attempted) vs. no such line (HF
Space not configured, went straight to difflib).

## Deploying to Render (free tier)

1. Push this repo to GitHub (already done if you're reading this from the repo).
2. In Render: New → Blueprint → point at this repo → it will read `render.yaml`.
3. Fill in `GROQ_API_KEY` / `GEMINI_API_KEY` / `FRONTEND_ORIGIN` (Phase 3) and,
   if setting up push notifications, `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
   / `FIREBASE_SERVICE_ACCOUNT_JSON` / `WEBHOOK_SECRET` (Phase 4) in the Render
   dashboard (all marked `sync: false` in render.yaml so they aren't stored in git).
4. Once deployed, copy the Render URL (e.g. `https://agrirent-ai-backend.onrender.com`)
   into the frontend's `VITE_BACKEND_URL` env var (Vercel project settings + local `.env.local`).

Note: Render's free tier spins down on inactivity and takes ~30-50s to wake up
on the first request after idling. The frontend's free-text input and ranking
call both handle this with a loading state and a generous timeout — see
`llmClient.js` and `rankClient.js`.

## Retraining the ranker on real data (Phase 5)

`app/ranking/train_ranker.py` trains on synthetic, rule-based labels (§6.4
cold-start strategy) — clearly marked as such in its docstring. Once real
bookings accumulate, `app/ranking/retrain_from_bookings.py` retrains on
them instead. Run it manually:

```bash
cd backend
python -m app.ranking.retrain_from_bookings
```

Needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set (same ones used for
push notifications above) so it can pull real bookings via Supabase's REST
API. On Render, run this via the dashboard's Shell tab for the backend
service (or `render exec`, if you're on a paid plan with SSH access) so it
runs with the same env vars already configured there.

**Why it might say "not enough real data yet" and do nothing:** LambdaMART
learns relative preference *within a group of candidates for the same
requirement* — a group only teaches it anything when at least two bookings
tracing back to the same `requirement_id` had *different* outcomes (e.g. one
Completed, one Rejected). The script requires at least 5 such groups and 30
total usable rows before it'll touch the model; below that, it logs exactly
how much data it found and leaves the existing (synthetic or previously
real-trained) model untouched — a handful of test bookings shouldn't be
allowed to quietly overfit the ranker. Note also that `requirement_id` was
NULL on every booking created before this fix (Phase 5) — only bookings made
through the search flow from here on carry it, so usable data accumulates
starting now, not retroactively.

There's no automatic schedule for this yet (Render's free tier has no
built-in cron) — re-run the command above periodically as real usage grows,
or wire it to a scheduled job later (a Render Cron Job on a paid plan, or a
GitHub Actions workflow calling a new admin-only retrain endpoint) once
there's enough real traffic to make scheduling worth it. Each successful
real-data run bumps the model to `phase5-real-v1` (see
`retrain_from_bookings.py`'s `REAL_MODEL_VERSION`) — check
`/equipment/rank` responses' `model_version` field to confirm which one is
currently serving.


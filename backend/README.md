# AgriRent AI — Backend (Phase 3)

FastAPI service. First backend in the project (Phase 1–2 were frontend-only,
talking directly to Supabase). See `AGRIRENT_AI_MASTER.md` §0 STATUS for why.

## What's here (Phase 3 scope only)

- `POST /requirements/parse` — free-text farmer input → structured JSON, using
  the LLM fallback chain (Groq → Gemini → error). See `app/llm_service.py` for
  the full reasoning on provider order and `app/semantic_match.py` for the
  §6.2 vocabulary-correction fallback.
- `GET /health` — trivial liveness check.

Nothing else yet — no DB access, no auth, no ranking. Phase 4 will extend
this same app with the LightGBM ranking endpoint and realtime/notifications
per the master doc build plan.

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
```

## Getting API keys (both free, no credit card needed for the tiers this project uses)

- **Groq** (primary): https://console.groq.com/keys — free tier, ~30 req/min,
  fast LPU inference, rarely rate-limited for a small JSON-extraction task like this.
- **Gemini** (fallback): https://aistudio.google.com/apikey — free tier as of
  early 2026 is 5–15 req/min depending on model; used only as the second
  provider in the chain, not primary (see `llm_service.py` docstring for why
  this is flipped from the master doc's original Gemini-first spec).

## Deploying to Render (free tier)

1. Push this repo to GitHub (already done if you're reading this from the repo).
2. In Render: New → Blueprint → point at this repo → it will read `render.yaml`.
3. Fill in `GROQ_API_KEY` / `GEMINI_API_KEY` / `FRONTEND_ORIGIN` in the Render
   dashboard (marked `sync: false` in render.yaml so they aren't stored in git).
4. Once deployed, copy the Render URL (e.g. `https://agrirent-ai-backend.onrender.com`)
   into the frontend's `VITE_BACKEND_URL` env var (Vercel project settings + local `.env.local`).

Note: Render's free tier spins down on inactivity and takes ~30-50s to wake up
on the first request after idling. The frontend's free-text input handles
this with a loading state and a generous timeout — see `FreeTextJobInput.jsx`.

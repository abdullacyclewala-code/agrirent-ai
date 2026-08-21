---
title: AgriRent AI — Multilingual Semantic Match
emoji: 🌾
colorFrom: green
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
---

# AgriRent AI — multilingual semantic double-check service

Master doc: `AGRIRENT_AI_MASTER.md`, Phase 6 item 2, role defined in §6.2a.

This is a small, stateless FastAPI service that wraps
[`paraphrase-multilingual-MiniLM-L12-v2`](https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2)
(sentence-transformers, free/OSS, 50+ languages including Hindi and Marathi)
behind one HTTP endpoint. It exists because the main backend
(`/backend` on Render, free tier, 512MB RAM) cannot fit `torch` +
`sentence-transformers` — see `backend/app/semantic_match.py`'s docstring
for the full Phase 3 disclosure. Hugging Face Spaces' free CPU tier gives
16GB RAM, which fits this model comfortably, so the model lives here
instead, called over HTTP by the main backend.

**What this is NOT:** it does not replace the LLM (Groq/Gemini) as the
primary extractor, and it is not just an outage fallback. Per §6.2a it runs
as a **double-check/corrector** on LLM output for the fields (`crop`,
`operation`, `equipment_type`) that didn't already resolve via the cheap
exact-match / synonym-map lookup in `semantic_match.py`. See that file and
`backend/app/multilingual_client.py` for exactly how it's called.

## API

### `GET /health`
Liveness check. Returns `{"status": "ok", "model": "<model name>", "model_loaded": true|false}`.
`model_loaded` is `false` on the very first request after a cold start,
while the model is still downloading/loading — see "Cold starts" below.

### `POST /match`
Request body:
```json
{
  "term": "jotai karni hai",
  "candidates": ["ploughing", "tilling", "harrowing", "sowing"],
  "threshold": 0.55
}
```
- `term` — the raw or LLM-produced word/phrase to resolve (any of the 50+
  languages the model supports, in practice English/Hindi/Marathi/Hinglish
  for this project).
- `candidates` — the taxonomy's canonical ids to match against (e.g.
  `vocab['operations']` from `backend/app/taxonomy.py`). 1–200 items.
- `threshold` — optional, defaults to `0.55`. Cosine-similarity cutoff below
  which the match is considered unreliable.

Response:
```json
{
  "best_match": "ploughing",
  "score": 0.81,
  "above_threshold": true
}
```
`best_match` is `null` (and `above_threshold` is `false`) when nothing
clears the threshold — the caller should leave the field for the farmer to
fix in the manual review step, per §6.2a step 5.

An optional shared-secret header, `X-API-Token`, is checked against the
`API_TOKEN` env var if that env var is set (mirrors the main backend's
`WEBHOOK_SECRET` pattern) — this is a free public Space, so this is a cheap
way to stop random internet traffic from burning the CPU quota. Leave
`API_TOKEN` unset to run without auth (fine for a low-traffic MVP).

## Cold starts

Free Hugging Face Spaces sleep after a period of inactivity. The first
request after sleeping pays for both the Space waking up AND (only on the
container's very first boot ever, before the image layer is cached) the
~470MB model download — subsequent wakes reuse the already-downloaded model
under `/data` inside the container, so only the Space wake-up latency
applies after that. Budget 30–60s for a cold call; the main backend's
`multilingual_client.py` uses a 45s timeout and treats a timeout as "this
term needs the difflib fallback instead," never as a hard failure — this is
the same "always degrade gracefully" pattern used everywhere else in this
project (LLM fallback chain, ranking endpoint, push notifications).

## Deploying this (manual step — cannot be done from a repo commit alone)

Hugging Face Spaces are created through a Hugging Face account; there's no
way to stand one up purely by pushing code to GitHub. To deploy:

1. Create a free account at https://huggingface.co if you don't have one.
2. Go to https://huggingface.co/new-space → pick a name (e.g.
   `agrirent-ai-semantic`) → **SDK: Docker** → **visibility: Public** (free
   tier requires public) → Create Space.
3. Push this folder's contents (`hf-space-semantic/`) as the *root* of that
   Space's git repo — the Space's own git remote, not this GitHub repo:
   ```bash
   cd hf-space-semantic
   git init
   git remote add space https://huggingface.co/spaces/<your-username>/agrirent-ai-semantic
   git add .
   git commit -m "Initial deploy"
   git push --force space main
   ```
   (Hugging Face will prompt for a username + an access token in place of a
   password the first time — create one at
   https://huggingface.co/settings/tokens with "Write" scope.)
4. The Space will build the Dockerfile automatically (first build takes a
   few minutes — downloading the base image + model). Watch progress on the
   Space's "Logs" tab.
5. Once it shows "Running", the service is live at
   `https://<your-username>-agrirent-ai-semantic.hf.space`.
6. (Optional but recommended) Settings → Variables and secrets → add a
   secret `API_TOKEN` with any random value (e.g. `openssl rand -hex 24`).
7. Back in the main repo: set `HF_SPACE_URL` (the URL from step 5) and, if
   you set one, `HF_SPACE_API_TOKEN` (same value as step 6's `API_TOKEN`)
   as env vars on the `/backend` Render service. No redeploy of the Space
   itself is needed when these change — only the Render backend needs the
   new env vars (Render → Environment → add the vars → the service restarts
   automatically). Until `HF_SPACE_URL` is set, the backend safely skips
   this step and falls straight to the `difflib` fallback — nothing breaks.

## Local dev

```bash
cd hf-space-semantic
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 7860
```

```bash
curl -X POST http://localhost:7860/match \
  -H "Content-Type: application/json" \
  -d '{"term": "jotai", "candidates": ["ploughing", "tilling", "sowing"]}'
```

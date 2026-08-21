"""
AgriRent AI — Phase 4 backend (FastAPI)

Master doc §5.3 + §6.1 + §6.2 + §6.4 + §6.5. Phase 3 scoped this app to one
endpoint (`/requirements/parse`, LLM free-text parsing). Phase 4 grows it
with the two things §0 STATUS said would need the backend next:

- `POST /equipment/rank` — §6.4/§6.5 LightGBM ranking. Takes a requirement +
  an ALREADY hard-filtered candidate list (rulesFilter.js, §6.3, still runs
  client-side against Supabase — unchanged) and returns real ML-ranked
  scores. See `app/ranking/` for the model itself.
- `POST /notifications/booking-webhook` — receiver for a Supabase Database
  Webhook on `bookings` UPDATE, sends FCM push via `app/notifications.py`.
  This is the first place this backend reads anything (via the Supabase
  REST API with a service-role key, never exposed to the frontend) — still
  no direct Postgres connection/ORM, consistent with keeping this service
  thin per the Phase 3 architecture note below.

Why a backend exists at all (per master doc §0 STATUS note): secrets (LLM
keys, then Firebase service-account credentials) can't safely live in
frontend code. Equipment/booking CRUD and the rules-engine filter are still
entirely frontend-to-Supabase (Phase 1/2, unchanged) — this service only
does the things that genuinely need a server.
"""

from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional
import logging
import os

logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")

from .llm_service import parse_requirement_via_llm, LLMAllProvidersFailed
from .taxonomy import load_taxonomy
from .ranking.ranker_service import rank_candidates as _rank_candidates
from .notifications import send_push_to_tokens, message_for_status, tokens_for_users

app = FastAPI(title="AgriRent AI Backend", version="0.4.0")

# CORS: allow the Vite dev server + the deployed Vercel frontend.
# Set FRONTEND_ORIGIN in Render env vars to the real deployed URL.
_frontend_origin = os.getenv("FRONTEND_ORIGIN", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[_frontend_origin] if _frontend_origin != "*" else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok", "phase": 4}


class ParseRequirementIn(BaseModel):
    raw_text: str = Field(..., min_length=2, max_length=1000)
    language: Optional[str] = "auto"  # "en" | "hi" | "mr" | "hinglish" | "auto"


class ParseRequirementOut(BaseModel):
    crop: Optional[str] = None
    area_acres: Optional[float] = None
    operation: Optional[str] = None
    equipment_type: Optional[str] = None
    provider_used: str  # "groq" | "gemini" | "semantic_fallback"
    confidence_notes: list[str] = []


@app.post("/requirements/parse", response_model=ParseRequirementOut)
def parse_requirement(payload: ParseRequirementIn):
    """
    §6.1 LLM layer entrypoint. Tries Groq → Gemini in order (see llm_service.py
    for why that order, a documented deviation from the master doc's
    Gemini→Groq default). If both providers fail or produce nothing usable,
    returns 422 — the frontend's existing manual-form path (Phase 2,
    DescribeJob.jsx) is the always-available fallback per §4.5, so we do not
    invent a fake result here.
    """
    taxonomy = load_taxonomy()
    try:
        result = parse_requirement_via_llm(payload.raw_text, payload.language, taxonomy)
    except LLMAllProvidersFailed as e:
        raise HTTPException(
            status_code=422,
            detail={
                "error": "llm_unavailable",
                "message": str(e),
                "fallback": "Use the manual structured form — this always works.",
            },
        )
    return result


# --------------------------------------------------------------------------
# §6.4 / §6.5 — LightGBM ranking
# --------------------------------------------------------------------------

class RankRequirementIn(BaseModel):
    crop: Optional[str] = None
    area_acres: Optional[float] = None
    operation: Optional[str] = None
    equipment_type: Optional[str] = None


class RankCandidateIn(BaseModel):
    id: int
    equipment_type: str
    hp: Optional[float] = None
    price: Optional[float] = None
    is_available: Optional[bool] = True
    # Optional richer signals a caller can supply if it already knows them;
    # both default sensibly (see app/ranking/features.py) if omitted.
    availability_quality: Optional[float] = None
    semantic_confidence: Optional[float] = None


class RankRequestIn(BaseModel):
    requirement: RankRequirementIn
    candidates: List[RankCandidateIn] = Field(default_factory=list, max_length=200)


class RankedCandidateOut(BaseModel):
    id: int
    rank_score: int
    features: dict


class RankResponseOut(BaseModel):
    model_config = {"protected_namespaces": ()}  # "model_version" isn't the reserved pydantic sense here

    ranked: List[RankedCandidateOut]
    model_version: str


@app.post("/equipment/rank", response_model=RankResponseOut)
def rank_equipment(payload: RankRequestIn):
    """
    §6.4 LightGBM ranking. Input `candidates` must already be hard-filtered
    (§6.3 — rulesFilter.js does this client-side against Supabase; nothing
    here re-checks compatibility, availability, or ownership). This endpoint
    only re-scores and re-orders what it's given.

    Per §4.5 "must always work" pattern used everywhere else in this
    project: if this endpoint is unreachable, the frontend's `rankClient.js`
    silently keeps the existing Phase 2 heuristic score from
    `rulesFilter.js` — nothing breaks, ranking just isn't ML-based that
    session.
    """
    taxonomy = load_taxonomy()
    requirement = payload.requirement.model_dump()
    candidates = [c.model_dump() for c in payload.candidates]
    return _rank_candidates(requirement, candidates, taxonomy)


# --------------------------------------------------------------------------
# Phase 4 — FCM push notifications (booking status changes)
# --------------------------------------------------------------------------

class BookingWebhookIn(BaseModel):
    type: str  # "INSERT" | "UPDATE" | "DELETE" (Supabase Database Webhook payload shape)
    table: str
    record: dict
    old_record: Optional[dict] = None


@app.post("/notifications/booking-webhook")
def booking_webhook(payload: BookingWebhookIn, x_webhook_secret: str = Header(default="")):
    """
    Receiver for a Supabase Database Webhook on the `bookings` table (UPDATE
    event) — this is a human dashboard-configuration step, not code; see
    backend/README.md "Setting up push notifications". Verifies a shared
    secret (`WEBHOOK_SECRET`) so this endpoint can't be spammed by anyone who
    finds the URL.

    Safe to call before that setup exists: with no `FIREBASE_SERVICE_ACCOUNT_JSON`
    configured, `send_push_to_tokens()` no-ops and this just returns
    `sent: 0` — same "degrade gracefully, never block the core flow" pattern
    as the LLM parse endpoint.
    """
    expected_secret = os.getenv("WEBHOOK_SECRET")
    if expected_secret and x_webhook_secret != expected_secret:
        raise HTTPException(status_code=401, detail="invalid webhook secret")

    if payload.table != "bookings" or payload.type != "UPDATE":
        return {"skipped": "not a bookings UPDATE event"}

    record = payload.record
    old_record = payload.old_record or {}
    new_status = record.get("status")
    if not new_status or new_status == old_record.get("status"):
        return {"skipped": "status unchanged"}

    message = message_for_status(new_status)
    if not message:
        return {"skipped": f"no notification copy for status '{new_status}'"}

    # We don't know from the webhook payload which party (farmer or owner)
    # triggered the change, so — for this MVP — notify both. A farmer
    # accepting their own cancel, or an owner seeing their own accept, gets
    # a harmless redundant notification; that's a reasonable trade-off
    # against the complexity of tracking "who changed it" separately.
    user_ids = [uid for uid in (record.get("farmer_id"), record.get("owner_id")) if uid]
    tokens = tokens_for_users(user_ids)
    sent = send_push_to_tokens(tokens, "AgriRent AI", message)
    return {"sent": sent, "status": new_status}

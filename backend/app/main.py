"""
AgriRent AI — Phase 3 backend (FastAPI)

Master doc §5.3 + §6.1 + §6.2. Scope for this phase is deliberately narrow:
one real endpoint (`/requirements/parse`) that does LLM free-text parsing with
the fallback chain, plus a health check. Phase 4 (LightGBM ranking, model
serving) will extend this same app — see AGRIRENT_AI_MASTER.md §5.3 for the
full endpoint table this will grow into.

Why a backend exists at all (per master doc §0 STATUS note): LLM provider API
keys can't safely live in frontend code, so this is the first backend service
in the project. It's a thin, stateless service — no DB writes happen here
(the frontend still writes to Supabase directly, same as Phase 1/2) — this
just takes raw text in and returns parsed structured JSON (or an error the
frontend already knows how to handle: fall back to the manual form).
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional
import os

from .llm_service import parse_requirement_via_llm, LLMAllProvidersFailed
from .taxonomy import load_taxonomy

app = FastAPI(title="AgriRent AI Backend", version="0.3.0")

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
    return {"status": "ok", "phase": 3}


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

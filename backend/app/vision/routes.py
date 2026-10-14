"""
Phase 7 — /verification/* endpoints.

Auth model (disclosed, matching the project's existing "thin backend" stance in
backend/README.md): the backend still has no session of its own. When a Supabase
service key is configured it validates the caller's user JWT and confirms they
are a party on the booking; when it is not, endpoints still work from the
client-supplied payload and report `auth_checked: false`, and the frontend's own
RLS-guarded writes remain the real enforcement point. Nothing here can move
money either way (see depositPolicy.js's `aiCanMoveMoney`).
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from . import analyze as analyze_mod
from . import providers, signals
from .supabase_rest import supabase

logger = logging.getLogger("agrirent.vision.routes")

router = APIRouter(prefix="/verification", tags=["verification"])

POLICY_VERSION = os.getenv("TRUST_POLICY_VERSION", "2026-10-1")


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class PhotoIn(BaseModel):
    slot: str
    storage_path: Optional[str] = None
    inline_b64: Optional[str] = Field(default=None, description="data URL or base64 JPEG, used when no service key is configured")
    sha256: Optional[str] = None
    dhash: Optional[str] = None
    exif: Optional[dict[str, Any]] = None
    gps: Optional[dict[str, Any]] = None
    captured_at_device: Optional[str] = None
    tz_offset_minutes: Optional[int] = None
    watermark_text: Optional[str] = None
    quality: Optional[dict[str, Any]] = None
    damage_labels: Optional[list[str]] = None
    ai: Optional[dict[str, Any]] = None
    dhash_client: Optional[str] = None


class EquipmentIn(BaseModel):
    id: Optional[int] = None
    name: Optional[str] = None
    type: Optional[str] = None
    lat: Optional[float] = None
    lng: Optional[float] = None


class AnalyzeIn(BaseModel):
    booking_id: int
    report_id: Optional[str] = None
    kind: str = Field(..., pattern="^(handover|return)$")
    report_code: Optional[str] = None
    equipment: EquipmentIn = EquipmentIn()
    policy: Optional[dict[str, Any]] = None
    policy_version: Optional[str] = None
    photos: list[PhotoIn] = Field(default_factory=list, max_length=12)
    history: Optional[list[dict[str, Any]]] = None
    known_damage: Optional[list[dict[str, Any]]] = None
    signed_by: int = 0
    chain_intact: Optional[bool] = None
    required_slots: Optional[list[str]] = None
    compare: Optional[dict[str, Any]] = None
    # UI language, so the AI's human-readable findings come back in the same
    # language the rest of the screen is in. Codes/enums stay English.
    lang: Optional[str] = Field(default=None, pattern="^(en|hi|mr)$")


class FinalizeIn(BaseModel):
    report_id: str


# ---------------------------------------------------------------------------
# Auth helper
# ---------------------------------------------------------------------------

def _authorise(authorization: Optional[str], booking_id: Optional[int]) -> bool:
    """
    Returns True when we positively confirmed the caller is a party on the
    booking. Anything else (no token, no service key, non-participant with a
    valid token) is a False, and the caller decides what to do about it.
    """
    if not authorization or not authorization.lower().startswith("bearer "):
        return False
    token = authorization.split(" ", 1)[1].strip()
    user = supabase.user_from_jwt(token)
    if not user:
        return False
    if not booking_id:
        return True
    rows = supabase.select("bookings", select="id,farmer_id,owner_id",
                           filters={"id": f"eq.{booking_id}"}, limit=1)
    if not rows:
        return False
    booking = rows[0]
    return user.get("id") in (booking.get("farmer_id"), booking.get("owner_id"))


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/config")
def verification_config():
    """What this deployment can actually do — the frontend reads this first so
    it can pick a transport (bucket vs inline) and tell the user the truth about
    whether AI reading is on."""
    return {
        "policy_version": POLICY_VERSION,
        "vision": {
            "providers_configured": providers.configured_providers(),
            "order": providers.DEFAULT_ORDER,
            "models": {
                "gemini": providers.GEMINI_VISION_MODEL,
                "groq": providers.GROQ_VISION_MODEL,
                "cloudflare": providers.CF_VISION_MODEL,
            },
            "enabled": bool(providers.configured_providers()),
        },
        "storage_access": supabase.configured,
        "auth_validation": bool(supabase.url and (supabase.key or supabase.anon_key)),
        "limits": {
            "max_photos_per_report": 12,
            "analysis_max_edge": signals.ANALYSIS_MAX_EDGE,
        },
    }


@router.post("/analyze")
def analyze_report(payload: AnalyzeIn, authorization: Optional[str] = Header(default=None)):
    """
    Analyze one handover/return report: server-side evidence verification, the
    AI reading, and (when `compare` is present) the before/after diff.
    """
    auth_checked = _authorise(authorization, payload.booking_id)
    if supabase.configured and authorization and not auth_checked:
        raise HTTPException(status_code=403, detail="not a party on this booking")

    data = payload.model_dump()
    data["_auth_checked"] = auth_checked
    try:
        result = analyze_mod.run_analysis(data, supabase)
    except Exception as exc:  # never let an analysis bug block a rental
        logger.exception("[verification] analyze failed")
        raise HTTPException(status_code=500, detail=f"analysis failed: {exc}") from exc

    result["auth_checked"] = auth_checked
    return result


@router.post("/compare")
def compare_reports(payload: AnalyzeIn, authorization: Optional[str] = Header(default=None)):
    """Standalone before/after comparison — same engine as the `compare` block
    inside /analyze, for when the return report was already analyzed."""
    if not payload.compare:
        raise HTTPException(status_code=422, detail="compare block is required")
    auth_checked = _authorise(authorization, payload.booking_id)
    if supabase.configured and authorization and not auth_checked:
        raise HTTPException(status_code=403, detail="not a party on this booking")

    data = payload.model_dump()
    data["_auth_checked"] = auth_checked
    result = analyze_mod.run_analysis(data, supabase)
    return {"compare": result.get("compare"), "auth_checked": auth_checked}


@router.post("/finalize")
def finalize(report_id: FinalizeIn, authorization: Optional[str] = Header(default=None)):
    """
    Freeze a report's hash (the DB function is the authority; this route just
    gives the frontend one place to call when it has a session). Without a
    service key the frontend calls the same RPC directly — see src/lib/reportDb.js.
    """
    if not supabase.url:
        raise HTTPException(status_code=503, detail="Supabase is not configured on this deployment")
    result = supabase.rpc("finalize_report", {"p_report_id": report_id.report_id})
    if result is None:
        raise HTTPException(status_code=502, detail="could not finalize the report")
    return {"report_hash": result if isinstance(result, str) else str(result)}


@router.get("/verify/{code}")
def verify(code: str):
    """
    Public integrity check: recomputes the report's hash chain and returns the
    verdict. No auth, no photos, no personal data — the thing behind the QR code
    on a printed report.
    """
    if not supabase.url:
        raise HTTPException(status_code=503, detail="Supabase is not configured on this deployment")
    result = supabase.rpc("verify_report", {"p_code": code})
    if result is None:
        raise HTTPException(status_code=502, detail="verification service unavailable")
    return result


@router.get("/history/{equipment_id}")
def equipment_history(equipment_id: int):
    """The machine's own condition file: known damage carried forward, plus how
    many verified reports exist. Public-by-design intent (a renter should know
    what they are getting), so it exposes no photos and no personal data."""
    known = supabase.select(
        "equipment_damage_log",
        select="id,part,kind,severity,status,notes,created_at",
        filters={"equipment_id": f"eq.{equipment_id}"},
        order="created_at.desc",
        limit=100,
    )
    photos = supabase.select(
        "report_photos", select="id,booking_id,slot,created_at",
        filters={"equipment_id": f"eq.{equipment_id}"}, order="created_at.desc", limit=1,
    )
    reports = supabase.select(
        "condition_reports", select="id,kind,verdict,ai_status,finalized_at,created_at",
        filters={"equipment_id": f"eq.{equipment_id}"}, order="created_at.desc", limit=50,
    )
    return {
        "equipment_id": equipment_id,
        "known_damage": known,
        "report_count": len(reports),
        "reports": reports,
        "source": "service" if supabase.configured else "unavailable",
    }

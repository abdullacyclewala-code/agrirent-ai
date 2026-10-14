"""
Phase 7 — report analysis orchestration.

Ties the three layers together for one condition report:

    deterministic signals  (signals.py — always runs)
        + AI reading       (providers.py — when configured)
            + cross-checks against history, the other party's photos and the
              machine's own damage log
                -> per-photo findings, a report-level signal pack, a verdict,
                   and (for return reports) a before/after comparison

Cost control, on purpose (§9.5 of the phase doc):
  * images are downscaled to 768px before they reach a model,
  * analyses are cached by image hash, so reopening a report never re-bills,
  * a re-usable analysis of the SAME slot in the same booking is reused when
    computing the deterministic duplicate check.
"""

from __future__ import annotations

import base64
import logging
import time
from typing import Any, Optional

from . import providers, signals
from .supabase_rest import SupabaseREST

logger = logging.getLogger("agrirent.vision.analyze")

# image-hash -> analysis dict. Bounded so a long-lived free-tier instance can't
# grow without limit.
_CACHE: dict[str, dict[str, Any]] = {}
_CACHE_MAX = 256

DEFAULT_POLICY = {
    "duplicate_hamming_threshold": 6,
    "gps_flag_distance_km": 25,
    "time_drift_flag_minutes": 120,
    "meter_delta_flag_hours": 2,
}


def _cache_put(key: str, value: dict[str, Any]) -> None:
    if len(_CACHE) >= _CACHE_MAX:
        for stale in list(_CACHE)[: _CACHE_MAX // 4]:
            _CACHE.pop(stale, None)
    _CACHE[key] = value


def _bytes_for(photo: dict[str, Any], supabase: SupabaseREST) -> Optional[bytes]:
    """Prefer the private bucket (server-authoritative); fall back to the
    inline copy the browser sends when the deployment has no service key."""
    path = photo.get("storage_path")
    if path and supabase.configured:
        data = supabase.download("inspection-photos", path)
        if data:
            return data
    inline = photo.get("inline_b64")
    if inline:
        try:
            if "," in inline:  # data URL
                inline = inline.split(",", 1)[1]
            return base64.b64decode(inline)
        except (ValueError, TypeError) as exc:
            logger.warning("[analyze] bad inline image for %s: %s", photo.get("slot"), exc)
    return None


def measure_photo(data: bytes, photo: dict[str, Any]) -> dict[str, Any]:
    """Everything the server can prove about the bytes it actually received."""
    img = signals.open_image(data)
    quality = signals.measure_quality(img)
    return {
        "server_sha256": signals.sha256_hex(data),
        "server_dhash": signals.dhash_from_image(img),
        "server_quality": quality,
        "server_exif": signals.read_exif(img),
        "analysis_jpeg": signals.analysis_jpeg(img),
    }


def _slot_hint(slot: str) -> str:
    return {
        "full_left": "the whole machine from the front-left",
        "full_right": "the whole machine from the rear-right",
        "meter": "the hour meter or odometer, close up",
        "work_area": "tyres, implement and usual wear points",
        "extra": "an extra view chosen by the user",
    }.get(slot, slot)


def _ai_photo(photo: dict[str, Any], measured: dict[str, Any], equipment: dict[str, Any]) -> Optional[dict]:
    """One AI reading per photo, cached by the image's own hash."""
    cache_key = f"photo:{measured['server_sha256']}"
    if cache_key in _CACHE:
        return _CACHE[cache_key]

    prompt = providers.PHOTO_PROMPT.format(
        equipment=f"{equipment.get('name') or 'equipment'} ({equipment.get('type') or 'unknown type'})",
        slot_hint=_slot_hint(photo.get("slot", "")),
        watermark=photo.get("watermark_text") or "(none recorded)",
    )
    try:
        result = providers.vision_json([measured["analysis_jpeg"]], prompt)
    except providers.VisionUnavailable as exc:
        logger.info("[analyze] AI unavailable: %s", exc)
        return None

    analysis = {"provider": result["provider"], "data": result["data"]}
    _cache_put(cache_key, analysis)
    return analysis


def _deterministic_diff(before_analysis: Optional[dict], after_analysis: Optional[dict]) -> dict[str, Any]:
    """
    The no-AI comparison. Matches damage items between the two readings on
    (part, kind) and reports what appeared, what repeats and what vanished.
    Weaker than a vision model looking at both images, and labelled as such —
    but it is honest, instant, free, and never hallucinates.
    """
    def items(analysis: Optional[dict]) -> list[dict]:
        if not analysis:
            return []
        data = analysis.get("data") if "data" in analysis else analysis
        damage = (data or {}).get("damage") or []
        return [d for d in damage if isinstance(d, dict)]

    before_keys = {(str(d.get("part", "")).lower(), str(d.get("kind", "")).lower()) for d in items(before_analysis)}
    new_damage = []
    unchanged = []
    for item in items(after_analysis):
        key = (str(item.get("part", "")).lower(), str(item.get("kind", "")).lower())
        (unchanged if key in before_keys else new_damage).append(item)

    return {
        "method": "deterministic",
        "new_damage": new_damage,
        "unchanged": unchanged,
        "worsened": [],
        "wear_and_tear": [],
        "confidence": 0.4 if (before_analysis and after_analysis) else 0.2,
        "recommended_action": "review" if new_damage else "no_claim",
        "narrative": (
            f"Compared from the app's own photo readings: {len(new_damage)} item(s) appear only in the "
            f"return photos and {len(unchanged)} appear in both. A person should confirm any difference."
            if (before_analysis and after_analysis)
            else "Not enough AI readings on both reports to compare automatically — please review the photos side by side."
        ),
    }


def _ai_compare(before_jpeg: bytes, after_jpeg: bytes, before_analysis: Optional[dict],
                after_analysis: Optional[dict], slot: str, equipment: dict[str, Any],
                known_damage: list[dict], watermark: str) -> Optional[dict]:
    cache_key = f"compare:{signals.sha256_hex(before_jpeg)}:{signals.sha256_hex(after_jpeg)}"
    if cache_key in _CACHE:
        return _CACHE[cache_key]

    known = "\n".join(
        f"- {d.get('part', '?')}: {d.get('kind', '?')} ({d.get('severity', '?')})"
        for d in (known_damage or [])
    ) or "- none recorded"
    prompt = providers.COMPARE_PROMPT.format(
        slot_hint=_slot_hint(slot),
        equipment=f"{equipment.get('name') or 'equipment'} ({equipment.get('type') or 'unknown type'})",
        known_damage=known,
        watermark=watermark or "(none recorded)",
    )
    try:
        result = providers.vision_json([before_jpeg, after_jpeg], prompt)
    except providers.VisionUnavailable:
        return None
    out = {"provider": result["provider"], "data": result["data"]}
    _cache_put(cache_key, out)
    return out


def _summarise(photo_results: list[dict[str, Any]], compare: Optional[dict[str, Any]],
               hour_meter: Optional[float]) -> dict[str, Any]:
    """A plain-language summary assembled from what was actually found — built
    from the findings rather than asked of a model, so it can never invent a
    condition that isn't in the record."""
    damage = []
    wear = []
    for r in photo_results:
        ai = (r.get("ai") or {}).get("data") or {}
        damage.extend(ai.get("damage") or [])
        wear.extend(ai.get("wear_and_tear") or [])

    parts = [f"{len(photo_results)} photo(s) recorded"]
    if hour_meter is not None:
        parts.append(f"hour meter read {hour_meter}")
    if damage:
        parts.append(f"{len(damage)} pre-existing damage item(s) noted")
    if compare:
        new_count = len(compare.get("new_damage") or [])
        parts.append(f"{new_count} item(s) differ from the handover photos" if new_count
                     else "no new damage found against the handover photos")
    return {
        "text": "; ".join(parts) + ".",
        "damage_found": damage,
        "wear_and_tear": sorted(set(wear)),
        "hour_meter": hour_meter,
    }


def run_analysis(payload: dict[str, Any], supabase: SupabaseREST) -> dict[str, Any]:
    """Analyze one condition report (handover or return), optionally comparing
    it against the handover report of the same booking."""
    policy = {**DEFAULT_POLICY, **(payload.get("policy") or {})}
    equipment = payload.get("equipment") or {}
    photos = payload.get("photos") or []
    compare_ctx = payload.get("compare") or None
    received_at = time.time()

    history = payload.get("history") or []
    history_source = "client" if history else "none"
    if supabase.configured and equipment.get("id"):
        # Authoritative history: every other photo ever filed for this machine.
        rows = supabase.select(
            "report_photos",
            select="id,booking_id,slot,dhash,sha256",
            filters={"equipment_id": f"eq.{equipment['id']}"},
            order="created_at.desc",
            limit=400,
        )
        if rows:
            history = rows
            history_source = "service"

    photo_results: list[dict[str, Any]] = []
    ai_status = "disabled"
    ai_provider: Optional[str] = None
    hour_meter: Optional[float] = None
    meter_confidence = 0.0

    for photo in photos:
        data = _bytes_for(photo, supabase)
        if not data:
            photo_results.append({
                "slot": photo.get("slot"),
                "flags": ["low_photo_quality"],
                "checks": [{"code": "photo_received", "pass": False,
                            "detail": "the server could not read this photo — it was not analysed"}],
                "ai": None,
                "unreadable": True,
            })
            continue

        try:
            measured = measure_photo(data, photo)
        except Exception as exc:  # a corrupt upload must not sink the report
            logger.warning("[analyze] could not decode %s: %s", photo.get("slot"), exc)
            photo_results.append({
                "slot": photo.get("slot"),
                "flags": ["low_photo_quality"],
                "checks": [{"code": "photo_decodable", "pass": False, "detail": str(exc)[:120]}],
                "ai": None,
                "unreadable": True,
            })
            continue

        enriched = {**photo, **measured, "captured_at_epoch": _epoch_from(photo)}

        ai = _ai_photo(enriched, measured, equipment)
        if ai:
            ai_status = "ok" if ai_status in ("ok", "disabled") else ai_status
            ai_provider = ai_provider or ai["provider"]
        elif providers.configured_providers():
            ai_status = "partial" if ai_status == "ok" else ("unavailable" if ai_status == "disabled" else ai_status)

        if ai:
            meter = (ai.get("data") or {}).get("meter") or {}
            value = meter.get("value")
            if meter.get("visible") and isinstance(value, (int, float)):
                conf = 0.9 if photo.get("slot") == "meter" else 0.6
                if conf > meter_confidence:
                    hour_meter, meter_confidence = float(value), conf

            # Watermark read-back: the stamp in the pixels vs. what we recorded.
            wm = (ai.get("data") or {}).get("watermark") or {}
            expected_code = (payload.get("report_code") or "").upper()
            read_code = (wm.get("code") or "").upper()
            enriched["watermark_ai"] = {
                "readable": bool(wm.get("readable")),
                "text": wm.get("text"),
                "expected": expected_code,
                "code_matches": (not read_code and not expected_code) or (read_code == expected_code) if wm.get("readable") else None,
            }

        result = signals.evaluate_photo(enriched, equipment=equipment, history=history,
                                        received_at=received_at, policy=policy)
        photo_results.append({
            "slot": photo.get("slot"),
            "flags": result["flags"],
            "checks": result["checks"],
            "ai": ai,
            "server_quality": measured["server_quality"],
            "server_dhash": measured["server_dhash"],
            "sha256_match": bool(photo.get("sha256")) and photo.get("sha256") == measured["server_sha256"],
            "dhash_distance": signals.hamming_hex(photo.get("dhash"), measured["server_dhash"]),
        })

    # ---- optional before/after comparison (return reports) -----------------
    compare_result = None
    if compare_ctx:
        compare_result = run_compare(
            after_photos=photos,
            after_results=photo_results,
            compare_ctx=compare_ctx,
            equipment=equipment,
            supabase=supabase,
            policy=policy,
        )

    # ---- report-level roll-up ---------------------------------------------
    signed_by = int(payload.get("signed_by") or 0)
    signals_pack = signals.build_report_signals(
        photo_results,
        required_slots=payload.get("required_slots") or ["full_left", "full_right", "meter", "work_area"],
        signed_by=signed_by,
        chain_intact=payload.get("chain_intact"),
        ai_status=ai_status,
    )
    signals_pack["history_source"] = history_source
    signals_pack["auth_checked"] = bool(payload.get("_auth_checked"))
    signals_pack["storage"] = "service" if supabase.configured else "client"

    if compare_result:
        signals_pack["checks"].extend(compare_result.get("checks", []))

    return {
        "ai_status": ai_status,
        "ai_provider": ai_provider,
        "policy_version": payload.get("policy_version") or "2026-10-1",
        "storage": "service" if supabase.configured else "client",
        "photos": photo_results,
        "signals": signals_pack,
        "verdict": signals_pack["verdict"],
        "flagged": signals_pack["flagged"],
        "hour_meter": hour_meter,
        "summary": _summarise(photo_results, compare_result, hour_meter),
        "compare": compare_result,
        "known_damage": payload.get("known_damage") or [],
    }


def _epoch_from(photo: dict[str, Any]) -> Optional[float]:
    captured = photo.get("captured_at_device")
    if not captured:
        return None
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(captured).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def run_compare(*, after_photos: list[dict[str, Any]], after_results: list[dict[str, Any]],
                compare_ctx: dict[str, Any], equipment: dict[str, Any],
                supabase: SupabaseREST, policy: dict[str, Any]) -> dict[str, Any]:
    """Compare a return report against the booking's handover report, slot by
    slot: the single most decisive artefact in a damage dispute."""
    before_by_slot = {p.get("slot"): p for p in (compare_ctx.get("before_photos") or [])}
    known_damage = compare_ctx.get("known_damage") or []
    slots: list[dict[str, Any]] = []
    checks: list[dict[str, Any]] = []

    for after in after_photos:
        slot = after.get("slot")
        before = before_by_slot.get(slot)
        after_result = next((r for r in after_results if r.get("slot") == slot), None)
        after_ai = (after_result or {}).get("ai")
        if not before:
            continue

        before_ai = before.get("ai")
        before_data = _bytes_for(before, supabase)
        after_data = _bytes_for(after, supabase)

        comparison = None
        if before_data and after_data:
            try:
                before_jpeg = signals.analysis_jpeg(signals.open_image(before_data))
                after_jpeg = signals.analysis_jpeg(signals.open_image(after_data))
                watermark = after.get("watermark_text") or before.get("watermark_text") or ""
                ai_result = _ai_compare(before_jpeg, after_jpeg, before_ai, after_ai, slot, equipment,
                                        known_damage, watermark)
                if ai_result:
                    comparison = {"method": "ai", **ai_result["data"], "provider": ai_result["provider"]}
            except Exception as exc:
                logger.warning("[compare] slot %s failed: %s", slot, exc)

        if comparison is None:
            comparison = _deterministic_diff(before_ai, after_ai)

        # A perceptual near-match between "before" and "after" of the same slot
        # is exactly what reusing the handover photo as return evidence looks
        # like — the sharpest anti-lying check in the compare path.
        before_dhash = before.get("dhash")
        after_dhash = (after_result or {}).get("server_dhash") or after.get("dhash")
        distance = signals.hamming_hex(before_dhash, after_dhash)
        reused = distance <= policy.get("duplicate_hamming_threshold", 6)
        if reused:
            checks.append({
                "code": "return_photo_is_not_a_reused_handover_photo",
                "pass": False,
                "detail": f"slot '{slot}': the return photo is visually identical to the handover photo "
                          f"(distance {distance}) — it cannot show what happened during the rental",
            })

        slots.append({
            "slot": slot,
            "reused_handover_photo": reused,
            "hash_distance": distance,
            "method": comparison.get("method"),
            "new_damage": comparison.get("new_damage") or [],
            "worsened": comparison.get("worsened") or [],
            "unchanged": comparison.get("unchanged") or [],
            "wear_and_tear": comparison.get("wear_and_tear") or [],
            "confidence": comparison.get("confidence"),
            "recommended_action": comparison.get("recommended_action"),
            "narrative": comparison.get("narrative"),
        })

    open_before = None
    close_after = None
    for slot in slots:
        if slot["slot"] == "meter":
            open_before = (before_by_slot.get("meter") or {}).get("ai_meter")
            close_after = None
    meter_check = signals.meter_delta_check(
        compare_ctx.get("opening_meter"), compare_ctx.get("closing_meter"),
        compare_ctx.get("start_date"), compare_ctx.get("end_date"), policy,
    )
    if meter_check.get("flag"):
        checks.append({"code": "meter_delta_plausible", "pass": False, "detail": meter_check["detail"]})
    elif meter_check.get("delta") is not None:
        checks.append({"code": "meter_delta_plausible", "pass": True, "detail": meter_check["detail"]})

    new_total = sum(len(s["new_damage"]) for s in slots)
    reused_any = any(s["reused_handover_photo"] for s in slots)
    return {
        "slots": slots,
        "new_damage_count": new_total,
        "reused_evidence": reused_any,
        "meter": meter_check,
        "checks": checks,
        "recommended_action": (
            "review" if reused_any else ("review" if new_total else "no_claim")
        ),
    }

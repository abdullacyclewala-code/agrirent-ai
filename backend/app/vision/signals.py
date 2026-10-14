"""
Phase 7 — deterministic evidence signals.

This module is the BACKBONE of the trust layer (docs/PHASE7 §5). It runs with
no API keys, no network and no AI, and it is what raises the cost of lying:
pixel hashes, exact-byte hashes, camera metadata, clocks and places, all
cross-checked against history.

Design rules, deliberately:
  * Every function is pure and takes bytes / plain dicts, so it is unit-testable
    against the same JPEG fixtures the frontend tests use.
  * The perceptual hash here mirrors the browser's dHash (9x8 grayscale, compare
    horizontal neighbours, 64 bits, hex). The two implementations differ by the
    resampler's rounding, so a cross-check allows a small distance — but all
    duplicate/history comparisons are done between SERVER values, which are
    internally identical, so duplicate detection has no such tolerance.
  * Nothing here decides money. It produces flags, and flags change what the UI
    says (see src/lib/depositPolicy.js).
"""

from __future__ import annotations

import hashlib
import io
import logging
import math
from datetime import datetime, timezone
from typing import Any, Optional

import numpy as np
from PIL import Image, ImageOps

logger = logging.getLogger("agrirent.vision.signals")

# Keep the analysis copy small: a 768px long edge is plenty for a vision model
# to read a crack or a meter, and it keeps token cost and payload size sane.
ANALYSIS_MAX_EDGE = 768
ANALYSIS_QUALITY = 72


# ---------------------------------------------------------------------------
# Bytes / hashing
# ---------------------------------------------------------------------------

def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def open_image(data: bytes) -> Image.Image:
    """Decode + honour the EXIF orientation, so a sideways phone photo is not
    hashed (or judged) in a rotated state."""
    img = Image.open(io.BytesIO(data))
    img.load()
    try:
        img = ImageOps.exif_transpose(img)
    except Exception:  # pragma: no cover - corrupt EXIF is not worth failing on
        pass
    return img


def analysis_jpeg(img: Image.Image, max_edge: int = ANALYSIS_MAX_EDGE) -> bytes:
    """Downscaled JPEG for sending to a vision model."""
    work = img.copy()
    work.thumbnail((max_edge, max_edge), Image.LANCZOS)
    if work.mode not in ("RGB", "L"):
        work = work.convert("RGB")
    buf = io.BytesIO()
    work.save(buf, format="JPEG", quality=ANALYSIS_QUALITY, optimize=True)
    return buf.getvalue()


def gray_array(img: Image.Image, max_edge: int = 384) -> np.ndarray:
    work = img.copy()
    work.thumbnail((max_edge, max_edge), Image.BILINEAR)
    return np.asarray(work.convert("L"), dtype=np.float64)


# ---------------------------------------------------------------------------
# Perceptual hash (mirrors src/lib/inspectionCapture.js dhashFromGray)
# ---------------------------------------------------------------------------

def dhash_from_image(img: Image.Image, hash_size: int = 8) -> str:
    small = img.convert("L").resize((hash_size + 1, hash_size), Image.BOX)
    arr = np.asarray(small, dtype=np.int16)
    bits = (arr[:, 1:] > arr[:, :-1]).flatten()
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    return f"{value:016x}"


def hamming_hex(a: Optional[str], b: Optional[str]) -> int:
    """Bit distance between two hex hashes. 64 (= 'as different as possible')
    when either side is missing, so an absent hash never reads as a match."""
    if not a or not b or len(a) != len(b):
        return 64
    try:
        return bin(int(a, 16) ^ int(b, 16)).count("1")
    except ValueError:
        return 64


# ---------------------------------------------------------------------------
# Quality (mirrors the browser's Laplacian-variance / exposure maths)
# ---------------------------------------------------------------------------

def laplacian_variance(gray: np.ndarray) -> float:
    if gray.shape[0] < 3 or gray.shape[1] < 3:
        return 0.0
    lap = (
        4 * gray[1:-1, 1:-1]
        - gray[1:-1, :-2]
        - gray[1:-1, 2:]
        - gray[:-2, 1:-1]
        - gray[2:, 1:-1]
    )
    return float(lap.var())


def exposure_stats(gray: np.ndarray) -> dict[str, float]:
    total = gray.size or 1
    return {
        "mean": float(gray.mean()) if gray.size else 0.0,
        "dark_ratio": float((gray < 32).sum() / total),
        "bright_ratio": float((gray > 240).sum() / total),
    }


def assess_quality(sharpness: float, stats: dict[str, float]) -> dict[str, Any]:
    warnings: list[str] = []
    if sharpness < 10:
        warnings.append("blurry")
    elif sharpness < 25:
        warnings.append("soft")
    if stats["mean"] < 45 or stats["dark_ratio"] > 0.55:
        warnings.append("too_dark")
    if stats["mean"] > 215 or stats["bright_ratio"] > 0.35:
        warnings.append("too_bright")
    blocking = sharpness < 4 or (stats["mean"] < 22 and stats["dark_ratio"] > 0.8)
    return {
        "verdict": "fail" if blocking else ("warn" if warnings else "pass"),
        "warnings": warnings,
        "sharpness": round(sharpness, 1),
        **{k: round(v, 4) for k, v in stats.items()},
    }


def measure_quality(img: Image.Image) -> dict[str, Any]:
    return assess_quality(laplacian_variance(gray_array(img)), exposure_stats(gray_array(img)))


# ---------------------------------------------------------------------------
# EXIF (server side, from the stored bytes — independent of what the client said)
# ---------------------------------------------------------------------------

_EXIF_TAGS = {
    "make": 0x010F,
    "model": 0x0110,
    "software": 0x0131,
    "datetime": 0x0132,
}
_GPS_TAGS = {0x0001: "lat_ref", 0x0002: "lat", 0x0003: "lng_ref", 0x0004: "lng"}


def _dms_to_deg(values: Any, ref: str) -> Optional[float]:
    try:
        if isinstance(values, (tuple, list)) and len(values) >= 3:
            d, m, s = (float(values[0]), float(values[1]), float(values[2]))
            val = d + m / 60 + s / 3600
            if ref in ("S", "W"):
                val = -val
            return val
    except (TypeError, ValueError, ZeroDivisionError):
        return None
    return None


def read_exif(img: Image.Image, raw_bytes: Optional[bytes] = None) -> dict[str, Any]:
    """Make/model/clock/GPS, read from the file itself. Never raises."""
    out: dict[str, Any] = {}
    try:
        exif = img.getexif()
        for name, tag in _EXIF_TAGS.items():
            value = exif.get(tag)
            if isinstance(value, str) and value.strip():
                out[name] = value.strip()

        exif_ifd = {}
        try:
            exif_ifd = exif.get_ifd(0x8769) or {}
        except Exception:
            exif_ifd = {}
        dto = exif_ifd.get(0x9003) or exif_ifd.get(0x9004) or out.get("datetime")
        if isinstance(dto, str) and dto.strip():
            out["datetime_original"] = dto.strip()

        gps_ifd = {}
        try:
            gps_ifd = exif.get_ifd(0x8825) or {}
        except Exception:
            gps_ifd = {}
        lat_ref = str(gps_ifd.get(0x0001) or "").strip().upper()
        lng_ref = str(gps_ifd.get(0x0003) or "").strip().upper()
        lat = _dms_to_deg(gps_ifd.get(0x0002), lat_ref)
        lng = _dms_to_deg(gps_ifd.get(0x0004), lng_ref)
        if lat is not None and lng is not None and abs(lat) <= 90 and abs(lng) <= 180:
            out["gps_lat"] = round(lat, 6)
            out["gps_lng"] = round(lng, 6)
    except Exception as exc:  # pragma: no cover
        logger.warning("[signals] EXIF read failed: %s", exc)
    return out


def exif_datetime_epoch(exif: dict[str, Any], tz_offset_minutes: Optional[int]) -> Optional[float]:
    """EXIF writes local wall-clock with no zone. Applying the offset the client
    reported makes it comparable with server receipt time — without it, every
    Indian farmer's photos would look 5h30m 'stale'."""
    raw = exif.get("datetime_original") or exif.get("datetime")
    if not isinstance(raw, str):
        return None
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y:%m:%d %H:%M"):
        try:
            naive = datetime.strptime(raw.strip(), fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        offset = tz_offset_minutes if isinstance(tz_offset_minutes, (int, float)) else 0
        return naive.timestamp() - offset * 60
    return None


# ---------------------------------------------------------------------------
# Geography
# ---------------------------------------------------------------------------

def haversine_km(lat1: Optional[float], lng1: Optional[float],
                 lat2: Optional[float], lng2: Optional[float]) -> Optional[float]:
    if None in (lat1, lng1, lat2, lng2):
        return None
    try:
        r = 6371.0
        p1, p2 = math.radians(float(lat1)), math.radians(float(lat2))
        dp = p2 - p1
        dl = math.radians(float(lng2) - float(lng1))
        a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
        return 2 * r * math.asin(math.sqrt(a))
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# The signal pack
# ---------------------------------------------------------------------------

# The shared flag vocabulary. This list and src/lib/depositPolicy.js's FLAGS
# object are the same contract seen from two languages: the frontend turns these
# codes into sentences (i18n `trust.flag_*`), sorts fatal ones into the verdict,
# and filters lists by them. Emitting a code that is not in here means the UI
# silently shows a raw identifier to a farmer — which is exactly the bug an
# earlier pass fixed for check names ("sha256_match" leaking out as a flag).
# backend/tests/test_vision.py fails if the two lists ever drift apart.
FLAG_VOCABULARY = frozenset({
    "sha_mismatch",
    "duplicate_photo",
    "photo_reused_across_bookings",
    "gps_far_from_equipment",
    "gps_missing",
    "gps_disagrees_with_other_party",
    "capture_clock_skew",
    "watermark_unreadable",
    "watermark_mismatch",
    "low_photo_quality",
    "missing_required_slots",
    "no_camera_exif",
    "unilateral_report",
    "ai_unavailable",
    "meter_delta_implausible",
})


def _add(flags: list[str], code: str) -> None:
    if code not in FLAG_VOCABULARY:  # a typo would be invisible in the UI
        logger.warning("[signals] refusing to emit unknown flag %r", code)
        return
    if code not in flags:
        flags.append(code)


def evaluate_photo(photo: dict[str, Any], *, equipment: dict[str, Any],
                   history: list[dict[str, Any]], received_at: float,
                   policy: dict[str, Any]) -> dict[str, Any]:
    """
    Everything provable about ONE photo, given what we already know.

    `photo` carries the client's claims (sha256, dhash, exif, gps, captured_at)
    plus, when the backend had storage access, the server's own measurements
    (`server_sha256`, `server_dhash`, `server_exif`, `server_quality`).
    """
    flags: list[str] = []
    checks: list[dict[str, Any]] = []

    def check(code: str, ok: bool, flag: Optional[str] = None, detail: str = "") -> None:
        """Record a check, and raise ONE standard flag when it fails.

        `code` is the human-readable check name ("sha256_match"); `flag` is the
        shared vocabulary the UI and src/lib/depositPolicy.js reason about
        ("sha_mismatch"). They are different namespaces — a check passing reads
        as 'sha256_match: true' while its failure is the flag 'sha_mismatch',
        and the fatal-flag set is keyed on the flag. Defaulting flag to code
        would silently emit check names nothing downstream understands.
        """
        checks.append({"code": code, "pass": bool(ok), "detail": detail})
        if not ok:
            _add(flags, flag or code)

    # 1. Exact bytes --------------------------------------------------------
    client_sha = photo.get("sha256")
    server_sha = photo.get("server_sha256")
    if server_sha:
        match = bool(client_sha) and client_sha == server_sha
        check("sha256_match", match, "sha_mismatch",
              "uploaded bytes match the client's fingerprint" if match
              else f"client {str(client_sha)[:12]}… vs server {server_sha[:12]}…")

    # 2. Perceptual fingerprint vs. the client's own hash -------------------
    client_dhash = photo.get("dhash")
    server_dhash = photo.get("server_dhash")
    if server_dhash and client_dhash:
        distance = hamming_hex(client_dhash, server_dhash)
        # A large gap means the pixels the client hashed are not the pixels the
        # server received — the same class of failure as a byte mismatch.
        check("dhash_consistent", distance <= 12, "sha_mismatch", f"client/server distance {distance}")

    # 3. Reuse detection (the anti-lying signal that actually bites) --------
    if server_dhash:
        best = None
        for prior in history or []:
            if not prior.get("dhash"):
                continue
            d = hamming_hex(server_dhash, prior["dhash"])
            if best is None or d < best["distance"]:
                best = {"distance": d, **prior}
        if best and best["distance"] <= policy.get("duplicate_hamming_threshold", 6):
            same_booking = best.get("booking_id") == photo.get("booking_id")
            kind = "duplicate_photo" if same_booking else "photo_reused_across_bookings"
            # A deliberate resubmit of the SAME slot in the SAME report is a
            # duplicate; a different slot reusing the image is the real cheat.
            same_slot = best.get("slot") == photo.get("slot")
            if not same_slot or not same_booking:
                _add(flags, kind)
            elif same_slot and same_booking:
                # Re-shooting the same physical view can legitimately look
                # near-identical — only flag it when it looks like the very
                # same file.
                if best["distance"] <= 2:
                    _add(flags, "duplicate_photo")
            checks.append({
                "code": "reuse_check",
                "pass": kind not in flags,
                "detail": f"closest prior photo distance {best['distance']} "
                          f"(slot {best.get('slot')}, booking {best.get('booking_id')})",
            })
        else:
            checks.append({
                "code": "reuse_check",
                "pass": True,
                "detail": f"no matching history (closest distance {best['distance']})" if best else "no history yet",
            })

    # 4. Camera metadata ----------------------------------------------------
    server_exif = photo.get("server_exif") or {}
    if server_exif:
        check("exif_present", True, f"{server_exif.get('make', '?')} {server_exif.get('model', '')}".strip())
        claimed = photo.get("exif") or {}
        if claimed.get("model") and server_exif.get("model") and claimed["model"] != server_exif["model"]:
            # The file's own metadata disagrees with the app's record. Its own
            # flag, because it means something different from a bad watermark.
            _add(flags, "exif_disagrees_with_record")
            checks.append({"code": "exif_matches_claim", "pass": False,
                           "detail": f"claimed {claimed['model']} vs file {server_exif['model']}"})
        else:
            checks.append({"code": "exif_matches_claim", "pass": True, "detail": "model matches or absent"})
    else:
        _add(flags, "no_camera_exif")
        checks.append({"code": "exif_present", "pass": False,
                       "detail": "no camera metadata in the file (screenshot, forwarded or stripped image)"})

    # 5. Location -----------------------------------------------------------
    gps = photo.get("gps") or {}
    lat, lng = gps.get("lat"), gps.get("lng")
    if lat is None or lng is None:
        check("gps_present", False, "gps_missing", "no location on this photo")
    else:
        checks.append({"code": "gps_present", "pass": True, "detail": f"{lat:.4f},{lng:.4f} ({gps.get('source')})"})
        distance = haversine_km(lat, lng, equipment.get("lat"), equipment.get("lng"))
        if distance is not None and distance > policy.get("gps_flag_distance_km", 25):
            check("gps_near_equipment", False, "gps_far_from_equipment",
                  f"{distance:.1f} km from the machine's registered location")
        elif distance is not None:
            checks.append({"code": "gps_near_equipment", "pass": True, "detail": f"{distance:.1f} km away"})

    # 6. Clock --------------------------------------------------------------
    captured = photo.get("captured_at_epoch")
    # `is not None`, not truthiness: epoch 0 is a real (if ancient) timestamp.
    if captured is not None:
        drift_min = abs(received_at - float(captured)) / 60.0
        skew = drift_min > policy.get("time_drift_flag_minutes", 120)
        check("capture_time_plausible", not skew, "capture_clock_skew",
              f"capture→receipt drift {drift_min:.0f} min")
    if server_exif.get("datetime_original"):
        exif_epoch = exif_datetime_epoch(server_exif, photo.get("tz_offset_minutes"))
        if exif_epoch is not None and captured is not None:
            delta_min = abs(exif_epoch - float(captured)) / 60.0
            check("exif_clock_agrees", delta_min <= 180, "capture_clock_skew",
                  f"camera clock vs app clock {delta_min:.0f} min apart")

    # 7. Quality ------------------------------------------------------------
    quality = photo.get("server_quality") or photo.get("quality") or {}
    if quality.get("verdict") == "fail":
        check("photo_quality", False, "low_photo_quality", ",".join(quality.get("warnings", [])))
    elif quality:
        checks.append({"code": "photo_quality", "pass": True, "detail": quality.get("verdict", "pass")})

    # 8. Watermark read-back (from the AI layer, when it ran) --------------
    watermark = photo.get("watermark_ai") or {}
    if server_exif or quality:
        if watermark.get("readable") is False:
            check("watermark_readable", False, "watermark_unreadable",
                  "stamp not readable in the pixels")
        elif watermark.get("code_matches") is False:
            check("watermark_matches", False, "watermark_mismatch",
                  f"read '{watermark.get('text')}' expected '{watermark.get('expected')}'")
        elif watermark.get("readable"):
            checks.append({"code": "watermark_readable", "pass": True, "detail": "stamp read back and matches"})

    return {"flags": flags, "checks": checks}


def cross_party_check(photos: list[dict[str, Any]], counterparty_photos: list[dict[str, Any]],
                      policy: dict[str, Any]) -> dict[str, Any]:
    """Do the two parties' photos of the same handover agree about where they
    were taken? Two people photographing one machine should be standing in
    roughly the same place."""
    flags: list[str] = []
    details: list[dict[str, Any]] = []
    mine = [p for p in photos if (p.get("gps") or {}).get("lat") is not None]
    theirs = [p for p in counterparty_photos or [] if (p.get("gps") or {}).get("lat") is not None]
    if mine and theirs:
        lat1 = sum(p["gps"]["lat"] for p in mine) / len(mine)
        lng1 = sum(p["gps"]["lng"] for p in mine) / len(mine)
        lat2 = sum(p["gps"]["lat"] for p in theirs) / len(theirs)
        lng2 = sum(p["gps"]["lng"] for p in theirs) / len(theirs)
        distance = haversine_km(lat1, lng1, lat2, lng2)
        if distance is not None and distance > policy.get("gps_flag_distance_km", 25):
            flags.append("gps_disagrees_with_other_party")
            details.append({"detail": f"the two parties' photos are {distance:.1f} km apart"})
    return {"flags": flags, "details": details}


def meter_delta_check(opening: Optional[float], closing: Optional[float],
                      start_date: Optional[str], end_date: Optional[str],
                      policy: dict[str, Any]) -> dict[str, Any]:
    """A meter that barely moved over a multi-day rental (or went backwards) is
    worth a human glance — it is the machine's own usage record."""
    if opening is None or closing is None:
        return {"flag": None, "delta": None, "detail": "meter not readable in one or both reports"}
    delta = closing - opening
    if delta < 0:
        return {"flag": "meter_delta_implausible", "delta": delta,
                "detail": f"closing reading ({closing}) is lower than the opening reading ({opening})"}
    days = 1
    try:
        if start_date and end_date:
            d1 = datetime.fromisoformat(str(start_date))
            d2 = datetime.fromisoformat(str(end_date))
            days = max(1, (d2 - d1).days)
    except (ValueError, TypeError):
        days = 1
    if days > 1 and delta < policy.get("meter_delta_flag_hours", 2):
        return {"flag": "meter_delta_implausible", "delta": delta,
                "detail": f"only {delta} h recorded over a {days}-day rental"}
    return {"flag": None, "delta": delta, "detail": f"meter advanced {delta} h over {days} day(s)"}


def build_report_signals(photo_results: list[dict[str, Any]], *,
                         required_slots: list[str], signed_by: int,
                         chain_intact: Optional[bool], ai_status: str) -> dict[str, Any]:
    """Roll the per-photo packs into the report-level pack the UI shows."""
    flags: list[str] = []
    for result in photo_results:
        for code in result.get("flags", []):
            _add(flags, code)

    present_slots = {r.get("slot") for r in photo_results}
    missing = [s for s in required_slots if s not in present_slots]
    if missing:
        _add(flags, "missing_required_slots")

    if signed_by == 0:
        _add(flags, "unilateral_report")
    if ai_status in ("unavailable", "disabled"):
        _add(flags, "ai_unavailable")

    # Verdict mirrors src/lib/depositPolicy.js verdictFor() exactly — one
    # definition per side, and the backend one is authoritative because it is
    # computed from the stored rows.
    fatal = {"sha_mismatch", "duplicate_photo", "photo_reused_across_bookings", "watermark_mismatch"}
    photos = len(photo_results)
    if photos < 3 or chain_intact is False or (fatal & set(flags)):
        verdict = "unverified"
    elif flags or signed_by == 0:
        verdict = "verified_with_flags"
    else:
        verdict = "verified"

    return {
        "flags": flags,
        "missing_slots": missing,
        "photo_count": photos,
        "signed_by": signed_by,
        "verdict": verdict,
        "flagged": bool(flags),
        "checks": [c for r in photo_results for c in r.get("checks", [])],
    }

"""
Phase 7 — backend tests for the trust layer.

Run from `backend/`:
    pip install -r requirements.txt -r requirements-dev.txt
    python3 scripts/make-fixtures.py          # from the repo root
    pytest

Two deliberate properties are asserted here, because they are the ones that
carry the feature:

  1. DUPLICATE DETECTION WORKS ON REAL PIXELS. These tests compute the server's
     perceptual hash over the actual fixture files and prove that a re-compressed
     copy of the same scene is caught, while a genuinely different photo is not.
     (The node suite covers the hash maths; this covers the decode + compare.)
  2. NOTHING HERE NEEDS AN API KEY. Every AI path is mocked, and a mocked
     failure must still yield a complete, honest report — this is the property
     that keeps a Render free-tier deployment working.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

FIXTURES = Path(os.getenv("FIXTURE_DIR", "/tmp/fixtures"))

pytestmark = pytest.mark.skipif(
    not (FIXTURES / "handover.jpg").exists(),
    reason="fixtures missing — run: python3 scripts/make-fixtures.py",
)

from app.vision import analyze as analyze_mod  # noqa: E402
from app.vision import providers, signals  # noqa: E402
from app.vision.supabase_rest import SupabaseREST  # noqa: E402


def load(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def img(name: str):
    return signals.open_image(load(name))


# ---------------------------------------------------------------------------
# Perceptual hashing over real pixels — the anti-reuse signal
# ---------------------------------------------------------------------------

def test_dhash_is_deterministic_and_hex():
    a = signals.dhash_from_image(img("handover.jpg"))
    b = signals.dhash_from_image(img("handover.jpg"))
    assert a == b
    assert len(a) == 16
    assert int(a, 16) >= 0


def test_recompressed_copy_is_caught_as_a_duplicate():
    """The exact lie this feature exists to stop: filing a saved copy of the
    handover photo as evidence of the return condition. Different bytes,
    different file size — same picture."""
    original = load("return.jpg")
    copy = load("return_recompressed.jpg")
    assert len(original) != len(copy), "the two files must differ byte-wise"
    assert signals.sha256_hex(original) != signals.sha256_hex(copy)

    distance = signals.hamming_hex(
        signals.dhash_from_image(signals.open_image(original)),
        signals.dhash_from_image(signals.open_image(copy)),
    )
    assert distance <= 6, f"re-compressed copy should hash as a duplicate (distance {distance})"


def test_a_genuinely_different_photo_is_not_flagged_as_a_duplicate():
    """The false-positive guard: a crack and a moved meter reading must not
    read as 'the same photo', or every honest return would be accused."""
    distance = signals.hamming_hex(
        signals.dhash_from_image(img("handover.jpg")),
        signals.dhash_from_image(img("return.jpg")),
    )
    assert distance > 6, f"different scenes must not collide (distance {distance})"


def test_hamming_missing_or_malformed_is_worst_case():
    assert signals.hamming_hex(None, "abcd") == 64
    assert signals.hamming_hex("abcd", None) == 64
    assert signals.hamming_hex("abcd", "abcdef") == 64
    assert signals.hamming_hex("zzzz", "0000") == 64
    assert signals.hamming_hex("0000", "0000") == 0


# ---------------------------------------------------------------------------
# Server-side EXIF + quality (independent of what the client claimed)
# ---------------------------------------------------------------------------

def test_reads_exif_from_the_stored_file():
    exif = signals.read_exif(img("handover.jpg"))
    assert exif["make"] == "Xiaomi"
    assert exif["model"] == "Redmi Note 12"
    assert exif["datetime_original"] == "2026:10:14 09:41:07"
    assert abs(exif["gps_lat"] - 19.13) < 0.001
    assert abs(exif["gps_lng"] - 72.87) < 0.001


def test_no_exif_file_reports_nothing_rather_than_guessing():
    assert signals.read_exif(img("noexif.jpg")) == {}


def test_exif_datetime_epoch_applies_the_device_offset():
    exif = {"datetime_original": "2026:10:14 09:41:07"}
    epoch_ist = signals.exif_datetime_epoch(exif, 330)      # +05:30
    epoch_utc = signals.exif_datetime_epoch(exif, 0)
    assert epoch_ist is not None and epoch_utc is not None
    assert epoch_utc - epoch_ist == pytest.approx(330 * 60)


def test_quality_gate_separates_a_crisp_photo_from_a_blurred_one():
    crisp = signals.measure_quality(img("handover.jpg"))
    blurred = signals.measure_quality(img("blurry.jpg"))
    assert crisp["verdict"] in ("pass", "warn")
    assert blurred["sharpness"] < crisp["sharpness"]
    assert blurred["verdict"] in ("warn", "fail")


def test_blurry_photo_is_flagged_low_quality_in_the_signal_pack():
    measured = signals.measure_quality(img("blurry.jpg"))
    result = signals.evaluate_photo(
        {"slot": "meter", "server_quality": measured, "server_dhash": signals.dhash_from_image(img("blurry.jpg"))},
        equipment={"lat": 19.13, "lng": 72.87}, history=[], received_at=0, policy={},
    )
    codes = {c["code"]: c["pass"] for c in result["checks"]}
    assert codes.get("photo_quality") is False


# ---------------------------------------------------------------------------
# Geography / clock / meter — the cheap cross-checks
# ---------------------------------------------------------------------------

def test_haversine_known_distance():
    km = signals.haversine_km(19.076, 72.8777, 18.5204, 73.8567)  # Mumbai -> Pune
    assert km is not None and 105 < km < 135


def test_gps_far_from_equipment_raises_a_flag_not_a_block():
    result = signals.evaluate_photo(
        {"slot": "full_left", "gps": {"lat": 28.61, "lng": 77.20, "source": "exif"}, "server_exif": {"make": "X"}},
        equipment={"lat": 19.13, "lng": 72.87},  # Delhi vs Mumbai
        history=[], received_at=0, policy={"gps_flag_distance_km": 25},
    )
    assert "gps_far_from_equipment" in result["flags"]


def test_clock_skew_is_flagged():
    result = signals.evaluate_photo(
        {"slot": "full_left", "captured_at_epoch": 0, "server_exif": {"make": "X"}},
        equipment={}, history=[], received_at=60 * 60 * 24,  # a day later
        policy={"time_drift_flag_minutes": 120},
    )
    assert "capture_clock_skew" in result["flags"]


def test_meter_going_backwards_is_implausible():
    check = signals.meter_delta_check(1258.0, 1240.5, "2026-10-14", "2026-10-18", {})
    assert check["flag"] == "meter_delta_implausible"
    assert "lower than the opening" in check["detail"]


def test_meter_barely_moving_over_a_long_rental_is_implausible():
    check = signals.meter_delta_check(1240.5, 1241.0, "2026-10-01", "2026-10-15", {})
    assert check["flag"] == "meter_delta_implausible"


def test_meter_moving_a_sane_amount_is_fine():
    check = signals.meter_delta_check(1240.5, 1258.0, "2026-10-14", "2026-10-18", {})
    assert check["flag"] is None
    assert check["delta"] == pytest.approx(17.5)


def test_meter_unreadable_is_not_a_flag():
    check = signals.meter_delta_check(None, None, "2026-10-14", "2026-10-18", {})
    assert check["flag"] is None


# ---------------------------------------------------------------------------
# Verdicts
# ---------------------------------------------------------------------------

def test_verdicts_match_the_frontend_policy():
    good = [{"slot": s, "flags": [], "checks": []} for s in ["full_left", "full_right", "meter", "work_area"]]
    assert signals.build_report_signals(good, required_slots=["full_left", "full_right", "meter", "work_area"],
                                        signed_by=2, chain_intact=True, ai_status="ok")["verdict"] == "verified"

    assert signals.build_report_signals(good, required_slots=["full_left", "full_right", "meter", "work_area"],
                                        signed_by=0, chain_intact=True, ai_status="ok")["verdict"] == "verified_with_flags"

    thin = good[:2]
    assert signals.build_report_signals(thin, required_slots=["full_left", "full_right", "meter", "work_area"],
                                        signed_by=2, chain_intact=True, ai_status="ok")["verdict"] == "unverified"

    reused = [dict(good[0], flags=["duplicate_photo"])] + good[1:]
    assert signals.build_report_signals(reused, required_slots=["full_left", "full_right", "meter", "work_area"],
                                        signed_by=2, chain_intact=True, ai_status="ok")["verdict"] == "unverified"


def test_missing_slots_and_unilateral_are_flagged():
    pack = signals.build_report_signals(
        [{"slot": "meter", "flags": [], "checks": []}],
        required_slots=["full_left", "full_right", "meter", "work_area"],
        signed_by=1, chain_intact=True, ai_status="unavailable",
    )
    assert "missing_required_slots" in pack["flags"]
    assert "ai_unavailable" in pack["flags"]
    assert set(pack["missing_slots"]) == {"full_left", "full_right", "work_area"}


# ---------------------------------------------------------------------------
# The client's claims vs the server's measurements
# ---------------------------------------------------------------------------

def test_client_sha_mismatch_raises_the_shared_flag():
    """The flag vocabulary is shared with src/lib/depositPolicy.js, where
    `sha_mismatch` is one of the FATAL flags. A check named `sha256_match`
    failing must emit `sha_mismatch`, not echo its own name — that mismatch
    between the two namespaces was a real bug, so it is pinned here."""
    data = load("handover.jpg")
    result = signals.evaluate_photo(
        {"slot": "meter", "sha256": "0" * 64, "server_sha256": signals.sha256_hex(data)},
        equipment={}, history=[], received_at=0, policy={},
    )
    assert "sha_mismatch" in result["flags"]
    check = next(c for c in result["checks"] if c["code"] == "sha256_match")
    assert check["pass"] is False
    # ...and no check name leaks into the flag list as a pseudo-flag.
    assert "sha256_match" not in result["flags"]
    assert "capture_time_plausible" not in result["flags"]


def test_client_sha_match_passes():
    data = load("handover.jpg")
    result = signals.evaluate_photo(
        {"slot": "meter", "sha256": signals.sha256_hex(data), "server_sha256": signals.sha256_hex(data)},
        equipment={}, history=[], received_at=0, policy={},
    )
    assert "sha_mismatch" not in result["flags"]
    assert next(c for c in result["checks"] if c["code"] == "sha256_match")["pass"] is True


def test_epoch_zero_is_a_timestamp_not_a_missing_value():
    """`if captured:` would treat epoch 0 as absent — a falsy-value bug that
    silently disabled the clock check."""
    skewed = signals.evaluate_photo(
        {"slot": "meter", "captured_at_epoch": 0},
        equipment={}, history=[], received_at=86400, policy={"time_drift_flag_minutes": 120},
    )
    assert "capture_clock_skew" in skewed["flags"]

    prompt = signals.evaluate_photo(
        {"slot": "meter", "captured_at_epoch": 0},
        equipment={}, history=[], received_at=60, policy={"time_drift_flag_minutes": 120},
    )
    assert "capture_clock_skew" not in prompt["flags"]


def test_history_duplicate_across_bookings_uses_the_harsher_flag():
    dhash = signals.dhash_from_image(img("return.jpg"))
    result = signals.evaluate_photo(
        {"slot": "full_left", "booking_id": 99, "server_dhash": dhash},
        equipment={}, history=[{"id": "x", "dhash": dhash, "booking_id": 42, "slot": "full_left"}],
        received_at=0, policy={"duplicate_hamming_threshold": 6},
    )
    assert "photo_reused_across_bookings" in result["flags"]


# ---------------------------------------------------------------------------
# End-to-end analyse, with the AI mocked
# ---------------------------------------------------------------------------

class _StubREST(SupabaseREST):
    """No service key: exercises the 'client supplies everything' path, which is
    also the path a bare deployment runs on."""

    def __init__(self):
        super().__init__(url="", key="")

    @property
    def configured(self):
        return False


def _photo_payload(name: str, slot: str, **overrides):
    data = load(name)
    image = signals.open_image(data)
    payload = {
        "slot": slot,
        "inline_b64": __import__("base64").b64encode(data).decode(),
        "sha256": signals.sha256_hex(data),
        "dhash": signals.dhash_from_image(image),
        "captured_at_device": "2026-10-14T09:41:07+05:30",
        "watermark_text": "AgriRent AI · AR-TEST1234 · Booking #43",
    }
    payload.update(overrides)
    return payload


def test_analysis_without_any_ai_still_produces_a_usable_report(monkeypatch):
    monkeypatch.setattr(providers, "vision_json",
                        lambda *a, **k: (_ for _ in ()).throw(providers.VisionUnavailable("no keys")))
    monkeypatch.setattr(providers, "configured_providers", lambda: ["gemini"])

    payload = {
        "booking_id": 43, "kind": "handover", "report_code": "AR-TEST1234",
        "equipment": {"id": 28, "name": "Mahindra 575", "type": "tractor", "lat": 19.13, "lng": 72.87},
        "photos": [
            _photo_payload("handover.jpg", "full_left"),
            _photo_payload("return.jpg", "full_right"),
            _photo_payload("noexif.jpg", "meter"),
        ],
        "signed_by": 1,
        "chain_intact": True,
        "required_slots": ["full_left", "full_right", "meter", "work_area"],
    }
    result = analyze_mod.run_analysis(payload, _StubREST())

    assert result["ai_status"] in ("unavailable", "partial")
    assert result["storage"] == "client"
    assert len(result["photos"]) == 3
    assert result["signals"]["verdict"] in ("verified_with_flags", "unverified")
    # The exact-bytes check still ran, with no AI involved at all:
    assert result["photos"][0]["sha256_match"] is True
    # ...and the file with no camera metadata is called out, not ignored.
    assert "no_camera_exif" in result["signals"]["flags"]
    assert result["summary"]["text"]


def test_analysis_with_mocked_ai_reads_the_meter_and_the_watermark(monkeypatch):
    calls = {"n": 0}

    def fake_vision(images, prompt):
        calls["n"] += 1
        return {"provider": "gemini", "data": {
            "shows_equipment": True,
            "quality": {"framing": "good", "issues": []},
            "watermark": {"readable": True, "text": "AgriRent AI · AR-TEST1234", "code": "AR-TEST1234"},
            "parts_visible": ["engine", "hour_meter"],
            "meter": {"visible": True, "value": 1240.5, "unit": "hours"},
            "damage": [{"part": "left fender", "kind": "scratch", "severity": "minor",
                        "description": "old scratch", "confidence": 0.8}],
            "wear_and_tear": ["dust"],
            "notes": None,
        }}

    monkeypatch.setattr(providers, "vision_json", fake_vision)

    payload = {
        "booking_id": 43, "kind": "handover", "report_code": "AR-TEST1234",
        "equipment": {"id": 28, "lat": 19.13, "lng": 72.87},
        "photos": [_photo_payload("handover.jpg", "meter")],
        "signed_by": 1,
    }
    result = analyze_mod.run_analysis(payload, _StubREST())

    assert result["ai_status"] == "ok"
    assert result["ai_provider"] == "gemini"
    assert result["hour_meter"] == 1240.5
    assert calls["n"] >= 1
    assert result["summary"]["damage_found"]


def test_reused_handover_photo_as_return_evidence_is_caught(monkeypatch):
    """The head-line lie: file the handover photo again as the 'return'
    condition. Same pixels, so the perceptual hash gives it away — and the
    compare path flags it even when the AI is off."""
    monkeypatch.setattr(providers, "vision_json",
                        lambda *a, **k: (_ for _ in ()).throw(providers.VisionUnavailable("off")))

    same = _photo_payload("handover.jpg", "full_left")
    payload = {
        "booking_id": 43, "kind": "return", "report_code": "AR-RET1234",
        "equipment": {"id": 28, "lat": 19.13, "lng": 72.87},
        "photos": [same],
        "signed_by": 1,
        "compare": {
            "before_photos": [{**same, "slot": "full_left"}],   # the handover report's photo
            "known_damage": [],
            "start_date": "2026-10-14", "end_date": "2026-10-18",
            "opening_meter": 1240.5, "closing_meter": 1240.5,
        },
    }
    result = analyze_mod.run_analysis(payload, _StubREST())

    assert result["compare"]["reused_evidence"] is True
    slot = result["compare"]["slots"][0]
    assert slot["reused_handover_photo"] is True
    assert slot["hash_distance"] == 0
    assert any(c["code"] == "return_photo_is_not_a_reused_handover_photo" and c["pass"] is False
               for c in result["compare"]["checks"])


def test_different_handover_and_return_photos_are_not_accused(monkeypatch):
    monkeypatch.setattr(providers, "vision_json",
                        lambda *a, **k: (_ for _ in ()).throw(providers.VisionUnavailable("off")))
    before = _photo_payload("handover.jpg", "full_left")
    after = _photo_payload("return.jpg", "full_left")
    payload = {
        "booking_id": 43, "kind": "return", "report_code": "AR-RET1234",
        "equipment": {"id": 28},
        "photos": [after], "signed_by": 1,
        "compare": {"before_photos": [before], "known_damage": []},
    }
    result = analyze_mod.run_analysis(payload, _StubREST())
    assert result["compare"]["reused_evidence"] is False
    assert result["compare"]["slots"][0]["reused_handover_photo"] is False


def test_unreadable_photo_is_recorded_not_crashed():
    payload = {
        "booking_id": 43, "kind": "handover", "report_code": "AR-X",
        "equipment": {"id": 28},
        "photos": [{"slot": "full_left", "inline_b64": __import__("base64").b64encode(b"not a jpeg").decode()}],
        "signed_by": 1,
    }
    result = analyze_mod.run_analysis(payload, _StubREST())
    assert result["photos"][0].get("unreadable") is True
    assert result["signals"]["verdict"] == "unverified"


def test_analysis_cache_avoids_paying_twice(monkeypatch):
    calls = {"n": 0}

    def counting_vision(images, prompt):
        calls["n"] += 1
        return {"provider": "gemini", "data": {"meter": {"visible": False}, "damage": []}}

    monkeypatch.setattr(providers, "vision_json", counting_vision)
    payload = {
        "booking_id": 1, "kind": "handover", "report_code": "AR-CACHE",
        "equipment": {"id": 1}, "photos": [_photo_payload("return.jpg", "meter")], "signed_by": 1,
    }
    analyze_mod.run_analysis(payload, _StubREST())
    first = calls["n"]
    analyze_mod.run_analysis(payload, _StubREST())
    assert calls["n"] == first, "the second run must hit the cache, not the provider"


# ---------------------------------------------------------------------------
# The flag vocabulary is a contract between two languages
# ---------------------------------------------------------------------------

def test_flag_vocabulary_matches_the_frontend_exactly():
    """Every flag the backend can emit must be one the UI knows how to explain.

    src/lib/depositPolicy.js's FLAGS object is what turns a code into a sentence
    (`trust.flag_*` in en/hi/mr) and what decides which flags are fatal. If the
    backend invents a code, a farmer sees a raw identifier like
    "watermark_unreadable" instead of a reason — the same class of bug as a
    check name leaking out as a flag. Both files are read here, so drift fails
    the build rather than the user.
    """
    import re
    from pathlib import Path

    from app.vision.signals import FLAG_VOCABULARY

    policy = Path(__file__).resolve().parents[2] / "src" / "lib" / "depositPolicy.js"
    source = policy.read_text(encoding="utf-8")
    block = source[source.index("export const FLAGS"):]
    block = block[: block.index("};")]
    frontend = set(re.findall(r'"([a-z_]+)"', block))

    assert frontend, "could not parse FLAGS out of depositPolicy.js"
    assert frontend == set(FLAG_VOCABULARY), {
        "only in the backend": sorted(set(FLAG_VOCABULARY) - frontend),
        "only in the frontend": sorted(frontend - set(FLAG_VOCABULARY)),
    }


def test_unknown_flags_are_dropped_rather_than_shown_to_a_farmer():
    from app.vision.signals import _add

    flags: list[str] = []
    _add(flags, "watermark_unreadable")     # in the vocabulary
    _add(flags, "definitely_not_a_flag")    # a typo
    assert flags == ["watermark_unreadable"]


def test_unilateral_and_missing_slots_use_the_shared_names():
    """These two were caught drifting by the live integration probe — the
    backend said "unilateral" while the UI only knew "unilateral_report"."""
    from app.vision.signals import build_report_signals

    signals = build_report_signals(
        [], required_slots=["full_left", "full_right"], signed_by=0,
        chain_intact=True, ai_status="ok",
    )
    assert "unilateral_report" in signals["flags"]
    assert "unilateral" not in signals["flags"]
    assert "missing_required_slots" in signals["flags"]

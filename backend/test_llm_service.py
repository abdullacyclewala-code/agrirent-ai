"""Tests for the smart-routing §6.1 changes (location_text / needed_date slots,
nullable operation). Provider HTTP calls are mocked — these run without API
keys. Run from backend/:  python -m pytest test_llm_service.py"""

from datetime import date, timedelta

import pytest

from app.llm_service import (
    LLMAllProvidersFailed,
    _clean_location_text,
    _clean_needed_date,
    _system_prompt,
    parse_requirement_via_llm,
)
from app.taxonomy import allowed_vocab_lists, load_taxonomy

TODAY = date.today()  # sandbox clock; _clean_needed_date takes `today` explicitly


def _mock_provider(monkeypatch, groq_out, gemini_out=None):
    import app.llm_service as svc

    monkeypatch.setattr(svc, "_call_groq", lambda *a: groq_out)
    monkeypatch.setattr(svc, "_call_gemini", lambda *a: gemini_out)


def test_full_new_shape_passes_through(monkeypatch):
    future = (TODAY + timedelta(days=10)).isoformat()
    _mock_provider(
        monkeypatch,
        {
            "crop": "wheat",
            "area_acres": 5,
            "operation": "harvesting",
            "equipment_type": "harvester",
            "location_text": "नाशिक",
            "needed_date": future,
        },
    )
    out = parse_requirement_via_llm("...", "auto", load_taxonomy())
    assert out["crop"] == "wheat"
    assert out["area_acres"] == 5.0
    assert out["operation"] == "harvesting"
    assert out["location_text"] == "नाशिक"
    assert out["needed_date"] == future
    assert out["provider_used"] == "groq"


def test_old_shape_backward_compatible(monkeypatch):
    # Model outputs / caches without the new keys must not crash — slots are None.
    _mock_provider(
        monkeypatch,
        {"crop": "cotton", "area_acres": 2, "operation": "ploughing", "equipment_type": None},
    )
    out = parse_requirement_via_llm("...", "auto", load_taxonomy())
    assert out["crop"] == "cotton"
    assert out["location_text"] is None
    assert out["needed_date"] is None


def test_operation_null_allowed_no_raise(monkeypatch):
    # "need a tractor" style input — frontend will ask a follow-up for the work.
    _mock_provider(
        monkeypatch,
        {
            "crop": None,
            "area_acres": None,
            "operation": None,
            "equipment_type": "tractor",
            "location_text": None,
            "needed_date": None,
        },
    )
    out = parse_requirement_via_llm("need a tractor", "auto", load_taxonomy())
    assert out["operation"] is None
    assert out["equipment_type"] == "tractor"


def test_operation_unmatchable_becomes_null_no_raise(monkeypatch):
    _mock_provider(monkeypatch, {"crop": None, "area_acres": None, "operation": "blargh_flargh"})
    out = parse_requirement_via_llm("...", "auto", load_taxonomy())
    assert out["operation"] is None
    assert any("operation" in n for n in out["confidence_notes"])


def test_all_providers_fail_still_raises(monkeypatch):
    _mock_provider(monkeypatch, None, None)
    with pytest.raises(LLMAllProvidersFailed):
        parse_requirement_via_llm("...", "auto", load_taxonomy())


def test_gemini_fallback_used_when_groq_fails(monkeypatch):
    _mock_provider(monkeypatch, None, {"crop": "rice", "operation": "transplanting"})
    out = parse_requirement_via_llm("...", "auto", load_taxonomy())
    assert out["provider_used"] == "gemini"
    assert out["crop"] == "rice"


def test_needed_date_validation():
    future = (TODAY + timedelta(days=30)).isoformat()
    assert _clean_needed_date(future, TODAY) == future
    assert _clean_needed_date(TODAY.isoformat(), TODAY) == TODAY.isoformat()  # today ok
    assert _clean_needed_date("2020-01-01", TODAY) is None  # past
    assert _clean_needed_date("next Monday", TODAY) is None  # not ISO
    assert _clean_needed_date("15/09/2026", TODAY) is None  # not ISO
    assert _clean_needed_date("2026-13-01", TODAY) is None  # bad month
    assert _clean_needed_date("2026-02-30", TODAY) is None  # bad day
    assert _clean_needed_date(None, TODAY) is None
    assert _clean_needed_date(12345, TODAY) is None
    far = (TODAY + timedelta(days=731)).isoformat()
    assert _clean_needed_date(far, TODAY) is None  # too far out
    edge = (TODAY + timedelta(days=730)).isoformat()
    assert _clean_needed_date(edge, TODAY) == edge


def test_location_cleaning():
    assert _clean_location_text("  Nashik ") == "Nashik"
    assert _clean_location_text("   ") is None
    assert _clean_location_text("") is None
    assert _clean_location_text(None) is None
    assert _clean_location_text(123) is None
    long = "x" * 200
    assert _clean_location_text(long) == "x" * 120


def test_prompt_contains_today_and_new_slots():
    vocab = allowed_vocab_lists(load_taxonomy())
    probe = date(2026, 9, 11)
    prompt = _system_prompt(vocab, {}, probe)
    assert "2026-09-11" in prompt
    assert "Friday" in prompt
    assert "location_text" in prompt
    assert "needed_date" in prompt
    assert "YYYY-MM-DD" in prompt


def test_response_model_accepts_new_shape():
    pytest.importorskip("fastapi")  # backend web deps optional in this sandbox
    # app.main transitively imports the LightGBM training module — stub the
    # heavy ML-only deps (unused at import time) so this stays hermetic.
    import sys
    import types

    for name in ("lightgbm", "joblib"):
        if name not in sys.modules:
            try:
                __import__(name)
            except ImportError:
                sys.modules[name] = types.ModuleType(name)
    from app.main import ParseRequirementOut

    full = ParseRequirementOut(
        crop="wheat",
        area_acres=5,
        operation="harvesting",
        equipment_type="harvester",
        location_text="Nashik",
        needed_date="2026-09-20",
        provider_used="groq",
    )
    assert full.model_dump()["needed_date"] == "2026-09-20"
    # Old clients / bare parses: everything optional except provider_used.
    bare = ParseRequirementOut(provider_used="gemini")
    assert bare.operation is None and bare.location_text is None

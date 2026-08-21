"""
§6.5 Model serving. Loads the (lazily trained, synthetic-cold-start)
LightGBM ranker once per process and serves inference synchronously per
request — candidate sets are already hard-filtered by the frontend's rules
engine (§6.3) before they ever reach here, so they're small (single/low-double
digits), and LightGBM inference on that size is effectively instant. No
batching or async queue is needed per §6.5.
"""

from typing import List

import numpy as np

from .features import FEATURE_NAMES, build_compatibility_index, extract_features
from .train_ranker import load_or_train

_model = None
_model_version = None

# Match the existing Phase 2 heuristic's display range (see rulesFilter.js:
# `score = Math.max(35, Math.min(99, ...))`) so the frontend's MatchRing /
# match-percentage UI needs zero changes to show real ML scores instead.
_DISPLAY_MIN, _DISPLAY_MAX = 35, 99


def get_model():
    global _model, _model_version
    if _model is None:
        _model, _model_version = load_or_train()
    return _model, _model_version


def rank_candidates(requirement: dict, candidates: List[dict], taxonomy: dict) -> dict:
    """
    requirement: {crop, area_acres, operation, equipment_type}
    candidates: equipment-like dicts, already hard-filtered by rulesFilter.js.
    Returns {"ranked": [{id, rank_score, features}], "model_version": str}.
    `ranked` is sorted best-first. `rank_score` is 35-99 for easy drop-in
    display alongside the existing Phase 2 UI.
    """
    model, version = get_model()

    if not candidates:
        return {"ranked": [], "model_version": version}

    compatibility_index = build_compatibility_index(taxonomy)
    feats = [extract_features(requirement, c, compatibility_index) for c in candidates]
    X = np.array([[f[name] for name in FEATURE_NAMES] for f in feats], dtype=float)

    raw_scores = model.predict(X)

    lo, hi = float(np.min(raw_scores)), float(np.max(raw_scores))
    spread = hi - lo

    ranked = []
    for candidate, feat, raw in zip(candidates, feats, raw_scores):
        norm = (float(raw) - lo) / spread if spread > 1e-9 else 0.5
        display_score = int(round(_DISPLAY_MIN + norm * (_DISPLAY_MAX - _DISPLAY_MIN)))
        ranked.append(
            {
                "id": candidate["id"],
                "rank_score": display_score,
                "features": feat,
            }
        )

    ranked.sort(key=lambda r: r["rank_score"], reverse=True)
    return {"ranked": ranked, "model_version": version}

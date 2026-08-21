"""
§6.4 LightGBM ranking — per-(requirement, candidate) feature extraction.

Builds the exact six-feature vector the master doc specifies:
HP delta, distance, price, availability match quality, equipment
rating/history, semantic match confidence.

Two of these are disclosed reductions here, in the same spirit as the
already-disclosed Phase 2/3 gaps (no Mapbox/PostGIS, no sentence-transformers):

- `distance`: Mapbox/PostGIS geocoding still isn't wired up — equipment rows
  only carry a free-text `location_label`, never a lat/lng (see
  AGRIRENT_AI_MASTER.md §0 STATUS, Phase 2 row, and `rulesFilter.js`'s own
  note on the same gap). There is no real distance to compute yet, so this
  feature is a constant neutral value for every candidate at serve time — it
  does not influence ranking order until real geocoding exists. The training
  data below still generates a *synthetic* distance feature so the model
  shape/weights are ready for that day; only the serve-time value is a stub.
- `equipment_rating`: no ratings/reviews system exists in the DB yet — always
  0.0 at serve time, exactly as §6.4 specifies for cold start ("Equipment
  rating/history (0 until real data exists)").

`semantic_confidence` defaults to 1.0 (exact taxonomy match) — nothing
upstream currently passes a lower value end-to-end. The Phase 3 semantic
matcher (`semantic_match.py`) already returns a confidence score when it
resolves an off-vocabulary LLM output; wiring that score through to this
endpoint (instead of discarding it after parse) is a small, contained
follow-up, not done in this pass so as not to touch the Phase 3 parse
response contract without a reason.
"""

from typing import Optional

FEATURE_NAMES = [
    "hp_delta_ratio",
    "distance",
    "price",
    "availability_quality",
    "equipment_rating",
    "semantic_confidence",
]

# Serve-time stand-in for the distance feature — see module docstring.
# Kept as a named constant (rather than a bare literal) so it's easy to find
# and replace once geocoding lands.
_DISTANCE_PLACEHOLDER = 0.5

# When an equipment_type has no hp_ranges data at all, don't reward or punish
# HP fit — treat it as a neutral midpoint rather than 0 (which would look
# like a "perfect" score) or 1 (which would look like the worst).
_HP_DELTA_NEUTRAL = 0.5


def build_compatibility_index(taxonomy: dict) -> dict:
    """equipment_type id -> its §3 compatibility row (operations/crops/hp_ranges)."""
    return {row["equipment_type"]: row for row in taxonomy.get("compatibility", [])}


def hp_target_for(equipment_type: str, acres: float, compatibility_index: dict) -> Optional[float]:
    """
    Midpoint HP of the taxonomy's hp_range bucket for this equipment_type at
    this land size — mirrors `rulesFilter.js`'s `hpRangeFor()` so the backend
    never derives a different "ideal HP" than the frontend's own filter did.
    """
    entry = compatibility_index.get(equipment_type)
    ranges = entry.get("hp_ranges") if entry else None
    if not ranges:
        return None
    sorted_ranges = sorted(ranges, key=lambda r: r["max_acres"])
    bucket = next((r for r in sorted_ranges if acres <= r["max_acres"]), sorted_ranges[-1])
    return (bucket["min_hp"] + bucket["max_hp"]) / 2


def extract_features(requirement: dict, candidate: dict, compatibility_index: dict) -> dict:
    """
    requirement: {crop, area_acres, operation, equipment_type}
    candidate: an equipment-like dict, already hard-filtered by §6.3 rules —
      expected keys: equipment_type, hp, price, plus optional
      is_available / availability_quality / semantic_confidence.
    """
    acres = requirement.get("area_acres") or 1
    hp_target = hp_target_for(candidate.get("equipment_type"), acres, compatibility_index)
    hp = candidate.get("hp")

    if hp_target and hp is not None and hp_target > 0:
        hp_delta_ratio = min(abs(hp_target - hp) / hp_target, 2.0)
    else:
        hp_delta_ratio = _HP_DELTA_NEUTRAL

    availability_quality = candidate.get("availability_quality")
    if availability_quality is None:
        availability_quality = 1.0 if candidate.get("is_available", True) else 0.0

    semantic_confidence = candidate.get("semantic_confidence")
    if semantic_confidence is None:
        semantic_confidence = 1.0

    return {
        "hp_delta_ratio": float(hp_delta_ratio),
        "distance": _DISTANCE_PLACEHOLDER,
        "price": float(candidate.get("price") or 0),
        "availability_quality": float(availability_quality),
        "equipment_rating": 0.0,
        "semantic_confidence": float(semantic_confidence),
    }

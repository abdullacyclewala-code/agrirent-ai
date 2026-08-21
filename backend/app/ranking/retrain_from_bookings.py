"""
Phase 5 — retrain the LightGBM ranker on REAL booking outcomes, replacing
`train_ranker.py`'s synthetic labels (§6.4's cold-start strategy) once
enough real data exists. Run manually:

    python -m app.ranking.retrain_from_bookings

WHY THIS IS GATED, NOT AUTOMATIC:
LambdaMART learns relative preference *within a group* — for this project, a
"group" is every booking that traces back to the same `requirement_id`
(§4.5's flow: one farmer requirement -> several ranked candidates -> the
farmer books one, or picks two over time if the first fell through). A group
only teaches the model anything when it has >= 2 resolved bookings with
different outcomes. Right now, most requirements only ever produce a single
booking, and `requirement_id` on bookings was actually NULL for every past
booking until this Phase 5 session wired it through from Recommendations.jsx
-> EquipmentDetails.jsx (see AGRIRENT_AI_MASTER.md §0 STATUS). So:

- Historical bookings (before this fix): no usable requirement_id, excluded.
- New bookings going forward: DO carry it, so real groups will accumulate
  over time as this gets used.

This script checks how much usable, multi-outcome data exists and REFUSES to
retrain (leaving the existing synthetic model in place) below a minimum
threshold, so a handful of test bookings can't quietly overwrite a
reasonable synthetic ranker with an overfit, near-meaningless one. Run it
again later once real usage has accumulated — it'll say clearly whether
there's now enough to retrain on.

LABELING (mirrors the retrain plan in backend/README.md):
- Completed              -> 4 (best outcome, the rental actually happened)
- Confirmed / In Use     -> 3 (owner said yes; not finished, but a positive signal)
- Rejected / Cancelled   -> 1 (didn't work out, but wasn't a straight loss to a competitor)
- Conflicted / Expired   -> 0 (worst — never even got a real decision)
- Requested              -> excluded (still unresolved, not a real outcome yet)
"""

import logging
import os
from collections import defaultdict
from typing import Dict, List, Optional

import joblib
import lightgbm as lgb
import numpy as np
import requests

from .features import FEATURE_NAMES, build_compatibility_index, extract_features
from .train_ranker import MODEL_VERSION as SYNTHETIC_MODEL_VERSION, _MODEL_PATH

logger = logging.getLogger("agrirent.ranking.retrain")

REAL_MODEL_VERSION = "phase5-real-v1"

# Below this many usable rows, or with zero multi-outcome groups, retraining
# would just be memorizing a handful of examples — refuse and keep the
# synthetic model instead. Tune this up as real usage grows; it's a floor,
# not a target.
_MIN_ROWS = 30
_MIN_MULTI_OUTCOME_GROUPS = 5

_OUTCOME_LABELS = {
    "Completed": 4,
    "Confirmed": 3,
    "In Use": 3,
    "Rejected": 1,
    "Cancelled": 1,
    "Conflicted": 0,
    "Expired": 0,
    # "Requested" deliberately omitted — not a resolved outcome yet.
}


def _fetch_resolved_bookings() -> Optional[List[dict]]:
    """
    Pulls every resolved booking with its equipment (equipment_type, hp,
    price) and linked requirement (parsed_json, for area_acres) via
    PostgREST resource embedding — same REST-with-service-role-key approach
    as notifications.py's token lookup, no new dependency.
    """
    supabase_url = os.getenv("SUPABASE_URL")
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_role_key:
        logger.error("retrain: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — can't fetch real bookings")
        return None

    statuses = ",".join(_OUTCOME_LABELS.keys())
    try:
        resp = requests.get(
            f"{supabase_url}/rest/v1/bookings",
            params={
                "select": "id,requirement_id,status,price,"
                "equipment:equipment_id(equipment_type,hp),"
                "requirement:requirement_id(parsed_json)",
                "status": f"in.({statuses})",
                "requirement_id": "not.is.null",
            },
            headers={"apikey": service_role_key, "Authorization": f"Bearer {service_role_key}"},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        logger.error("retrain: fetching bookings failed (%s)", e)
        return None


def _build_training_set(rows: List[dict], taxonomy: dict):
    """
    Groups rows by requirement_id, keeps only groups with >= 2 rows AND more
    than one distinct label (a group where every booking got the same
    outcome teaches LambdaMART nothing about relative preference). Returns
    (X, y, groups) in the same shape train_ranker.py's synthetic data uses,
    or (None, None, None) if nothing qualifies.
    """
    compatibility_index = build_compatibility_index(taxonomy)
    by_requirement: Dict[str, List[dict]] = defaultdict(list)

    for row in rows:
        status = row.get("status")
        label = _OUTCOME_LABELS.get(status)
        if label is None:
            continue

        requirement = row.get("requirement") or {}
        parsed = requirement.get("parsed_json") or {}
        equipment = row.get("equipment") or {}

        candidate = {
            "hp": equipment.get("hp"),
            "price": row.get("price"),
            "equipment_type": equipment.get("equipment_type"),
            "is_available": True,  # it was bookable at the time, by definition
        }
        req_features = {
            "area_acres": parsed.get("area_acres"),
            "equipment_type": equipment.get("equipment_type"),
        }
        feats = extract_features(req_features, candidate, compatibility_index)
        by_requirement[row["requirement_id"]].append({"features": feats, "label": label})

    rows_out, labels_out, groups_out = [], [], []
    qualifying_groups = 0
    for requirement_id, items in by_requirement.items():
        if len(items) < 2 or len({it["label"] for it in items}) < 2:
            continue  # no relative preference to learn from this group
        qualifying_groups += 1
        groups_out.append(len(items))
        for it in items:
            rows_out.append([it["features"][name] for name in FEATURE_NAMES])
            labels_out.append(it["label"])

    if qualifying_groups < _MIN_MULTI_OUTCOME_GROUPS or len(rows_out) < _MIN_ROWS:
        logger.info(
            "retrain: only %d usable rows across %d multi-outcome groups (need >= %d rows, >= %d groups) — "
            "not enough real data yet, keeping the synthetic model",
            len(rows_out), qualifying_groups, _MIN_ROWS, _MIN_MULTI_OUTCOME_GROUPS,
        )
        return None, None, None

    return np.array(rows_out, dtype=float), np.array(labels_out, dtype=int), groups_out


def retrain_from_real_data(taxonomy: dict) -> bool:
    """Returns True if a real-data model was trained and saved, False if it declined (not enough data) or failed."""
    rows = _fetch_resolved_bookings()
    if rows is None:
        return False

    X, y, groups = _build_training_set(rows, taxonomy)
    if X is None:
        return False

    train_set = lgb.Dataset(X, label=y, feature_name=FEATURE_NAMES)
    train_set.set_group(groups)
    params = {
        "objective": "lambdarank",
        "metric": "ndcg",
        "num_leaves": 15,
        "learning_rate": 0.05,
        "min_child_samples": 5,
        "verbosity": -1,
    }
    booster = lgb.train(params, train_set, num_boost_round=120)

    joblib.dump({"model": booster, "version": REAL_MODEL_VERSION, "features": FEATURE_NAMES}, _MODEL_PATH)
    logger.info(
        "retrain: trained on %d real rows across %d groups -> %s (was %s)",
        len(y), len(groups), REAL_MODEL_VERSION, SYNTHETIC_MODEL_VERSION,
    )
    return True


if __name__ == "__main__":
    import sys

    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
    logging.basicConfig(level=logging.INFO)
    from app.taxonomy import load_taxonomy  # local import: only needed for this manual entrypoint

    ok = retrain_from_real_data(load_taxonomy())
    print("Retrained on real data." if ok else "Not enough real data yet — synthetic model unchanged.")

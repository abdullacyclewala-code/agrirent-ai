"""
§6.4 cold-start strategy — train a LightGBM LambdaMART ranker on SYNTHETIC
data, since no real booking outcomes exist yet.

"Generate synthetic training data using rule-based heuristics (e.g.
closer+cheaper+better-HP-match = higher synthetic label) plus randomness,
and clearly label it synthetic in code/docs." — this file IS that label.
Every score `model.joblib` produces traces back to the heuristic below, NOT
to real farmer/owner behavior. Do not present its output as "AI-verified" —
it's a reasonable starting ranker, nothing more, until Phase 5 retraining.

Retrain plan (Phase 5, per master doc): once real bookings accumulate,
replace `_synthetic_dataset()` with a query over completed/cancelled
bookings (completed + no early cancellation = high relevance label;
rejected/cancelled = low), retrain on a periodic job (e.g. weekly cron), and
bump MODEL_VERSION so `/equipment/rank` responses make the switch visible.
Per §6.4: don't silently mix synthetic and real labels in one training run.

§6.5 "train offline (script, not real-time)": this module is run once at
process startup if no cached model exists yet (see `ranker_service.py`), not
per-request. Training ~4,000 synthetic rows takes well under a second, so a
lazy first-run cost is fine on Render's free tier and avoids committing a
binary model artifact to git.
"""

import logging
import os
import random

import joblib
import lightgbm as lgb
import numpy as np

from .features import FEATURE_NAMES

logger = logging.getLogger("agrirent.ranking")

MODEL_VERSION = "phase4-synthetic-v1"
_MODEL_PATH = os.path.join(os.path.dirname(__file__), "model.joblib")


def _synthetic_dataset(n_groups: int = 400, group_size_range=(3, 10), seed: int = 42):
    """
    One "group" = one simulated (requirement, candidate-set) search — mirrors
    how LightGBM's LambdaMART expects grouped/query-relative training data,
    matching how `/equipment/rank` is actually called (one requirement, many
    candidates, ranked relative to each other).
    """
    rng = random.Random(seed)
    rows, labels, groups = [], [], []

    for _ in range(n_groups):
        group_size = rng.randint(*group_size_range)
        groups.append(group_size)

        for _ in range(group_size):
            hp_delta_ratio = rng.uniform(0, 1.5)
            # Synthetic-only distance signal (0=nearby, 1=far) — at serve
            # time this feature is a constant placeholder until geocoding
            # exists (see features.py); the model still learns a sensible
            # weight for the day that becomes real.
            distance = rng.uniform(0, 1)
            price = rng.uniform(300, 3000)
            availability_quality = rng.choice([1.0, 1.0, 1.0, 0.5, 0.0])
            # Synthetic-only rating signal — real serving always sends 0.0
            # (cold start, §6.4), so this just gives the model a plausible
            # weight to fall back on once ratings exist.
            equipment_rating = rng.uniform(0, 1)
            semantic_confidence = rng.uniform(0.6, 1.0)

            # Heuristic "ground truth": closer + cheaper + better HP match +
            # available + higher-rated = more relevant. Weights are a
            # reasonable starting guess, not fit to any real data.
            relevance = (
                (1 - min(hp_delta_ratio, 1.5) / 1.5) * 0.35
                + (1 - distance) * 0.20
                + (1 - min(price, 3000) / 3000) * 0.15
                + availability_quality * 0.20
                + equipment_rating * 0.10
            )
            relevance += rng.uniform(-0.05, 0.05)  # small noise so it isn't a perfect function
            relevance = min(max(relevance, 0.0), 1.0)
            label = int(round(relevance * 4))  # 0-4 graded relevance, standard for LambdaMART

            rows.append(
                [hp_delta_ratio, distance, price, availability_quality, equipment_rating, semantic_confidence]
            )
            labels.append(label)

    return np.array(rows, dtype=float), np.array(labels, dtype=int), groups


def train_and_save():
    """
    Uses LightGBM's native `lgb.train()` API (not the `lightgbm.sklearn`
    wrapper) so the backend doesn't need scikit-learn/scipy as a dependency
    just to train a ranker — same reasoning as choosing Groq over a
    heavier stack elsewhere in this project: keep Render's free-tier
    footprint small. `lgb.Booster` is what gets cached and served.
    """
    X, y, groups = _synthetic_dataset()
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

    joblib.dump({"model": booster, "version": MODEL_VERSION, "features": FEATURE_NAMES}, _MODEL_PATH)
    logger.info("ranking: trained synthetic LambdaMART ranker -> %s", _MODEL_PATH)
    return booster


def load_or_train():
    """Load the cached model if present and readable, else train a fresh one."""
    if os.path.exists(_MODEL_PATH):
        try:
            bundle = joblib.load(_MODEL_PATH)
            return bundle["model"], bundle["version"]
        except Exception as e:
            logger.warning("ranking: cached model unreadable (%s) — retraining", e)
    ranker = train_and_save()
    return ranker, MODEL_VERSION


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    train_and_save()
    print(f"Trained and saved synthetic LightGBM ranker to {_MODEL_PATH}")

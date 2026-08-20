"""
Loads the SAME taxonomy.json the frontend uses (src/data/taxonomy.json),
so the backend never has a second, drifting copy of the allowed vocabulary.
Per master doc §3.2: taxonomy.json is imported into (a) DB, (b) frontend
dropdowns, (c) LLM system prompt. This module is (c).
"""

import json
import os
from functools import lru_cache

# backend/app/taxonomy.py -> repo root -> src/data/taxonomy.json
_TAXONOMY_PATH = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "src", "data", "taxonomy.json")
)


@lru_cache(maxsize=1)
def load_taxonomy() -> dict:
    with open(_TAXONOMY_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def allowed_vocab_lists(taxonomy: dict) -> dict:
    """Flat id lists for the three controlled vocabularies (what the LLM is allowed to output)."""
    return {
        "crops": [c["id"] for c in taxonomy["crops"]],
        "operations": [o["id"] for o in taxonomy["operations"]],
        "equipment_types": [e["id"] for e in taxonomy["equipment_types"]],
    }

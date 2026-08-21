"""
§6.2a — HTTP client for the multilingual semantic double-check Space.

Master doc: AGRIRENT_AI_MASTER.md, Phase 6 item 2. The actual embedding
model (`paraphrase-multilingual-MiniLM-L12-v2`) does NOT run in this
backend — it can't fit Render's 512MB free tier, same reason
`semantic_match.py` originally gave for using difflib instead of
`sentence-transformers` locally (see that file's Phase 3 docstring). It
runs in a separate service under `/hf-space-semantic` at the repo root,
deployed to a free Hugging Face Space (Docker SDK, 16GB free CPU RAM). This
module is the thin HTTP client `semantic_match.py` calls to reach it.

This is deliberately the ONLY file that knows the HF Space's HTTP shape —
`semantic_match.py` just gets back a (match, score) tuple, same shape as
its own difflib-based matching, so callers don't care which one answered.

Degrades gracefully by design, matching every other external call in this
project (LLM fallback chain in llm_service.py, ranking endpoint's client-side
fallback, push notifications no-op): if `HF_SPACE_URL` isn't set, or the
call errors, times out, or the Space is cold-starting past our timeout,
`hf_semantic_match()` returns None and the caller falls through to the
difflib last resort — this integration is never a hard dependency.
"""

import logging
import os
from typing import List, Optional, Tuple

import requests

logger = logging.getLogger("agrirent.multilingual_client")

HF_SPACE_URL = os.getenv("HF_SPACE_URL", "").rstrip("/")
HF_SPACE_API_TOKEN = os.getenv("HF_SPACE_API_TOKEN")

# Free HF Spaces sleep after inactivity; a cold call pays for both the Space
# waking up and (first boot only) the model already being cached on disk.
# 45s comfortably covers the documented 30-60s cold-start window (see
# hf-space-semantic/README.md "Cold starts") while still failing fast enough
# that a farmer isn't stuck waiting indefinitely before the difflib fallback
# kicks in.
HF_SPACE_TIMEOUT_S = int(os.getenv("HF_SPACE_TIMEOUT_S", "45"))

# Matches the Space's own default (see hf-space-semantic/app.py MatchIn) —
# repeated here explicitly so this client's behaviour doesn't silently
# depend on a default defined in a different service/repo folder.
DEFAULT_THRESHOLD = 0.55


def is_configured() -> bool:
    """Whether the HF Space integration is set up at all (Phase 6, optional)."""
    return bool(HF_SPACE_URL)


def hf_semantic_match(
    term: str, candidates: List[str], threshold: float = DEFAULT_THRESHOLD
) -> Optional[Tuple[Optional[str], float]]:
    """
    Ask the multilingual HF Space which of `candidates` best matches `term`.

    Returns:
    - None if the Space isn't configured (`HF_SPACE_URL` unset) or the call
      failed/timed out/errored — caller should fall back to difflib.
    - (matched_id_or_None, score) on a successful call. `matched_id_or_None`
      is None (not an exception) when the Space itself found nothing above
      threshold — that's a real, trustworthy "no confident match" answer per
      §6.2a step 5, distinct from "the Space was unreachable" above.
    """
    if not HF_SPACE_URL:
        return None
    if not term or not candidates:
        return None

    headers = {"Content-Type": "application/json"}
    if HF_SPACE_API_TOKEN:
        headers["X-API-Token"] = HF_SPACE_API_TOKEN

    try:
        resp = requests.post(
            f"{HF_SPACE_URL}/match",
            headers=headers,
            json={"term": term, "candidates": candidates, "threshold": threshold},
            timeout=HF_SPACE_TIMEOUT_S,
        )
        if not resp.ok:
            logger.warning(
                "[hf_space] HTTP %s for term=%r — falling back to difflib. Body: %s",
                resp.status_code,
                term,
                resp.text[:300],
            )
            return None
        body = resp.json()
        return body.get("best_match"), float(body.get("score", 0.0))
    except requests.RequestException as e:
        logger.warning(
            "[hf_space] Request failed for term=%r (%s) — falling back to difflib. "
            "This is expected occasionally on a cold Space; see hf-space-semantic/README.md.",
            term,
            e,
        )
        return None
    except (ValueError, TypeError) as e:
        logger.warning("[hf_space] Unexpected response shape for term=%r: %s", term, e)
        return None

"""
§6.2a — HTTP client for the multilingual semantic double-check.

Master doc: AGRIRENT_AI_MASTER.md, Phase 6 item 2 (superseded implementation
— see that item's changelog). The original Phase 6 pass ran the embedding
model (`paraphrase-multilingual-MiniLM-L12-v2`) in a separate, self-hosted
Hugging Face Space (Docker SDK) that this backend called over HTTP. That
service was replaced in a follow-up pass with a direct call to
**Cloudflare Workers AI**'s hosted `@cf/baai/bge-m3` model — no separate
service to deploy, cold-start, or keep alive: Cloudflare hosts and scales
the model, this backend just calls its REST API.

Why the swap (disclosed):
- The HF Space was a whole extra piece of infrastructure (its own Dockerfile,
  its own git remote, its own deploy step, its own cold-start/sleep
  behaviour on the free tier) just to serve one embedding model.
- BGE-M3 (BAAI) is a stronger multilingual embedding model than
  `paraphrase-multilingual-MiniLM-L12-v2` for this project's actual
  languages (English, Hindi, Marathi, and Hinglish/code-mixed text) and
  supports an 8,192-token context window.
- Cloudflare Workers AI's free allowance (10,000 Neurons/day) comfortably
  covers this project's low-volume "double-check on a farmer's requirement
  fields" use case, with no cold starts to plan around.

This module is deliberately the ONLY file that knows Cloudflare's HTTP
shape — `semantic_match.py` just gets back a (match, score) tuple, same
contract the old HF Space client returned, so callers don't care which
implementation answered.

Degrades gracefully by design, matching every other external call in this
project (LLM fallback chain in llm_service.py, ranking endpoint's
client-side fallback, push notifications no-op): if `CF_ACCOUNT_ID` /
`CF_API_TOKEN` aren't set, or the call errors or times out,
`cf_semantic_match()` returns None and the caller falls through to the
difflib last resort — this integration is never a hard dependency.
"""

import logging
import os
from typing import List, Optional, Tuple

import requests

logger = logging.getLogger("agrirent.cloudflare_client")

CF_ACCOUNT_ID = os.getenv("CF_ACCOUNT_ID", "")
CF_API_TOKEN = os.getenv("CF_API_TOKEN")

# `@cf/baai/bge-m3` — Multi-Functionality/Multi-Linguality/Multi-Granularity
# embeddings model, 100+ languages incl. Hindi/Marathi, 8k+ token context.
# Kept as an env var (not hardcoded) so it can be swapped without a code
# change, same pattern as GROQ_MODEL/GEMINI_MODEL in llm_service.py.
CF_BGE_MODEL = os.getenv("CF_BGE_MODEL", "@cf/baai/bge-m3")

CF_API_BASE = "https://api.cloudflare.com/client/v4"

# Cloudflare Workers AI is a hosted, always-on service (no cold starts to
# wait out, unlike the old free HF Space) — a short timeout is enough to
# fail fast to difflib on a genuine network hiccup without making a farmer
# wait on a stuck request.
CF_TIMEOUT_S = int(os.getenv("CF_TIMEOUT_S", "15"))

# Cosine-similarity cutoff for the Cloudflare step — kept as its own
# constant (rather than reusing semantic_match.py's difflib-scale
# SIMILARITY_THRESHOLD) since the two scores aren't on the same scale.
DEFAULT_THRESHOLD = 0.55


def is_configured() -> bool:
    """Whether the Cloudflare Workers AI integration is set up (Phase 6, optional)."""
    return bool(CF_ACCOUNT_ID and CF_API_TOKEN)


def cf_semantic_match(
    term: str, candidates: List[str], threshold: float = DEFAULT_THRESHOLD
) -> Optional[Tuple[Optional[str], float]]:
    """
    Ask Cloudflare Workers AI's BGE-M3 model which of `candidates` best
    matches `term`, using bge-m3's built-in query/contexts similarity mode
    (the model embeds `term` and every candidate and scores them directly —
    no separate embedding math needed on our side).

    Returns:
    - None if the integration isn't configured (`CF_ACCOUNT_ID`/
      `CF_API_TOKEN` unset) or the call failed/timed out/errored — caller
      should fall back to difflib.
    - (matched_id_or_None, score) on a successful call. `matched_id_or_None`
      is None (not an exception) when nothing scored above `threshold` —
      that's a real, trustworthy "no confident match" answer per §6.2a
      step 5, distinct from "the call was unreachable" above.
    """
    if not is_configured():
        return None
    if not term or not candidates:
        return None

    url = f"{CF_API_BASE}/accounts/{CF_ACCOUNT_ID}/ai/run/{CF_BGE_MODEL}"
    headers = {
        "Authorization": f"Bearer {CF_API_TOKEN}",
        "Content-Type": "application/json",
    }
    payload = {
        "query": term,
        "contexts": [{"text": c} for c in candidates],
        "truncate_inputs": True,
    }

    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=CF_TIMEOUT_S)
        if not resp.ok:
            logger.warning(
                "[cloudflare] HTTP %s for term=%r — falling back to difflib. Body: %s",
                resp.status_code,
                term,
                resp.text[:300],
            )
            return None

        body = resp.json()
        if not body.get("success", False):
            logger.warning(
                "[cloudflare] API reported failure for term=%r — falling back to difflib. Errors: %s",
                term,
                body.get("errors"),
            )
            return None

        scored = body.get("result", {}).get("response")
        if not scored:
            logger.warning(
                "[cloudflare] Unexpected response shape for term=%r: %s", term, body
            )
            return None

        best = max(scored, key=lambda r: r.get("score", 0.0))
        best_idx = int(best["id"])
        best_score = float(best["score"])

        if best_score >= threshold and 0 <= best_idx < len(candidates):
            return candidates[best_idx], best_score
        return None, best_score

    except requests.RequestException as e:
        logger.warning(
            "[cloudflare] Request failed for term=%r (%s) — falling back to difflib.",
            term,
            e,
        )
        return None
    except (ValueError, TypeError, KeyError) as e:
        logger.warning("[cloudflare] Unexpected response shape for term=%r: %s", term, e)
        return None

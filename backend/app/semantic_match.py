"""
§6.2 Semantic matching (fallback for vocabulary mismatch).

DEVIATION FROM MASTER DOC, Phase 3 (disclosed): §6.2 originally specced
`sentence-transformers` (`all-MiniLM-L6-v2`) running in-process with cosine
similarity. Phase 3 shipped without it — `sentence-transformers` pulls in
`torch` (~800MB+), which does not fit Render's 512MB free-tier backend and
would slow cold starts to the point of the service timing out on first
request. Phase 3 covered the gap with (1) the `synonyms` map already seeded
in `taxonomy.json` (exact regional-term lookup — "jotai" -> "ploughing",
etc.) and (2) stdlib `difflib.SequenceMatcher` lexical similarity as a last
resort.

PHASE 6 UPDATE (§6.2a): the real embedding model is now live — not in this
backend (still can't fit 512MB RAM), but as a direct call to **Cloudflare
Workers AI**'s hosted `@cf/baai/bge-m3` model, over HTTP via
`cloudflare_client.py`. (An earlier Phase 6 pass ran this via a self-hosted
Hugging Face Space instead; that extra service — its own Dockerfile, git
remote, deploy step, and cold-start/sleep behaviour — has been removed in
favour of calling Cloudflare's already-hosted model directly. BGE-M3 is
also a stronger multilingual model for this project's actual languages
(English, Hindi, Marathi, Hinglish) than the Space's MiniLM model was, and
Cloudflare's free allowance covers this project's volume with no cold
starts to plan around.) Per §6.2a, this isn't just a fallback for when the
LLM totally fails; it's a double-check on every LLM-produced field that
didn't already resolve via the free exact-match/synonym-map lookup below —
a low-confidence LLM guess on a dialectal Hindi/Marathi term can get
silently corrected before the farmer ever sees it. The synonym map and
difflib both stay exactly as they were: synonym lookup is still the free
first stop (most known regional terms are already listed there and don't
need a network call at all), and difflib is still the final resort if
Cloudflare Workers AI is unreachable, unconfigured, or the call fails —
same "always degrade gracefully, never hard-fail" pattern this project
uses for the LLM chain, the ranking endpoint, and push notifications.

Order (unchanged from the Phase 3 shape, one step inserted):
1. Exact taxonomy match (instant, free).
2. Synonym/alias map from taxonomy.json §3.1 (instant, free).
3. Cloudflare Workers AI (BGE-M3) semantic call (§6.2a) — only reached for
   terms that didn't resolve above; adds latency, handles dialectal
   Hindi/Marathi/Hinglish variance far better than difflib.
4. difflib lexical similarity — last resort if Cloudflare isn't configured
   (`CF_ACCOUNT_ID`/`CF_API_TOKEN` unset) or the call fails/times out.
"""

from difflib import SequenceMatcher
from typing import Optional

from .cloudflare_client import cf_semantic_match

# Below this lexical-similarity score, treat the term as unmatched rather
# than guessing (mirrors the §6.2 "below threshold -> ask farmer to clarify" rule,
# though for now we just null the field and let the farmer edit in the review step).
SIMILARITY_THRESHOLD = 0.6

# Cosine-similarity cutoff for the Cloudflare step — kept as its own
# constant (rather than reusing SIMILARITY_THRESHOLD) since cosine
# similarity and difflib's ratio() aren't the same scale; 0.55 mirrors
# `cloudflare_client.py`'s own default so behaviour matches if this
# constant and that default ever drift, whichever call path is actually
# taken is still coherent on its own.
CF_SIMILARITY_THRESHOLD = 0.55


def best_match(term: str, allowed: list[str], synonyms: dict) -> tuple[Optional[str], float]:
    """
    Resolve `term` (a value the LLM produced, or a raw word from the farmer's
    text) to the closest canonical id in `allowed`.

    Returns (matched_id_or_None, score). score is 1.0 for an exact taxonomy
    or synonym-map hit, Cloudflare's cosine similarity for a §6.2a semantic
    match, or the difflib similarity ratio as a last resort.
    """
    term = term.strip().lower().replace(" ", "_")

    # 1. Exact taxonomy match (already handled by caller, but safe to re-check).
    if term in allowed:
        return term, 1.0

    # 2. Synonym/alias map (§3.1) — regional terms mapped to canonical terms.
    #    Try both underscore and space variants since the map is authored with spaces.
    lookup_key = term.replace("_", " ")
    if lookup_key in synonyms:
        canonical = synonyms[lookup_key]
        if canonical in allowed:
            return canonical, 1.0
    if term in synonyms:
        canonical = synonyms[term]
        if canonical in allowed:
            return canonical, 1.0

    # 3. §6.2a Cloudflare Workers AI (BGE-M3) semantic double-check. Returns
    #    None (not a low score) when the integration isn't configured or the
    #    call failed — that's the signal to fall through to difflib below,
    #    as opposed to a real "the model checked and found nothing" answer.
    cf_result = cf_semantic_match(lookup_key, allowed, threshold=CF_SIMILARITY_THRESHOLD)
    if cf_result is not None:
        cf_match, cf_score = cf_result
        if cf_match is not None:
            return cf_match, cf_score
        # Cloudflare answered but found nothing above threshold — per §6.2a
        # step 5 this is a confident "no match," not a reason to guess via
        # difflib next. Fall through anyway with a difflib pass is still
        # useful as a safety net against a too-strict threshold on short/
        # noisy terms, so we don't return early here.

    # 4. Lexical similarity fallback (last resort — see module docstring).
    best_id, best_score = None, 0.0
    for candidate in allowed:
        score = SequenceMatcher(None, term, candidate).ratio()
        if score > best_score:
            best_id, best_score = candidate, score

    if best_score >= SIMILARITY_THRESHOLD:
        return best_id, best_score
    return None, best_score

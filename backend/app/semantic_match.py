"""
§6.2 Semantic matching (fallback for vocabulary mismatch).

DEVIATION FROM MASTER DOC (disclosed): §6.2 specs `sentence-transformers`
(`all-MiniLM-L6-v2`) embeddings with cosine similarity. This build instead
uses (1) the existing `synonyms` map already seeded in `taxonomy.json` (exact
regional-term lookup — "jotai" -> "ploughing", etc.) and (2) stdlib
`difflib.SequenceMatcher` lexical similarity as a second pass.

Why: `sentence-transformers` pulls in `torch` (~800MB+) which does not fit
Render's 512MB free-tier instance and would slow cold starts to the point of
the service timing out on first request — exactly the "always busy / stuck"
failure mode this project is trying to avoid for the LLM layer, just moved
into the ranking layer instead. The synonym map already covers the known
regional-term cases from §3.1, and difflib catches near-miss LLM typos
(e.g. "harvestin", "rotavetor"). This is a real scope reduction, not a silent
one — flagged here and in AGRIRENT_AI_MASTER.md STATUS.

Upgrade path (Phase 4/5, once a paid Render instance or a separate small
embedding-serving box is available): swap `best_match()`'s body for a real
`sentence-transformers` cosine-similarity lookup against cached taxonomy
embeddings, per the original §6.2 spec. The function signature below is
already shaped so that swap doesn't touch any caller.
"""

from difflib import SequenceMatcher
from typing import Optional

# Below this lexical-similarity score, treat the term as unmatched rather
# than guessing (mirrors the §6.2 "below threshold -> ask farmer to clarify" rule,
# though for now we just null the field and let the farmer edit in the review step).
SIMILARITY_THRESHOLD = 0.6


def best_match(term: str, allowed: list[str], synonyms: dict) -> tuple[Optional[str], float]:
    """
    Resolve `term` (a value the LLM produced, or a raw word from the farmer's
    text) to the closest canonical id in `allowed`.

    Returns (matched_id_or_None, score). score is 1.0 for an exact synonym-map
    hit, otherwise the difflib similarity ratio of the best candidate.
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

    # 3. Lexical similarity fallback (stand-in for embedding cosine-similarity).
    best_id, best_score = None, 0.0
    for candidate in allowed:
        score = SequenceMatcher(None, term, candidate).ratio()
        if score > best_score:
            best_id, best_score = candidate, score

    if best_score >= SIMILARITY_THRESHOLD:
        return best_id, best_score
    return None, best_score

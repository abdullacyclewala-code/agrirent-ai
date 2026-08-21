"""
AgriRent AI — multilingual semantic double-check service.

Master doc: AGRIRENT_AI_MASTER.md, Phase 6 item 2, role defined in §6.2a.
See README.md in this folder for the full picture (what this is, what it
isn't, deploy steps, cold-start behaviour).

One model (`paraphrase-multilingual-MiniLM-L12-v2`), one endpoint
(`POST /match`): embed `term`, embed each of `candidates`, return the
candidate with the highest cosine similarity plus that score. No taxonomy
knowledge lives here — the caller (backend/app/multilingual_client.py)
always supplies the exact candidate list, so this service stays a dumb,
reusable, language-aware similarity function and the taxonomy stays
single-sourced in src/data/taxonomy.json, per the project's existing
convention (see backend/app/taxonomy.py's docstring).
"""

import logging
import os
from typing import List, Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="%(levelname)s:%(name)s:%(message)s")
logger = logging.getLogger("agrirent.semantic_space")

MODEL_NAME = "paraphrase-multilingual-MiniLM-L12-v2"
API_TOKEN = os.getenv("API_TOKEN")  # optional shared secret, see README.md

app = FastAPI(title="AgriRent AI — Multilingual Semantic Match", version="1.0.0")

# Loaded lazily on first request rather than at import time so `GET /health`
# responds immediately even while the (first-boot-only) model download is
# still in progress, instead of the whole container failing to come up.
_model = None


def _get_model():
    global _model
    if _model is None:
        logger.info("Loading %s (first request since boot — this can take a while) ...", MODEL_NAME)
        from sentence_transformers import SentenceTransformer

        _model = SentenceTransformer(MODEL_NAME)
        logger.info("Model loaded.")
    return _model


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_NAME, "model_loaded": _model is not None}


class MatchIn(BaseModel):
    term: str = Field(..., min_length=1, max_length=200)
    candidates: List[str] = Field(..., min_length=1, max_length=200)
    threshold: float = Field(default=0.55, ge=0.0, le=1.0)


class MatchOut(BaseModel):
    best_match: Optional[str] = None
    score: float
    above_threshold: bool


@app.post("/match", response_model=MatchOut)
def match(payload: MatchIn, x_api_token: str = Header(default="")):
    """
    Embed `term` and every string in `candidates`, return the candidate with
    the highest cosine similarity to `term` plus that score. Callers pass
    taxonomy canonical ids as `candidates` — this endpoint has no taxonomy
    knowledge of its own (see module docstring).
    """
    if API_TOKEN and x_api_token != API_TOKEN:
        raise HTTPException(status_code=401, detail="invalid API token")

    model = _get_model()

    # sentence-transformers' util.cos_sim expects tensors; encoding term +
    # candidates together in one batch call is a lot cheaper than N calls.
    from sentence_transformers import util

    texts = [payload.term] + payload.candidates
    embeddings = model.encode(texts, convert_to_tensor=True, normalize_embeddings=True)
    term_embedding = embeddings[0]
    candidate_embeddings = embeddings[1:]

    scores = util.cos_sim(term_embedding, candidate_embeddings)[0]
    best_idx = int(scores.argmax())
    best_score = float(scores[best_idx])
    above_threshold = best_score >= payload.threshold

    return MatchOut(
        best_match=payload.candidates[best_idx] if above_threshold else None,
        score=best_score,
        above_threshold=above_threshold,
    )

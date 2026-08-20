"""
§6.1 LLM layer — free-text requirement parsing with a fallback chain.

DEVIATION FROM MASTER DOC (disclosed, per project convention of documenting
deviations rather than hiding them): the master doc specs Gemini as primary
and Groq as fallback. This build flips that order — Groq (llama-3.1-8b-instant)
primary, Gemini (gemini-2.5-flash-lite) fallback — because as of the Dec 2025
Gemini free-tier cuts, Gemini's free tier is now only 5-15 requests/minute and
100-1,000 requests/day, while Groq's free tier gives ~30 req/min with a high
tokens-per-minute ceiling on the 8B model and very low latency (LPU inference,
rarely "busy"). For a short structured-JSON extraction task like this one,
Groq is both faster and less likely to be rate-limited under real usage, so
it's the better primary. Gemini remains a genuinely independent second
provider (different infra, different outage domain) for the fallback slot.
If a third-party outage report changes this calculus later, swap the order
here — it's isolated to this one file.

Both providers are called with a strict JSON-only system prompt built from
the live taxonomy (§3), so the model is only ever asked to choose from real
crop/operation/equipment_type ids. If a provider returns a term that ISN'T in
the taxonomy, semantic_match.py (§6.2) tries to correct it before we give up
on that field.

If BOTH providers fail (network error, no API key configured, rate limit,
non-JSON response) we raise LLMAllProvidersFailed. The caller (main.py) turns
that into a 422 and the frontend's manual form (already built in Phase 2)
takes over — this path must always work per §4.5, independent of LLM uptime.
"""

import json
import logging
import os
import re
from typing import Optional

import requests

from .taxonomy import allowed_vocab_lists
from .semantic_match import best_match

logger = logging.getLogger("agrirent.llm_service")

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite")
GEMINI_URL = (
    f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
)

REQUEST_TIMEOUT_S = 12


class LLMAllProvidersFailed(Exception):
    pass


def _system_prompt(vocab: dict) -> str:
    # §6.1: system prompt includes the full allowed vocabulary and instructs
    # JSON-only output matching the exact shape.
    return (
        "You extract structured farming-job data from a farmer's free-text message. "
        "The farmer may write in English, Hindi, Marathi, or Hinglish (mixed/romanized). "
        "Respond with ONLY a JSON object, no markdown, no explanation, matching exactly this shape:\n"
        '{"crop": "string or null", "area_acres": number or null, '
        '"operation": "string", "equipment_type": "string or null"}\n\n'
        f"crop MUST be one of: {vocab['crops']} or null if not mentioned.\n"
        f"operation MUST be one of: {vocab['operations']}. This field is required — infer the "
        "most likely operation from context if not stated explicitly.\n"
        f"equipment_type MUST be one of: {vocab['equipment_types']}, or null if it can be "
        "inferred from the operation alone.\n"
        "area_acres is a plain number (convert hectares/bigha to acres if mentioned; 1 hectare "
        "= 2.47 acres). Use null if no land size is mentioned.\n"
        "If the farmer uses a regional/informal word you don't recognize, still pick your best "
        "guess from the allowed lists above — do not invent new vocabulary."
    )


def _extract_json_object(text: str) -> Optional[dict]:
    """Models sometimes wrap JSON in ```json fences or add stray text — pull the object out."""
    text = text.strip()
    fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence_match:
        text = fence_match.group(1)
    else:
        brace_match = re.search(r"\{.*\}", text, re.DOTALL)
        if brace_match:
            text = brace_match.group(0)
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None


def _call_groq(system_prompt: str, raw_text: str) -> Optional[dict]:
    if not GROQ_API_KEY:
        logger.warning("[groq] GROQ_API_KEY not set — skipping.")
        return None
    try:
        resp = requests.post(
            GROQ_URL,
            headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
            json={
                "model": GROQ_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": raw_text},
                ],
                "temperature": 0.1,
                "max_tokens": 300,
                "response_format": {"type": "json_object"},
            },
            timeout=REQUEST_TIMEOUT_S,
        )
        if not resp.ok:
            logger.error("[groq] HTTP %s: %s", resp.status_code, resp.text[:500])
            return None
        content = resp.json()["choices"][0]["message"]["content"]
        parsed = _extract_json_object(content)
        if parsed is None:
            logger.error("[groq] Could not parse JSON from model output: %r", content[:500])
        return parsed
    except requests.RequestException as e:
        logger.error("[groq] Request failed: %s", e)
        return None
    except (KeyError, IndexError) as e:
        logger.error("[groq] Unexpected response shape: %s — body: %r", e, resp.text[:500] if 'resp' in dir() else "?")
        return None


def _call_gemini(system_prompt: str, raw_text: str) -> Optional[dict]:
    if not GEMINI_API_KEY:
        logger.warning("[gemini] GEMINI_API_KEY not set — skipping.")
        return None
    try:
        resp = requests.post(
            f"{GEMINI_URL}?key={GEMINI_API_KEY}",
            json={
                "contents": [{"parts": [{"text": raw_text}]}],
                "systemInstruction": {"parts": [{"text": system_prompt}]},
                "generationConfig": {
                    "temperature": 0.1,
                    "maxOutputTokens": 300,
                    "responseMimeType": "application/json",
                },
            },
            timeout=REQUEST_TIMEOUT_S,
        )
        if not resp.ok:
            logger.error("[gemini] HTTP %s: %s", resp.status_code, resp.text[:500])
            return None
        content = resp.json()["candidates"][0]["content"]["parts"][0]["text"]
        parsed = _extract_json_object(content)
        if parsed is None:
            logger.error("[gemini] Could not parse JSON from model output: %r", content[:500])
        return parsed
    except requests.RequestException as e:
        logger.error("[gemini] Request failed: %s", e)
        return None
    except (KeyError, IndexError) as e:
        logger.error("[gemini] Unexpected response shape: %s — body: %r", e, resp.text[:500] if 'resp' in dir() else "?")
        return None


def parse_requirement_via_llm(raw_text: str, language: Optional[str], taxonomy: dict) -> dict:
    vocab = allowed_vocab_lists(taxonomy)
    system_prompt = _system_prompt(vocab)

    provider_used = None
    parsed = _call_groq(system_prompt, raw_text)
    if parsed is not None:
        provider_used = "groq"
    else:
        parsed = _call_gemini(system_prompt, raw_text)
        if parsed is not None:
            provider_used = "gemini"

    if parsed is None:
        raise LLMAllProvidersFailed(
            "Both Groq and Gemini were unreachable or returned unusable output."
        )

    # §6.2: if the model output a term outside the taxonomy (despite instructions),
    # or the raw text itself uses a regional synonym the model missed, run it through
    # the lexical semantic-match fallback before accepting/rejecting the field.
    confidence_notes = []
    corrected = dict(parsed)

    for field, allowed in (
        ("crop", vocab["crops"]),
        ("operation", vocab["operations"]),
        ("equipment_type", vocab["equipment_types"]),
    ):
        value = corrected.get(field)
        if value is None:
            continue
        value = str(value).strip().lower().replace(" ", "_")
        if value in allowed:
            corrected[field] = value
            continue
        match, score = best_match(value, allowed, taxonomy.get("synonyms", {}))
        if match:
            corrected[field] = match
            confidence_notes.append(
                f"'{parsed.get(field)}' matched to '{match}' (semantic fallback, score {score:.2f})"
            )
        else:
            corrected[field] = None
            confidence_notes.append(
                f"Could not confidently match '{parsed.get(field)}' for {field} — left blank."
            )

    # operation is required by schema — if we still don't have one, this parse is unusable.
    if not corrected.get("operation"):
        raise LLMAllProvidersFailed(
            "LLM response did not resolve to a valid operation even after semantic fallback."
        )

    area = corrected.get("area_acres")
    try:
        corrected["area_acres"] = float(area) if area is not None else None
    except (TypeError, ValueError):
        corrected["area_acres"] = None

    return {
        "crop": corrected.get("crop"),
        "area_acres": corrected.get("area_acres"),
        "operation": corrected.get("operation"),
        "equipment_type": corrected.get("equipment_type"),
        "provider_used": provider_used,
        "confidence_notes": confidence_notes,
    }

"""
§6.1 LLM layer — free-text requirement parsing with a fallback chain.

DEVIATION FROM MASTER DOC (disclosed, per project convention of documenting
deviations rather than hiding them): the master doc specs Gemini as primary
and Groq as fallback. This build flips that order — Groq primary, Gemini
fallback — because Groq's free tier gives ~30 req/min with a high
tokens-per-minute ceiling and very low latency (LPU inference, rarely
"busy"), while Gemini's free tier has been repeatedly cut and is more
restrictive (5-15 req/min, 100-1,000 req/day as of late 2025/early 2026).
For a short structured-JSON extraction task like this one, Groq is both
faster and less likely to be rate-limited under real usage, so it's the
better primary. Gemini remains a genuinely independent second provider
(different infra, different outage domain) for the fallback slot.

MODEL NAMES CHANGE OVER TIME — both providers retire models on their own
schedule (Groq deprecated `llama-3.1-8b-instant` in favor of
`openai/gpt-oss-20b`; Google retired `gemini-2.5-flash-lite` in favor of
`gemini-3.5-flash-lite`, discovered via a live 404 during Phase 3 testing).
The defaults below are current as of this commit, driven by env vars
(GROQ_MODEL / GEMINI_MODEL) so they can be swapped without a code change —
check Render logs for `ERROR:agrirent.llm_service:[groq|gemini]` if either
provider starts 404ing again; the error body names the correct replacement.
If a third-party outage report changes the provider-order calculus later,
that's isolated to this one file too.

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
from datetime import date, datetime, timedelta, timezone
from typing import Optional

import requests

from .taxonomy import allowed_vocab_lists
from .semantic_match import best_match

logger = logging.getLogger("agrirent.llm_service")

# Farmers are in India — relative dates ("tomorrow", "next Monday") in the
# prompt resolve against IST, not server-local time (Render runs on UTC).
IST = timezone(timedelta(hours=5, minutes=30))

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
GEMINI_URL = (
    f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
)

REQUEST_TIMEOUT_S = 12


class LLMAllProvidersFailed(Exception):
    pass


def _system_prompt(vocab: dict, synonyms: dict, today_ist: date) -> str:
    # §6.1: system prompt includes the full allowed vocabulary and instructs
    # JSON-only output matching the exact shape.
    # Also inject the known regional-term synonym map (§3.1) directly, since
    # testing showed the model will otherwise guess wrong on terms it hasn't
    # reliably memorized (e.g. "jotai" -> misread as sowing instead of ploughing).
    synonym_lines = "\n".join(f'- "{term}" means "{canon}"' for term, canon in synonyms.items())
    return (
        "You extract structured farming-job data from a farmer's free-text message. "
        "The farmer may write in English, Hindi, Marathi, or Hinglish (mixed/romanized). "
        f"Today's date is {today_ist.isoformat()} ({today_ist.strftime('%A')}). "
        "Respond with ONLY a JSON object, no markdown, no explanation, matching exactly this shape:\n"
        '{"crop": "string or null", "area_acres": number or null, '
        '"operation": "string or null", "equipment_type": "string or null", '
        '"location_text": "string or null", "needed_date": "YYYY-MM-DD string or null"}\n\n'
        f"crop MUST be one of: {vocab['crops']} or null if not mentioned.\n"
        f"operation MUST be one of: {vocab['operations']}, or null if the message says nothing "
        "about what work is needed (greetings, equipment-only requests like \"need a tractor\"). "
        "Prefer a real inference when the context hints at the work "
        "(e.g. \"cut my wheat\" -> harvesting).\n"
        f"equipment_type MUST be one of: {vocab['equipment_types']}, or null if it can be "
        "inferred from the operation alone.\n"
        "area_acres is a plain number (convert hectares/bigha to acres if mentioned; 1 hectare "
        "= 2.47 acres). Use null if no land size is mentioned.\n"
        "location_text is the village/town/city/area the farmer mentions — copy their words "
        "exactly, in the original script (e.g. \"Nashik\", \"नाशिक\", \"near Shirdi\"). "
        "Use null if no place is mentioned.\n"
        "needed_date is the date the farmer needs the equipment, resolved against today's date "
        "above: \"tomorrow\" means the next day, \"next Monday\" the coming Monday, \"15 September\" "
        "the nearest future one. ALWAYS output YYYY-MM-DD exactly (e.g. \"2026-09-20\"). "
        "Use null if no date is mentioned, or if the resolved date would be in the past.\n\n"
        "Known regional/informal terms — use these exact mappings whenever one appears "
        "in the farmer's text, they are NOT guesses:\n"
        f"{synonym_lines}\n\n"
        "If the farmer uses a regional/informal word not in the list above, still pick your best "
        "guess from the allowed lists above — do not invent new vocabulary."
    )


_NEEDED_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_LOCATION_MAX_LEN = 120
# Dates further out than this are almost certainly model error ("2099") rather
# than real farm planning — reject them so the farmer picks a date manually.
_NEEDED_DATE_MAX_DAYS_OUT = 730


def _clean_location_text(value) -> Optional[str]:
    """Free-form place name, copied as written. Empty/blank -> None."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    return text[:_LOCATION_MAX_LEN]


def _clean_needed_date(value, today: date) -> Optional[str]:
    """Strict ISO date within [today, today+730d]. Anything else -> None."""
    if not isinstance(value, str):
        return None
    match = _NEEDED_DATE_RE.match(value.strip())
    if not match:
        return None
    try:
        parsed = date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None  # e.g. month 13, Feb 30
    if parsed < today:
        return None
    if (parsed - today).days > _NEEDED_DATE_MAX_DAYS_OUT:
        return None
    return parsed.isoformat()


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
                "max_tokens": 400,
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
                    "maxOutputTokens": 400,
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
    today_ist = datetime.now(IST).date()
    system_prompt = _system_prompt(vocab, taxonomy.get("synonyms", {}), today_ist)

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

    # NOTE (smart-routing change): operation used to be required here — a parse
    # without one raised LLMAllProvidersFailed (HTTP 422). It is now nullable:
    # a partial parse (e.g. crop only) is still useful, because the frontend
    # asks targeted follow-up questions for exactly the missing slots instead
    # of throwing the whole parse away. 422 now means ONLY "both providers
    # unreachable/unusable" (raised above), and the frontend's §4.5 manual
    # fallback still triggers on that.
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
        # New free-form slots (absent/None on old model outputs — callers must
        # treat them as optional, see ParseRequirementOut).
        "location_text": _clean_location_text(corrected.get("location_text")),
        "needed_date": _clean_needed_date(corrected.get("needed_date"), today_ist),
        "provider_used": provider_used,
        "confidence_notes": confidence_notes,
    }

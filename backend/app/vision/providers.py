"""
Phase 7 — vision provider chain.

Same philosophy as app/llm_service.py (text parsing): try providers in order,
degrade to the next, and never let an AI outage break the user's flow. The
difference is that this chain handles IMAGES, and the last resort is not a
manual form but the deterministic signal pack in signals.py — which is why an
unconfigured deployment still produces a real, useful report.

Provider order (env `VISION_PROVIDER_ORDER`, default "gemini,groq,cloudflare"):
  1. Gemini  — the strongest at reading a specific small detail ("is that a new
     crack?") and the only one here that is comfortable returning strict JSON.
  2. Groq    — very low latency (LPU), independent infrastructure; the same
     Llama-4 scout vision model family the text side already relies on.
  3. Cloudflare Workers AI — already configured for BGE-M3 embeddings; the
     smallest models, so it is the last resort before "no AI".

Everything is env-driven because vision model IDs churn (this project has
already been burned once by a retired Gemini model name — see llm_service.py).
If a provider starts 404-ing, set the *_VISION_MODEL env var on Render; no
deploy needed.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
from typing import Any, Optional

import requests

logger = logging.getLogger("agrirent.vision.providers")

REQUEST_TIMEOUT_S = 30  # images are slower than the text parse path

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_VISION_MODEL = os.getenv("GEMINI_VISION_MODEL", os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite"))

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_VISION_MODEL = os.getenv("GROQ_VISION_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

CF_ACCOUNT_ID = os.getenv("CF_ACCOUNT_ID")
CF_API_TOKEN = os.getenv("CF_API_TOKEN")
CF_VISION_MODEL = os.getenv("CF_VISION_MODEL", "@cf/meta/llama-3.2-11b-vision-instruct")

DEFAULT_ORDER = os.getenv("VISION_PROVIDER_ORDER", "gemini,groq,cloudflare")


class VisionUnavailable(Exception):
    """No provider produced a usable answer. Callers fall back to the
    deterministic signals, not to an error page."""


def configured_providers() -> list[str]:
    """Which providers have credentials on this deployment."""
    out = []
    if GEMINI_API_KEY:
        out.append("gemini")
    if GROQ_API_KEY:
        out.append("groq")
    if CF_ACCOUNT_ID and CF_API_TOKEN:
        out.append("cloudflare")
    return out


def _extract_json(text: str) -> Optional[dict]:
    """Models still wrap JSON in prose or fences — pull the object out."""
    if not text:
        return None
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    else:
        brace = re.search(r"\{.*\}", text, re.DOTALL)
        if brace:
            text = brace.group(0)
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except (json.JSONDecodeError, TypeError):
        return None


def _call_gemini(images: list[bytes], prompt: str) -> Optional[str]:
    if not GEMINI_API_KEY:
        return None
    parts: list[dict[str, Any]] = [{"text": prompt}]
    for image in images:
        parts.append({
            "inline_data": {
                "mime_type": "image/jpeg",
                "data": base64.b64encode(image).decode("ascii"),
            }
        })
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_VISION_MODEL}:generateContent"
    try:
        resp = requests.post(
            f"{url}?key={GEMINI_API_KEY}",
            json={
                "contents": [{"parts": parts}],
                "generationConfig": {"temperature": 0.1, "maxOutputTokens": 1200,
                                     "responseMimeType": "application/json"},
            },
            timeout=REQUEST_TIMEOUT_S,
        )
        if not resp.ok:
            logger.error("[gemini-vision] HTTP %s: %s", resp.status_code, resp.text[:400])
            return None
        return resp.json()["candidates"][0]["content"]["parts"][0]["text"]
    except (requests.RequestException, KeyError, IndexError) as exc:
        logger.error("[gemini-vision] failed: %s", exc)
        return None


def _call_groq(images: list[bytes], prompt: str) -> Optional[str]:
    if not GROQ_API_KEY:
        return None
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for image in images:
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:image/jpeg;base64,{base64.b64encode(image).decode('ascii')}"},
        })
    try:
        resp = requests.post(
            GROQ_URL,
            headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
            json={
                "model": GROQ_VISION_MODEL,
                "messages": [{"role": "user", "content": content}],
                "temperature": 0.1,
                "max_tokens": 1200,
            },
            timeout=REQUEST_TIMEOUT_S,
        )
        if not resp.ok:
            logger.error("[groq-vision] HTTP %s: %s", resp.status_code, resp.text[:400])
            return None
        return resp.json()["choices"][0]["message"]["content"]
    except (requests.RequestException, KeyError, IndexError) as exc:
        logger.error("[groq-vision] failed: %s", exc)
        return None


def _call_cloudflare(images: list[bytes], prompt: str) -> Optional[str]:
    """Workers AI takes ONE image per call. Multiple images are handled by
    asking the model about them in sequence and concatenating — the compare
    path therefore prefers Gemini/Groq and only reaches here as a fallback."""
    if not (CF_ACCOUNT_ID and CF_API_TOKEN):
        return None
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai/run/{CF_VISION_MODEL}"
    answers: list[str] = []
    try:
        for image in images:
            resp = requests.post(
                url,
                headers={"Authorization": f"Bearer {CF_API_TOKEN}"},
                json={"image": list(image), "prompt": prompt},
                timeout=REQUEST_TIMEOUT_S,
            )
            if not resp.ok:
                logger.error("[cf-vision] HTTP %s: %s", resp.status_code, resp.text[:400])
                return None
            body = resp.json()
            text = (body.get("result") or {}).get("response") or (body.get("result") or {}).get("description")
            if not text:
                logger.error("[cf-vision] unexpected body: %s", str(body)[:400])
                return None
            answers.append(text)
        return answers[0] if len(answers) == 1 else "\n".join(answers)
    except (requests.RequestException, KeyError, TypeError) as exc:
        logger.error("[cf-vision] failed: %s", exc)
        return None


_PROVIDERS = {
    "gemini": _call_gemini,
    "groq": _call_groq,
    "cloudflare": _call_cloudflare,
}


# ---------------------------------------------------------------------------
# Output language
# ---------------------------------------------------------------------------
# The UI is fully translated (en/hi/mr), so the AI's *human-readable* text has
# to arrive in the same language or the report page reads half-English. The
# frontend sends its current language with the analyze request and we append
# one instruction to whichever prompt is being used.
#
# Codes and enum tokens are deliberately NOT translated: `kind`, `severity`,
# flag codes and check codes are a shared vocabulary between this service, the
# database and the UI's own translations. Translating them would silently break
# every lookup downstream, so the instruction says so explicitly.

LANGUAGE_NAMES = {
    "en": "English",
    "hi": "Hindi (written in Devanagari script)",
    "mr": "Marathi (written in Devanagari script)",
}


def output_language_line(lang: Optional[str]) -> str:
    """Instruction appended to a prompt so free text comes back in `lang`.

    Returns "" for anything unrecognised — an unknown language must degrade to
    today's behaviour (English free text), never to a broken request.
    """
    name = LANGUAGE_NAMES.get((lang or "").strip().lower())
    if not name:
        return ""
    return (
        f"\n\nWrite every human-readable text value in {name}: part names, "
        "descriptions, notes, wear-and-tear items and any narrative sentence. "
        "Keep every key, code and enum token exactly as specified above, in "
        "English — those are shared identifiers and must not be translated."
    )


def vision_json(images: list[bytes], prompt: str) -> dict[str, Any]:
    """
    Run the chain and return {provider, data}. Raises VisionUnavailable when
    every configured provider fails — callers must treat that as "no AI today",
    never as "no report today".
    """
    order = [p.strip() for p in DEFAULT_ORDER.split(",") if p.strip()] or ["gemini", "groq", "cloudflare"]
    attempts: list[str] = []

    for name in order:
        fn = _PROVIDERS.get(name)
        if fn is None:
            continue
        raw = fn(images, prompt)
        if not raw:
            attempts.append(f"{name}:error")
            continue
        data = _extract_json(raw)
        if data is None:
            attempts.append(f"{name}:unparsable")
            logger.error("[vision] %s returned unparsable output: %r", name, raw[:300])
            continue
        return {"provider": name, "data": data}

    raise VisionUnavailable(f"no vision provider succeeded (attempts: {', '.join(attempts) or 'none configured'})")


# ---------------------------------------------------------------------------
# Prompts — deliberately narrow, and the same "only describe what you see"
# discipline the rest of this project uses for LLM output.
# ---------------------------------------------------------------------------

PHOTO_PROMPT = """You are inspecting ONE photo for a farm-equipment rental condition report in India.

Equipment: {equipment}
This photo is meant to show: {slot_hint}
The app stamped this text into the photo's pixels when it was taken: {watermark}

Report ONLY what you can actually see. If the photo does not show machinery, say so.
Never guess a number you cannot read. Use low confidence instead of inventing detail.

Return ONLY this JSON object:
{{
  "shows_equipment": true|false,
  "quality": {{"framing": "good|partial|poor", "issues": ["blurry","too_dark","too_far","obstructed",...]}},
  "watermark": {{"readable": true|false, "text": "the stamp text you can read, or null", "code": "the AR-XXXXXXXX code if visible, or null"}},
  "parts_visible": ["engine","tyres","implement","hour_meter",...],
  "meter": {{"visible": true|false, "value": number|null, "unit": "hours|km|unknown"}},
  "damage": [
    {{
      "part": "e.g. left rear tyre",
      "kind": "scratch|dent|crack|tyre|leak|rust|missing_part|other",
      "severity": "minor|moderate|major",
      "description": "one short factual sentence",
      "confidence": 0.0-1.0
    }}
  ],
  "wear_and_tear": ["dust","minor scratches",...],
  "notes": "one short sentence, or null"
}}"""

COMPARE_PROMPT = """You are comparing TWO photos of the SAME view of a farm machine: BEFORE (image 1, at handover) and AFTER (image 2, at return).

Slot being compared: {slot_hint}
Equipment: {equipment}
Damage already known and accepted BEFORE this rental (never count these as new):
{known_damage}
This text was stamped into both photos when they were taken: {watermark}

Be conservative. Damage visible in BOTH images is NOT new. Normal field wear (dust, mud, minor scratches, tread wear) is NOT chargeable damage. If a difference could be lighting, angle or dirt, say so in the notes and lower the confidence.

Return ONLY this JSON object:
{{
  "new_damage": [
    {{"part":"...","kind":"scratch|dent|crack|tyre|leak|rust|missing_part|other",
      "severity":"minor|moderate|major","description":"...","confidence":0.0-1.0}}
  ],
  "worsened": [{{"part":"...","description":"...","confidence":0.0-1.0}}],
  "unchanged": ["..."],
  "wear_and_tear": ["..."],
  "meter_delta_readable": true|false,
  "confidence": 0.0-1.0,
  "recommended_action": "no_claim|review|claim",
  "narrative": "2-3 plain sentences a farmer can understand, in English"
}}"""

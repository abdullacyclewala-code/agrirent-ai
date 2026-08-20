// Phase 3 — client for the FastAPI backend's LLM free-text parsing endpoint.
// Master doc §6.1 + §4.5: "Both LLM providers fail -> fall back to manual
// structured form; this path must always work independently of LLM uptime."
// This module NEVER throws in a way that blocks the form — callers should
// always be prepared for `null` back and fall through to the manual wizard
// steps that already exist from Phase 2.

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL;

// Render's free tier cold-starts after idling (~30-50s). Give it real room
// before giving up, so a farmer's first request of the day doesn't fail
// needlessly and fall back to manual entry when the LLM would've worked fine.
const TIMEOUT_MS = 45000;

/**
 * @param {string} rawText - the farmer's free-text job description
 * @param {string} language - "en" | "hi" | "mr" | "hinglish" | "auto"
 * @returns {Promise<{crop, area_acres, operation, equipment_type, provider_used, confidence_notes}|null>}
 *   null means: LLM path unavailable — caller should fall back to the manual form.
 */
export async function parseRequirementFreeText(rawText, language = "auto") {
  if (!BACKEND_URL) {
    console.warn("[llmClient] VITE_BACKEND_URL not set — skipping LLM parse, using manual form.");
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${BACKEND_URL}/requirements/parse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raw_text: rawText, language }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // 422 = both providers failed (per backend contract) — expected fallback path, not an error to alarm over.
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn("[llmClient] LLM parse request failed, falling back to manual form:", err.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

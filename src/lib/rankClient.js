// Phase 4 — client for the FastAPI backend's LightGBM ranking endpoint.
// Master doc §6.4/§6.5 + §4.5's "must always work independently of uptime"
// pattern, same shape as llmClient.js: this NEVER throws in a way that
// blocks the results screen — callers should always be prepared for `null`
// back and keep using the Phase 2 heuristic score that rulesFilter.js
// already computed (see DescribeJob.jsx submit()).

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL;

// Same generous timeout as llmClient.js — Render's free tier cold-starts
// after idling, and ranking piggybacks on the same backend instance.
const TIMEOUT_MS = 45000;

/**
 * @param {{crop:string|null, area_acres:number|null, operation:string, equipment_type?:string|null}} requirement
 * @param {Array} candidates - rules-filtered equipment rows (already passed §6.3).
 *   Only the fields the ranker actually uses are sent (id, equipment_type,
 *   hp, price, is_available, availability_quality) — no need to ship the
 *   whole row over the wire.
 * @returns {Promise<Map<number, {rank_score:number, features:object}>|null>}
 *   null means: ranking endpoint unavailable — caller should keep the
 *   existing heuristic `matchScore` values untouched.
 */
export async function rankCandidates(requirement, candidates) {
  if (!BACKEND_URL || !candidates?.length) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${BACKEND_URL}/equipment/rank`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requirement: {
          crop: requirement.crop ?? null,
          area_acres: requirement.area_acres ?? null,
          operation: requirement.operation,
          equipment_type: requirement.equipment_type ?? null,
        },
        candidates: candidates.map((c) => ({
          id: c.id,
          equipment_type: c.equipment_type,
          hp: c.hp ?? null,
          price: c.price ?? null,
          is_available: c.is_available ?? true,
          availability_quality: c.availability_quality ?? null,
        })),
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null; // expected fallback path, not an error to alarm over

    const data = await res.json();
    const byId = new Map();
    for (const r of data.ranked || []) byId.set(r.id, r);
    return byId;
  } catch (err) {
    console.warn("[rankClient] ranking request failed, keeping heuristic scores:", err.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

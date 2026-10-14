// Phase 7 — the frontend's door to the trust-layer backend.
//
// The backend does three things the browser cannot: verify the bytes it
// actually received, hold vision-model credentials, and read evidence across
// bookings. This module asks for those, and — critically — DEGRADES instead of
// failing. If the backend is unreachable (Render cold start, offline field,
// no keys configured), `localSignals()` still produces an honest signal pack
// and verdict in the browser, so a report is never left blank.

import { supabase } from "./supabase.js";
import { POLICY, POLICY_VERSION, verdictFor, FLAGS, isFatalFlag } from "./depositPolicy.js";
import { hammingDistance, haversineKm } from "./inspectionCapture.js";

const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL || "").replace(/\/+$/, "");

let _config = null;

export function isBackendConfigured() {
  return Boolean(BACKEND_URL);
}

/** What this deployment can do. Cached for the session; `force` re-reads. */
export async function getVerificationConfig({ force = false } = {}) {
  if (_config && !force) return _config;
  if (!BACKEND_URL) {
    _config = {
      reachable: false,
      storage_access: true, // the browser can always write to the bucket itself
      vision: { enabled: false, providers_configured: [], models: {} },
      auth_validation: false,
      policy_version: POLICY_VERSION,
    };
    return _config;
  }
  try {
    const resp = await fetch(`${BACKEND_URL}/verification/config`, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    _config = { reachable: true, ...(await resp.json()) };
  } catch {
    _config = {
      reachable: false,
      storage_access: true,
      vision: { enabled: false, providers_configured: [], models: {} },
      auth_validation: false,
      policy_version: POLICY_VERSION,
    };
  }
  return _config;
}

async function authHeaders() {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

async function post(path, body, timeoutMs) {
  const headers = { "Content-Type": "application/json", ...(await authHeaders()) };
  const resp = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`backend ${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

/** Downscale + base64 for the no-service-key path. Reuses the browser's own
 *  decoder so the bytes sent are the bytes hashed. */
async function inlineFrom(photo) {
  if (!photo?.blob) return photo?.inline_b64 || null;
  const buf = await photo.blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Ask the backend to analyse a report.
 *
 * `photos` are the capture results (with blobs); `report` is the DB row, so
 * the backend knows the booking/equipment/code without a second lookup.
 */
export async function analyzeReport({ report, booking, equipment, photos, beforePhotos = [], knownDamage = [], signedBy = 0, chainIntact = null, timeoutMs = 60000 }) {
  const config = await getVerificationConfig();
  if (!config.reachable) {
    return { ...localSignals({ photos, knownDamage, signedBy, chainIntact, equipment }), backend: "unreachable" };
  }

  // With a service key the backend reads the bucket itself; without one it
  // needs the bytes, so we send downscaled copies (never the originals twice).
  const needsInline = config.storage_access === false;
  const photoPayload = [];
  for (const p of photos) {
    photoPayload.push({
      slot: p.slot,
      storage_path: p.storage_path || null,
      inline_b64: needsInline ? await inlineFrom(p) : undefined,
      sha256: p.sha256,
      dhash: p.dhash,
      exif: p.exif || null,
      gps: p.gps || null,
      captured_at_device: p.captured_at_device,
      tz_offset_minutes: p.exif?.tz_offset_minutes ?? null,
      watermark_text: p.watermark_text,
      quality: p.quality || null,
      damage_labels: p.damage_labels || [],
    });
  }

  const beforePayload = [];
  for (const p of beforePhotos) {
    beforePayload.push({
      slot: p.slot,
      storage_path: p.storage_path,
      inline_b64: needsInline ? await inlineFrom(p) : undefined,
      dhash: p.dhash,
      ai: p.ai || null,
      watermark_text: p.watermark_text,
      captured_at_device: p.captured_at_device,
    });
  }

  try {
    const result = await post("/verification/analyze", {
      booking_id: booking.id,
      report_id: report.id,
      kind: report.kind,
      report_code: report.report_code,
      equipment: {
        id: equipment?.id ?? booking.equipment_id,
        name: equipment?.name,
        type: equipment?.equipment_type,
        lat: equipment?.latitude ?? null,
        lng: equipment?.longitude ?? null,
      },
      policy: {
        duplicate_hamming_threshold: POLICY.duplicateHammingThreshold,
        gps_flag_distance_km: POLICY.gpsFlagDistanceKm,
        time_drift_flag_minutes: POLICY.timeDriftFlagMinutes,
        meter_delta_flag_hours: POLICY.meterDeltaFlagHours,
      },
      policy_version: POLICY_VERSION,
      photos: photoPayload,
      known_damage: knownDamage,
      signed_by: signedBy,
      chain_intact: chainIntact,
      required_slots: photos.filter((p) => p.required !== false).map((p) => p.slot),
      compare: beforePayload.length
        ? {
            before_photos: beforePayload,
            known_damage: knownDamage,
            start_date: booking.start_date,
            end_date: booking.end_date,
            opening_meter: booking.opening_meter ?? null,
            closing_meter: photos.find((p) => p.slot === "meter")?.meter_reading ?? null,
          }
        : null,
    }, timeoutMs);
    return { ...result, backend: "ok" };
  } catch (err) {
    console.warn("[trustClient] analyze failed, using local signals:", err?.message || err);
    return { ...localSignals({ photos, knownDamage, signedBy, chainIntact, equipment }), backend: "error", error: String(err?.message || err) };
  }
}

export async function verifyReportCode(code, timeoutMs = 20000) {
  if (!BACKEND_URL) return null;
  try {
    const resp = await fetch(`${BACKEND_URL}/verification/verify/${encodeURIComponent(code)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

export async function finalizeViaBackend(reportId, timeoutMs = 20000) {
  if (!BACKEND_URL) return null;
  try {
    return await post("/verification/finalize", { report_id: reportId }, timeoutMs);
  } catch {
    return null;
  }
}

/**
 * Browser-side signal pack — the same checks the server runs, minus the ones
 * that need the server's own copy of the bytes (exact-byte and server-side
 * perceptual verification). Marked `verified_by: "client"` wherever the UI
 * could otherwise imply server verification.
 */
export function localSignals({ photos = [], knownDamage = [], signedBy = 0, chainIntact = null, equipment = null }) {
  const history = photos.flatMap((p) => p.history || []);
  const results = photos.map((p) => {
    const flags = [];
    const checks = [];
    const push = (code, ok, flag, detail = "") => {
      checks.push({ code, pass: ok, detail });
      if (!ok) flags.push(flag || code);
    };

    if (!p.sha256) {
      checks.push({ code: "sha256_computed", pass: false, detail: "browser couldn't compute a byte fingerprint (insecure context)" });
    } else {
      checks.push({ code: "sha256_computed", pass: true, detail: `${p.sha256.slice(0, 12)}…` });
    }

    const best = history.reduce((acc, h) => {
      if (!h?.dhash || !p.dhash) return acc;
      const d = hammingDistance(p.dhash, h.dhash);
      return acc === null || d < acc.distance ? { distance: d, ...h } : acc;
    }, null);
    if (best && best.distance <= POLICY.duplicateHammingThreshold) {
      const sameBooking = String(best.booking_id) === String(p.booking_id);
      push("reuse_check", false, sameBooking ? FLAGS.duplicatePhoto : FLAGS.reuseAcrossBooking,
        `closest earlier photo is ${best.distance} bits away (booking ${best.booking_id})`);
    } else {
      push("reuse_check", true, null, best ? `closest earlier photo ${best.distance} bits away` : "no earlier photos for this machine");
    }

    if (!p.gps?.lat) {
      push("gps_present", false, FLAGS.gpsMissing, "no location recorded with this photo");
    } else {
      push("gps_present", true, null, `${p.gps.lat.toFixed(4)}, ${p.gps.lng.toFixed(4)} (${p.gps.source})`);
      const km = haversineKm(p.gps.lat, p.gps.lng, equipment?.latitude, equipment?.longitude);
      if (km !== null) push("gps_near_equipment", km <= POLICY.gpsFlagDistanceKm, FLAGS.gpsFarFromEquipment, `${km.toFixed(1)} km from the machine`);
    }

    if (p.quality?.verdict === "fail") {
      push("photo_quality", false, FLAGS.lowQuality, (p.quality.warnings || []).join(", "));
    } else if (p.quality) {
      push("photo_quality", true, null, p.quality.verdict);
    }

    if (!p.exif?.model && !p.exif?.make) push("exif_present", false, FLAGS.noExif, "no camera information in the file");

    const captured = p.captured_at_device ? new Date(p.captured_at_device).getTime() : null;
    if (captured && Math.abs(Date.now() - captured) > POLICY.timeDriftFlagMinutes * 60000) {
      push("capture_time_plausible", false, FLAGS.clockSkew, "the photo's clock is far from this device's clock");
    }

    return { slot: p.slot, flags, checks, ai: p.ai || null, quality: p.quality || null, dhash: p.dhash, sha256: p.sha256 };
  });

  const flags = [...new Set(results.flatMap((r) => r.flags))];
  if (photos.length < 4) flags.push(FLAGS.missingSlots);
  if (signedBy === 0) flags.push(FLAGS.unilateral);
  flags.push(FLAGS.aiUnavailable);
  const uniqueFlags = [...new Set(flags)];

  const verdict = verdictFor({
    photos: photos.length,
    signedBy,
    flags: uniqueFlags.filter((f) => f !== FLAGS.aiUnavailable),
    chainIntact,
  });

  return {
    ai_status: "unavailable",
    ai_provider: null,
    policy_version: POLICY_VERSION,
    storage: "client",
    photos: results,
    signals: {
      flags: uniqueFlags,
      verdict,
      flagged: uniqueFlags.length > 0,
      checks: results.flatMap((r) => r.checks),
      verified_by: "client",
    },
    verdict,
    flagged: uniqueFlags.length > 0,
    hour_meter: photos.find((p) => p.meter_reading != null)?.meter_reading ?? null,
    summary: {
      text: `Recorded ${photos.length} photo(s) with ${uniqueFlags.length} flag(s). Server-side verification was not available when this was filed.`,
      damage_found: [],
      wear_and_tear: [],
      hour_meter: photos.find((p) => p.meter_reading != null)?.meter_reading ?? null,
    },
    compare: null,
    known_damage: knownDamage,
  };
}

export { isFatalFlag, FLAGS, POLICY };

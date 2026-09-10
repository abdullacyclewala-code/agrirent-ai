// Phase 6 item 4 — geo helpers (free-tier path per the master doc: browser
// Geolocation API + manual pin-on-map, no paid Mapbox geocoding).
//
// Conventions: { lat, lng } everywhere in JS. PostGIS geography(Point) on the
// DB side is fed by the latitude/longitude numeric columns via trigger.

export const DEFAULT_SEARCH_RADIUS_KM = 50;
export const RADIUS_OPTIONS_KM = [10, 25, 50, 100];

export class GeoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GeoError";
    this.code = code; // unsupported | denied | unavailable | timeout
  }
}

export function isValidLatLng(lat, lng) {
  const la = Number(lat);
  const ln = Number(lng);
  return (
    Number.isFinite(la) &&
    Number.isFinite(ln) &&
    Math.abs(la) <= 90 &&
    Math.abs(ln) <= 180 &&
    !(la === 0 && ln === 0) // Null Island = almost certainly a bug, not a farm
  );
}

/**
 * One-shot browser location. Resolves { lat, lng, accuracyM }.
 * @throws {GeoError} with a code the UI maps to a translated message.
 */
export function getBrowserLocation({ timeoutMs = 12000, highAccuracy = true } = {}) {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new GeoError("unsupported", "Geolocation isn't available in this browser."));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new GeoError("timeout", "Location request timed out."));
      }
    }, timeoutMs + 1000); // own cap in case the browser never calls back

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const { latitude, longitude, accuracy } = pos.coords || {};
        if (!isValidLatLng(latitude, longitude)) {
          reject(new GeoError("unavailable", "Couldn't determine a valid location."));
          return;
        }
        resolve({ lat: latitude, lng: longitude, accuracyM: accuracy ?? null });
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err?.code === 1) {
          reject(new GeoError("denied", "Location permission was denied."));
        } else if (err?.code === 3) {
          reject(new GeoError("timeout", "Location request timed out."));
        } else {
          reject(new GeoError("unavailable", "Location is unavailable right now."));
        }
      },
      { enableHighAccuracy: highAccuracy, timeout: timeoutMs, maximumAge: 60000 }
    );
  });
}

/** Great-circle distance in km. Client-side fallback for display only — the
 *  authoritative distance comes from the nearby_equipment RPC (PostGIS). */
export function haversineKm(aLat, aLng, bLat, bLng) {
  if (!isValidLatLng(aLat, aLng) || !isValidLatLng(bLat, bLng)) return null;
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Human distance: 850 m under 1 km, otherwise one decimal km. */
export function formatDistance(km) {
  if (km == null || !Number.isFinite(Number(km))) return null;
  const v = Number(km);
  if (v < 0) return null;
  if (v < 1) return `${Math.max(50, Math.round(v * 1000))} m`;
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} km`;
}

/** Parse a free-typed coordinate box ("19.07" / "19.07, 72.87"). Returns a
 *  finite number or null — never throws, never NaN. */
export function parseCoordinate(raw, min, max) {
  if (raw == null || raw === "") return null;
  const cleaned = String(raw).trim().replace(/[°\s]+/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const v = Number(cleaned);
  return Number.isFinite(v) && v >= min && v <= max ? v : null;
}

/**
 * Turn coords into a human place label ("Rurka, Ludhiana") using OpenStreetMap's
 * free Nominatim service — no API key, CORS-enabled. Used to fill the location
 * text box when the farmer taps "use current location".
 *
 * NEVER throws and NEVER blocks the flow: any failure (offline, rate limit,
 * timeout, unexpected shape) resolves to null and the caller falls back to a
 * "Current location (lat, lng)" label. Results power the visible box text, so
 * OSM attribution is shown alongside (see describeJob.osmAttribution).
 */
export async function reverseGeocode(lat, lng, { timeoutMs = 8000 } = {}) {
  if (!isValidLatLng(lat, lng)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url =
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
      `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}` +
      `&zoom=14&addressdetails=1&accept-language=en`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return formatOsmAddress(data?.address) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** "village, district" from a Nominatim address object — null if unusable. */
export function formatOsmAddress(addr) {
  if (!addr || typeof addr !== "object") return null;
  const place =
    addr.village || addr.hamlet || addr.town || addr.city || addr.suburb ||
    addr.neighbourhood || addr.municipality || null;
  const area =
    addr.county || addr.state_district || addr.district || addr.state || null;
  const bits = [place, area].filter(Boolean).filter((b, i, a) => a.indexOf(b) === i);
  if (bits.length === 0) return null;
  return bits.slice(0, 2).join(", ");
}

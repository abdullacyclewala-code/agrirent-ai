// The plain-language summary of an AI reading, rebuilt from the numbers.
//
// Why this file exists: the backend assembles that sentence in English
// (`_summarise()` in backend/app/vision/analyze.py — "4 photo(s) recorded;
// hour meter read 120; 2 pre-existing damage item(s) noted.") because the
// backend has no locale. It is a deterministic sentence over counts, so the
// right place to write it is here, where the app language is known.
//
// The backend's own `text` stays in the payload and is used as the fallback:
// a report analysed before this screen existed, or by an older deployment,
// still reads correctly rather than showing nothing.

import { appLocale } from "./format.js";

/**
 * Join the parts the way the language does it — "A, B and C" in English,
 * "अ, ब और स" in Hindi/Marathi. Falls back to a semicolon list if the runtime
 * has no Intl.ListFormat, which is exactly what the backend used.
 */
function joinParts(t, parts) {
  if (!parts.length) return "";
  try {
    return new Intl.ListFormat(appLocale(), { style: "long", type: "unit" }).format(parts);
  } catch {
    return parts.join(t("common.listSeparator"));
  }
}

/**
 * @param {(key: string, opts?: object) => string} t
 * @param {{photoCount?: number, hourMeter?: number|null, damageCount?: number,
 *          newDamageCount?: number|null, compareRan?: boolean}} input
 * @returns {string} the summary sentence, or "" when there is nothing to say
 */
export function summarySentence(t, { photoCount = 0, hourMeter = null, damageCount = 0,
                                     newDamageCount = null, compareRan = false } = {}) {
  const parts = [];
  if (photoCount > 0) parts.push(t("trust.aiSummaryPhotos", { count: photoCount }));
  if (hourMeter != null) parts.push(t("trust.aiSummaryMeter", { value: hourMeter }));
  if (damageCount > 0) parts.push(t("trust.aiSummaryDamage", { count: damageCount }));
  if (compareRan) {
    parts.push(newDamageCount
      ? t("trust.aiSummaryNewDamage", { count: newDamageCount })
      : t("trust.aiSummaryNoNewDamage"));
  }
  if (!parts.length) return "";
  return t("trust.aiSummarySentence", { parts: joinParts(t, parts) });
}

/**
 * Works out whether the summary can be rebuilt for the current language, and
 * returns the translated sentence — or `null`, meaning "show the stored text".
 */
export function translatedSummary(t, { aiSummary, photos = [], hourMeter = null, fallbackText = null }) {
  if (!aiSummary && !fallbackText) return null;
  const compare = aiSummary?.compare || null;
  const built = summarySentence(t, {
    photoCount: photos.length,
    hourMeter: hourMeter ?? aiSummary?.hour_meter ?? null,
    damageCount: (aiSummary?.damage_found || []).length,
    newDamageCount: compare ? (compare.new_damage_count ?? (compare.new_damage || []).length) : null,
    compareRan: !!compare,
  });
  return built || fallbackText || null;
}

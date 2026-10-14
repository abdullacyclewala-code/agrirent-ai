// Locale-aware date/time formatting.
//
// Why this file exists: the app's dates were being rendered with bare
// `toLocaleString()` / `toLocaleDateString()`, which format in the *browser's*
// locale, not the language the user picked in the app. A phone set to English
// with the UI in Marathi showed "14 Oct 2026, 5:12 pm" in the middle of Marathi
// text — the single most visible way the UI looked partly untranslated.
//
// `src/lib/availability.js` already did this correctly (it picks `en-IN` or
// `<lang>-IN`); this is the same rule, in one place, for everything else.
//
// Everything takes an optional explicit language so pure functions stay easy to
// test; the default reads the live i18n language.

import i18n from "../i18n/index.js";

export function appLanguage() {
  return (i18n.resolvedLanguage || i18n.language || "en").split("-")[0];
}

/** `en-IN` / `hi-IN` / `mr-IN` — Indian formats for all three languages. */
export function appLocale(lang = appLanguage()) {
  return `${lang}-IN`;
}

export function formatDate(value, { lang, options } = {}) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(appLocale(lang), options || { day: "numeric", month: "short", year: "numeric" });
}

export function formatTime(value, { lang, options } = {}) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(appLocale(lang), options || { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(value, { lang, options } = {}) {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(appLocale(lang), options || {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

/** "2 days", "5 hours" — for windows and deadlines, in the app's language. */
export function formatDuration(ms, { lang } = {}) {
  const rtf = new Intl.RelativeTimeFormat(appLocale(lang), { numeric: "auto" });
  const mins = Math.round(ms / 60000);
  if (Math.abs(mins) < 60) return rtf.format(mins, "minute");
  const hours = Math.round(mins / 60);
  if (Math.abs(hours) < 48) return rtf.format(hours, "hour");
  return rtf.format(Math.round(hours / 24), "day");
}

// One place that turns a thrown error into a sentence the user can read.
//
// The bug this fixes: every catch block did `setError(err?.message || t("…"))`,
// so whenever an error actually carried a message — Supabase's PostgREST
// errors, a fetch failure, a storage policy denial — the screen showed raw
// English inside an otherwise-translated page. Choosing "Marathi" and then
// seeing "new row violates row-level security policy" is exactly the
// "some things don't translate" report.
//
// Rule: the *headline* is always translated. A coded error (see
// `codedStorageError` in inspectionCapture.js and `imageUpload.js`) maps to its
// own key; anything else falls back to the calling screen's translated message.
// The raw text is kept in the console, not on screen, so a failure stays
// diagnosable without leaking English into the UI.

import i18n from "../i18n/index.js";

/**
 * @param {unknown} err
 * @param {(key: string) => string} t
 * @param {string} fallbackKey translation key for this screen's generic failure
 * @returns {string} a translated message
 */
export function errorText(err, t, fallbackKey) {
  const code = err?.code;
  if (code) {
    const key = `trust.err_${code}`;
    if (i18n.exists(key)) {
      logForDiagnosis(err);
      return t(key);
    }
  }
  logForDiagnosis(err);
  return t(fallbackKey);
}

function logForDiagnosis(err) {
  if (!err) return;
  // Deliberately console-only: developers keep the detail, users keep a
  // translated screen.
  console.warn("[agrirent] action failed:", err?.code || "", err?.message || err);
}

// ---------------------------------------------------------------------------
// Auth (Supabase) errors
// ---------------------------------------------------------------------------
// Supabase returns its own English strings and no codes, so the only honest
// options are to map the ones that actually happen or show a generic line.
// The matching is deliberately loose: a wording change upstream must fall
// through to the generic message, never break sign-in.

const AUTH_PATTERNS = [
  [/invalid login credentials/i, "auth.errInvalidCredentials"],
  [/email not confirmed/i, "auth.errEmailNotConfirmed"],
  [/already registered|already been registered|user already exists/i, "auth.errEmailTaken"],
  [/password should be at least (\d+)/i, "auth.errPasswordTooShort"],
  [/unable to validate email|invalid email|invalid format/i, "auth.errInvalidEmail"],
  [/for security purposes|rate limit|too many requests|over_email_send_rate_limit/i, "auth.errTooManyAttempts"],
  [/signups not allowed|signup is disabled/i, "auth.errSignupDisabled"],
];

/**
 * @param {unknown} err a Supabase auth error (has `.message`)
 * @param {(key: string, opts?: object) => string} t
 * @returns {string} a translated message, or "" when there was no error
 */
export function authErrorText(err, t) {
  if (!err) return "";
  const message = String(err.message || "");
  logForDiagnosis(err);
  for (const [pattern, key] of AUTH_PATTERNS) {
    const m = message.match(pattern);
    if (!m) continue;
    if (key === "auth.errPasswordTooShort" && m[1]) {
      return t(key, { count: Number(m[1]) });
    }
    return t(key);
  }
  return t("auth.errGeneric");
}

// Phase 7 — the rules of engagement for verified condition reports.
//
// The product principle (docs/PHASE7_VERIFIED_CONDITION_REPORTS.md §6):
// **the policy defines the rules; the app enforces and records them.** Every
// number that decides something for a farmer is therefore in this one file,
// versioned, and stamped into every settlement (`policy_snapshot`) so that a
// decision made under today's rules is still explainable years later, even if
// the rules change.
//
// Changing a rule = bumping POLICY_VERSION. Never edit a shipped version's
// meaning in place — old settlements reference it.

export const POLICY_VERSION = "2026-10-1";

export const POLICY = {
  version: POLICY_VERSION,

  // How long after a return report is acknowledged the owner has to raise a
  // damage claim (§6 gate). No claim in this window = automatic release, and
  // the release is recorded as "no claim filed", never as "renter was fine".
  claimWindowHours: 24,

  // How long the other party has to countersign a UNILATERAL report before it
  // is shown as "unanswered" rather than "pending". It never becomes an
  // agreement by silence — silence is recorded as silence (§2).
  countersignWindowHours: 24,

  // Default refundable deposit, expressed as a share of the booking price,
  // capped. Owners can override per booking; this is only the suggestion the
  // UI pre-fills.
  defaultDepositPct: 0.2,
  defaultDepositCap: 5000,
  defaultDepositFloor: 500,

  // What the app will never do: move money on an AI's opinion alone. Kept as a
  // named constant so the UI can say it out loud, and so any future change is
  // a deliberate, reviewable act.
  aiCanMoveMoney: false,

  // Minimum number of photos for a report to be worth calling "verified".
  minPhotosForVerdict: 3,

  // A perceptual-hash match this close (Hamming distance on a 64-bit dHash)
  // is treated as "the same photo", not "a similar photo".
  duplicateHammingThreshold: 6,

  // Capture is expected to happen on site: photos taken more than this far
  // from the equipment's registered location raise a flag (not a block — GPS
  // in rural India is often inaccurate, and a machine can legitimately be at a
  // different field than the owner's registered base).
  gpsFlagDistanceKm: 25,

  // A photo whose capture clock is this far from server receipt is flagged.
  timeDriftFlagMinutes: 120,

  // Bounds for "the meter reading moved a plausible amount": catches a meter
  // claim that is nonsense in either direction.
  meterDeltaFlagHours: 2, // less than this many hours of runtime over a multi-day rental = suspicious
};

/** The rule set, frozen, to store alongside a decision. */
export function policySnapshot() {
  return {
    version: POLICY.version,
    claim_window_hours: POLICY.claimWindowHours,
    countersign_window_hours: POLICY.countersignWindowHours,
    default_deposit_pct: POLICY.defaultDepositPct,
    default_deposit_cap: POLICY.defaultDepositCap,
    ai_can_move_money: POLICY.aiCanMoveMoney,
    duplicate_hamming_threshold: POLICY.duplicateHammingThreshold,
    gps_flag_distance_km: POLICY.gpsFlagDistanceKm,
    time_drift_flag_minutes: POLICY.timeDriftFlagMinutes,
    captured_at: new Date().toISOString(),
  };
}

/** Suggested deposit for a booking price (owner can always override). */
export function suggestDeposit(price) {
  const p = Number(price) || 0;
  if (p <= 0) return 0;
  const raw = Math.round(p * POLICY.defaultDepositPct);
  return Math.max(POLICY.defaultDepositFloor, Math.min(POLICY.defaultDepositCap, raw));
}

// ---------------------------------------------------------------------------
// Verdicts — turning signals into one of three honest labels
// ---------------------------------------------------------------------------

/**
 * Rolls a signal pack into the single label shown on a report.
 *
 * The three labels are deliberately boring and honest:
 *   verified            — every signature/consistency check passed
 *   verified_with_flags — the evidence exists and is intact, but something is
 *                         worth a human's attention (a reused photo, GPS far
 *                         from the machine, a missing attestation)
 *   unverified          — not enough evidence to call it anything
 *
 * A flag NEVER silently changes money. It changes what the UI *says*.
 *
 * @param {{photos?: number, signedBy?: number, flags?: string[],
 *          chainIntact?: boolean|null, aiStatus?: string}} input
 */
export function verdictFor({ photos = 0, signedBy = 0, flags = [], chainIntact = null }) {
  if (photos < POLICY.minPhotosForVerdict) return "unverified";
  if (chainIntact === false) return "unverified";
  // Flags that mean "this evidence cannot be trusted at all" — as opposed to
  // "this evidence needs a look".
  const fatal = flags.filter((f) => FATAL_FLAGS.has(f));
  if (fatal.length) return "unverified";
  if (flags.length || signedBy === 0) return "verified_with_flags";
  return "verified";
}

/** Flag codes the capture/AI layers can raise — kept here so UI copy, backend
 *  and DB agree on the vocabulary. */
export const FLAGS = {
  shaMismatch: "sha_mismatch", // bytes changed between client hash and server hash
  duplicatePhoto: "duplicate_photo", // perceptual match with an earlier photo
  reuseAcrossBooking: "photo_reused_across_bookings",
  gpsFarFromEquipment: "gps_far_from_equipment",
  gpsMissing: "gps_missing",
  gpsDisagreesWithOtherParty: "gps_disagrees_with_other_party",
  clockSkew: "capture_clock_skew",
  watermarkUnreadable: "watermark_unreadable",
  watermarkMismatch: "watermark_mismatch",
  lowQuality: "low_photo_quality",
  missingSlots: "missing_required_slots",
  noExif: "no_camera_exif",
  unilateral: "unilateral_report",
  aiUnavailable: "ai_unavailable",
  meterInconsistent: "meter_delta_implausible",
};

/** Flags that make a report unusable as evidence, however it is labelled. */
const FATAL_FLAGS = new Set([
  FLAGS.shaMismatch,
  FLAGS.duplicatePhoto,
  FLAGS.reuseAcrossBooking,
  FLAGS.watermarkMismatch,
]);

export function isFatalFlag(code) {
  return FATAL_FLAGS.has(code);
}

/** Human-readable default text for a flag code (i18n looks these up first). */
export const FLAG_COPY = {
  [FLAGS.shaMismatch]: "The photo's fingerprint didn't match after upload — it may have been altered in transit.",
  [FLAGS.duplicatePhoto]: "This photo appears to be the same image as an earlier one in this booking.",
  [FLAGS.reuseAcrossBooking]: "This photo was already used in a different booking.",
  [FLAGS.gpsFarFromEquipment]: "The photo was taken far from where this machine is registered.",
  [FLAGS.gpsMissing]: "No location was recorded with this photo.",
  [FLAGS.gpsDisagreesWithOtherParty]: "The two parties' photos of this handover were taken in different places.",
  [FLAGS.clockSkew]: "The photo's camera clock doesn't match when it reached the server.",
  [FLAGS.watermarkUnreadable]: "The in-photo stamp couldn't be read back.",
  [FLAGS.watermarkMismatch]: "The in-photo stamp doesn't match this booking's details.",
  [FLAGS.lowQuality]: "A photo was too blurry or dark to rely on.",
  [FLAGS.missingSlots]: "One or more standard views are missing.",
  [FLAGS.noExif]: "The photo has no camera information attached.",
  [FLAGS.unilateral]: "Only one party has filed this report so far.",
  [FLAGS.aiUnavailable]: "The AI reading isn't available right now — the evidence itself is unaffected.",
  [FLAGS.meterInconsistent]: "The hour-meter reading doesn't fit the rental period.",
};

// ---------------------------------------------------------------------------
// Damage vs. wear and tear — the boundary disputes actually turn on
// ---------------------------------------------------------------------------

/**
 * Guidance surfaced to BOTH parties before a claim is filed, because the
 * research on Indian rental disputes is unambiguous: the fights that reach a
 * tribunal are about undocumented deductions and a vague damage-vs-wear line.
 *
 * This is guidance, not a rule engine: agriculture is dirty work and normal
 * working wear must never be chargeable.
 */
export const WEAR_AND_TEAR = [
  { key: "dust_mud", label: "Dust, mud, crop residue on the machine", chargeable: false },
  { key: "minor_scratches", label: "Minor scratches or faded paint from normal field use", chargeable: false },
  { key: "tyre_tread_wear", label: "Normal tyre tread wear", chargeable: false },
  { key: "consumables", label: "Fuel, oil, coolant, grease used in the rental", chargeable: false },
  { key: "blade_sharpening", label: "Routine blade/implement sharpening", chargeable: false },
];

export const CHARGEABLE_DAMAGE = [
  { key: "bent_broken", label: "Bent, broken or cracked parts", severity: "moderate" },
  { key: "burnt_clutch", label: "Burnt clutch or overheated engine from misuse", severity: "major" },
  { key: "punctured_tyre", label: "Punctured or cut tyre (not normal wear)", severity: "minor" },
  { key: "missing_part", label: "Missing parts or tools", severity: "moderate" },
  { key: "fluid_leak", label: "Leaks caused during the rental", severity: "moderate" },
  { key: "structural", label: "Damage from an accident or overloading", severity: "major" },
];

/** Does a claim need a repair estimate attached before it can be filed? */
export function claimNeedsEstimate(amountClaimed) {
  return Number(amountClaimed) >= 2000;
}

/**
 * Splits a deposit into what is released now and what stays held, given a
 * claim. Used by both the UI preview and the settlement row — one definition,
 * so the number the renter sees is the number that gets recorded.
 *
 * "Release any undisputed amount where the payment arrangement permits" — a
 * dispute holds only the disputed part, never the whole deposit.
 */
export function settlementSplit({ deposit = 0, claimAmount = 0, agreed = false, disputed = false, settledAmount = null }) {
  const d = Number(deposit) || 0;
  if (disputed) {
    // While disputed: nothing is withheld. The undisputed remainder is freed;
    // the disputed portion is simply "not yet decided".
    const held = Math.min(d, Number(claimAmount) || 0);
    return {
      released: Math.max(0, d - held),
      withheld: 0,
      held,
      status: held > 0 ? "disputed_hold" : "released",
      note: "Nothing is deducted while a claim is disputed. The disputed amount is held, the rest is released.",
    };
  }
  const finalClaim = settledAmount != null ? Number(settledAmount) : Number(claimAmount) || 0;
  const withheld = agreed ? Math.max(0, Math.min(d, finalClaim)) : 0;
  return {
    released: Math.max(0, d - withheld),
    withheld,
    held: 0,
    status: d <= 0 ? "no_deposit" : withheld > 0 ? (withheld < d ? "partial" : "withheld") : "released",
    note: agreed
      ? "Both parties agreed to this deduction."
      : "No deduction was agreed.",
  };
}

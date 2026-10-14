// Phase 7 — the gates, in one place.
//
// Pure functions only (no Supabase import): given a booking, its reports and
// its claims, decide what state the rental is in and what each party should be
// asked to do next. Keeping this pure means the rules can be unit-tested
// (scripts/test-trust.mjs) instead of being discovered in production, and it
// keeps Booking.jsx from growing a third copy of the same if-statements.
//
// The rules are the ones in docs/PHASE7_VERIFIED_CONDITION_REPORTS.md §6:
//   * nothing blocks a farmer's machine because an owner didn't open the app —
//     a missing report becomes a UNILATERAL report, flagged as such, forever;
//   * no claim inside the window = release, recorded as "no claim filed";
//   * while disputed, nothing is withheld;
//   * silence is never recorded as agreement.

import { POLICY, settlementSplit } from "./depositPolicy.js";

export const VSTATE = {
  notStarted: "not_started",
  handoverDue: "handover_due",
  handoverSigned: "handover_signed",
  handoverUnilateral: "handover_unilateral",
  returnDue: "return_due",
  returnFiled: "return_filed",
  claimOpen: "claim_open",
  disputed: "disputed",
  settled: "settled",
  closedClean: "closed_clean",
};

export const VSTATE_LABEL_KEY = {
  [VSTATE.notStarted]: "trust.stateNotStarted",
  [VSTATE.handoverDue]: "trust.stateHandoverDue",
  [VSTATE.handoverSigned]: "trust.stateHandoverSigned",
  [VSTATE.handoverUnilateral]: "trust.stateHandoverUnilateral",
  [VSTATE.returnDue]: "trust.stateReturnDue",
  [VSTATE.returnFiled]: "trust.stateReturnFiled",
  [VSTATE.claimOpen]: "trust.stateClaimOpen",
  [VSTATE.disputed]: "trust.stateDisputed",
  [VSTATE.settled]: "trust.stateSettled",
  [VSTATE.closedClean]: "trust.stateClosedClean",
};

export function handoverReport(reports = []) {
  return reports.find((r) => r.kind === "handover" && r.status !== "cancelled") || null;
}

export function returnReport(reports = []) {
  return reports.find((r) => r.kind === "return" && r.status !== "cancelled") || null;
}

export function openClaim(claims = []) {
  return claims.find((c) => ["open", "disputed", "agreed", "resolved"].includes(c.status)
    && c.status !== "withdrawn") || null;
}

export function isReportFinal(report) {
  return !!report?.finalized_at;
}

export function isReportSignedBy(report, role) {
  return !!report?.signatures?.some?.((s) => s.role === role);
}

/** When does the owner's window to claim close? */
export function claimWindowEndsAt(report) {
  if (!report?.finalized_at) return null;
  return new Date(new Date(report.finalized_at).getTime() + POLICY.claimWindowHours * 3600 * 1000);
}

/** Still open, and has the window actually elapsed? Evaluated lazily (the
 *  project's existing §4.5 pattern — no cron needed). */
export function claimWindowState(report, now = new Date()) {
  const ends = claimWindowEndsAt(report);
  if (!ends) return { open: false, endsAt: null, expired: false };
  return { open: true, endsAt: ends, expired: now >= ends };
}

/**
 * Derive the booking's verification state from the underlying rows, rather
 * than trusting a stored value to be in sync. The stored column is a cache for
 * lists/filters; this is the source of truth for what to show.
 */
export function deriveVerificationState({ booking, reports = [], claims = [] }) {
  const handover = handoverReport(reports);
  const ret = returnReport(reports);
  const claim = openClaim(claims);

  if (claim) {
    if (claim.status === "disputed") return VSTATE.disputed;
    if (claim.status === "agreed" || claim.status === "resolved") return VSTATE.settled;
    return VSTATE.claimOpen;
  }
  if (ret?.finalized_at) return VSTATE.returnFiled;
  if (ret) return VSTATE.returnDue;
  if (handover?.finalized_at) {
    return handover.unilateral ? VSTATE.handoverUnilateral : VSTATE.handoverSigned;
  }
  if (handover) return VSTATE.handoverDue;
  if (booking?.status === "Confirmed" || booking?.status === "In Use" || booking?.status === "Completed") {
    return VSTATE.handoverDue;
  }
  return VSTATE.notStarted;
}

/**
 * What should THIS person see as their next step? Returning one primary action
 * (plus any secondary ones) is what keeps the flow "minimal steps, no
 * hunting": the booking page shows one button, not a menu.
 */
export function nextAction({ booking, reports = [], claims = [], role, userId, now = new Date() }) {
  const handover = handoverReport(reports);
  const ret = returnReport(reports);
  const claim = openClaim(claims);
  const state = deriveVerificationState({ booking, reports, claims });
  const isOwner = role === "owner";
  const secondary = [];

  if (booking?.status === "Cancelled" || booking?.status === "Rejected") {
    return { state, primary: null, secondary, note: "bookingClosed" };
  }

  // A filed claim needs an answer from the renter.
  if (claim?.status === "open") {
    if (!isOwner && claim.filed_by !== userId) {
      return { state, primary: { action: "respondToClaim", claimId: claim.id }, secondary, note: "claimNeedsAnswer" };
    }
    if (isOwner) {
      return { state, primary: { action: "awaitClaimResponse", claimId: claim.id }, secondary, note: "waitingOnRenter" };
    }
  }
  if (claim?.status === "disputed") {
    return {
      state,
      primary: { action: "resolveDispute", claimId: claim.id },
      secondary: [{ action: "viewReport", reportId: ret?.id }],
      note: "disputeHoldsDeposit",
    };
  }

  // Return leg: the return report is the gate for settling the deposit.
  if (["In Use", "Confirmed", "Completed"].includes(booking?.status)) {
    if (handover?.finalized_at && !ret && (booking.status === "In Use" || booking.status === "Completed")) {
      return {
        state,
        primary: { action: "startReturnReport" },
        secondary: [{ action: "viewReport", reportId: handover.id }],
        note: "returnEvidenceDue",
      };
    }
    if (ret?.finalized_at) {
      const window = claimWindowState(ret, now);
      if (isOwner && window.open && !window.expired) {
        return {
          state,
          primary: { action: "fileDamageClaim", reportId: ret.id },
          secondary: [{ action: "markNoClaim", reportId: ret.id }, { action: "viewReport", reportId: ret.id }],
          note: "claimWindowOpen",
        };
      }
      if (!isOwner) {
        return { state, primary: { action: "viewReport", reportId: ret.id }, secondary, note: "awaitingOwner" };
      }
      return { state, primary: { action: "releaseDeposit", reportId: ret.id }, secondary, note: "claimWindowClosed" };
    }
  }

  // Handover leg: the first report is what protects everyone afterwards.
  if (handover && !handover.finalized_at) {
    return { state, primary: { action: "finishHandoverReport", reportId: handover.id }, secondary, note: "handoverDraft" };
  }
  if (handover?.finalized_at) {
    const signedByMe = isReportSignedBy(handover, role);
    if (!signedByMe) {
      return {
        state,
        primary: { action: "countersign", reportId: handover.id },
        secondary: [{ action: "viewReport", reportId: handover.id }],
        note: "needsYourSignature",
      };
    }
    if (handover.unilateral === false) {
      return { state, primary: null, secondary: [{ action: "viewReport", reportId: handover.id }], note: "verified" };
    }
  }

  if (["Confirmed", "In Use"].includes(booking?.status)) {
    const canFile = isOwner || booking?.status === "In Use";
    return {
      state,
      primary: canFile ? { action: "startHandoverReport" } : null,
      secondary: handover ? [{ action: "viewReport", reportId: handover.id }] : [],
      note: canFile ? "handoverEvidenceDue" : "ownerWillRecordCondition",
    };
  }

  return { state, primary: null, secondary, note: null };
}

/** Preview of what a claim would do to the deposit, using the same policy
 *  function the settlement row is written with. */
export function previewSettlement({ deposit, claimAmount, agreed = false, disputed = false, settledAmount = null }) {
  return settlementSplit({ deposit, claimAmount, agreed, disputed, settledAmount });
}

/**
 * Should the app nag about a unilateral report? Yes — but only to the party
 * who hasn't acted, and it never becomes an agreement on its own.
 */
export function countersignReminder({ report, role, userId, now = new Date() }) {
  if (!report?.unilateral || !report.finalized_at) return null;
  if (isReportSignedBy(report, role)) return null;
  const ageHours = (now - new Date(report.finalized_at)) / 3600000;
  if (ageHours < POLICY.countersignWindowHours) {
    return { level: "pending", hoursLeft: Math.max(0, POLICY.countersignWindowHours - ageHours) };
  }
  return { level: "overdue", hoursLeft: 0 };
}

/** Verdict → the badge the UI shows. Kept here so all three labels are used
 *  consistently and nothing re-invents a fourth. */
export function verdictLabelKey(verdict) {
  return {
    verified: "trust.verdictVerified",
    verified_with_flags: "trust.verdictFlagged",
    unverified: "trust.verdictUnverified",
  }[verdict] || "trust.verdictUnverified";
}

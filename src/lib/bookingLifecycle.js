// Phase 5 — shared booking lifecycle helpers (§4.5 edge cases: auto-expiring
// a stale "Requested" booking the owner never responded to, and handling a
// double-booking conflict when an owner accepts one request while other
// overlapping requests are still pending on the same equipment).
//
// Pulled into one module — not duplicated across EquipmentDetails.jsx,
// Booking.jsx, and MyBookings.jsx — so "what counts as overlapping" and
// "how stale is stale" are each defined exactly once.

import { supabase } from "./supabase.js";

/**
 * Inclusive date-range overlap check — the same rule already used at
 * booking-creation time (EquipmentDetails.jsx) and in the ranker's
 * availability feature (DescribeJob.jsx). Dates are ISO strings
 * (YYYY-MM-DD), which compare correctly as plain strings.
 */
export function datesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && aEnd >= bStart;
}

// §4.5: "Owner doesn't respond to a booking request -> auto-expire the
// request after a set window (e.g. 24-48h)". Using the upper end of that.
const REQUEST_EXPIRY_HOURS = 48;

/**
 * §4.5 edge case: auto-expires stale "Requested" bookings.
 *
 * DISCLOSED SIMPLIFICATION: there's no cron/scheduled job running
 * server-side (Render's free tier has no built-in scheduler, and adding one
 * — a Render Cron Job or a GitHub Actions schedule hitting a small backend
 * endpoint — is a real infra addition, not just code, so it's noted as a
 * follow-up rather than done here). Instead, this runs lazily: whenever a
 * farmer or owner loads a bookings list that includes a stale request, it
 * gets flipped to "Expired" right then. That covers the case that actually
 * matters for the UI (nobody sees a misleadingly-still-pending request), but
 * a request nobody ever revisits could sit as "Requested" in the DB
 * indefinitely. Acceptable for MVP; not the same as a guaranteed 48h SLA.
 *
 * Updates Supabase directly — RLS already allows either party on a booking
 * to update its status (see supabase/schema.sql), so no backend round-trip
 * is needed just for this. Returns the ids that were expired so callers can
 * patch their local state without a full refetch.
 */
export async function expireStaleRequests(bookings) {
  const cutoffIso = new Date(Date.now() - REQUEST_EXPIRY_HOURS * 60 * 60 * 1000).toISOString();
  const staleIds = (bookings || [])
    .filter((b) => b.status === "Requested" && b.created_at && b.created_at < cutoffIso)
    .map((b) => b.id);

  if (!staleIds.length) return [];

  const { error } = await supabase.from("bookings").update({ status: "Expired" }).in("id", staleIds);
  if (error) {
    console.warn("[bookingLifecycle] failed to expire stale bookings:", error.message);
    return [];
  }
  return staleIds;
}

/**
 * §4.5 edge case: "first accepted booking locks the slot; other pending
 * requests on that slot auto-notify farmer of conflict."
 *
 * Call AFTER successfully confirming `acceptedBooking`. Finds every other
 * still-"Requested" booking for the same equipment with overlapping dates
 * and flips them to "Conflicted" — a status distinct from "Rejected" so the
 * farmer sees an accurate reason (the owner didn't decline them; someone
 * else's request just got accepted first). Since this is a normal bookings
 * UPDATE, the existing pg_net trigger -> /notifications/booking-webhook ->
 * FCM push pipeline notifies the farmer automatically — no new plumbing
 * needed (see backend/app/notifications.py's "Conflicted" message).
 *
 * Returns the ids that were auto-conflicted.
 */
export async function conflictOutOverlappingRequests(acceptedBooking) {
  const { data: others, error } = await supabase
    .from("bookings")
    .select("id, start_date, end_date")
    .eq("equipment_id", acceptedBooking.equipment_id)
    .eq("status", "Requested")
    .neq("id", acceptedBooking.id);

  if (error || !others?.length) return [];

  const conflictIds = others
    .filter((b) => datesOverlap(b.start_date, b.end_date, acceptedBooking.start_date, acceptedBooking.end_date))
    .map((b) => b.id);

  if (!conflictIds.length) return [];

  const { error: updateErr } = await supabase.from("bookings").update({ status: "Conflicted" }).in("id", conflictIds);
  if (updateErr) {
    console.warn("[bookingLifecycle] failed to auto-conflict overlapping requests:", updateErr.message);
    return [];
  }
  return conflictIds;
}

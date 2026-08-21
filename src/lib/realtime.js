// Phase 4 — Supabase Realtime helpers (master doc §2: "Realtime for booking
// updates" is a Supabase feature, not a separate service — no new deps).
//
// Two thin wrappers around supabase-js's `postgres_changes` channel API so
// Booking.jsx and MyBookings.jsx don't each hand-roll channel setup/teardown.
// Both return an unsubscribe function meant to be returned directly from a
// `useEffect`.

import { supabase } from "./supabase.js";

/**
 * Subscribe to UPDATE events on a single booking row (Booking.jsx's tracking
 * page). Fires `onChange(newRow)` whenever `status` (or anything else) changes.
 *
 * @param {number|string} bookingId
 * @param {(newRow: object) => void} onChange
 * @returns {() => void} unsubscribe
 */
export function subscribeToBooking(bookingId, onChange) {
  const channel = supabase
    .channel(`booking-${bookingId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "bookings", filter: `id=eq.${bookingId}` },
      (payload) => onChange(payload.new)
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

/**
 * Subscribe to INSERT/UPDATE events on the `bookings` table for a given
 * user, as either farmer or owner (MyBookings.jsx's list view). Supabase
 * Realtime filters support one `filter` per subscription, so this opens two
 * channels (one per role column) rather than trying to OR them together.
 *
 * @param {string} userId
 * @param {(newRow: object, eventType: "INSERT"|"UPDATE") => void} onChange
 * @returns {() => void} unsubscribe
 */
export function subscribeToUserBookings(userId, onChange) {
  const handler = (payload) => onChange(payload.new, payload.eventType);

  const farmerChannel = supabase
    .channel(`bookings-farmer-${userId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "bookings", filter: `farmer_id=eq.${userId}` },
      handler
    )
    .subscribe();

  const ownerChannel = supabase
    .channel(`bookings-owner-${userId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "bookings", filter: `owner_id=eq.${userId}` },
      handler
    )
    .subscribe();

  return () => {
    supabase.removeChannel(farmerChannel);
    supabase.removeChannel(ownerChannel);
  };
}

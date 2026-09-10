/**
 * Availability calendar over the `availability_slots` table (Phase 6 item 5).
 *
 * Slot semantics:
 *  - `is_booked = false` → an AVAILABLE window the owner offers.
 *  - `is_booked = true`  → dates locked by a Confirmed booking. Written by the
 *    app (see Booking.jsx) when a request is confirmed, removed if that
 *    booking is cancelled.
 *  - Equipment with NO offered windows is "always available" (backward
 *    compatible for owners who never set slots), but booked-date clashes are
 *    ALWAYS enforced, with or without offered windows.
 *
 * Dates are plain 'YYYY-MM-DD' strings everywhere, so plain string comparison
 * is a correct chronological comparison (no timezone traps).
 */

import { currentLang } from "./equipmentDisplay.js";

/** True when [aStart, aEnd] and [bStart, bEnd] share at least one day. */
export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  return aStart <= bEnd && bStart <= aEnd;
}

/** True when [start, end] sits fully inside [winStart, winEnd]. */
export function rangeInside(start, end, winStart, winEnd) {
  if (!start || !end || !winStart || !winEnd) return false;
  return winStart <= start && end <= winEnd;
}

/**
 * Validate an owner-entered offered range.
 * @returns translated error string, or null when the range is fine.
 */
export function validateOfferedRange(start, end, today, t) {
  if (!start || !end) return t("addEquipment.slotNeedBoth", "Pick both a start and an end date.");
  if (end < start) return t("addEquipment.slotEndBeforeStart", "End date cannot be before the start date.");
  if (today && start < today)
    return t("addEquipment.slotPast", "Availability windows cannot start in the past.");
  return null;
}

/**
 * Decide whether [start, end] can be booked given the equipment's slots.
 *
 * @returns {{ ok: boolean, reason: 'ok'|'missing-dates'|'outside-offered'|'already-booked',
 *   unconstrained: boolean }} — `unconstrained` is true when the owner never
 *   set any offered windows (only booked-clash rules applied).
 */
export function checkAvailability(slots, start, end) {
  const rows = Array.isArray(slots) ? slots : [];
  if (!start || !end) return { ok: false, reason: "missing-dates", unconstrained: false };
  // Booked-date clashes always win, whether or not the owner set windows.
  if (rows.some((s) => s.is_booked && rangesOverlap(start, end, s.start_date, s.end_date))) {
    return { ok: false, reason: "already-booked", unconstrained: false };
  }
  const offered = rows.filter((s) => !s.is_booked);
  if (offered.length === 0) return { ok: true, reason: "ok", unconstrained: true };
  if (offered.some((s) => rangeInside(start, end, s.start_date, s.end_date))) {
    return { ok: true, reason: "ok", unconstrained: false };
  }
  return { ok: false, reason: "outside-offered", unconstrained: false };
}

/**
 * Status of a single day for browse/search display.
 * @returns 'booked' | 'unoffered' | 'offered' | 'unconstrained'
 */
export function dateStatusOn(slots, date) {
  const rows = Array.isArray(slots) ? slots : [];
  if (!date) return "unconstrained";
  if (rows.some((s) => s.is_booked && rangeInside(date, date, s.start_date, s.end_date))) {
    return "booked";
  }
  const offered = rows.filter((s) => !s.is_booked);
  if (offered.length === 0) return "unconstrained";
  return offered.some((s) => rangeInside(date, date, s.start_date, s.end_date))
    ? "offered"
    : "unoffered";
}

/** Fetch all slots for one equipment, offered windows first, then by date. */
export async function fetchSlots(supabase, equipmentId) {
  const { data, error } = await supabase
    .from("availability_slots")
    .select("id,equipment_id,start_date,end_date,is_booked")
    .eq("equipment_id", equipmentId)
    .order("is_booked", { ascending: true })
    .order("start_date", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/**
 * Fetch slots for many equipment rows in one query (search/browse paths).
 * @returns Map equipmentId -> slot rows.
 */
export async function fetchSlotsForMany(supabase, equipmentIds) {
  const ids = [...new Set((equipmentIds ?? []).filter((v) => v != null))];
  const map = new Map(ids.map((id) => [id, []]));
  if (ids.length === 0) return map;
  const { data, error } = await supabase
    .from("availability_slots")
    .select("id,equipment_id,start_date,end_date,is_booked")
    .in("equipment_id", ids)
    .order("is_booked", { ascending: true })
    .order("start_date", { ascending: true });
  if (error) throw error;
  for (const row of data ?? []) {
    if (!map.has(row.equipment_id)) map.set(row.equipment_id, []);
    map.get(row.equipment_id).push(row);
  }
  return map;
}

/** Owner adds an offered window. Throws the Supabase error on failure. */
export async function addOfferedSlot(supabase, equipmentId, start, end) {
  const { data, error } = await supabase
    .from("availability_slots")
    .insert({ equipment_id: equipmentId, start_date: start, end_date: end, is_booked: false })
    .select("id,equipment_id,start_date,end_date,is_booked")
    .single();
  if (error) throw error;
  return data;
}

/** Owner removes an offered window (booked locks cannot be removed this way). */
export async function removeOfferedSlot(supabase, slotId) {
  const { error } = await supabase
    .from("availability_slots")
    .delete()
    .eq("id", slotId)
    .eq("is_booked", false);
  if (error) throw error;
}

/**
 * Lock dates for a Confirmed booking. Throws on failure — callers confirming
 * a booking must treat this as fatal and roll the status back.
 */
export async function createBookedSlot(supabase, equipmentId, start, end) {
  const { error } = await supabase
    .from("availability_slots")
    .insert({ equipment_id: equipmentId, start_date: start, end_date: end, is_booked: true });
  if (error) throw error;
}

/**
 * Release a booking's date lock (cancel path). Best-effort: a missing row is
 * fine (already released), other errors are returned, never thrown.
 * @returns { released: number, error: Error|null }
 */
export async function removeBookedSlot(supabase, equipmentId, start, end) {
  const { data, error } = await supabase
    .from("availability_slots")
    .delete()
    .eq("equipment_id", equipmentId)
    .eq("start_date", start)
    .eq("end_date", end)
    .eq("is_booked", true)
    .select("id");
  if (error) return { released: 0, error };
  return { released: (data ?? []).length, error: null };
}

/** "12 Sep – 20 Sep" / "12 सित – 20 सित" style range for the current UI language. */
export function formatSlotRange(start, end) {
  const fmt = (d) => {
    const dt = new Date(`${d}T00:00:00`);
    if (Number.isNaN(dt.getTime())) return d;
    try {
      const lang = currentLang();
      return dt.toLocaleDateString(lang === "en" ? "en-IN" : `${lang}-IN`, {
        day: "numeric",
        month: "short",
      });
    } catch {
      return dt.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
    }
  };
  if (!start || !end) return "";
  return start === end ? fmt(start) : `${fmt(start)} – ${fmt(end)}`;
}

/** Today's date as 'YYYY-MM-DD' in the device's local timezone. */
export function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

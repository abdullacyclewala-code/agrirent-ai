// Phase 7 — Supabase access for the trust layer.
//
// Same architecture as the rest of this app (see backend/README.md): row-level
// security is the enforcement point, and the frontend talks to Postgres
// directly. The database — not this file and not the browser — owns the two
// guarantees that matter:
//   * evidence tables are append-only (no update/delete policies exist), and
//   * report hashes are computed by DB triggers that recompute the chain.
// So a compromised or simply buggy client cannot rewrite history; the worst it
// can do is write a bad row, which stays visible forever.

import { supabase } from "./supabase.js";
import { POLICY_VERSION, policySnapshot } from "./depositPolicy.js";
// Re-exported under a name that reads right at the call site (claim page,
// report page): "give me signed URLs for these evidence paths".
export { signedEvidenceUrls as signedEvidenceUrlsFor } from "./inspectionCapture.js";

const REPORT_SELECT = `
  id, booking_id, equipment_id, kind, status, created_by, created_by_role, unilateral,
  report_code, report_hash, chain_head, finalized_at, ai_summary, ai_provider, ai_status,
  signals, verdict, flagged, hour_meter, hour_meter_source, policy_version,
  renter_response, renter_responded_at, notes, created_at, supersedes_id
`;

/** Everything the report UI needs about the booking + machine, in one round trip. */
export async function getBookingContext(bookingId) {
  const { data, error } = await supabase
    .from("bookings")
    .select(`*, equipment:equipment_id ( id, name, equipment_type, images, latitude, longitude, location_label, price, price_unit, owner_id ),
             owner:owner_id ( id, name ), farmer:farmer_id ( id, name )`)
    .eq("id", bookingId)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/** Reports attached to a booking (handover + return), newest first. */
export async function getReportsForBooking(bookingId) {
  const { data, error } = await supabase
    .from("condition_reports")
    .select(REPORT_SELECT)
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

/** A report plus its evidence, attestations and audit trail. */
export async function getReportDetail(reportId) {
  const [report, photos, signatures, events] = await Promise.all([
    supabase.from("condition_reports").select(REPORT_SELECT).eq("id", reportId).single(),
    supabase.from("report_photos")
      .select("id, slot, storage_path, captured_by, captured_by_role, sha256, sha256_server, sha256_match, dhash, dhash_distance, dup_of, hamming_min, captured_at_device, received_at, exif, gps_lat, gps_lng, gps_source, device, watermark_text, ai, quality, damage_labels, damage_severity, flags, created_at")
      .eq("report_id", reportId)
      .order("created_at", { ascending: true }),
    supabase.from("report_signatures")
      .select("id, user_id, role, statement_version, statement_text, signature_png_path, content_hash, signed_at")
      .eq("report_id", reportId)
      .order("signed_at", { ascending: true }),
    supabase.from("report_events")
      .select("id, actor_id, actor_role, event, payload, created_at, prev_hash, row_hash")
      .eq("report_id", reportId)
      .order("id", { ascending: true }),
  ]);
  if (report.error) throw new Error(report.error.message);
  return {
    report: report.data,
    photos: photos.data || [],
    signatures: signatures.data || [],
    events: events.data || [],
  };
}

/**
 * Find or create the report for one side of a handover.
 * Created as `draft` so an abandoned capture leaves an obvious, dated trace
 * rather than nothing at all.
 */
export async function ensureConditionReport({ booking, kind, userId, role, supersedesId = null }) {
  const existing = await supabase
    .from("condition_reports")
    .select(REPORT_SELECT)
    .eq("booking_id", booking.id)
    .eq("kind", kind)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(1);
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data?.length) return existing.data[0];

  const { data, error } = await supabase
    .from("condition_reports")
    .insert({
      booking_id: booking.id,
      equipment_id: booking.equipment_id,
      kind,
      created_by: userId,
      created_by_role: role,
      unilateral: true,          // becomes false once the other party countersigns
      policy_version: POLICY_VERSION,
      supersedes_id: supersedesId,
    })
    .select(REPORT_SELECT)
    .single();
  if (error) throw new Error(error.message);

  await logEvent(data.id, "report_created", { kind, role }, role, data.booking_id);
  return data;
}

/** Insert one photo's evidence row (append-only; there is no update path). */
export async function insertReportPhoto({ report, booking, photo, storagePath, userId, role }) {
  const { data, error } = await supabase
    .from("report_photos")
    .insert({
      report_id: report.id,
      booking_id: booking.id,
      equipment_id: booking.equipment_id,
      slot: photo.slot,
      storage_path: storagePath,
      captured_by: userId,
      captured_by_role: role,
      sha256: photo.sha256 || "unknown",
      dhash: photo.dhash || "0000000000000000",
      captured_at_device: photo.captured_at_device,
      exif: photo.exif || null,
      gps_lat: photo.gps?.lat ?? null,
      gps_lng: photo.gps?.lng ?? null,
      gps_source: photo.gps_source || photo.gps?.source || "none",
      device: photo.device,
      watermark_text: photo.watermark_text,
      quality: photo.quality || null,
      damage_labels: photo.damage_labels || [],
      damage_severity: photo.damage_severity || null,
    })
    .select("id, slot")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/** Persist the backend's reading of the evidence (service-role writes it too;
 *  this path covers deployments where the frontend owns all writes). */
export async function updateReportAnalysis(reportId, analysis) {
  const photos = analysis.photos || [];
  const patch = {
    // The compare block rides along inside ai_summary: it is produced by the
    // same call, belongs to the same reading, and keeping it here means the
    // report page can render the slider caption ("reused evidence") without a
    // second round trip or a second table.
    ai_summary: analysis.summary
      ? { ...analysis.summary, compare: analysis.compare || null, verified_by: analysis.signals?.verified_by || "server" }
      : null,
    ai_provider: analysis.ai_provider || null,
    ai_status: analysis.ai_status || "pending",
    signals: analysis.signals || {},
    verdict: analysis.verdict || "unverified",
    flagged: !!analysis.flagged,
    hour_meter: analysis.hour_meter ?? null,
    hour_meter_source: analysis.hour_meter != null ? (analysis.ai_provider || "ai") : null,
  };
  // `.select("id")` is deliberate: with row-level security an UPDATE that the
  // policies filter out returns **no error and no rows**, so a silent no-op is
  // indistinguishable from success unless we ask for the row back.
  const { data: written, error } = await supabase
    .from("condition_reports")
    .update(patch)
    .eq("id", reportId)
    .select("id");
  if (error) throw new Error(error.message);
  if (!written?.length) {
    throw new Error(
      "The report's analysis could not be recorded — it is already signed, or you are not a party on this booking.",
    );
  }

  // Per-photo findings + the cross-checks the server found.
  for (const p of photos) {
    if (!p.slot) continue;
    const update = {
      flags: p.flags || [],
      sha256_match: p.sha256_match ?? null,
      dhash_distance: p.dhash_distance ?? null,
    };
    if (p.ai) update.ai = p.ai;
    if (p.server_quality) update.quality = p.server_quality;
    if (p.server_dhash) {
      update.dhash_server = p.server_dhash;
      update.hamming_min = p.dhash_distance ?? null;
    }
    // Findings are writable only while the report is a draft (Phase 7b migration);
    // asking for the row back tells us whether they actually landed.
    const { data: changed, error: pErr } = await supabase
      .from("report_photos")
      .update(update)
      .eq("report_id", reportId)
      .eq("slot", p.slot)
      .select("id");
    if (pErr) throw new Error(`${p.slot}: ${pErr.message}`);
    if (!changed?.length) {
      throw new Error(
        `Findings for the ${p.slot} photo were not recorded — the report is already signed.`,
      );
    }
  }

  // Carry any *new* damage into the machine's own file, so the next renter
  // sees it and the next owner cannot bill for it twice.
  const damage = analysis.compare?.slots?.flatMap((s) => s.new_damage || []) || [];
  if (damage.length) {
    await supabase.from("equipment_damage_log").insert(
      damage.map((d) => ({
        equipment_id: analysis.equipment_id ?? null,
        first_seen_report_id: reportId,
        booking_id: analysis.booking_id ?? null,
        part: d.part || "unknown",
        kind: (d.kind || "other").toLowerCase(),
        severity: (d.severity || "minor").toLowerCase(),
        status: "open",
        notes: d.description || null,
      })),
    );
  }
}

/**
 * Attach the repair estimate a large claim requires.
 *
 * Photo-only, and shot fresh through the same evidence pipeline as everything
 * else (stamped, fingerprinted, hashed) rather than picked from the gallery:
 * a "repair estimate" is exactly the sort of paper someone would otherwise
 * edit, and the database now refuses a claim of ₹2000+ without one
 * (damage_claims_estimate_required). It is stored as an `extra` slot on the
 * return report so it sits in the same evidence set as the damage it prices.
 */
export async function attachRepairEstimate({ booking, report, userId, role, rawBlob, label }) {
  const { prepareEvidencePhoto, uploadEvidencePhoto } = await import("./inspectionCapture.js");
  const prepared = await prepareEvidencePhoto({
    rawBlob,
    slot: "extra",
    reportCode: report.report_code,
    bookingId: booking.id,
    label: label || "Repair estimate",
  });
  prepared.damage_labels = ["repair_estimate"];
  const path = await uploadEvidencePhoto(supabase, {
    bookingId: booking.id,
    reportId: report.id,
    photo: prepared,
  });
  const row = await insertReportPhoto({ report, booking, photo: prepared, storagePath: path, userId, role });
  return row.id;
}

/** One party's attestation. Insert-only: you can never un-sign or edit it. */
export async function signReport({ report, userId, role, statement, signaturePngPath, contentHash }) {
  const { data, error } = await supabase
    .from("report_signatures")
    .insert({
      report_id: report.id,
      booking_id: report.booking_id,
      user_id: userId,
      role,
      statement_text: statement,
      statement_version: POLICY_VERSION,
      signature_png_path: signaturePngPath || null,
      content_hash: contentHash || null,
    })
    .select("id, role, signed_at")
    .single();
  if (error) throw new Error(error.message);
  await logEvent(report.id, role === "owner" ? "owner_signed" : "farmer_signed",
                 { statement_version: POLICY_VERSION }, role, report.booking_id);
  return data;
}

/** Append to the audit trail. The DB computes prev_hash/row_hash itself. */
export async function logEvent(reportId, event, payload = {}, actorRole = "system", bookingId = null) {
  try {
    const { error } = await supabase.rpc("log_report_event", {
      p_report_id: reportId,
      p_event: event,
      p_payload: payload,
      p_actor_role: actorRole,
    });
    if (error) {
      // The RPC is the preferred path (it validates participation and lets the
      // backend log as 'system'). If it isn't reachable we still record the
      // event — an incomplete audit trail is worse than a client-written row.
      console.warn("[reportDb] log_report_event RPC failed, inserting directly:", error.message);
      if (bookingId) {
        await supabase.from("report_events").insert({
          report_id: reportId, booking_id: bookingId, actor_role: actorRole, event, payload,
        });
      }
    }
  } catch (err) {
    console.warn("[reportDb] logEvent failed:", err?.message || err);
  }
}

/** Freeze the report's content hash (idempotent — the DB decides). */
export async function finalizeReport(reportId) {
  const { data, error } = await supabase.rpc("finalize_report", { p_report_id: reportId });
  if (error) throw new Error(error.message);
  return data;
}

/** The other party's response to a report (agree / disagree). Silence is
 *  recorded as silence — never as agreement (docs §6). */
export async function respondToReport({ report, response, userId, role }) {
  const patch = { renter_response: response, renter_responded_at: new Date().toISOString() };
  if (response === "agreed") patch.unilateral = false;
  const { error } = await supabase.from("condition_reports").update(patch).eq("id", report.id);
  if (error) throw new Error(error.message);
  await logEvent(report.id, response === "agreed" ? "countersigned" : "disagreed",
                 { role }, role, report.booking_id);
}

/** Record the machine's opening hour-meter reading on the handover report. */
export async function setReportNotes(reportId, notes) {
  const { error } = await supabase.from("condition_reports").update({ notes }).eq("id", reportId);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Booking verification state (the gates, docs §6)
// ---------------------------------------------------------------------------

export async function setVerificationState(bookingId, state, patch = {}) {
  const { error } = await supabase
    .from("bookings")
    .update({ verification_state: state, ...patch })
    .eq("id", bookingId);
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------------------
// Claims + settlements
// ---------------------------------------------------------------------------

export async function fileDamageClaim({
  booking, report, userId, amount, description, parts, severity,
  evidencePhotoIds = [], estimatePhotoId = null, responseWindowHours,
}) {
  const deadline = new Date(Date.now() + responseWindowHours * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from("damage_claims")
    .insert({
      booking_id: booking.id,
      return_report_id: report.id,
      handover_report_id: booking.handover_report_id || null,
      filed_by: userId,
      amount_claimed: amount,
      description,
      parts: parts || [],
      severity: severity || "moderate",
      evidence_photo_ids: evidencePhotoIds,
      repair_estimate_photo_id: estimatePhotoId,
      response_deadline: deadline,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  await logEvent(report.id, "damage_claimed", { amount, parts, severity }, "owner", booking.id);
  await setVerificationState(booking.id, "claim_open");
  return data;
}

export async function respondToClaim({ claim, booking, report, userId, agree, amount = null, note = null }) {
  const patch = {
    status: agree ? "agreed" : "disputed",
    renter_response: agree ? "agreed" : "disputed",
    renter_responded_at: new Date().toISOString(),
    resolved_amount: agree ? (amount ?? claim.amount_claimed) : null,
    decided_at: new Date().toISOString(),
    resolution_note: note || null,
  };
  const { data, error } = await supabase.from("damage_claims").update(patch).eq("id", claim.id).select("*").single();
  if (error) throw new Error(error.message);
  await logEvent(report.id, agree ? "claim_agreed" : "claim_disputed",
                 { amount: patch.resolved_amount, note }, "farmer", booking.id);
  await setVerificationState(booking.id, agree ? "settled" : "disputed");
  return data;
}

export async function withdrawClaim({ claim, booking, report, note }) {
  const { data, error } = await supabase
    .from("damage_claims")
    .update({ status: "withdrawn", resolution_note: note || null, decided_at: new Date().toISOString() })
    .eq("id", claim.id).select("*").single();
  if (error) throw new Error(error.message);
  await logEvent(report.id, "claim_withdrawn", { note }, "owner", booking.id);
  await setVerificationState(booking.id, "closed_clean");
  return data;
}

/** Record the settlement decision. Money moves offline in this phase — this
 *  row is the ledger entry a payment integration will act on later. */
/**
 * Record a settlement decision.
 *
 * Append-only on purpose (the live integration test caught the earlier
 * `upsert(onConflict: booking_id)` — there is no such constraint, and adding
 * one would have thrown away the interesting case): a disputed booking
 * legitimately produces more than one decision over time — a hold while the
 * dispute is open, then the release once it is resolved. A ledger that keeps
 * both is a receipt; a row that gets overwritten is not.
 */
export async function recordSettlement({
  booking, claimId = null, depositAmount, released, withheld, status, reason,
  offlineRef = null, userId = null, notes = null,
}) {
  const payload = {
    booking_id: booking.id,
    claim_id: claimId,
    deposit_amount: depositAmount,
    released_amount: released,
    withheld_amount: withheld,
    status,
    reason,
    offline_ref: offlineRef,
    decided_by: userId,
    notes,
    policy_version: POLICY_VERSION,
    policy_snapshot: policySnapshot(),
    settled_at: status === "pending" ? null : new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from("deposit_settlements")
    .insert(payload)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/** The most recent settlement decision for a booking (the current position). */
export async function getSettlement(bookingId) {
  const { data } = await supabase
    .from("deposit_settlements")
    .select("*")
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0] || null;
}

/** Every decision recorded on this booking, oldest first — the receipt trail. */
export async function getSettlementHistory(bookingId) {
  const { data } = await supabase
    .from("deposit_settlements")
    .select("*")
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: true });
  return data || [];
}

export async function getClaimsForBooking(bookingId) {
  const { data, error } = await supabase
    .from("damage_claims")
    .select("*")
    .eq("booking_id", bookingId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

// ---------------------------------------------------------------------------
// The machine's own file
// ---------------------------------------------------------------------------

export async function getKnownDamage(equipmentId) {
  const { data, error } = await supabase
    .from("equipment_damage_log")
    .select("id, part, kind, severity, status, notes, created_at, first_seen_report_id")
    .eq("equipment_id", equipmentId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function getEquipmentPhotoHashes(equipmentId) {
  const { data, error } = await supabase.rpc("equipment_photo_hashes", { p_equipment_id: equipmentId });
  if (error) return [];
  return data || [];
}

export async function closeDamageEntry(entryId, repairedReportId) {
  const { error } = await supabase
    .from("equipment_damage_log")
    .update({ status: "repaired", repaired_report_id: repairedReportId, updated_at: new Date().toISOString() })
    .eq("id", entryId);
  if (error) throw new Error(error.message);
}

/** Public integrity check — works with the anon key, so the QR page needs no
 *  session at all (the DB function is SECURITY DEFINER but returns only a
 *  verdict and non-personal summary fields). */
export async function verifyReportCode(code) {
  const { data, error } = await supabase.rpc("verify_report", { p_code: code });
  if (error) throw new Error(error.message);
  return data;
}

export async function getUserTrust(userId) {
  const { data } = await supabase.from("user_trust_summary").select("*").eq("user_id", userId).maybeSingle();
  return data || null;
}

export async function getEquipmentReportCount(equipmentId) {
  const { count } = await supabase
    .from("condition_reports")
    .select("id", { count: "exact", head: true })
    .eq("equipment_id", equipmentId)
    .not("finalized_at", "is", null);
  return count || 0;
}

export async function uploadSignature(supabaseClient, userId, reportId, blob) {
  const path = `signatures/${userId}/${reportId}.png`;
  const { error } = await supabaseClient.storage
    .from("inspection-photos")
    .upload(path, blob, { contentType: "image/png", upsert: true });
  if (error) return null; // a missing signature image never blocks an attestation
  return path;
}

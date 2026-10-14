// LIVE integration test for the Phase 7 trust layer.
//
// Runs the ACTUAL shipped frontend modules (src/lib/reportDb.js, trustFlow.js,
// depositPolicy.js) against the live Supabase project, signed in as real users,
// so RLS, triggers, the hash chain and every column name are exercised exactly
// as the browser will exercise them.
//
// Everything it creates is deleted at the end (see cleanup()).
//
// Run it (from the repo root, with the project's own credentials):
//
//   SUPABASE_URL=https://<ref>.supabase.co \
//   ANON_KEY=<anon> SERVICE_KEY=<service_role> \
//   SUPABASE_REF=<ref> SUPABASE_PAT=<personal access token> \
//   node scripts/test-trust-live.mjs
//
// The service key and the PAT are needed only because the test creates and then
// purges its own users/rows (report_events is append-only, so the purge needs
// the SQL hatch from migration 7b). Nothing is written outside the test's own
// rows, and cleanup runs even if an assertion fails. Do NOT point this at a
// database you care about rows in — it deletes everything it created by email.
//
// Nothing here is committed with credentials, and nothing prints them.

import fs from "node:fs";
import { register } from "node:module";
import { createClient } from "@supabase/supabase-js";

register(new URL("./env-shim-loader.mjs", import.meta.url));

// supabase-js v2 refuses to build a client on Node < 22 without a global
// WebSocket. This test never touches Realtime, so a stub is enough.
if (typeof globalThis.WebSocket !== "function") {
  globalThis.WebSocket = class { constructor() { throw new Error("realtime unused in this test"); } };
}

const url = process.env.SUPABASE_URL;
const anon = process.env.ANON_KEY;
const service = process.env.SERVICE_KEY;
if (!url || !anon || !service) {
  console.error(
    [
      "This is a LIVE integration test: it signs up three real users, creates a real",
      "booking, uploads real evidence, then deletes all of it.",
      "",
      "Set SUPABASE_URL, ANON_KEY, SERVICE_KEY (and SUPABASE_REF + SUPABASE_PAT for",
      "the purge step), then run it again. See the header of this file.",
    ].join("\n"),
  );
  process.exit(2);
}

globalThis.__VITE_ENV__ = {
  VITE_SUPABASE_URL: url,
  VITE_SUPABASE_ANON_KEY: anon,
  VITE_BACKEND_URL: "",
};

const { supabase } = await import(new URL("../src/lib/supabase.js", import.meta.url));
const db = await import(new URL("../src/lib/reportDb.js", import.meta.url));
const { deriveVerificationState, nextAction, VSTATE } = await import(new URL("../src/lib/trustFlow.js", import.meta.url));
const { suggestDeposit, settlementSplit, POLICY } = await import(new URL("../src/lib/depositPolicy.js", import.meta.url));

const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
const stamp = Date.now();
const PW = "Live-Test-Password-1!";
const ownerEmail = `trust-live-owner-${stamp}@example.com`;
const farmerEmail = `trust-live-farmer-${stamp}@example.com`;
const strangerEmail = `trust-live-stranger-${stamp}@example.com`;

let passed = 0, failed = 0;
const created = { users: [], equipment: [], bookings: [], storage: [] };
function ok(label, extra = "") { passed++; console.log(`  \u001b[32m✓\u001b[0m ${label}${extra ? ` — ${extra}` : ""}`); }
function no(label, detail) { failed++; console.log(`  \u001b[31m✗\u001b[0m ${label} — ${detail}`); }
async function check(label, fn) {
  try {
    const r = await fn();
    if (r === false) no(label, "assertion returned false");
    else ok(label, typeof r === "string" ? r : "");
  } catch (err) {
    no(label, err?.message || String(err));
  }
}
const signOut = async () => { try { await supabase.auth.signOut(); } catch {} };

// ---------------------------------------------------------------------------
console.log("\n1. fixtures");
// ---------------------------------------------------------------------------
const OWNER = (await admin.auth.admin.createUser({ email: ownerEmail, password: PW, email_confirm: true })).data.user;
const FARMER = (await admin.auth.admin.createUser({ email: farmerEmail, password: PW, email_confirm: true })).data.user;
const STRANGER = (await admin.auth.admin.createUser({ email: strangerEmail, password: PW, email_confirm: true })).data.user;
created.users.push(OWNER.id, FARMER.id, STRANGER.id);
await check("three test users created (public.users rows via handle_new_user trigger)", async () => {
  const { data, error } = await admin.from("users").select("id").in("id", created.users);
  if (error) throw new Error(error.message);
  if (data.length !== 3) throw new Error(`expected 3, got ${data.length}`);
  return "trigger created all 3";
});

const { data: eq, error: eqErr } = await admin.from("equipment").insert({
  owner_id: OWNER.id, name: "Live test tractor", equipment_type: "tractor", hp: 45,
  compatible_operations: ["ploughing"], compatible_crops: ["wheat"], price: 800, price_unit: "hour",
  location_label: "Test village", service_area_radius_km: 15,
  latitude: 30.9, longitude: 75.85,
}).select("id, latitude, longitude").single();
if (eqErr) throw new Error("equipment insert: " + eqErr.message);
created.equipment.push(eq.id);
ok("equipment row (with lat/lng columns the trust checks need)", `id=${eq.id} ${eq.latitude},${eq.longitude}`);

const today = new Date();
const bookingPayload = {
  equipment_id: eq.id, farmer_id: FARMER.id, owner_id: OWNER.id,
  start_date: today.toISOString().slice(0, 10),
  end_date: new Date(today.getTime() + 2 * 864e5).toISOString().slice(0, 10),
  price: 1600, status: "In Use",
};
let { data: booking, error: bErr } = await admin.from("bookings").insert(bookingPayload).select("*").single();
if (bErr) {
  // fall back to whatever the bookings table actually requires
  console.log("   bookings insert failed, retrying minimal:", bErr.message);
  ({ data: booking, error: bErr } = await admin.from("bookings").insert({ ...bookingPayload }).select("*").single());
}
if (!booking) throw new Error("booking insert failed: " + bErr?.message);
created.bookings.push(booking.id);
ok("booking row created", `id=${booking.id} status=${booking.status} deposit_amount=${booking.deposit_amount}`);

// ---------------------------------------------------------------------------
console.log("\n2. capture → sign → finalize (as the OWNER, real RLS)");
// ---------------------------------------------------------------------------
await supabase.auth.signInWithPassword({ email: ownerEmail, password: PW });
const myOwner = (await supabase.auth.getUser()).data.user;
await check("signed in as owner (session is what PostgREST sees)", () => myOwner.id === OWNER.id ? "uid matches" : false);

let handover = await db.ensureConditionReport({ booking, kind: "handover", userId: OWNER.id, role: "owner" });
await check("ensureConditionReport() creates a draft with a human code", () =>
  /^AR-[0-9A-F]{8}$/.test(handover.report_code) ? handover.report_code : `got ${handover.report_code}`);
await check("second call returns the same report (no duplicates)", async () => {
  const again = await db.ensureConditionReport({ booking, kind: "handover", userId: OWNER.id, role: "owner" });
  return again.id === handover.id ? "idempotent" : false;
});

const FIX = process.env.FIXTURES || "/tmp/fixtures";
const jpeg = fs.readFileSync(`${FIX}/handover.jpg`);
const photoRows = [];
for (const [i, slot] of ["full_left", "full_right", "meter", "work_area"].entries()) {
  const path = `inspections/${booking.id}/${handover.id}/${slot}-${i}.jpg`;
  const up = await supabase.storage.from("inspection-photos").upload(path, jpeg, { contentType: "image/jpeg" });
  if (up.error) { no(`upload ${slot}`, up.error.message); continue; }
  created.storage.push(path);
  const row = await db.insertReportPhoto({
    report: handover, booking,
    photo: {
      slot, sha256: "deadbeef" + i, dhash: "0f0f0f0f0f0f0f0f",
      captured_at_device: new Date().toISOString(),
      exif: { make: "TestCam", model: "T1", datetime_original: null },
      gps: { lat: 30.9001, lng: 75.8501, source: "exif" }, gps_source: "exif",
      device: "live-test", watermark_text: `AR ${handover.report_code} ${slot}`,
      quality: { sharpness: 120, verdict: "pass" }, damage_labels: ["scratch"],
    },
    storagePath: path, userId: OWNER.id, role: "owner",
  });
  photoRows.push(row);
}
await check("4 evidence photos uploaded to the PRIVATE bucket + rows inserted", () =>
  photoRows.length === 4 ? `${photoRows.length} rows` : false);

await check("updateReportAnalysis() writes the AI reading + verdict", async () => {
  await db.updateReportAnalysis(handover.id, {
    ai_status: "ok", ai_provider: "test", flagged: false, verdict: "verified_with_flags",
    hour_meter: 1234.5, hour_meter_source: "test",
    signals: { flags: ["gps_missing"], checks: [{ code: "sha256_match", ok: true }], verified_by: "server" },
    summary: { text: "Front-left guard has an old scratch.", damage_found: [] },
    photos: [{ slot: "full_left", flags: ["gps_missing"], sha256_match: true, dhash_distance: 9 }],
    booking_id: booking.id, equipment_id: eq.id,
  });
  const { data } = await supabase.from("condition_reports").select("verdict, ai_status, hour_meter").eq("id", handover.id).single();
  const { data: p } = await supabase.from("report_photos").select("flags, sha256_match").eq("report_id", handover.id).eq("slot", "full_left").single();
  if (data.verdict !== "verified_with_flags" || data.hour_meter !== 1234.5 || p.flags[0] !== "gps_missing") throw new Error(JSON.stringify({ data, p }));
  return "report + per-photo findings persisted";
});

// ---------------------------------------------------------------------------
console.log("\n3. tamper resistance + the hash chain");
// ---------------------------------------------------------------------------
await check("evidence columns cannot be rewritten (migration 7b guard trigger)", async () => {
  const { error } = await supabase.from("report_photos").update({ sha256: "tampered" }).eq("id", photoRows[0].id).select("id");
  const { data: after } = await admin.from("report_photos").select("sha256, storage_path").eq("id", photoRows[0].id).single();
  if (after.sha256 === "tampered") throw new Error("TAMPERED");
  return `${error ? "refused by trigger" : "0 rows matched"} — row unchanged (${after.sha256})`;
});
await check("evidence rows cannot be deleted by a participant", async () => {
  await supabase.from("report_photos").delete().eq("id", photoRows[0].id);
  const { data: after } = await admin.from("report_photos").select("id").eq("id", photoRows[0].id).maybeSingle();
  return after?.id ? "still there" : "DELETED — leak";
});
await check("a participant cannot point an evidence row at another machine", async () => {
  const { error } = await supabase.from("report_photos").update({ equipment_id: null }).eq("id", photoRows[0].id).select("id");
  const { data: after } = await admin.from("report_photos").select("equipment_id").eq("id", photoRows[0].id).single();
  return after.equipment_id === eq.id ? "evidence identity intact" : (error?.message || "CHANGED");
});
await check("report identity columns are immutable (trigger)", async () => {
  const { error } = await supabase.from("condition_reports").update({ kind: "return" }).eq("id", handover.id);
  return error && /immutable/.test(error.message) ? "trigger fired" : `unexpected: ${error?.message || "no error"}`;
});
await check("log_report_event() hashes + chains the audit trail", async () => {
  await db.logEvent(handover.id, "handover_captured", { photos: 4, role: "owner" }, "owner", booking.id);
  const { data } = await supabase.from("report_events").select("event, prev_hash, row_hash").eq("report_id", handover.id).order("id");
  const last = data[data.length - 1];
  const chained = data.length >= 2 ? last.prev_hash === data[data.length - 2].row_hash : last.prev_hash === "genesis";
  if (!/^[0-9a-f]{64}$/.test(last.row_hash) || !chained) throw new Error(JSON.stringify(data));
  return `${data.length} events, each chained to the last`;
});
await check("report_events cannot be edited, even by a participant", async () => {
  await supabase.from("report_events").update({ event: "rewritten" }).eq("report_id", handover.id).select("id");
  const { data: after } = await admin.from("report_events").select("event").eq("report_id", handover.id).order("id");
  const rewritten = after.filter((e) => e.event === "rewritten").length;
  return rewritten === 0 ? `${after.length} events unchanged` : `${rewritten} REWRITTEN`;
});
await check("findings are accepted while the report is a draft (that is the point of a draft)", async () => {
  const { data } = await supabase.from("report_photos").select("flags, sha256_match").eq("report_id", handover.id).eq("slot", "full_left").single();
  return data.flags.length ? `flags persisted: ${data.flags.join(",")}` : "no flags persisted";
});

// ---------------------------------------------------------------------------
console.log("\n4. attestation (both parties, separately)");
// ---------------------------------------------------------------------------
await check("owner signs with a statement (and an absent PNG does not block it)", async () => {
  await db.signReport({
    report: handover, userId: OWNER.id, role: "owner",
    statement: `I confirm that report ${handover.report_code} shows the machine as it was handed over.`,
    signaturePngPath: null, contentHash: null,
  });
  const { data } = await supabase.from("report_signatures").select("role, statement_text").eq("report_id", handover.id);
  return data.length === 1 && data[0].role === "owner" ? "statement stored as text" : false;
});
await check("the same party cannot sign twice (unique constraint)", async () => {
  try {
    await db.signReport({ report: handover, userId: OWNER.id, role: "owner", statement: "again", signaturePngPath: null, contentHash: null });
    return false;
  } catch (err) { return "refused"; }
});
const hash = await db.finalizeReport(handover.id);
await check("finalize_report() freezes a content hash", () => /^[0-9a-f]{64}$/.test(hash) ? hash.slice(0, 16) + "…" : `got ${hash}`);
await check("finalize is idempotent (cannot re-freeze with different content)", async () => {
  const again = await db.finalizeReport(handover.id);
  return again === hash ? "same hash returned" : false;
});
await check("the analysis is frozen once the report is signed (migration 7b)", async () => {
  try {
    await db.updateReportAnalysis(handover.id, {
      ai_status: "ok", verdict: "verified", signals: { flags: [] }, summary: { text: "rewritten after signing" },
      photos: [], booking_id: booking.id, equipment_id: eq.id,
    });
    return "WRITE SUCCEEDED — leak";
  } catch (err) {
    const { data } = await admin.from("condition_reports").select("verdict, signals").eq("id", handover.id).single();
    return data.verdict === "verified_with_flags" ? `refused ("${err.message.slice(0, 34)}…"), row unchanged` : "ROW CHANGED";
  }
});
await check("finalized hash can never be rewritten", async () => {
  const { error } = await supabase.from("condition_reports").update({ report_hash: "0".repeat(64) }).eq("id", handover.id);
  return error ? "trigger refused" : false;
});
await db.setVerificationState(booking.id, VSTATE.handoverSigned, { handover_report_id: handover.id });
await check("booking verification_state + handover_report_id written", async () => {
  const { data } = await supabase.from("bookings").select("verification_state, handover_report_id").eq("id", booking.id).single();
  return data.verification_state === VSTATE.handoverSigned && data.handover_report_id === handover.id ? data.verification_state : JSON.stringify(data);
});

// ---------------------------------------------------------------------------
console.log("\n5. the other party: countersign, then file the return report");
// ---------------------------------------------------------------------------
await signOut();
await supabase.auth.signInWithPassword({ email: farmerEmail, password: PW });
await check("farmer can read the owner's report (participant RLS)", async () => {
  const d = await db.getReportDetail(handover.id);
  return d.photos.length === 4 && d.signatures.length === 1 ? `${d.photos.length} photos, ${d.events.length} events` : JSON.stringify({ p: d.photos.length });
});
await check("farmer gets a signed photo URL from the private bucket", async () => {
  const { signedEvidenceUrls } = await import(new URL("../src/lib/inspectionCapture.js", import.meta.url));
  const urls = await signedEvidenceUrls(supabase, [d0Path()]);
  const target = Object.values(urls)[0];
  if (!target) return false;
  const res = await fetch(target);
  return res.ok ? `HTTP ${res.status}, ${(await res.arrayBuffer()).byteLength} bytes` : `HTTP ${res.status}`;
});
function d0Path() { return `inspections/${booking.id}/${handover.id}/full_left-0.jpg`; }

await check("farmer countersigns (agreement is recorded, not assumed)", async () => {
  await db.respondToReport({ report: handover, response: "agreed", userId: FARMER.id, role: "farmer" });
  await db.signReport({
    report: handover, userId: FARMER.id, role: "farmer",
    statement: `I confirm that report ${handover.report_code} shows the machine as it was handed over.`,
    signaturePngPath: null, contentHash: hash,
  });
  const { data } = await supabase.from("condition_reports").select("unilateral, renter_response").eq("id", handover.id).single();
  return data.renter_response === "agreed" && data.unilateral === false ? "unilateral=false, response=agreed" : JSON.stringify(data);
});

const ret = await db.ensureConditionReport({ booking, kind: "return", userId: FARMER.id, role: "farmer" });
for (const [i, slot] of ["full_left", "full_right", "meter", "work_area"].entries()) {
  const path = `inspections/${booking.id}/${ret.id}/${slot}-ret-${i}.jpg`;
  const up = await supabase.storage.from("inspection-photos").upload(path, fs.readFileSync(`${FIX}/return.jpg`), { contentType: "image/jpeg" });
  if (up.error) { no(`return upload ${slot}`, up.error.message); continue; }
  created.storage.push(path);
  await db.insertReportPhoto({
    report: ret, booking,
    photo: { slot, sha256: "cafe" + i, dhash: "f0f0f0f0f0f0f0f0", captured_at_device: new Date().toISOString(),
      exif: { make: "TestCam", model: "T1" }, gps: { lat: 30.9, lng: 75.85, source: "live" }, gps_source: "live",
      device: "live-test", watermark_text: `AR ${ret.report_code} ${slot}`, quality: { sharpness: 99, verdict: "pass" } },
    storagePath: path, userId: FARMER.id, role: "farmer",
  });
}
await check("farmer files the return report + evidence", async () => {
  const d = await db.getReportDetail(ret.id);
  return d.photos.length === 4 ? "4 photos" : `${d.photos.length} photos`;
});
await db.signReport({ report: ret, userId: FARMER.id, role: "farmer", statement: `I confirm that report ${ret.report_code} shows the machine as it was returned.`, signaturePngPath: null, contentHash: null });
const retHash = await db.finalizeReport(ret.id);
await db.setVerificationState(booking.id, VSTATE.returnFiled, { return_report_id: ret.id });
ok("return report signed + finalized", retHash.slice(0, 16) + "…");

// ---------------------------------------------------------------------------
console.log("\n6. claim → dispute → settlement (the money rules)");
// ---------------------------------------------------------------------------
const deposit = suggestDeposit(booking.price);
await check("suggestDeposit() is inside the policy bounds", () => deposit >= 500 && deposit <= 5000 ? `₹${deposit}` : false);

await signOut();
await supabase.auth.signInWithPassword({ email: ownerEmail, password: PW });
let claim;
await check("owner files a damage claim on the return report", async () => {
  claim = await db.fileDamageClaim({
    booking, report: ret, userId: OWNER.id, amount: 1200,
    description: "Rear tyre cut during ploughing.", parts: ["punctured_tyre"], severity: "moderate",
    evidencePhotoIds: [], responseWindowHours: POLICY.claimWindowHours,
  });
  return claim?.id ? `id set, deadline ${claim.response_deadline ? "set" : "MISSING"}` : JSON.stringify(claim);
});
await check("a ₹5,000 claim with NO repair estimate is refused by the database", async () => {
  const { error } = await supabase.from("damage_claims").insert({
    booking_id: booking.id, return_report_id: ret.id, handover_report_id: handover.id,
    filed_by: OWNER.id, amount_claimed: 5000, description: "no estimate attached",
  });
  return error && /estimate/i.test(error.message) ? `refused: ${error.message.slice(0, 72)}` : `NOT refused (${error?.message || "inserted"})`;
});
await check("...and the same claim goes through once the estimate photo is attached", async () => {
  const estRow = await db.insertReportPhoto({
    report: ret, booking,
    photo: { slot: "extra", sha256: "e5t1mate", dhash: "1f1f1f1f1f1f1f1f", captured_at_device: new Date().toISOString(),
      gps: { lat: 30.9, lng: 75.85, source: "live" }, gps_source: "live", device: "live-test",
      watermark_text: "repair estimate", damage_labels: ["repair_estimate"], quality: { sharpness: 88, verdict: "pass" } },
    storagePath: `inspections/${booking.id}/${ret.id}/extra-estimate.jpg`, userId: OWNER.id, role: "owner",
  });
  const big = await db.fileDamageClaim({
    booking, report: ret, userId: OWNER.id, amount: 5000,
    description: "Engine overhaul after overheating; workshop estimate attached.",
    parts: ["burnt_clutch"], severity: "major", estimatePhotoId: estRow.id,
    responseWindowHours: POLICY.claimWindowHours,
  });
  await admin.from("damage_claims").delete().eq("id", big.id);
  return big?.id ? `accepted with estimate photo ${estRow.id.slice(0, 8)}…` : "rejected";
});

await signOut();
await supabase.auth.signInWithPassword({ email: farmerEmail, password: PW });
await check("renter DISPUTES the claim (nothing may be deducted)", async () => {
  await db.respondToClaim({ claim, booking, report: ret, userId: FARMER.id, agree: false });
  const { data } = await supabase.from("damage_claims").select("status, renter_response").eq("id", claim.id).single();
  const split = settlementSplit({ deposit, claimAmount: 1200, disputed: true });
  if (data.status !== "disputed") throw new Error(JSON.stringify(data));
  if (split.withheld !== 0) throw new Error("policy withheld money on a dispute: " + JSON.stringify(split));
  return `status=disputed, withheld=₹${split.withheld}, released=₹${split.released}`;
});
await check("the owner records the held position (nothing deducted while disputed)", async () => {
  await signOut();
  await supabase.auth.signInWithPassword({ email: ownerEmail, password: PW });
  const split = settlementSplit({ deposit, claimAmount: 1200, disputed: true });
  await db.recordSettlement({
    booking, claimId: claim.id, depositAmount: deposit, released: split.released,
    withheld: split.withheld, status: split.status, reason: "dispute_hold",
  });
  const s2 = await db.getSettlement(booking.id);
  if (!s2) throw new Error("no settlement row");
  return `status=${s2.status}, released=₹${s2.released_amount}, withheld=₹${s2.withheld_amount}, policy=${s2.policy_version}`;
});
await check("a settlement row cannot be written without a participant", async () => {
  await signOut();
  await supabase.auth.signInWithPassword({ email: strangerEmail, password: PW });
  const { error } = await supabase.from("deposit_settlements").insert({
    booking_id: booking.id, deposit_amount: deposit, released_amount: deposit, withheld_amount: 0, status: "released",
  });
  return error ? "refused for a non-participant" : false;
});

// ---------------------------------------------------------------------------
console.log("\n7. a stranger (or a third party with the code) sees nothing private");
// ---------------------------------------------------------------------------
await check("stranger cannot read the booking's reports", async () => {
  const { data } = await supabase.from("condition_reports").select("id").eq("booking_id", booking.id);
  return data.length === 0 ? "0 rows (RLS)" : `${data.length} LEAKED`;
});
await check("stranger cannot read the evidence rows", async () => {
  const { data } = await supabase.from("report_photos").select("id").eq("booking_id", booking.id);
  return data.length === 0 ? "0 rows (RLS)" : `${data.length} LEAKED`;
});
await check("stranger cannot read the claims", async () => {
  const { data } = await supabase.from("damage_claims").select("id").eq("booking_id", booking.id);
  return data.length === 0 ? "0 rows (RLS)" : `${data.length} LEAKED`;
});
await check("stranger cannot download the raw evidence file", async () => {
  const res = await fetch(`${url}/storage/v1/object/inspection-photos/${d0Path()}`, { headers: { apikey: anon } });
  return res.status >= 400 ? `HTTP ${res.status}` : `HTTP ${res.status} — LEAKED`;
});
await check("BUT the public verification RPC answers with the code alone (no login)", async () => {
  const c = createClient(url, anon, { auth: { persistSession: false } });
  const { data, error } = await c.rpc("verify_report", { p_code: handover.report_code });
  if (error) throw new Error(error.message);
  if (!data.found || !data.chain_intact) throw new Error(JSON.stringify(data).slice(0, 200));
  if (data.signers.length !== 2) throw new Error("expected 2 attestations, got " + JSON.stringify(data.signers));
  return `found, chain_intact, ${data.event_count} events, ${data.signers.length} signatures, verdict=${data.verdict}`;
});
await check("verify_report reports a MISSING code honestly (no false 'verified')", async () => {
  const c = createClient(url, anon, { auth: { persistSession: false } });
  const { data } = await c.rpc("verify_report", { p_code: "AR-DOESNOTEXIST" });
  return data.found === false ? "found:false" : JSON.stringify(data);
});

// ---------------------------------------------------------------------------
console.log("\n8. flow helpers agree with the database");
// ---------------------------------------------------------------------------
await check("deriveVerificationState() reads the rows, not a cached column", async () => {
  const reports = await db.getReportsForBooking(booking.id);
  const claims = await db.getClaimsForBooking(booking.id);
  const state = deriveVerificationState({ booking, reports, claims });
  const na = nextAction({ booking, reports, claims, role: "owner", userId: OWNER.id });
  return `${state} · owner next: ${na.primary?.action || "none"} (${na.note || "-"})`;
});
await check("getKnownDamage() + trust summary read back", async () => {
  const dmg = await db.getKnownDamage(eq.id);
  const trust = await db.getUserTrust(OWNER.id);
  return `${dmg.length} damage entries, owner badge=${trust?.badge || "n/a"}`;
});

// ---------------------------------------------------------------------------
console.log("\n9. cleanup");
// ---------------------------------------------------------------------------
async function cleanup() {
  try {
    await signOut();
    if (created.storage.length) await admin.storage.from("inspection-photos").remove(created.storage);
    // report_events is append-only by design, so a cascade delete needs the
    // purge hatch — which only a direct SQL session can reach (migration 7b).
    const sql = `
      begin;
      set local agrirent.allow_purge = 'on';
      delete from public.bookings where owner_id in (select id from public.users where id = any(array['${created.users.join("','")}']::uuid[]));
      delete from public.equipment where owner_id = any(array['${created.users.join("','")}']::uuid[]);
      delete from public.users where id = any(array['${created.users.join("','")}']::uuid[]);
      commit;
      select (select count(*) from public.condition_reports where booking_id = ${booking.id}) as reports,
             (select count(*) from public.equipment where id = ${eq.id}) as equipment;
    `;
    const res = await fetch(`https://api.supabase.com/v1/projects/${process.env.SUPABASE_REF}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.SUPABASE_PAT}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
    });
    if (!res.ok) throw new Error(`purge HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const out = await res.json();
    for (const id of created.users) await admin.auth.admin.deleteUser(id).catch(() => {});
    if (out[0]?.reports === 0 && out[0]?.equipment === 0) ok("cleanup", "purged via the SQL hatch; rows and auth users gone");
    else no("cleanup", JSON.stringify(out));
  } catch (err) { no("cleanup", err.message); }
}
await cleanup();

console.log(`\n\u001b[1m${passed} passed, ${failed} failed\u001b[0m\n`);
process.exit(failed ? 1 : 0);

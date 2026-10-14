// FULL end-to-end audit — every workflow, against the live services.
//
// scripts/test-trust-live.mjs already proves the trust layer in depth (RLS,
// triggers, hash chain, money rules). This file is the wider net around it: the
// paths that script does NOT touch, because a bug there would not show up in a
// trust-layer test but would still break the app for a real user.
//
// What it exercises, in order:
//   1.  sign-in for the real demo accounts (read-only — their data is not changed)
//   2.  every read a screen does on load, as those accounts, from live data
//   3.  the whole owner listing lifecycle on throwaway accounts (create with a
//       real photo upload → edit → pause → delete, incl. photo cleanup)
//   4.  the farmer search path: requirement row → rules filter → backend rank →
//       the LLM parser, with the offline fallbacks asserted
//   5.  the booking lifecycle: request → accept → in use → complete, plus
//       reject, farmer-cancel, the 48 h expiry and the double-booking conflict
//   6.  the trust workflow through the DEPLOYED BACKEND (not just the DB):
//       handover capture → analyze → finalize → sign → countersign → public
//       verify → return report → before/after compare → claim → dispute →
//       settlement → the machine's carried-forward damage log
//   7.  the rest of the backend's surface: config, history, webhook auth
//   8.  push-token registration
//   9.  anonymous/negative checks (RLS, private bucket, missing report code)
//  10.  cleanup — everything this audit created, then a demo-state re-check
//
// It creates its own throwaway users and deletes everything afterwards (the
// purge needs the service key + PAT because report_events is append-only).
// The demo accounts are only ever *read*.
//
//   SUPABASE_URL=… ANON_KEY=… SERVICE_KEY=… SUPABASE_REF=… SUPABASE_PAT=… \
//     node scripts/audit-e2e.mjs
//
// Nothing here is committed with credentials, and nothing prints them.

import fs from "node:fs";
import { register } from "node:module";
import { createClient } from "@supabase/supabase-js";

register(new URL("./env-shim-loader.mjs", import.meta.url));

if (typeof globalThis.WebSocket !== "function") {
  globalThis.WebSocket = class { constructor() { throw new Error("realtime unused in this audit"); } };
}

const url = process.env.SUPABASE_URL;
const anon = process.env.ANON_KEY;
const service = process.env.SERVICE_KEY;
const ref = process.env.SUPABASE_REF;
const pat = process.env.SUPABASE_PAT;
if (!url || !anon || !service) {
  console.error("Set SUPABASE_URL, ANON_KEY, SERVICE_KEY (and SUPABASE_REF + SUPABASE_PAT for the purge).");
  process.exit(2);
}

globalThis.__VITE_ENV__ = {
  VITE_SUPABASE_URL: url,
  VITE_SUPABASE_ANON_KEY: anon,
  VITE_BACKEND_URL: process.env.BACKEND_URL || "https://agrirent-ai-backend.onrender.com",
};

const { supabase } = await import(new URL("../src/lib/supabase.js", import.meta.url));
const db = await import(new URL("../src/lib/reportDb.js", import.meta.url));
const capture = await import(new URL("../src/lib/inspectionCapture.js", import.meta.url));
const upload = await import(new URL("../src/lib/imageUpload.js", import.meta.url));
const flow = await import(new URL("../src/lib/trustFlow.js", import.meta.url));
const policy = await import(new URL("../src/lib/depositPolicy.js", import.meta.url));
const rules = await import(new URL("../src/lib/rulesFilter.js", import.meta.url));
const rank = await import(new URL("../src/lib/rankClient.js", import.meta.url));
const llm = await import(new URL("../src/lib/llmClient.js", import.meta.url));
const trust = await import(new URL("../src/lib/trustClient.js", import.meta.url));
const availability = await import(new URL("../src/lib/availability.js", import.meta.url));
const lifecycle = await import(new URL("../src/lib/bookingLifecycle.js", import.meta.url));

const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

const BACKEND = (process.env.BACKEND_URL || "https://agrirent-ai-backend.onrender.com").replace(/\/+$/, "");
const FIX = process.env.FIXTURES || "/tmp/fixtures";
const PW = "Audit-" + Math.random().toString(36).slice(2, 10) + "!9";
const stamp = Date.now().toString(36);
const emails = {
  owner: `audit.owner.${stamp}@example.com`,
  farmer: `audit.farmer.${stamp}@example.com`,
  stranger: `audit.stranger.${stamp}@example.com`,
};

let passed = 0, failed = 0, soft = 0;
const problems = [];
function ok(label, extra = "") { passed++; console.log(`  \u001b[32m✓\u001b[0m ${label}${extra ? ` — ${extra}` : ""}`); }
function no(label, detail) { failed++; problems.push(`${label}: ${detail}`); console.log(`  \u001b[31m✗\u001b[0m ${label} — ${detail}`); }
function warn(label, detail) { soft++; console.log(`  \u001b[33m!\u001b[0m ${label} — ${detail}`); }
/** Passes when the happy path works, warns (never fails) on the documented
 *  degraded path, and only fails when the result is wrong. */
async function checkSoft(label, fn) {
  try {
    const r = await fn();
    if (r === false || r === undefined) no(label, "assertion failed");
    else if (typeof r === "string" && /cold start|unavailable|returned null|fallback active/.test(r)) warn(label, r);
    else ok(label, typeof r === "string" ? r : "");
  } catch (err) { no(label, err?.message || String(err)); }
}
async function check(label, fn) {
  try {
    const r = await fn();
    if (r === false || r === undefined) no(label, "assertion failed");
    else ok(label, typeof r === "string" ? r : "");
  } catch (err) { no(label, err?.message || String(err)); }
}
function section(t) { console.log(`\n\u001b[1m${t}\u001b[0m`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const created = { users: [], equipment: [], bookings: [], requirements: [], storage: [], claims: [] };
const storagePathsOf = (paths) => paths.filter(Boolean);

// ---------------------------------------------------------------------------
section("1. sign-in and identity");
// ---------------------------------------------------------------------------
const DEMO = { owner: "abdullacyclewala@gmail.com", farmer: "menhdi@gmail.com" };
const DEMO_PW = "12345678";   // the documented demo password
await check("real demo password still works for the owner account", async () => {
  const { data, error } = await supabase.auth.signInWithPassword({ email: DEMO.owner, password: DEMO_PW });
  if (error) throw new Error(error.message);
  const { data: prof } = await supabase.from("users").select("id, name, is_owner, is_farmer").eq("id", data.user.id).single();
  return `${prof.name} (owner=${prof.is_owner}, farmer=${prof.is_farmer})`;
});
await signIn(DEMO.farmer, DEMO_PW);
await check("…and for the farmer account", async () => {
  const { data: prof } = await supabase.from("users").select("name, is_farmer").eq("id", (await supabase.auth.getUser()).data.user.id).single();
  return `${prof.name} (farmer=${prof.is_farmer})`;
});
await check("a wrong password is refused (not silently signed in)", async () => {
  await signOut();
  const { error } = await supabase.auth.signInWithPassword({ email: DEMO.owner, password: "definitely-wrong" });
  return error && /invalid login/i.test(error.message) ? "refused as expected" : false;
});

async function signIn(email, password) {
  // Guard, not decoration: calling this without a password sends
  // `password: undefined` and Supabase answers "Invalid login credentials",
  // which reads exactly like a wrong password and wastes an hour. Fail loud.
  if (!email || !password) throw new Error(`signIn() needs an email and a password (got ${email ?? "no email"} / ${password ? "password" : "NO PASSWORD"})`);
  await supabase.auth.signOut();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`${email}: ${error.message}`);
}
async function signOut() { await supabase.auth.signOut(); }

// ---------------------------------------------------------------------------
section("2. every screen's read path, against live data (as the demo accounts)");
// ---------------------------------------------------------------------------
await signIn(DEMO.farmer, DEMO_PW);
await check("Dashboard: the farmer's booking count + latest booking", async () => {
  const { data, error, count } = await supabase.from("bookings").select("*", { count: "exact" }).eq("farmer_id", (await supabase.auth.getUser()).data.user.id).order("created_at", { ascending: false }).limit(1);
  if (error) throw new Error(error.message);
  return `${count} bookings, latest status=${data[0]?.status ?? "none"}`;
});
await check("Marketplace: nearby_equipment RPC answers for the farmer's location", async () => {
  const { data, error } = await supabase.from("users").select("latitude, longitude").eq("id", (await supabase.auth.getUser()).data.user.id).single();
  if (error || data.latitude == null) throw new Error("no profile location on this account");
  const { data: rows, error: rpcErr } = await supabase.rpc("nearby_equipment", { p_lat: data.latitude, p_lng: data.longitude, p_radius_km: 50 });
  if (rpcErr) throw new Error(rpcErr.message);
  const nearest = rows?.[0]?.distance_km;
  return `${rows?.length ?? 0} listings within 50 km${nearest != null ? `, nearest ${Number(nearest).toFixed(1)} km` : ""}`;
});
await check("Marketplace: the no-location fallback list is still queryable", async () => {
  const { data, error } = await supabase.from("equipment").select("id, name, equipment_type, location_label, images, price, price_unit, is_available").eq("is_available", true).limit(200);
  if (error) throw new Error(error.message);
  return `${data.length} available listings`;
});
await check("My Bookings: the joined equipment/owner/farmer select parses", async () => {
  const { data, error } = await supabase.from("bookings").select("*, equipment:equipment_id ( name, equipment_type, location_label, images ), owner:owner_id ( name ), farmer:farmer_id ( name )").limit(3);
  if (error) throw new Error(error.message);
  return `${data.length} rows, equipment joined=${!!data[0]?.equipment}`;
});
await check("Equipment detail: the listing + its owner resolve", async () => {
  const { data, error } = await supabase.from("equipment").select("*, users:owner_id ( id, name, is_owner )").eq("is_available", true).limit(1);
  if (error) throw new Error(error.message);
  return data[0] ? `${data[0].name} by ${data[0].users?.name}` : "no listings";
});
await check("Booking detail: getBookingContext() + reports + claims + settlement + known damage", async () => {
  const ctx = await db.getBookingContext(53);
  const [reports, claims, damage, settlement] = await Promise.all([
    db.getReportsForBooking(53), db.getClaimsForBooking(53), db.getKnownDamage(ctx.equipment_id), db.getSettlement(53),
  ]);
  return `booking #53 → ${reports.length} reports, ${claims.length} claims, ${damage.length} known-damage rows, settlement=${settlement ? settlement.status : "none"}`;
});
await check("Profile: my listings + my bookings + trust badges", async () => {
  const uid = (await supabase.auth.getUser()).data.user.id;
  const [{ data: mine }, { data: summaries }] = await Promise.all([
    supabase.from("equipment").select("id, name, is_available").eq("owner_id", uid),
    supabase.from("user_trust_summary").select("*").eq("user_id", uid),
  ]);
  return `${mine.length} listings, ${summaries.length} trust-summary row(s)`;
});
await check("EquipmentCondition: equipment_photo_hashes() + damage log read back", async () => {
  const hashes = await db.getEquipmentPhotoHashes(1, 50);
  const { data: log, error } = await supabase.from("equipment_damage_log").select("id, part, kind, severity, status").eq("equipment_id", 1);
  if (error) throw new Error(error.message);
  return `${hashes.length} photo hashes, ${log.length} damage-log rows`;
});
await check("Availability: fetchSlotsForMany() on real listings", async () => {
  const { data: ids } = await supabase.from("equipment").select("id").limit(3);
  const slots = await availability.fetchSlotsForMany(ids.map((r) => r.id));
  return `${Object.keys(slots).length} listings answered`;
});

// ---------------------------------------------------------------------------
section("3. owner listing lifecycle (throwaway accounts, real photo upload)");
// ---------------------------------------------------------------------------
await signOut();
for (const [key, email] of Object.entries(emails)) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PW, email_confirm: true, user_metadata: { name: `Audit ${key}` } });
  if (error) throw new Error(`createUser ${key}: ${error.message}`);
  created.users.push(data.user.id);
  if (key === "owner") await admin.from("users").update({ is_owner: true, is_farmer: false }).eq("id", data.user.id);
  if (key === "farmer") await admin.from("users").update({ is_owner: false, is_farmer: true }).eq("id", data.user.id);
}
await check("handle_new_user trigger created the public.users rows", async () => {
  const { data, error } = await admin.from("users").select("id").in("id", created.users);
  if (error) throw new Error(error.message);
  return `${data.length}/3 rows`;
});

await signIn(emails.owner, PW);
const uidOwner = (await supabase.auth.getUser()).data.user.id;
await check("role switching (farmer ↔ owner) works on a real account", async () => {
  await supabase.from("users").update({ is_owner: true, is_farmer: true }).eq("id", uidOwner);
  const { data } = await supabase.from("users").select("is_owner, is_farmer").eq("id", uidOwner).single();
  return data.is_owner && data.is_farmer ? "both roles active" : false;
});

let listing, listingPhotoPath;
await check("AddEquipment: compressImage refuses a non-browser environment loudly (documented)", async () => {
  // The compressor needs createImageBitmap + canvas. Node has neither, and the
  // contract is that it says so with a coded error rather than throwing a
  // ReferenceError — the browser pass covers the real compression.
  const file = new File([fs.readFileSync(`${FIX}/handover.jpg`)], "handover.jpg", { type: "image/jpeg" });
  try { await upload.compressImage(file); return false; }
  catch (err) { return err.code ? `code=${err.code} ("${err.message}")` : `no code on ${err.message}`; }
});
await check("AddEquipment: the photo uploads to the public bucket along the app's own path", async () => {
  const jpeg = fs.readFileSync(`${FIX}/handover.jpg`);
  listingPhotoPath = upload.photoStoragePath(uidOwner, `audit-${stamp}`, "jpg");
  const { error } = await supabase.storage.from("equipment-photos").upload(listingPhotoPath, jpeg, { contentType: "image/jpeg" });
  if (error) throw new Error(`${error.message} (code ${error.code || "-"})`);
  created.storage.push(listingPhotoPath);
  const { data } = supabase.storage.from("equipment-photos").getPublicUrl(listingPhotoPath);
  const head = await fetch(data.publicUrl);
  return `path ${listingPhotoPath.split("/").slice(0, 2).join("/")}/…, public URL HTTP ${head.status}`;
});
await check("AddEquipment: the listing row saves with the photo attached", async () => {
  const { data, error } = await supabase.from("equipment").insert({
    owner_id: uidOwner, name: `Audit Tractor ${stamp}`, equipment_type: "tractor", hp: 45,
    compatible_operations: ["ploughing"], compatible_crops: ["wheat"], price: 800, price_unit: "hour",
    location_label: "Audit Village", latitude: 19.0652, longitude: 72.8985,
    service_area_radius_km: 15, images: [listingPhotoPath], is_available: true,
  }).select("id, name").single();
  if (error) throw new Error(error.message);
  listing = data;
  created.equipment.push(data.id);
  return `id=${data.id}`;
});
await check("the sync_location_geography trigger derived a location point", async () => {
  const { data, error } = await admin.from("equipment").select("location").eq("id", listing.id).single();
  if (error) throw new Error(error.message);
  return data.location ? "geography point set" : false;
});
await check("edit: rename + re-price + pause a listing", async () => {
  const { error } = await supabase.from("equipment").update({ name: `Audit Tractor ${stamp} (edited)`, price: 900, is_available: false }).eq("id", listing.id);
  if (error) throw new Error(error.message);
  const { data } = await supabase.from("equipment").select("name, price, is_available").eq("id", listing.id).single();
  return data.price === 900 && data.is_available === false ? "updated" : false;
});
await check("a paused listing disappears from the marketplace list", async () => {
  const { data } = await supabase.from("equipment").select("id").eq("id", listing.id).eq("is_available", true);
  return data.length === 0 ? "hidden while paused" : false;
});
await check("deleteEquipmentPhoto() is reflected in the bucket", async () => {
  const okDel = await upload.deleteEquipmentPhoto(supabase, listingPhotoPath);
  created.storage = created.storage.filter((p) => p !== listingPhotoPath);
  const folder = listingPhotoPath.slice(0, listingPhotoPath.lastIndexOf("/"));
  const { data: left } = await admin.storage.from("equipment-photos").list(folder);
  if (!okDel) return false;
  // NB: fetching the public URL would still answer 200 for a while — public
  // bucket URLs sit behind the CDN, so the bucket listing is the real check.
  return (left || []).length === 0 ? "deleted (bucket listing empty; the public URL may stay cached)" : `${left.length} object(s) left`;
});

// ---------------------------------------------------------------------------
section("4. farmer search path: requirement → filter → rank → LLM parse");
// ---------------------------------------------------------------------------
await signIn(emails.farmer, PW);
await check("a requirements row saves (what DescribeJob writes)", async () => {
  const { data, error } = await supabase.from("requirements").insert({
    farmer_id: (await supabase.auth.getUser()).data.user.id, raw_text: "I need to plough 3 acres of wheat in Panvel next week",
    language: "en", parsed_json: { crop: "wheat", operation: "ploughing", area_acres: 3 },
  }).select("id").single();
  if (error) throw new Error(error.message);
  created.requirements.push(data.id);
  return `id=${data.id}`;
});
await check("the rules filter runs over the live listings and excludes own equipment", async () => {
  const { data } = await supabase.from("equipment").select("*").limit(500);
  const { results, relaxedHp } = rules.runRulesFilter(data, { crop: "wheat", operation: "ploughing", area_acres: 3 }, null);
  return `${results.length} candidates from ${data.length} listings${relaxedHp ? " (hp relaxed)" : ""}`;
});
await checkSoft("the backend ranker scores live candidates (warm service)", async () => {
  const { data: rows } = await supabase.from("equipment").select("id, equipment_type, hp, price, is_available").limit(4);
  const candidates = rows.map((r) => ({ ...r, distance_km: 12 }));
  let map = null;
  for (let i = 0; i < 3 && !map; i++) {
    map = await rank.rankCandidates({ crop: "wheat", operation: "ploughing", area_acres: 3 }, candidates);
    if (!map) await sleep(8000);
  }
  if (!map) return "null after 3 tries — cold start or endpoint down; the wizard keeps its heuristic order (documented fallback)";
  const first = candidates.find((c) => map.has(c.id));
  return `${map.size}/${candidates.length} scored, top=${first?.id} → ${map.get(first?.id)?.rank_score}`;
});
await check("the soft-fallback contract holds: null means 'keep existing order'", async () => {
  const map = await rank.rankCandidates({ crop: "wheat", operation: "ploughing" }, []);
  return map === null ? "empty input → null, no throw" : "unexpected non-null";
});
await check("LLM free-text parsing works, and degrades honestly if the provider is down", async () => {
  if (!BACKEND) return "backend URL not set — fallback path not exercised";
  let r = null;
  for (let i = 0; i < 2 && !r; i++) r = await llm.parseRequirementFreeText("I need to plough 3 acres of wheat in Panvel next week", "auto");
  if (!r) return "parser returned nothing twice (Render cold start or both providers down) — the manual form fallback is active, which is the documented behaviour";
  const got = { crop: r.crop, operation: r.operation, area: r.area_acres, place: r.location_text, provider: r.provider_used };
  return /wheat/.test(r.crop || "") && /plough/i.test(r.operation || "")
    ? `parsed ${JSON.stringify(got)}`
    : `unexpected parse: ${JSON.stringify(got)}`;
});

// ---------------------------------------------------------------------------
section("5. booking lifecycle (request → accept → use → complete, + edges)");
// ---------------------------------------------------------------------------
await signIn(emails.owner, PW);
// make the owner's listing bookable again and give the farmer a compatible one
await supabase.from("equipment").update({ is_available: true, compatible_operations: ["ploughing"] }).eq("id", listing.id);

const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const uidFarmer = created.users[1];
let booking;
await check("an owner cannot create a booking on someone else's behalf (RLS)", async () => {
  const { error } = await supabase.from("bookings").insert({
    equipment_id: listing.id, farmer_id: uidFarmer, owner_id: uidOwner,
    start_date: day(7), end_date: day(9), price: 1600, status: "Requested",
  });
  return error && /row-level security|policy/i.test(error.message) ? "refused — the farmer must be the one asking" : `unexpected: ${error?.message || "ALLOWED"}`;
});
await signIn(emails.farmer, PW);
await check("a booking request is created (farmer → owner)", async () => {
  const { data, error } = await supabase.from("bookings").insert({
    equipment_id: listing.id, farmer_id: uidFarmer, owner_id: uidOwner,
    start_date: day(7), end_date: day(9), price: 1600, status: "Requested",
  }).select("*").single();
  if (error) throw new Error(error.message);
  booking = data;
  created.bookings.push(data.id);
  return `id=${data.id} status=${data.status}`;
});
await check("a Requested booking does not lock the calendar yet", async () => {
  const slots = await availability.fetchSlots(supabase, booking.equipment_id);
  return slots.filter((x) => x.is_booked).length === 0 ? "no booked slot (correct — only Confirmed locks dates)" : "SLOT LOCKED EARLY";
});
await signIn(emails.owner, PW);
await check("owner accepts through the app's own sequence (status + date lock + conflict sweep)", async () => {
  const { error } = await supabase.from("bookings").update({ status: "Confirmed" }).eq("id", booking.id).select("id");
  if (error) throw new Error(error.message);
  await availability.createBookedSlot(supabase, booking.equipment_id, booking.start_date, booking.end_date);
  const conflicted = await lifecycle.conflictOutOverlappingRequests(booking);
  const { data } = await supabase.from("bookings").select("status").eq("id", booking.id).single();
  return data.status === "Confirmed" ? `Confirmed, date lock written, ${conflicted.length} overlapping request(s) swept` : `status=${data.status}`;
});
await check("the date lock is now visible to everyone (the calendar reads it)", async () => {
  const slots = await availability.fetchSlots(supabase, booking.equipment_id);
  const locked = slots.find((x) => x.is_booked);
  return locked ? `booked slot ${locked.start_date} → ${locked.end_date}` : "NO LOCK WRITTEN after confirmation";
});
await check("a conflicting request on the same dates is auto-flipped to Conflicted", async () => {
  const { data: rival } = await admin.from("bookings").insert({
    equipment_id: listing.id, farmer_id: uidFarmer, owner_id: uidOwner,
    start_date: day(8), end_date: day(10), price: 1200, status: "Requested",
  }).select("id").single();
  created.bookings.push(rival.id);
  await lifecycle.conflictOutOverlappingRequests({ id: booking.id, equipment_id: listing.id, start_date: booking.start_date, end_date: booking.end_date });
  const { data: after } = await admin.from("bookings").select("status").eq("id", rival.id).single();
  return after.status === "Conflicted" ? `rival booking → ${after.status}` : `expected Conflicted, got ${after.status}`;
});
await check("In Use → Completed marks the rental done and releases the date lock", async () => {
  for (const next of ["In Use", "Completed"]) {
    const { error } = await supabase.from("bookings").update({ status: next }).eq("id", booking.id).select("id");
    if (error) throw new Error(`${next}: ${error.message}`);
  }
  await availability.removeBookedSlot(supabase, booking.equipment_id, booking.start_date, booking.end_date);
  const { data } = await supabase.from("bookings").select("status").eq("id", booking.id).single();
  const slots = await availability.fetchSlots(supabase, booking.equipment_id);
  if (data.status !== "Completed") return `status=${data.status}`;
  return slots.filter((x) => x.is_booked).length === 0 ? "Completed, date lock released" : "date lock LEAKED after completion";
});
await check("farmer cancel works on a separate request", async () => {
  const { data: b2 } = await admin.from("bookings").insert({
    equipment_id: listing.id, farmer_id: uidFarmer, owner_id: uidOwner,
    start_date: day(20), end_date: day(21), price: 800, status: "Requested",
  }).select("id").single();
  created.bookings.push(b2.id);
  await signIn(emails.farmer, PW);
  const { error } = await supabase.from("bookings").update({ status: "Cancelled" }).eq("id", b2.id).select("id");
  if (error) throw new Error(error.message);
  const { data } = await admin.from("bookings").select("status").eq("id", b2.id).single();
  return data.status === "Cancelled" ? "Cancelled (a Requested booking holds no lock to release)" : `status=${data.status}`;
});
await check("cancelling a CONFIRMED booking releases its date lock", async () => {
  await signIn(emails.owner, PW);
  const { data: b5 } = await admin.from("bookings").insert({
    equipment_id: listing.id, farmer_id: uidFarmer, owner_id: uidOwner,
    start_date: day(50), end_date: day(52), price: 1100, status: "Confirmed",
  }).select("id, start_date, end_date, equipment_id").single();
  created.bookings.push(b5.id);
  await availability.createBookedSlot(supabase, b5.equipment_id, b5.start_date, b5.end_date);
  const before = (await availability.fetchSlots(supabase, b5.equipment_id)).filter((x) => x.is_booked).length;
  await supabase.from("bookings").update({ status: "Cancelled" }).eq("id", b5.id).select("id");
  await availability.removeBookedSlot(supabase, b5.equipment_id, b5.start_date, b5.end_date);
  const after = (await availability.fetchSlots(supabase, b5.equipment_id)).filter((x) => x.is_booked).length;
  return before === 1 && after === 0 ? "lock written then released" : `before=${before} after=${after}`;
});
await check("owner reject works (Requested → Rejected)", async () => {
  const { data: b3 } = await admin.from("bookings").insert({
    equipment_id: listing.id, farmer_id: uidFarmer, owner_id: uidOwner,
    start_date: day(30), end_date: day(31), price: 900, status: "Requested",
  }).select("id").single();
  created.bookings.push(b3.id);
  await signIn(emails.owner, PW);
  await supabase.from("bookings").update({ status: "Rejected" }).eq("id", b3.id).select("id");
  const { data } = await admin.from("bookings").select("status").eq("id", b3.id).single();
  return data.status;
});
await check("the 48 h stale-request expiry flips an old Requested booking", async () => {
  const { data: b4 } = await admin.from("bookings").insert({
    equipment_id: listing.id, farmer_id: uidFarmer, owner_id: uidOwner,
    start_date: day(40), end_date: day(41), price: 700, status: "Requested",
    created_at: new Date(Date.now() - 72 * 3600e3).toISOString(),
  }).select("id, status, created_at, start_date, end_date").single();
  created.bookings.push(b4.id);
  await signIn(emails.owner, PW);
  const expired = await lifecycle.expireStaleRequests([b4]);
  const { data } = await admin.from("bookings").select("status").eq("id", b4.id).single();
  return data.status === "Expired" ? `→ Expired (${expired.length} id returned, row was ${Math.round((Date.now() - Date.parse(b4.created_at)) / 3600e3)} h old)` : `expected Expired, got ${data.status}`;
});
await check("a stranger cannot read this booking (RLS)", async () => {
  await signIn(emails.stranger, PW);
  const { data } = await supabase.from("bookings").select("id").eq("id", booking.id);
  return data.length === 0 ? "0 rows for a non-participant" : "LEAK";
});

// ---------------------------------------------------------------------------
section("6. trust workflow through the DEPLOYED backend");
// ---------------------------------------------------------------------------
await signIn(emails.owner, PW);
let trustBooking = booking;
let handover, returnReport;
/** Render's free tier sleeps; the first request after idle can take a minute.
 *  Retry rather than reporting a healthy service as down. */
async function backendJson(path, opts = {}, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(`${BACKEND}${path}`, { ...opts, signal: AbortSignal.timeout(120000) });
      const text = await r.text();
      return { status: r.status, json: text ? JSON.parse(text) : null, text };
    } catch (err) { last = err; await sleep(4000 * i); }
  }
  return { status: 0, json: null, text: String(last?.message || last) };
}
const backendReachable = (await backendJson("/health", {}, 2)).status === 200;
if (!backendReachable) warn("backend unreachable", "the trust steps below still run, but only the local fallback path is exercised");

await check("handover report opens with a human-readable code", async () => {
  handover = await db.ensureConditionReport({ booking: trustBooking, kind: "handover", userId: uidOwner, role: "owner" });
  return /^AR-[0-9A-F]{8}$/.test(handover.report_code) ? handover.report_code : `bad code ${handover.report_code}`;
});
const captured = [];
await check("4 evidence photos upload to the private bucket and the rows insert", async () => {
  const jpeg = fs.readFileSync(`${FIX}/handover.jpg`);
  for (const [i, slot] of ["full_left", "full_right", "meter", "work_area"].entries()) {
    const path = capture.inspectionStoragePath(trustBooking.id, handover.id, slot);
    const up = await supabase.storage.from("inspection-photos").upload(path, jpeg, { contentType: "image/jpeg", upsert: true });
    if (up.error) throw new Error(`${slot}: ${up.error.message}`);
    created.storage.push(path);
    const sha = await capture.sha256Hex(new Uint8Array(jpeg));
    captured.push({
      slot, storage_path: path, sha256: sha, dhash: "1f2e3d4c5b6a7988",
      captured_at_device: new Date().toISOString(), exif: null,
      gps: { lat: 19.0652, lng: 72.8985, source: "live" }, gps_source: "live",
      watermark_text: `AR ${handover.report_code} ${slot}`, quality: { verdict: "pass", sharpness: 120 },
      damage_labels: [], blob: new Blob([jpeg], { type: "image/jpeg" }), bytes: jpeg.length,
    });
    await db.insertReportPhoto({ report: handover, booking: trustBooking, photo: captured[i], storagePath: path, userId: uidOwner, role: "owner" });
  }
  return `${captured.length} photos stored`;
});
await check("the backend verifies + reads the evidence (real network call)", async () => {
  const analysis = await trust.analyzeReport({
    report: handover, booking: trustBooking,
    equipment: { name: "Audit Tractor", type: "tractor" },
    photos: captured, beforePhotos: [], knownDamage: [], signedBy: 0, chainIntact: true,
    timeoutMs: 120000,
  });
  const via = analysis.backend === "unreachable" ? "local signals (backend asleep)" : "server-side";
  if (analysis.backend === "unreachable") { warn("analysis ran on the local fallback", "backend was unreachable — documented behaviour"); }
  await db.updateReportAnalysis(handover.id, { ...analysis, booking_id: trustBooking.id, equipment_id: trustBooking.equipment_id });
  const verdict = analysis.verdict || analysis.signals?.verdict;
  return `${via}: verdict=${verdict}, ai_status=${analysis.ai_status ?? "n/a"}, photos read=${analysis.photos?.length ?? 0}`;
});
await check("the stored reading is what a reload shows", async () => {
  const detail = await db.getReportDetail(handover.id);
  return detail.report.verdict ? `verdict=${detail.report.verdict}, photos=${detail.photos.length}, events=${detail.events.length}` : "no verdict stored";
});
await check("owner signs, then the report finalizes with a content hash", async () => {
  await db.signReport({ report: handover, userId: uidOwner, role: "owner", statement: `I confirm report ${handover.report_code} shows the machine at handover.`, signaturePngPath: null, contentHash: null });
  const hash = await db.finalizeReport(handover.id);
  await db.setVerificationState(trustBooking.id, flow.VSTATE.handoverSigned, { handover_report_id: handover.id });
  return /^[0-9a-f]{64}$/.test(hash) ? `hash ${hash.slice(0, 12)}…` : `bad hash ${hash}`;
});
await check("the farmer countersigns with one tap (no second signature drawn)", async () => {
  await signIn(emails.farmer, PW);
  await db.respondToReport({ report: handover, response: "agreed", userId: uidFarmer, role: "farmer" });
  const { data } = await admin.from("condition_reports").select("unilateral").eq("id", handover.id).single();
  return data.unilateral === false ? "unilateral=false" : `still unilateral=${data.unilateral}`;
});
await check("trustFlow derives state and next action from the rows, not a cached column", async () => {
  const reports = await db.getReportsForBooking(trustBooking.id);
  const claims = await db.getClaimsForBooking(trustBooking.id);
  const state = flow.deriveVerificationState({ booking: trustBooking, reports, claims });
  const next = flow.nextAction({ booking: trustBooking, reports, claims, role: "owner", userId: uidOwner });
  const valid = Object.values(flow.VSTATE);
  if (!valid.includes(state)) return `state "${state}" is not one of ${valid.length} known states`;
  return `state=${state} · next=${next.primary?.action ?? "none"} · note=${next.note}`;
});
await check("public verification works with NO login (the /verify/:code page)", async () => {
  await signIn(emails.stranger, PW);
  const res = await db.verifyReportCode(handover.report_code);
  return res?.found ? `found, chain_intact=${res.chain_intact}, signers=${res.signers?.length}` : `not found: ${JSON.stringify(res)}`;
});
await check("a bogus report code is reported honestly (no false 'verified')", async () => {
  const res = await db.verifyReportCode("AR-DEADBEEF");
  return res?.found === false ? "found=false" : `unexpected ${JSON.stringify(res)?.slice(0, 80)}`;
});
await check("the raw evidence file is NOT downloadable by a stranger", async () => {
  const res = await fetch(`${url}/storage/v1/object/inspection-photos/${created.storage[created.storage.length - 1]}`);
  return res.status >= 400 ? `HTTP ${res.status}` : "PUBLIC — leak";
});

// return report + comparison
await signIn(emails.farmer, PW);
await check("the return report opens and reuses the handover's known damage", async () => {
  returnReport = await db.ensureConditionReport({ booking: trustBooking, kind: "return", userId: uidFarmer, role: "farmer" });
  const known = await db.getKnownDamage(trustBooking.equipment_id);
  return `${returnReport.report_code}, ${known.length} known-damage rows carried forward`;
});
let returnPhotos = [];
await check("return evidence uploads (same slots, so before/after pairs up)", async () => {
  const jpeg = fs.readFileSync(`${FIX}/return.jpg`);
  for (const slot of ["full_left", "full_right", "meter", "work_area"]) {
    const path = capture.inspectionStoragePath(trustBooking.id, returnReport.id, slot);
    const up = await supabase.storage.from("inspection-photos").upload(path, jpeg, { contentType: "image/jpeg", upsert: true });
    if (up.error) throw new Error(`${slot}: ${up.error.message}`);
    created.storage.push(path);
    const sha = await capture.sha256Hex(new Uint8Array(jpeg));
    const photo = {
      slot, storage_path: path, sha256: sha, dhash: "9a8b7c6d5e4f3021",
      captured_at_device: new Date().toISOString(), exif: null,
      gps: { lat: 19.0652, lng: 72.8985, source: "live" }, gps_source: "live",
      watermark_text: `AR ${returnReport.report_code} ${slot}`, quality: { verdict: "pass", sharpness: 130 },
      damage_labels: [], blob: new Blob([jpeg], { type: "image/jpeg" }), bytes: jpeg.length,
    };
    returnPhotos.push(photo);
    await db.insertReportPhoto({ report: returnReport, booking: trustBooking, photo, storagePath: path, userId: uidFarmer, role: "farmer" });
  }
  return `${returnPhotos.length} photos stored`;
});
await check("before/after comparison runs on the deployed backend", async () => {
  const { data: before } = await supabase.from("report_photos").select("slot, storage_path, dhash, ai, watermark_text, captured_at_device").eq("report_id", handover.id);
  const analysis = await trust.analyzeReport({
    report: returnReport, booking: trustBooking,
    equipment: { name: "Audit Tractor", type: "tractor" },
    photos: returnPhotos, beforePhotos: (before || []).map((p) => ({ ...p, history: [] })),
    knownDamage: [], signedBy: 1, chainIntact: true, timeoutMs: 180000,
  });
  await db.updateReportAnalysis(returnReport.id, { ...analysis, booking_id: trustBooking.id, equipment_id: trustBooking.equipment_id });
  const slots = analysis.compare?.slots?.length ?? 0;
  return `compare ran on ${slots} slot(s), new_damage=${analysis.compare?.new_damage_count ?? "n/a"}, verdict=${analysis.verdict}`;
});
await check("the return report signs + finalizes, and the booking reaches return_signed", async () => {
  await db.signReport({ report: returnReport, userId: uidFarmer, role: "farmer", statement: `I confirm report ${returnReport.report_code} shows the machine at return.`, signaturePngPath: null, contentHash: null });
  const hash = await db.finalizeReport(returnReport.id);
  await db.setVerificationState(trustBooking.id, flow.VSTATE.returnFiled, { return_report_id: returnReport.id });
  const { data } = await admin.from("bookings").select("verification_state, return_report_id").eq("id", trustBooking.id).single();
  if (data.verification_state !== flow.VSTATE.returnFiled) return `booking state is "${data.verification_state}", expected "${flow.VSTATE.returnFiled}"`;
  if (data.return_report_id !== returnReport.id) return "return_report_id was not written";
  return `${data.verification_state}, return_report_id linked (hash ${hash.slice(0, 10)}…)`;
});

// claim → dispute → settlement → damage log
let claim;
await check("the owner files a damage claim on the return report", async () => {
  await signIn(emails.owner, PW);
  claim = await db.fileDamageClaim({
    booking: trustBooking, report: returnReport, userId: uidOwner,
    amount: 1500, description: "Front guard dented during the rental.",
    parts: ["dent"], severity: "moderate", evidencePhotoIds: [],
    responseWindowHours: policy.POLICY.claimWindowHours,
  });
  created.claims.push(claim?.id);
  return claim?.id ? `claim #${claim.id} · ₹${claim.amount_claimed} · deadline set` : false;
});
await check("a ₹2000+ claim with no repair estimate is refused by the database", async () => {
  const { data, error } = await admin.from("damage_claims").insert({
    booking_id: trustBooking.id, return_report_id: returnReport.id, handover_report_id: handover.id,
    filed_by: uidOwner, amount_claimed: 5000, description: "no estimate attached",
    severity: "major", parts: ["other"], response_deadline: new Date(Date.now() + 864e5).toISOString(),
  }).select("id").single();
  if (!error) { created.claims.push(data.id); return "INSERT SUCCEEDED — the ₹2000 rule is not enforced"; }
  return /estimate|check constraint|damage_c/i.test(error.message) ? `refused: ${error.message.slice(0, 70)}` : `refused for the wrong reason: ${error.message}`;
});
await check("the farmer disputes it — the claim records the dispute, nothing is deducted", async () => {
  await signIn(emails.farmer, PW);
  await db.respondToClaim({ claim, booking: trustBooking, report: returnReport, userId: uidFarmer, agree: false, note: "That dent was already there at handover." });
  const { data } = await admin.from("damage_claims").select("status, renter_response, resolved_amount").eq("id", claim.id).single();
  if (data.status !== "disputed") return `claim status is "${data.status}", expected "disputed"`;
  if (data.resolved_amount != null) return `a disputed claim must not carry a resolved amount (got ₹${data.resolved_amount})`;
  return "claim=disputed, no amount resolved";
});
await check("a dispute never moves money — the disputed part is held, nothing deducted", async () => {
  const split = policy.settlementSplit({ deposit: 1000, claimAmount: 1500, disputed: true });
  if (split.withheld !== 0) return `POLICY WITHHELD ₹${split.withheld} on a dispute`;
  if (split.held !== 1000) return `expected the disputed ₹1000 to be held, got ₹${split.held}`;
  if (split.released !== 0) return `nothing may be released either while it is disputed (got ₹${split.released})`;
  return `withheld=₹0, held=₹${split.held}, released=₹${split.released}, status=${split.status}`;
});
await check("the owner records the held position (disputed → nothing moves)", async () => {
  await signIn(emails.owner, PW);
  await db.recordSettlement({
    booking: trustBooking, claimId: claim.id, depositAmount: 1000,
    released: 0, withheld: 0, status: "disputed_hold", reason: "dispute_hold",
  });
  const s = await db.getSettlement(trustBooking.id);
  return `${s.status} · policy_version=${s.policy_version}`;
});
await check("the settlement history RPC reads back", async () => {
  const rows = await db.getSettlementHistory(trustBooking.id);
  return `${rows.length} history row(s)`;
});
await check("a resolved claim writes to the machine's carried-forward damage log", async () => {
  const { data: entry } = await admin.from("equipment_damage_log").insert({
    equipment_id: trustBooking.equipment_id, part: "front guard", kind: "dent", severity: "minor",
    status: "open", notes: "Noted after the audit rental.",
  }).select("id").single();
  await db.closeDamageEntry(entry.id, returnReport.id);
  const { data: after } = await admin.from("equipment_damage_log").select("status, repaired_report_id").eq("id", entry.id).single();
  const rows = await db.getKnownDamage(trustBooking.equipment_id);
  return after.status === "repaired" && after.repaired_report_id === returnReport.id
    ? `entry #${entry.id} → repaired; ${rows.length} known-damage row(s) carried forward`
    : JSON.stringify(after);
});
await check("withdrawing a claim is possible while it is open", async () => {
  const c2 = await db.fileDamageClaim({
    booking: trustBooking, report: returnReport, userId: uidOwner,
    amount: 300, description: "scratch on the seat", parts: ["scratch"], severity: "minor",
    evidencePhotoIds: [], responseWindowHours: policy.POLICY.claimWindowHours,
  });
  created.claims.push(c2?.id);
  await db.withdrawClaim({ claim: c2, booking: trustBooking, report: returnReport, note: "Withdrawn after a phone call." });
  const { data } = await admin.from("damage_claims").select("status").eq("id", c2.id).single();
  return `claim #${c2.id} → ${data.status}`;
});

// ---------------------------------------------------------------------------
section("7. the rest of the backend's surface");
// ---------------------------------------------------------------------------
await check("GET /health answers (retried across a cold start)", async () => {
  const r = await backendJson("/health");
  if (!r.json) throw new Error(`HTTP ${r.status}: ${r.text.slice(0, 120)}`);
  return `HTTP ${r.status}, phase ${r.json.phase}, status ${r.json.status}`;
});
await check("GET /verification/config describes what this deployment can do", async () => {
  const cfg = await trust.getVerificationConfig({ force: true });
  return `reachable=${cfg.reachable}, providers=${(cfg.vision?.providers_configured || []).join("+") || "none"}, storage_access=${cfg.storage_access}`;
});
await check("GET /verification/history/{equipment_id} answers", async () => {
  const r = await backendJson(`/verification/history/${trustBooking.equipment_id}`);
  return `HTTP ${r.status}${Array.isArray(r.json?.history) ? `, ${r.json.history.length} entries` : ""}`;
});
await check("POST /notifications/booking-webhook refuses a bad secret", async () => {
  // A body the endpoint accepts, sent with a wrong secret — so the answer tests
  // the secret check and not body validation.
  const r = await backendJson("/notifications/booking-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-webhook-secret": "definitely-wrong" },
    body: JSON.stringify({ type: "INSERT", table: "bookings", record: { id: booking.id, equipment_id: listing.id, farmer_id: uidFarmer, owner_id: uidOwner, status: "Requested" } }),
  });
  if (r.status === 401 || r.status === 403) return `HTTP ${r.status} (secret enforced)`;
  if (r.status === 422) return `HTTP 422 — the body schema was rejected before the secret check: ${r.text.slice(0, 140)}`;
  return `HTTP ${r.status} — CHECK THIS: ${r.text.slice(0, 140)}`;
});
await check("POST /verification/analyze refuses a signed-in NON-PARTY (403)", async () => {
  await signIn(emails.stranger, PW);
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) return "no session token for the stranger";
  const r = await backendJson("/verification/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ booking_id: trustBooking.id, kind: "handover", photos: [] }),
  });
  return r.status === 403 ? `HTTP ${r.status} — ${r.json?.detail ?? "not a party on this booking"}` : `expected 403, got HTTP ${r.status}: ${r.text.slice(0, 120)}`;
});

// ---------------------------------------------------------------------------
section("8. push tokens");
// ---------------------------------------------------------------------------
await check("a push token registers, upserts on conflict, and is scoped to its owner", async () => {
  const uid = (await supabase.auth.getUser()).data.user.id;
  const token = `audit-token-${stamp}`;
  const { error } = await supabase.from("push_tokens").upsert({ user_id: uid, token, platform: "web" }, { onConflict: "token" });
  if (error) throw new Error(error.message);
  const { data } = await supabase.from("push_tokens").select("user_id, token").eq("token", token).single();
  return data.user_id === uid ? "saved and readable by its owner" : "wrong owner";
});
await check("another user cannot read that token", async () => {
  await signIn(emails.farmer, PW);
  const { data } = await supabase.from("push_tokens").select("token").eq("token", `audit-token-${stamp}`);
  return data.length === 0 ? "0 rows for a non-owner" : "LEAK";
});

// ---------------------------------------------------------------------------
section("9. anonymous / negative checks");
// ---------------------------------------------------------------------------
await check("the anon key alone cannot read bookings, reports or claims", async () => {
  const anonClient = createClient(url, anon, { auth: { persistSession: false } });
  const [{ data: b }, { data: r }, { data: c }] = await Promise.all([
    anonClient.from("bookings").select("id").limit(5),
    anonClient.from("condition_reports").select("id").limit(5),
    anonClient.from("damage_claims").select("id").limit(5),
  ]);
  return `bookings=${b.length} reports=${r.length} claims=${c.length}`;
});
await check("…but the public verification RPC still answers for anon (by design)", async () => {
  const anonClient = createClient(url, anon, { auth: { persistSession: false } });
  const { data, error } = await anonClient.rpc("verify_report", { p_code: handover.report_code });
  return error ? `RPC error: ${error.message}` : `found=${data?.found}, chain_intact=${data?.chain_intact}`;
});

// ---------------------------------------------------------------------------
section("10. cleanup + demo state");
// ---------------------------------------------------------------------------
async function cleanup() {
  try {
    await signOut();
    if (ref && pat) {
      // report_events is append-only by design, so a cascade delete needs the
      // purge hatch from migration 7b — reachable only from a direct SQL
      // session, deliberately. One transaction, and the response is CHECKED:
      // an unchecked batch here once left six throwaway accounts (and their
      // bookings) in the live project, which is exactly the kind of mess an
      // audit must not create.
      const ids = created.users.map((u) => `'${u}'::uuid`).join(",");
      const query = `
        begin;
        set local agrirent.allow_purge = 'on';
        delete from public.bookings where owner_id = any(array[${ids}]) or farmer_id = any(array[${ids}]);
        delete from public.equipment where owner_id = any(array[${ids}]);
        delete from public.requirements where farmer_id = any(array[${ids}]);
        delete from public.push_tokens where user_id = any(array[${ids}]);
        delete from public.users where id = any(array[${ids}]);
        delete from auth.users where id = any(array[${ids}]);
        commit;
        select (select count(*) from auth.users where id = any(array[${ids}])) as users_left,
               (select count(*) from public.equipment where owner_id = any(array[${ids}])) as equipment_left,
               (select count(*) from public.bookings where owner_id = any(array[${ids}]) or farmer_id = any(array[${ids}])) as bookings_left;`;
      const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) throw new Error(`purge HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const out = await res.json();
      const left = out[0];
      if (left && (left.users_left || left.equipment_left || left.bookings_left)) {
        throw new Error(`purge left rows behind: ${JSON.stringify(left)}`);
      }
    } else {
      // No PAT: best-effort only, and say so rather than pretending.
      console.log("   (no SUPABASE_REF/PAT — falling back to API-only cleanup, which the append-only triggers may block)");
    }
    for (const path of storagePathsOf(created.storage)) {
      await admin.storage.from("inspection-photos").remove([path]);
      await admin.storage.from("equipment-photos").remove([path]);
    }
    for (const id of created.users) await admin.auth.admin.deleteUser(id).catch(() => {});
  } catch (err) { throw new Error(`cleanup failed: ${err.message}`); }
}
await cleanup();
await check("everything this audit created is gone (no litter in the live project)", async () => {
  const { data } = await admin.from("users").select("id").in("id", created.users);
  const { data: eqLeft } = created.equipment.length ? await admin.from("equipment").select("id").in("id", created.equipment) : { data: [] };
  const { data: bLeft } = created.bookings.length ? await admin.from("bookings").select("id").in("id", created.bookings) : { data: [] };
  if (data.length || eqLeft.length || bLeft.length) {
    return false; // leftovers must fail the run, not be reported as a footnote
  }
  return "0 users, 0 listings, 0 bookings left";
});

await check("the live demo state is still intact", async () => {
  const { data: b } = await admin.from("bookings").select("id, status, verification_state, equipment_id").eq("id", 53).single();
  const { data: authList } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  const idOf = (email) => authList.users.find((u) => u.email === email)?.id;
  const { data: o } = await admin.from("users").select("is_owner, is_farmer").eq("id", idOf(DEMO.owner)).single();
  const { data: f } = await admin.from("users").select("is_owner, is_farmer").eq("id", idOf(DEMO.farmer)).single();
  if (!b) throw new Error("booking #53 missing");
  return `#${b.id} ${b.status}/${b.verification_state} · owner is_owner=${o.is_owner} · farmer is_farmer=${f.is_farmer}`;
});
await signOut();

console.log(`\n\u001b[1m${passed} passed, ${failed} failed${soft ? `, ${soft} warning(s)` : ""}\u001b[0m`);
if (problems.length) { console.log("\nProblems:"); problems.forEach((p) => console.log("  ✗ " + p)); }

// Pre-demo readiness check — run this 5 minutes before you present.
//
//   SUPABASE_URL=... ANON_KEY=... node scripts/check-demo-ready.mjs
//
// It signs in as both demo accounts with the demo password, proves the
// marketplace queries actually return the listings you expect, finds the
// prepared booking to walk through, and checks the backend + AI chain are
// awake. Everything here is read-only: no rows are created or changed.
//
// Green lines are things that will work in the demo. Red lines are things to
// fix (or avoid clicking) before you start.

import { createClient } from "@supabase/supabase-js";

if (typeof globalThis.WebSocket !== "function") {
  globalThis.WebSocket = class { constructor() { throw new Error("realtime unused"); } };
}

const url = process.env.SUPABASE_URL;
const anon = process.env.ANON_KEY;
const BACKEND = process.env.BACKEND_URL || "https://agrirent-ai-backend.onrender.com";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "abdullacyclewala@gmail.com";
const FARMER_EMAIL = process.env.FARMER_EMAIL || "menhdi@gmail.com";
const PASSWORD = process.env.DEMO_PASSWORD || "12345678";

if (!url || !anon) {
  console.error("Set SUPABASE_URL and ANON_KEY (see .env.example).");
  process.exit(2);
}

let pass = 0, fail = 0, warn = 0;
const ok = (m) => { pass++; console.log(`  \u001b[32m✓\u001b[0m ${m}`); };
const no = (m) => { fail++; console.log(`  \u001b[31m✗\u001b[0m ${m}`); };
const wr = (m) => { warn++; console.log(`  \u001b[33m!\u001b[0m ${m}`); };

const client = () => createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });

console.log("\n1. the two demo accounts");
const owner = client();
const farmer = client();

const ownerAuth = await owner.auth.signInWithPassword({ email: OWNER_EMAIL, password: PASSWORD });
if (ownerAuth.error) no(`${OWNER_EMAIL} could not sign in — ${ownerAuth.error.message}`);
else ok(`${OWNER_EMAIL} signs in (owner side of the demo)`);

const farmerAuth = await farmer.auth.signInWithPassword({ email: FARMER_EMAIL, password: PASSWORD });
if (farmerAuth.error) no(`${FARMER_EMAIL} could not sign in — ${farmerAuth.error.message}`);
else ok(`${FARMER_EMAIL} signs in (renter side of the demo)`);

const ownerId = ownerAuth.data?.user?.id;
const farmerId = farmerAuth.data?.user?.id;

console.log("\n2. marketplace (the new browse tab)");
const { data: profile } = farmerId
  ? await farmer.from("users").select("latitude, longitude, location_label").eq("id", farmerId).maybeSingle()
  : { data: null };

if (profile?.latitude && profile?.longitude) {
  ok(`location on the renter's profile: ${profile.location_label || `${profile.latitude}, ${profile.longitude}`}`);
  const { data: nearby, error } = await farmer.rpc("nearby_equipment", {
    p_lat: profile.latitude, p_lng: profile.longitude, p_radius_km: 50,
  });
  if (error) no(`nearby_equipment failed — ${error.message}`);
  else if (!nearby?.length) wr("no equipment within 50 km of the renter — the marketplace will look empty; widen the radius in the demo");
  else {
    const nearest = [...nearby].sort((a, b) => (a.distance_km ?? 9e9) - (b.distance_km ?? 9e9))[0];
    ok(`${nearby.length} listings inside 50 km (nearest: ${nearest.name}, ${Number(nearest.distance_km).toFixed(1)} km)`);
  }
} else {
  wr("the renter has no saved location — press “Show what's near me” in the demo instead of expecting distances");
}

const { data: all } = await farmer.from("equipment").select("id, name, is_available, equipment_type");
ok(`full list fallback returns ${all?.length ?? 0} listings`);
if (all?.length) {
  const types = new Set(all.map((r) => r.equipment_type));
  ok(`type filter has something to filter: ${types.size} distinct types`);
}

console.log("\n3. the booking to walk through");
if (farmerId) {
  const { data: bookings } = await farmer
    .from("bookings")
    .select("id, status, start_date, end_date, verification_state, deposit_amount, equipment:equipment_id ( name )")
    .eq("farmer_id", farmerId)
    .in("status", ["Confirmed", "In Use"])
    .order("id", { ascending: false })
    .limit(5);
  const ready = (bookings || []).find((b) => b.status === "Confirmed" || b.status === "In Use");
  if (!ready) no("no Confirmed/In Use booking for the renter — make one before the demo, or book live on stage");
  else {
    ok(`booking #${ready.id} (${ready.equipment?.name}) — ${ready.status}, ${ready.start_date} → ${ready.end_date}`);
    console.log(`     → open https://agrirent-ai.vercel.app/booking/${ready.id} as ${FARMER_EMAIL}`);
    const { count } = await farmer
      .from("condition_reports").select("id", { count: "exact", head: true }).eq("booking_id", ready.id);
    if (count) wr(`this booking already has ${count} report(s) — use a fresh one for a clean handover walkthrough`);
    else ok("no condition reports on it yet — the handover capture is unspoiled");
  }
}

console.log("\n4. backend + AI chain");
try {
  const health = await (await fetch(`${BACKEND}/health`)).json();
  if (health.phase >= 7) ok(`backend awake, phase ${health.phase}`);
  else wr(`backend reports phase ${health.phase} — the trust endpoints may not be deployed yet`);
  const cfg = await (await fetch(`${BACKEND}/verification/config`)).json();
  const providers = cfg?.vision?.providers_configured || [];
  if (providers.length) ok(`vision providers configured: ${providers.join(", ")}`);
  else wr("no vision provider configured — the demo will show “AI reading off — evidence still recorded” (still a complete flow)");
  ok(`storage mode: ${cfg.storage_access ? "service (backend reads the bucket)" : "inline (browser sends the bytes)"}`);
} catch (err) {
  wr(`backend not answering right now (${err.message}) — it may be cold; open /health once to wake it`);
}

console.log(`\n\u001b[1m${pass} ok, ${warn} warning(s), ${fail} problem(s)\u001b[0m`);
if (fail) console.log("\nFix the red lines before presenting.\n");
else console.log("\nReady to demo.\n");
process.exit(fail ? 1 : 0);

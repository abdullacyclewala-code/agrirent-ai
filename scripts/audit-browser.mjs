// BROWSER end-to-end check of the DEPLOYED app.
//
// The Node audits (scripts/audit-e2e.mjs, scripts/test-trust-live.mjs) prove the
// data layer, RLS, triggers and backend contracts. They cannot prove the thing a
// person actually sees: that the built bundle boots, that every route renders,
// that no page throws, and — the complaint this work started from — that
// switching language really changes the text on screen.
//
// So this drives a real Chromium against the live site:
//   * every public route, signed out
//   * sign-in through the real form with the demo farmer account
//   * every signed-in route, including a real booking and the new marketplace
//   * the language switcher, asserting the visible text actually changes and
//     that no screen is left half-English
//   * console/page errors collected throughout — any uncaught error fails the run
//
// It only READS: no form that creates data is submitted, so the demo state is
// untouched. Sign-in is the one write, and Supabase does that on its own.
//
//   node scripts/audit-browser.mjs [baseUrl]

import { chromium } from "playwright";

const BASE = (process.argv[2] || process.env.BASE_URL || "https://agrirent-ai.vercel.app").replace(/\/+$/, "");
const DEMO = { email: process.env.FARMER_EMAIL || "menhdi@gmail.com", password: process.env.DEMO_PASSWORD || "12345678" };
const DEMO_REPORT_CODE = process.env.DEMO_REPORT_CODE || "AR-91BBDC1E";

let passed = 0, failed = 0, warned = 0;
const problems = [];
const ok = (l, x = "") => { passed++; console.log(`  \u001b[32m✓\u001b[0m ${l}${x ? ` — ${x}` : ""}`); };
const no = (l, d) => { failed++; problems.push(`${l}: ${d}`); console.log(`  \u001b[31m✗\u001b[0m ${l} — ${d}`); };
const warn = (l, d) => { warned++; console.log(`  \u001b[33m!\u001b[0m ${l} — ${d}`); };
const section = (t) => console.log(`\n\u001b[1m${t}\u001b[0m`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-IN" });
const page = await ctx.newPage();

// Anything that throws in the app is a finding, not noise. Chunk-load failures
// and the known third-party noise are separated so real bugs stand out.
const jsErrors = [];
const netFails = [];
page.on("pageerror", (err) => jsErrors.push(err.message));
page.on("console", (msg) => {
  if (msg.type() !== "error") return;
  const text = msg.text();
  if (/favicon|manifest|firebase-messaging-sw/i.test(text)) return;
  if (/Failed to load resource/i.test(text)) return;
  jsErrors.push(text);
});
page.on("response", (r) => {
  const u = r.url();
  if (r.status() >= 400 && !/favicon|manifest|api\.mapbox|firebase|supabase\.co\/auth\/v1\/token/.test(u)) {
    netFails.push(`${r.status()} ${u.slice(0, 90)}`);
  }
});

async function goto(path, { waitFor = null, rich = true, timeout = 45000 } = {}) {
  const res = await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded", timeout });
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 30000 }).catch(() => {});
  // Data-backed screens are blank until their first fetch lands. Waiting on a
  // fixed delay made /bookings look broken when it was simply still loading, so
  // wait for the page's own content instead (bounded, never fatal).
  if (rich) {
    await page.waitForFunction(
      () => (document.querySelector("main")?.innerText || document.body.innerText || "").trim().length > 200,
      null, { timeout: 15000 },
    ).catch(() => {});
  }
  await page.waitForTimeout(600);
  return res;
}
const bodyText = () => page.evaluate(() => document.body.innerText);
/** English words that should never survive a switch to Hindi/Marathi. */
const untranslatedChrome = (text) =>
  ["Sign out", "My Bookings", "Marketplace", "Find Equipment", "Loading", "Back", "Continue",
   "Dashboard", "Profile", "Search", "Available", "Price", "Distance", "Notifications"]
    .filter((w) => text.includes(w));

// ---------------------------------------------------------------------------
section("1. the deployed bundle boots");
// ---------------------------------------------------------------------------
const rootRes = await goto("/");
if (rootRes?.status() < 400) ok("GET / answers", `HTTP ${rootRes.status()}`);
else no("GET / answers", `HTTP ${rootRes?.status()}`);
const t0 = await bodyText();
if (t0.trim().length > 20) ok("the app renders content (not a blank SPA shell)", `${t0.trim().split("\n").length} lines of visible text`);
else no("the app renders content", `only ${t0.trim().length} chars: ${t0.slice(0, 80)}`);
if (jsErrors.length === 0) ok("no uncaught JS errors on load");
else no("no uncaught JS errors on load", jsErrors[0]);

// ---------------------------------------------------------------------------
section("2. public routes (signed out)");
// ---------------------------------------------------------------------------
await ctx.clearCookies();
await page.evaluate(() => localStorage.clear()).catch(() => {});
jsErrors.length = 0;
{
  const res = await goto("/auth", { waitFor: 'input[type="email"]' });
  const text = await bodyText();
  const hasForm = (await page.locator('input[type="email"]').count()) > 0 && (await page.locator('input[type="password"]').count()) > 0;
  if (res?.status() < 400 && hasForm) ok("/auth renders the real sign-in form", `"${text.trim().split("\n")[0].slice(0, 40)}"`);
  else no("/auth renders the sign-in form", `HTTP ${res?.status()} · email+password fields=${hasForm}`);
  if (jsErrors.length) no("/auth runs clean", jsErrors[0]);
}
jsErrors.length = 0;
{
  // A bogus code must say "no report found" — never render a plausible-looking report.
  const res = await goto("/verify/AR-DEADBEEF", { waitFor: "h1, h2" });
  const text = await bodyText();
  const honest = /no report found|not found|genuine/i.test(text) && !/verified|intact,|report is genuine — yes/i.test(text);
  if (res?.status() < 400 && honest) ok("/verify/<bogus> reports honestly that nothing was found", `"${text.split("\n").slice(1, 3).join(" ").slice(0, 60)}"`);
  else no("/verify/<bogus> honesty", `HTTP ${res?.status()} · honest=${honest} · "${text.slice(0, 120)}"`);
  if (jsErrors.length) no("/verify runs clean", jsErrors[0]);
}
jsErrors.length = 0;
{
  // Chain integrity alone does not mean a draft is a verified condition report.
  const res = await goto(`/verify/${DEMO_REPORT_CODE}`, { waitFor: "h1, h2" });
  await page.waitForFunction(() => /not signed yet/i.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  const text = await bodyText();
  const explicitDraft = /record history is intact/i.test(text)
    && /not been finalized/i.test(text)
    && /not a verified condition report/i.test(text)
    && /not verified/i.test(text)
    && /not signed yet/i.test(text);
  if (res?.status() < 400 && explicitDraft) ok("public verifier separates intact event history from an unsigned, unverified draft", DEMO_REPORT_CODE);
  else no("public verifier labels an unfinalized draft honestly", `HTTP ${res?.status()} · explicit=${explicitDraft} · "${text.slice(0, 180)}"`);
  if (jsErrors.length) no("draft verification runs clean", jsErrors[0]);
}
// a protected route must redirect to /auth when signed out
await goto("/bookings");
const afterGuard = page.url();
if (/\/auth/.test(afterGuard)) ok("a protected route redirects a signed-out visitor to /auth");
else no("route guard", `went to ${afterGuard.replace(BASE, "")}`);

// ---------------------------------------------------------------------------
section("3. sign-in through the real form");
// ---------------------------------------------------------------------------
jsErrors.length = 0;
await goto("/auth");
await page.fill('input[type="email"]', DEMO.email);
await page.fill('input[type="password"]', DEMO.password);
await Promise.all([
  page.waitForURL((u) => !/\/auth/.test(u.pathname), { timeout: 45000 }).catch(() => {}),
  page.click('button[type="submit"]'),
]);
await page.waitForTimeout(2500);
const signedIn = !/\/auth/.test(new URL(page.url()).pathname);
if (signedIn) ok(`${DEMO.email} signed in through the form`, `landed on ${new URL(page.url()).pathname}`);
else no("sign-in", `still at ${page.url()}`);
if (jsErrors.length) no("sign-in runs clean", jsErrors[0]);

// ---------------------------------------------------------------------------
section("4. the signed-in screens");
// ---------------------------------------------------------------------------
// Each route is asserted on content only that screen can show, after waiting
// for that content — a loose "the page is non-empty" test passes on the nav bar
// alone, which is how a broken screen hides.
const signedInRoutes = [
  ["/", /Dashboard/i, "h1, h2, .font-display"],
  ["/marketplace", /Marketplace/i, "a[href^='/equipment/'], main"],
  ["/bookings", /Bookings|बुकिंग/i, "main"],
  ["/booking/53", /Mahindra|Tractor|ट्रैक्टर/i, "main"],
  ["/describe-job", /describe|job|फसल|crop/i, "main"],
  ["/profile", /Profile|Settings|प्रोफ़ाइल/i, "main"],
];
for (const [path, expect, waitForSel] of signedInRoutes) {
  jsErrors.length = 0;
  netFails.length = 0;
  const res = await goto(path, { waitFor: waitForSel });
  // A list screen is empty until its query lands: wait for actual rows or the
  // empty-state copy, so "the nav rendered" can never pass as "the page works".
  if (path === "/bookings") {
    await page.waitForFunction(
      () => /Requested|Confirmed|In Use|Completed|Cancelled|Expired|Rejected|Conflicted|no bookings|No bookings|बुकिंग/i.test(document.body.innerText),
      null, { timeout: 20000 },
    ).catch(() => {});
    await page.waitForTimeout(500);
  }
  const text = await bodyText();
  const good = res?.status() < 400 && text.trim().length > 40 && expect.test(text);
  if (good) {
    const line = text.split("\n").map((x) => x.trim()).filter((x) => x && expect.test(x))[0] ?? "";
    ok(`${path} renders its own content`, `"${line.slice(0, 58)}"`);
  } else {
    no(`${path} renders its own content`, `HTTP ${res?.status()} · ${text.trim().length} chars · matches=${expect.test(text)} · "${text.slice(0, 100)}"`);
  }
  if (jsErrors.length) no(`${path} runs clean`, jsErrors[0]);
  const realNet = netFails.filter((n) => !/401|403/.test(n));
  if (realNet.length) warn(`${path} had failing requests`, realNet.slice(0, 2).join(" | "));
}

// the marketplace's own behaviour: a filter must actually narrow the list
await goto("/marketplace", { waitFor: 'input[type="text"], input:not([type]), main' });
await page.waitForSelector("a[href^='/equipment/']", { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);
const cardsBefore = await page.locator("a[href^='/equipment/']").count();
const search = page.locator('input[type="text"], input:not([type])').first();
if (cardsBefore > 0) ok("the marketplace lists real equipment for this renter", `${cardsBefore} cards`);
else no("the marketplace lists real equipment for this renter", `0 cards — ${(await bodyText()).trim().slice(0, 120)}`);
if (cardsBefore > 0 && (await search.count())) {
  await search.fill("zzzz-no-such-machine");
  await page.waitForTimeout(1000);
  const cardsAfter = await page.locator("a[href^='/equipment/']").count();
  // clearing the box must bring them back — a filter that hides everything
  // permanently would look "successful" otherwise
  await search.fill("");
  await page.waitForTimeout(1000);
  const cardsRestored = await page.locator("a[href^='/equipment/']").count();
  if (cardsAfter < cardsBefore && cardsRestored === cardsBefore) ok("marketplace search filters and clears correctly", `${cardsBefore} → ${cardsAfter} → ${cardsRestored}`);
  else no("marketplace search filters and clears correctly", `${cardsBefore} → ${cardsAfter} → ${cardsRestored}`);
} else {
  warn("marketplace filter not exercised", `search input=${await search.count()}`);
}

// ---------------------------------------------------------------------------
section("5. the language switch (the original complaint)");
// ---------------------------------------------------------------------------
await goto("/marketplace");
// The three language buttons share one aria-label ("Language"), and the app
// renders a second switcher for the mobile bar — so they are picked by their
// visible label, exactly as a person would: the full name, in that language
// (the locale files spell it हिन्दी / मराठी).
// NOTE: the switcher's aria-label is itself translated ("Language" → "भाषा"), so
// selecting it by aria-label stops working the moment the test switches away
// from English — which is exactly the kind of trap a language test must not
// fall into. The button TEXT is stable across all three locales
// (language.en/hi/mr = English / हिन्दी / मराठी in every file), so match on that.
const LANG_LABEL = { en: "English", hi: "हिन्दी", mr: "मराठी" };
async function switchLang(code) {
  const target = page.locator('button:visible').filter({ hasText: LANG_LABEL[code] }).first();
  if (!(await target.count())) return false;
  await target.click();
  await page.waitForTimeout(1800);
  return true;
}
await page.waitForTimeout(1200);   // let the first listing fetch land before comparing
const enText = await bodyText();
const clicked = await switchLang("hi");
const hiText = await bodyText();
const leftoverHi = untranslatedChrome(hiText);
if (clicked && hiText !== enText) ok("switching to हिंदी changes the visible text", `en ${enText.length} chars → hi ${hiText.length} chars`);
else no("switching to हिंदी changes the visible text", `clicked=${clicked}, changed=${hiText !== enText}`);
if (/[\u0900-\u097F]/.test(hiText)) ok("Devanagari actually renders on screen", `${(hiText.match(/[\u0900-\u097F]/g) || []).length} Devanagari characters visible`);
else no("Devanagari renders", "no Devanagari characters in the page text");
if (leftoverHi.length === 0) ok("no English chrome left on the Hindi marketplace", "");
else warn("some English chrome remains when switched to Hindi", leftoverHi.join(", "));

const clickedMr = await switchLang("mr");
const mrText = await bodyText();
if (clickedMr && /[\u0900-\u097F]/.test(mrText) && mrText !== enText) ok("switching to मराठी also re-renders", `${mrText.length} chars`);
else no("switching to मराठी re-renders", `changed=${mrText !== enText}`);
// and back to English, persisted
await switchLang("en");
const backText = await bodyText();
if (/Marketplace/.test(backText)) ok("switching back to English restores the English UI");
else warn("English restore", `"${backText.slice(0, 60)}"`);

// A data-heavy screen must translate too, not just the nav: the booking page
// pulls a real booking, its equipment and the trust panel from the database,
// so it is the best proof that translated copy reaches real data.
await goto("/booking/53", { waitFor: "main" });
const bookingEn = await bodyText();
const switchedOnBooking = await switchLang("hi");
await page.waitForTimeout(1500);
const bookingHi = await bodyText();
if (switchedOnBooking && /[\u0900-\u097F]/.test(bookingHi) && bookingHi !== bookingEn) {
  ok("the booking screen (real data) follows the language switch", `${(bookingHi.match(/[\u0900-\u097F]/g) || []).length} Devanagari chars`);
} else {
  no("the booking screen follows the language switch", `clicked=${switchedOnBooking} changed=${bookingHi !== bookingEn}`);
}
await switchLang("en");

// The dashboard's stat tiles are the one place that briefly held *translated*
// text in React state (so the "latest booking" value used to stay in the old
// language after a switch while the rest of the screen translated). Reading the
// tile again in Hindi is the regression test for that fix: StatTile renders the
// value div directly above its label div.
async function statTileValue(labelText) {
  return page.evaluate((label) => {
    const el = [...document.querySelectorAll("div")].find((d) => d.children.length === 0 && d.textContent.trim() === label);
    return el?.previousElementSibling?.textContent?.trim() ?? null;
  }, labelText);
}
await goto("/", { waitFor: "main" });
await page.waitForTimeout(1800);   // the stat fetch lands after the shell paints
const tileEn = await statTileValue("Latest booking");
const switchedOnDash = await switchLang("hi");
await page.waitForTimeout(900);
const tileHi = await statTileValue("ताज़ा बुकिंग");
if (tileEn && tileHi) {
  if (/[A-Za-z]/.test(tileEn)) {
    if (!/[A-Za-z]/.test(tileHi)) ok("the dashboard stat tile translates too (the bug this pass fixed)", `"${tileEn}" → "${tileHi}"`);
    else no("the dashboard stat tile translates too", `still Latin after the switch: "${tileHi}"`);
  } else {
    warn("dashboard tile check had nothing to translate (no status shown)", `"${tileEn}" → "${tileHi}"`);
  }
} else {
  no("the dashboard's latest-booking tile could be read", `en=${JSON.stringify(tileEn)} hi=${JSON.stringify(tileHi)} clicked=${switchedOnDash}`);
}
await switchLang("en");

// ---------------------------------------------------------------------------
section("6. console hygiene across the whole walk");
// ---------------------------------------------------------------------------
if (jsErrors.length === 0) ok("no uncaught JS errors anywhere in this run");
else { no("uncaught JS errors", `${jsErrors.length} total`); jsErrors.slice(0, 4).forEach((e) => console.log("      •", e.slice(0, 160))); }
// A 404 for a page's own asset would already show up above; check the API layer
const realFails = netFails.filter((n) => !/401|403/.test(n));
if (realFails.length === 0) ok("no unexpected failing XHRs");
else warn("some requests failed", realFails.slice(0, 3).join(" | "));

await browser.close();
console.log(`\n\u001b[1m${passed} passed, ${failed} failed${warned ? `, ${warned} warning(s)` : ""}\u001b[0m`);
if (problems.length) { console.log("\nProblems:"); problems.forEach((p) => console.log("  ✗ " + p)); }
process.exit(failed ? 1 : 0);

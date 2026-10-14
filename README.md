# AgriRent AI — Farm Equipment Rental Platform

A fully-animated, mobile + desktop responsive platform that matches farmers
with rentable equipment (tractors, harvesters, implements) using an ML-style
matching flow. Frontend in React + Vite + Tailwind, backed by Supabase
(Postgres/Auth/Realtime) and a FastAPI ranking/LLM backend on Render (see
`backend/` and `AGRIRENT_AI_MASTER.md`).

## What's inside

- **React 19 + Vite** — fast dev server & build
- **Tailwind CSS v4** — utility styling, custom theme tokens (see `src/index.css`)
- **React Router** — every screen is a real, separate route (not one long scrolling page)
- **Framer Motion** — page transitions, step animations, reveal-on-scroll, timelines
- **Animated India hero map** — a live-network SVG scene (see below), no 3D deps needed
- **Supabase + Firebase** — auth, database, realtime booking updates, push notifications
- **Lucide icons**

### Verified condition reports (Phase 7)

Every rental is bracketed by two signed condition reports — one at handover, one
at return — so "it was already like that" becomes a question with an answer, for
both sides. The owner or renter taps through four guided photos; each one is
stamped in the pixels with the report code, time and location, fingerprinted
(sha256 + perceptual hash) and quality-checked on the device. An AI reading
compares handover with return and flags anything that changed — it only ever
flags, a person decides. Both parties sign separately, wear and tear is
enumerated and never charged, and a disputed claim is held rather than deducted.
The whole record is append-only with a hash chain computed inside Postgres, so
the `/verify/:code` page can be checked by a third party — a bank, an insurer, a
court — without an account. See `docs/PHASE7_VERIFIED_CONDITION_REPORTS.md`.

### Pages / routes

| Route | Screen |
|---|---|
| `/` | Overview dashboard — greeting hero with live India map, stats, how-it-works |
| `/describe-job` | Guided multi-step job wizard (free-text AI parse → crop → operation → land → location → date → review) + animated "matching" loading screen |
| `/recommendations` | Ranked equipment matches with "why this machine" reasoning |
| `/equipment/:id` | Equipment details — gallery, specs, owner, sticky booking panel |
| `/booking/:id` | Booking confirmation + live-style tracking timeline |
| `/bookings` | All bookings (farmer + owner), realtime updates |
| `/equipment/new` | List equipment (owner mode) |
| `/report/:id` | Condition report — guided capture, AI reading, before/after comparison, both parties' signatures |
| `/claim/:bookingId` | Damage claim and deposit — file, answer, dispute, settle |
| `/verify/:code` | Public verification page (no login) — anyone holding a report code can check it is intact |
| `/profile` | Profile — overview, listings (if renting out equipment), settings |

## Running it locally

```bash
npm install
npm run dev       # dev server, usually http://localhost:5173
npm run build     # production build → dist/
npm run preview   # preview the production build locally
```

Works out of the box on desktop and mobile browsers (responsive down to ~360px width).

Copy `.env.example` to `.env.local` and fill in your Supabase / backend / Firebase
keys (same keys go in Vercel → Project → Settings → Environment Variables).

## The hero animation (signature element)

`src/components/ui/HeroMap.jsx` visualises the *matching network itself* — a
tilted, extruded 3D-looking slab of India (real Natural Earth geometry in
`src/data/india.json`, 800×850 viewBox) where every animation means something:

- Faint dashed arcs connect 15 equipment-station cities to the Nagpur match hub.
- Booking "packets" (glowing dots) travel station → hub along those arcs using
  **SVG SMIL** (`<animate>` / `<animateMotion>`), which keeps animating even when
  the OS "reduce motion" setting disables CSS animations.
- Each station has a pulsing "listening" ring; the Ludhiana high-demand zone is
  highlighted in orange.
- The hub pings when data "arrives," and a conic-gradient radar sweep rotates
  over the whole scene.

No canvas, no rAF, no client JS animation loop — cheap and always smooth.

## Equipment imagery

Equipment "photos" are illustrated SVGs (`src/components/ui/EquipmentArt.jsx`)
drawn in the app's own color palette, so the whole product feels cohesive without
depending on stock photography or hitting copyright issues. **To use real photos:**

1. Add your images to `public/images/equipment/...`
2. In the Supabase `equipment` table (or `src/data/mockData.js` for local mocks),
   add an `image: "/images/equipment/tractor-1.jpg"` field to each equipment entry.
3. Swap `<EquipmentArt category={eq.category} />` for a plain `<img src={eq.image} />` in
   `Recommendations.jsx`, `EquipmentDetails.jsx`, `MyBookings.jsx`, and `Booking.jsx`.

## Data flow

- The `DescribeJob` wizard writes the collected form to `localStorage` under the
  key `agrirent_job`, saves a `requirements` row to Supabase, runs the rules
  filter (`src/lib/rulesFilter.js`), optionally re-ranks via the backend
  (`src/lib/rankClient.js`), and stashes matches in `sessionStorage` under
  `agrirent_matches` for `Recommendations.jsx`.
- The "scanning" loading screen (`ScanningScreen` inside `DescribeJob.jsx`) shows
  while the real Supabase + ranking calls resolve.
- Booking status pages stay live via Supabase Realtime (`src/lib/realtime.js`).

## Design system

Color, type and animation tokens live in `src/index.css` under `@theme`. Palette is
"Ivory paper · espresso ink · clay terracotta · haldi gold · moss green": warm ivory
page background (`--color-paper`), espresso headings (`--color-ink`), a clay
terracotta primary action (`--color-accent`), haldi gold highlights (`--color-gold`),
and moss green positives (`--color-sage`), with the dark soil hero panel
(`--color-night`). Display type is **Fraunces** (serif), body is
**Instrument Sans**, and specs/prices use **IBM Plex Mono**. Reusable pieces are in
`src/components/ui/Primitives.jsx` (buttons, chips, badges, match-score rings, stat
tiles, scroll-reveal wrapper) plus plain-CSS `.btn` / `.chip` / `.card` / `.hero`
primitives in `src/index.css`.

## Deploying

- **Frontend:** static site after `npm run build` (output in `dist/`), deployed on
  Vercel — pushing to `main` autodeploys (`vercel.json` handles SPA rewrites).
- **Backend:** `backend/` deploys on Render via `backend/render.yaml` — pushing to
  `main` autodeploys the FastAPI service. `GET /verification/config` reports which
  vision providers and which storage mode a deployment actually has, which is the
  quickest way to tell what the trust layer can do in that environment.
- **Database:** migrations live in `supabase/migrations/` (Phase 7's two files are
  applied; `supabase/schema.sql` is the from-scratch mirror).

### Testing it by hand

`docs/PHASE7_MANUAL_TEST_PLAN.md` is the 30–40 minute two-person script for the
condition-report flow: handover, return, deposit release, a disputed claim, the
public verification page, and the things that should not break.

### Tests

```bash
python3 scripts/make-fixtures.py && node scripts/test-trust.mjs   # trust logic
cd backend && python3 -m pytest tests/ -q                          # vision backend
SUPABASE_URL=... ANON_KEY=... SERVICE_KEY=... node scripts/test-trust-live.mjs
```

The last one is a live integration test: it runs the shipped modules against the
real database as real signed-in users (real row-level security, real triggers,
the real hash chain), creating and then purging its own users, booking and
evidence.

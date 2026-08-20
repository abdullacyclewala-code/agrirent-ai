# Kisan Match — Farm Equipment Rental Platform (Frontend UI/UX)

A fully-animated, mobile + desktop responsive **frontend prototype** for a platform that
matches farmers with rentable equipment (tractors, harvesters, implements) using an ML-style
matching flow. This is **UI/UX only** — no backend, no real ML model, no real data. All
equipment, bookings, and profile data are mocked in `src/data/mockData.js`.

## What's inside

- **React 19 + Vite** — fast dev server & build
- **Tailwind CSS v4** — utility styling, custom theme tokens (see `src/index.css`)
- **React Router** — every screen is a real, separate route (not one long scrolling page)
- **Framer Motion** — page transitions, step animations, reveal-on-scroll, timelines
- **React Three Fiber + Three.js** — the animated 3D "field & tractor" hero scene (fully
  procedural, no external 3D model files needed)
- **Lucide icons**

### Pages / routes

| Route | Screen |
|---|---|
| `/` | Dashboard — 3D hero, how-it-works, active booking, recommended strip |
| `/describe-job` | Guided multi-step job wizard (crop → operation → land → location → date → review) + animated "matching" loading screen |
| `/recommendations` | Ranked equipment matches with "why this machine" reasoning |
| `/equipment/:id` | Equipment details — gallery, specs, owner, sticky booking panel |
| `/booking/:id` | Booking confirmation + live-style tracking timeline |
| `/profile` | Farmer profile — overview, listings (if renting out equipment), settings |

## Running it locally

```bash
npm install
npm run dev       # dev server, usually http://localhost:5173
npm run build     # production build → dist/
npm run preview   # preview the production build locally
```

Works out of the box on desktop and mobile browsers (responsive down to ~360px width).

## The 3D animation (signature element)

`src/three/FieldScene.jsx` visualises the *matching engine itself*, not a literal machine —
this is what makes it feel specific to an ML-matching product rather than generic farm decor.
It's a small looping scene built entirely from Three.js primitives:

- An undulating wireframe terrain grid (a stylised map of farmland) that keeps rippling.
- ~20 glowing nodes scattered across the grid, representing nearby equipment — a few of them
  (the "matches") glow gold and pulse, the rest glow a cooler blue.
- Animated light pulses continuously travel along curved beams from each matched node toward
  a central "match core," visualising the platform finding and confirming a fit in real time.
- The match core itself is a slowly counter-rotating wireframe icosahedron with expanding
  radar-style rings underneath it.
- Soft drifting light motes add depth, and the camera auto-orbits slowly the whole time.

It keeps animating continuously (not a one-off zoom) and is used as the Dashboard hero. It's
intentionally built from geometry and canvas-generated glow textures (no downloaded 3D
assets), so it stays lightweight and works offline.

If the 3D scene ever feels heavy on very low-end phones, you can lower the `count` values in
`Nodes`/`Fireflies`, or drop `dpr` in `FieldScene`'s `<Canvas>` props.

## Equipment imagery

Equipment "photos" are illustrated SVGs (`src/components/ui/EquipmentArt.jsx`) drawn in the
app's own color palette, so the whole product feels cohesive without depending on stock
photography or hitting copyright issues. **To use real photos:**

1. Add your images to `public/images/equipment/...`
2. In `src/data/mockData.js`, add an `image: "/images/equipment/tractor-1.jpg"` field to each
   equipment entry.
3. Swap `<EquipmentArt category={eq.category} />` for a plain `<img src={eq.image} />` in
   `Recommendations.jsx`, `EquipmentDetails.jsx`, `Dashboard.jsx`, and `Booking.jsx`.

## Wiring up real data / backend

Everything currently reads from `src/data/mockData.js`. To connect a real backend:

- Replace the mock arrays with API calls (e.g. React Query or plain `fetch` in `useEffect`).
- The `DescribeJob` wizard already writes the collected form to `localStorage` under the key
  `kisan_job` — swap that `localStorage.setItem` for a POST to your matching endpoint, and
  feed the returned ranked list into `Recommendations.jsx` instead of the local sort.
- The "scanning" loading screen (`ScanningScreen` inside `DescribeJob.jsx`) is timed with
  `setTimeout`; replace that with your real API call's promise resolution.

## Design system

Color, type and animation tokens live in `src/index.css` under `@theme`. Palette is a
"dusk field" theme: deep pine (`--color-ink`), forest greens, a warm wheat-gold accent
(`--color-wheat`) for primary actions, and a cool sky blue (`--color-sky`) for data/ML
accents. Display type is **Space Grotesk**, body is **Inter**, and specs/prices use
**IBM Plex Mono** for a technical, legible feel. Reusable pieces are in
`src/components/ui/Primitives.jsx` (buttons, chips, badges, match-score rings, stat tiles,
scroll-reveal wrapper).

## Deploying

This is a static site after `npm run build` (output in `dist/`). Deploy `dist/` to Vercel,
Netlify, Cloudflare Pages, GitHub Pages, or any static host.

## Notes / next steps for a real product

- Hook up real authentication and a farmer/owner account split.
- Replace the mocked ML "match score" and "why matched" reasons with your real model's
  output — the UI already has slots for a numeric score and a list of short reason strings.
- Add a real map (e.g. Mapbox/Google Maps) to the Booking tracking screen in place of the
  illustrative route bar.
- Add multi-language support (Hindi/Punjabi placeholders are already sketched in Profile →
  Settings) via `react-i18next` or similar.

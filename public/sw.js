/* AgriRent AI service worker (Phase 6 item 6 — hand-rolled, no build deps).
 *
 * Strategy:
 *  - Page navigations: network-first, falling back to the cached copy of the
 *    page, then to /offline.html. The app is a SPA, so a cached shell lets
 *    React render its own error/empty states when the network is gone.
 *  - Same-origin static assets (JS/CSS/fonts/images): cache-first. Vite
 *    content-hashes these filenames, so a cached copy is never stale.
 *  - Everything else (Supabase, backend API, map tiles, geocoding):
 *    network-only. Farm data must never be served stale from a cache, and
 *    map tiles are deliberately not bulk-cached (tile usage policy).
 *
 * Bump CACHE_VERSION to invalidate all caches on deploy.
 */
const CACHE_VERSION = "agrirent-v1";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const PAGES_CACHE = `${CACHE_VERSION}-pages`;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PAGES_CACHE)
      .then((cache) => cache.add(OFFLINE_URL))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((n) => n.startsWith("agrirent-") && n !== STATIC_CACHE && n !== PAGES_CACHE)
            .map((n) => caches.delete(n))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isStaticAsset(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname === "/sw.js" || url.pathname === "/firebase-messaging-sw.js") return false;
  return /\.(js|css|woff2?|ttf|otf|png|jpg|jpeg|webp|gif|svg|ico|json|webmanifest)$/.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  // Navigations: network first, cached page, offline fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(PAGES_CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          const offline = await caches.match(OFFLINE_URL);
          if (offline) return offline;
          return new Response("Offline", { status: 503, statusText: "Offline" });
        })
    );
    return;
  }

  // Same-origin static assets: cache first.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        });
      })
    );
    return;
  }

  // API + third-party: network only, no caching.
});

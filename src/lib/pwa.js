/**
 * PWA wiring (Phase 6 item 6): service-worker registration + install prompt.
 *
 * The service worker is registered in PRODUCTION builds only — registering it
 * in dev would serve stale cached bundles while developing. Installability
 * (beforeinstallprompt) is captured in every build so it can be tested.
 */

let deferredPrompt = null;

/** Call once from main.jsx. Never throws. */
export function initPwa() {
  try {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      window.dispatchEvent(new Event("agrirent:installable"));
    });
    if (import.meta.env.PROD) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch((err) => {
          console.error("service worker registration failed:", err);
        });
      });
    }
  } catch (err) {
    console.error("pwa init failed:", err);
  }
}

/** True once the browser has offered install (and the user hasn't used it yet). */
export function isInstallable() {
  return deferredPrompt != null;
}

/**
 * Show the browser's install prompt. Resolves true when the user accepts.
 * Resolves false when there is no pending prompt (already installed,
 * dismissed, or browser never offered).
 */
export async function promptInstall() {
  if (!deferredPrompt) return false;
  try {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    return outcome === "accepted";
  } catch (err) {
    console.error("install prompt failed:", err);
    return false;
  } finally {
    deferredPrompt = null;
  }
}

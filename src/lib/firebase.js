// Phase 4 — Firebase app init, used only for Cloud Messaging (FCM push).
// No other Firebase product is used anywhere in this project — Supabase
// remains the DB/Auth/Storage/Realtime layer per the master doc §2 stack
// table; this is purely the push-notification transport.
//
// DISCLOSED SETUP DEPENDENCY: all of VITE_FIREBASE_* below come from a
// Firebase project a human needs to create (Firebase Console -> Add project
// -> Cloud Messaging). Until they're set, `getMessagingIfSupported()` returns
// null and `push.js` treats that as "notifications unavailable" — nothing
// else in the app depends on this working, same as the Phase 3 LLM keys.

import { initializeApp, getApps } from "firebase/app";
import { getMessaging, isSupported } from "firebase/messaging";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const isConfigured = !!(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);

let app = null;
if (isConfigured) {
  app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
} else {
  console.warn(
    "[firebase] VITE_FIREBASE_* env vars not set — push notifications are disabled. " +
      "See backend/README.md 'Setting up push notifications' for the one-time Firebase project setup."
  );
}

/**
 * @returns {Promise<import("firebase/messaging").Messaging|null>} null if
 *   Firebase isn't configured, or this browser doesn't support the Web Push
 *   APIs FCM needs (e.g. some in-app browsers, Safari without a manifest).
 */
export async function getMessagingIfSupported() {
  if (!app) return null;
  if (!(await isSupported())) return null;
  return getMessaging(app);
}

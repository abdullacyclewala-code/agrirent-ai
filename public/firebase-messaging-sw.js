// Phase 4 — FCM background service worker. Must live at this exact path
// (site root) so its scope covers the whole app. Handles push messages that
// arrive while the app isn't in the foreground — foreground messages are
// handled directly in src/lib/push.js via onMessage().
//
// NOTE: this file can't read Vite env vars (it's not bundled by Vite — the
// browser fetches it as a static file), so the Firebase config here is
// hardcoded. All of these values are PUBLIC by design (Firebase's own docs:
// the web config is not a secret, unlike the backend's service-account
// JSON) — safe to commit. Fill them in from the same Firebase project as
// the VITE_FIREBASE_* values in your frontend env vars.

importScripts("https://www.gstatic.com/firebasejs/12.17.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.17.1/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "REPLACE_WITH_FIREBASE_WEB_API_KEY",
  authDomain: "REPLACE_WITH_FIREBASE_AUTH_DOMAIN",
  projectId: "REPLACE_WITH_FIREBASE_PROJECT_ID",
  storageBucket: "REPLACE_WITH_FIREBASE_STORAGE_BUCKET",
  messagingSenderId: "REPLACE_WITH_FIREBASE_SENDER_ID",
  appId: "REPLACE_WITH_FIREBASE_APP_ID",
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || "AgriRent AI";
  const body = payload.notification?.body || "You have a booking update.";
  self.registration.showNotification(title, {
    body,
    icon: "/favicon.svg",
  });
});

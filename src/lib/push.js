// Phase 4 — request notification permission, get an FCM device token, and
// save it to Supabase's `push_tokens` table (see supabase/schema.sql Phase 4
// section) so the backend can look it up when a booking status changes
// (see backend/app/notifications.py). Direct-to-Supabase, same pattern as
// all other CRUD in this project — no backend round-trip needed just to
// save a token, only to actually SEND a push (that needs the secret
// service-account key, which can't live here).

import { getToken, onMessage } from "firebase/messaging";
import { getMessagingIfSupported } from "./firebase.js";
import { supabase } from "./supabase.js";

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY;

/**
 * Call from a user action (e.g. a "Turn on notifications" button in
 * Profile.jsx) — browsers require a permission prompt to be triggered by a
 * real user gesture, not on page load.
 *
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function enablePushNotifications(userId) {
  if (!userId) return { ok: false, message: "Sign in first to enable notifications." };
  if (!VAPID_KEY) {
    return {
      ok: false,
      message: "Push notifications aren't configured for this deployment yet.",
    };
  }

  const messaging = await getMessagingIfSupported();
  if (!messaging) {
    return { ok: false, message: "This browser doesn't support push notifications." };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, message: "Notification permission was not granted." };
  }

  try {
    const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
    if (!token) {
      return { ok: false, message: "Couldn't get a notification token. Try again." };
    }

    const { error } = await supabase
      .from("push_tokens")
      .upsert({ user_id: userId, token, platform: "web" }, { onConflict: "token" });
    if (error) {
      return { ok: false, message: error.message || "Couldn't save your notification token." };
    }

    return { ok: true, message: "Notifications are on." };
  } catch (err) {
    return { ok: false, message: err.message || "Couldn't enable notifications." };
  }
}

/**
 * Listens for FCM messages that arrive while the app is in the foreground
 * (background messages are handled by firebase-messaging-sw.js instead).
 * Call once near the app root; returns an unsubscribe function.
 *
 * @param {(payload: {title:string, body:string}) => void} onNotification
 * @returns {Promise<() => void>}
 */
export async function listenForForegroundMessages(onNotification) {
  const messaging = await getMessagingIfSupported();
  if (!messaging) return () => {};

  return onMessage(messaging, (payload) => {
    onNotification({
      title: payload.notification?.title || "AgriRent AI",
      body: payload.notification?.body || "",
    });
  });
}

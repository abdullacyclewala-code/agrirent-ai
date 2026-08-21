"""
Phase 4 — FCM push notifications for booking status changes (master doc
§4.3 booking states + the "Realtime/Notifications" hosting row in §2).

DISCLOSED SETUP DEPENDENCY (same pattern as Phase 3's Groq/Gemini keys):
sending real push notifications needs a Firebase project's service-account
credentials, which only a human can create — see backend/README.md "Setting
up push notifications". Until `FIREBASE_SERVICE_ACCOUNT_JSON` is set in
Render's env vars, `send_push_to_tokens()` is a safe no-op: it logs and
returns 0, exactly like the LLM/manual-form fallback pattern elsewhere in
this project. Nothing in the booking flow depends on push actually being
delivered — realtime in-app status updates (Supabase Realtime, see
`src/lib/realtime.js`) work independently of whether Firebase is configured.

This module also does the one bit of DB reading this backend needs
(`tokens_for_users`) via Supabase's REST API (PostgREST) using the
service-role key — not a Postgres driver/ORM, so no new heavy dependency,
consistent with everything else in this backend staying deliberately thin.
"""

import json
import logging
import os
from functools import lru_cache
from typing import List, Optional

import requests

logger = logging.getLogger("agrirent.notifications")

# Mirrors the `status` values used in supabase/schema.sql `bookings.status`
# and src/pages/Booking.jsx's STAGES/TERMINAL_NEGATIVE — keep these in sync
# if that enum ever changes.
_STATUS_MESSAGES = {
    "Confirmed": "Your booking was accepted by the owner.",
    "Rejected": "Your booking request was declined.",
    "In Use": "Your rental is now marked in use.",
    "Completed": "Your rental is complete. Hope it went well!",
    "Cancelled": "This booking was cancelled.",
}


def message_for_status(status: str) -> Optional[str]:
    return _STATUS_MESSAGES.get(status)


@lru_cache(maxsize=1)
def _firebase_app():
    """
    Lazily initializes Firebase Admin from FIREBASE_SERVICE_ACCOUNT_JSON (the
    full service-account JSON, as a single-line env var string). Returns
    None — not an exception — if unset or invalid, so callers can treat
    "not configured yet" and "configured but briefly erroring" the same way:
    log it, skip sending, keep the booking flow working.
    """
    raw = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")
    if not raw:
        return None
    try:
        import firebase_admin
        from firebase_admin import credentials

        cred = credentials.Certificate(json.loads(raw))
        return firebase_admin.initialize_app(cred)
    except Exception as e:
        logger.error("notifications: Firebase Admin init failed (%s) — push disabled", e)
        return None


def send_push_to_tokens(tokens: List[str], title: str, body: str) -> int:
    """Sends one push message per token. Returns how many sent successfully. No-op (0) if Firebase isn't configured or there are no tokens."""
    app = _firebase_app()
    if not app:
        logger.info("notifications: Firebase not configured — skipping push (%r)", title)
        return 0
    if not tokens:
        return 0

    from firebase_admin import messaging

    sent = 0
    for token in tokens:
        try:
            messaging.send(
                messaging.Message(notification=messaging.Notification(title=title, body=body), token=token)
            )
            sent += 1
        except Exception as e:
            # A single dead/expired token shouldn't stop the rest from sending.
            logger.warning("notifications: push failed for one token (%s)", e)
    return sent


def tokens_for_users(user_ids: List[str]) -> List[str]:
    """
    Looks up device push tokens for the given user ids from the `push_tokens`
    table (see supabase/schema.sql Phase 4 section) via Supabase's REST API,
    using the service-role key (SUPABASE_SERVICE_ROLE_KEY — Render env var
    only, never sent to the frontend). Returns [] if unconfigured or on any
    lookup failure — same "degrade, don't break the request" pattern as
    everything else here.
    """
    supabase_url = os.getenv("SUPABASE_URL")
    service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not service_role_key or not user_ids:
        return []

    ids_filter = ",".join(user_ids)
    try:
        resp = requests.get(
            f"{supabase_url}/rest/v1/push_tokens",
            params={"user_id": f"in.({ids_filter})", "select": "token"},
            headers={
                "apikey": service_role_key,
                "Authorization": f"Bearer {service_role_key}",
            },
            timeout=8,
        )
        resp.raise_for_status()
        return [row["token"] for row in resp.json() if row.get("token")]
    except Exception as e:
        logger.warning("notifications: push_tokens lookup failed (%s)", e)
        return []

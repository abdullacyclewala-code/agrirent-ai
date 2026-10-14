"""
Phase 7 — minimal Supabase access for the trust layer.

Same discipline as app/notifications.py: the backend talks to Supabase's REST
API over plain `requests`, with no Postgres driver and no ORM. The service-role
key (when configured) is what lets the backend do the two things the browser
genuinely cannot: read evidence across bookings (for reuse detection) and
confirm who is calling.

Everything degrades when the key is absent — the endpoints then work from the
data the client supplies, and say so in the response (`storage: "client"`), so
a deployment without secrets still produces a real report.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

import requests

logger = logging.getLogger("agrirent.vision.supabase")

TIMEOUT_S = 20


class SupabaseREST:
    def __init__(self, url: Optional[str] = None, key: Optional[str] = None):
        self.url = (url or os.getenv("SUPABASE_URL") or "").rstrip("/")
        self.key = key or os.getenv("SUPABASE_SERVICE_ROLE_KEY") or ""
        # The anon key is public by definition and is enough to validate a user
        # JWT; it is only used when no service key is configured.
        self.anon_key = os.getenv("SUPABASE_ANON_KEY") or ""

    @property
    def configured(self) -> bool:
        return bool(self.url and self.key)

    def _headers(self, prefer: Optional[str] = None) -> dict[str, str]:
        headers = {
            "apikey": self.key or self.anon_key,
            "Authorization": f"Bearer {self.key or self.anon_key}",
            "Content-Type": "application/json",
        }
        if prefer:
            headers["Prefer"] = prefer
        return headers

    # -- data ---------------------------------------------------------------

    def select(self, table: str, *, select: str = "*", filters: Optional[dict[str, str]] = None,
               order: Optional[str] = None, limit: Optional[int] = None) -> list[dict[str, Any]]:
        if not self.configured:
            return []
        params = {"select": select}
        for column, value in (filters or {}).items():
            params[column] = value
        if order:
            params["order"] = order
        if limit:
            params["limit"] = str(limit)
        try:
            resp = requests.get(f"{self.url}/rest/v1/{table}", headers=self._headers(),
                                params=params, timeout=TIMEOUT_S)
            if not resp.ok:
                logger.error("[supabase] select %s failed: HTTP %s %s", table, resp.status_code, resp.text[:300])
                return []
            data = resp.json()
            return data if isinstance(data, list) else []
        except requests.RequestException as exc:
            logger.error("[supabase] select %s error: %s", table, exc)
            return []

    def insert(self, table: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not self.configured or not rows:
            return []
        try:
            resp = requests.post(f"{self.url}/rest/v1/{table}", headers=self._headers("return=representation"),
                                 json=rows, timeout=TIMEOUT_S)
            if not resp.ok:
                logger.error("[supabase] insert %s failed: HTTP %s %s", table, resp.status_code, resp.text[:300])
                return []
            data = resp.json()
            return data if isinstance(data, list) else []
        except requests.RequestException as exc:
            logger.error("[supabase] insert %s error: %s", table, exc)
            return []

    def rpc(self, fn: str, params: dict[str, Any]) -> Any:
        if not self.url:
            return None
        try:
            resp = requests.post(f"{self.url}/rest/v1/rpc/{fn}", headers=self._headers(), json=params,
                                 timeout=TIMEOUT_S)
            if not resp.ok:
                logger.error("[supabase] rpc %s failed: HTTP %s %s", fn, resp.status_code, resp.text[:300])
                return None
            return resp.json()
        except (requests.RequestException, ValueError) as exc:
            logger.error("[supabase] rpc %s error: %s", fn, exc)
            return None

    # -- storage ------------------------------------------------------------

    def download(self, bucket: str, path: str) -> Optional[bytes]:
        """Fetch a private object with the service key (RLS-bypassing)."""
        if not self.configured or not path:
            return None
        try:
            resp = requests.get(
                f"{self.url}/storage/v1/object/{bucket}/{path}",
                headers={"apikey": self.key, "Authorization": f"Bearer {self.key}"},
                timeout=TIMEOUT_S,
            )
            if not resp.ok:
                logger.error("[supabase] download %s failed: HTTP %s", path, resp.status_code)
                return None
            return resp.content
        except requests.RequestException as exc:
            logger.error("[supabase] download %s error: %s", path, exc)
            return None

    # -- auth ---------------------------------------------------------------

    def user_from_jwt(self, token: str) -> Optional[dict[str, Any]]:
        """Validate a user access token. Uses whichever key we have (the anon
        key is sufficient — Supabase treats it as the project's public API key)."""
        if not self.url or not token:
            return None
        key = self.anon_key or self.key
        if not key:
            return None
        try:
            resp = requests.get(
                f"{self.url}/auth/v1/user",
                headers={"apikey": key, "Authorization": f"Bearer {token}"},
                timeout=TIMEOUT_S,
            )
            if not resp.ok:
                return None
            data = resp.json()
            return data if isinstance(data, dict) and data.get("id") else None
        except (requests.RequestException, ValueError):
            return None


supabase = SupabaseREST()

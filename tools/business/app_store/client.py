from __future__ import annotations

import json
import time
from typing import Any

import httpx

from centaur_sdk import secret

_APPSTORE_API_BASE = "https://api.appstoreconnect.apple.com/v1"


class AppStoreClient:
    """App Store Connect API client for sales, reviews, and app data.

    API: https://developer.apple.com/documentation/appstoreconnectapi
    Auth: JWT signed with ES256 using ``APP_STORE_CONNECT_PRIVATE_KEY``,
          ``APP_STORE_KEY_ID``, and ``APP_STORE_ISSUER_ID``.
    """

    def __init__(
        self,
        private_key: str | None = None,
        key_id: str | None = None,
        issuer_id: str | None = None,
    ):
        self.private_key = private_key or secret("APP_STORE_CONNECT_PRIVATE_KEY", "")
        self.key_id = key_id or secret("APP_STORE_KEY_ID", "")
        self.issuer_id = issuer_id or secret("APP_STORE_ISSUER_ID", "")
        if not self.private_key or not self.key_id or not self.issuer_id:
            raise RuntimeError(
                "APP_STORE_CONNECT_PRIVATE_KEY, APP_STORE_KEY_ID, and "
                "APP_STORE_ISSUER_ID must all be set."
            )
        self._token: str | None = None
        self._token_expiry = 0

    def _get_token(self) -> str:
        if self._token and time.time() < self._token_expiry - 60:
            return self._token

        import jwt as pyjwt
        now = int(time.time())
        payload = {
            "iss": self.issuer_id,
            "iat": now,
            "exp": now + 1200,  # 20 min max
            "aud": "appstoreconnect-v1",
        }
        self._token = pyjwt.encode(
            payload,
            self.private_key,
            algorithm="ES256",
            headers={"kid": self.key_id},
        )
        self._token_expiry = now + 1200 - 60
        return self._token

    def _http(self) -> httpx.Client:
        return httpx.Client(
            base_url=_APPSTORE_API_BASE,
            headers={"Authorization": f"Bearer {self._get_token()}"},
            timeout=30.0,
        )

    # ── Apps ──────────────────────────────────────────────────────────────

    def list_apps(self) -> dict[str, Any]:
        """List apps.

        API: ``GET /v1/apps``
        """
        with self._http() as http:
            r = http.get("/apps")
        r.raise_for_status()
        return r.json()

    # ── Sales Reports ─────────────────────────────────────────────────────

    def get_sales_reports(
        self,
        *,
        vendor_number: str,
        report_type: str = "SALES",
        report_sub_type: str = "SUMMARY",
        frequency: str = "DAILY",
        report_date: str | None = None,
    ) -> dict[str, Any]:
        """Download sales reports.

        API: ``GET /v1/salesReports``

        Args:
            vendor_number: Apple vendor number.
            report_type: ``"SALES"``, ``"PRE_ORDER"``, ``"NEWSSTAND"``, ``"SUBSCRIPTION"``.
            report_sub_type: ``"SUMMARY"``, ``"DETAILED"``.
            frequency: ``"DAILY"``, ``"WEEKLY"``, ``"MONTHLY"``, ``"YEARLY"``.
            report_date: Report date in YYYY-MM-DD format.
        """
        params: dict[str, str] = {
            "filter[vendorNumber]": vendor_number,
            "filter[reportType]": report_type,
            "filter[reportSubType]": report_sub_type,
            "filter[frequency]": frequency,
        }
        if report_date:
            params["filter[reportDate]"] = report_date

        with self._http() as http:
            r = http.get("/salesReports", params=params)
        r.raise_for_status()
        return {"body": r.text} if r.text else r.json()

    # ── Customer Reviews ──────────────────────────────────────────────────

    def list_customer_reviews(
        self, app_id: str, *, limit: int = 20
    ) -> dict[str, Any]:
        """List customer reviews for an app.

        API: ``GET /v1/apps/{id}/customerReviews``
        """
        with self._http() as http:
            r = http.get(
                f"/apps/{app_id}/customerReviews",
                params={"limit": min(limit, 200)},
            )
        r.raise_for_status()
        return r.json()

    # ── Builds ────────────────────────────────────────────────────────────

    def list_builds(self, app_id: str, *, limit: int = 20) -> dict[str, Any]:
        """List builds for an app (includes TestFlight).

        API: ``GET /v1/builds?filter[app]={app_id}``
        """
        with self._http() as http:
            r = http.get(
                "/builds",
                params={
                    "filter[app]": app_id,
                    "limit": min(limit, 200),
                },
            )
        r.raise_for_status()
        return r.json()

    # ── App Store Versions ────────────────────────────────────────────────

    def get_app_store_versions(self, app_id: str) -> dict[str, Any]:
        """Get App Store versions for an app.

        API: ``GET /v1/apps/{id}/appStoreVersions``
        """
        with self._http() as http:
            r = http.get(f"/apps/{app_id}/appStoreVersions")
        r.raise_for_status()
        return r.json()

    # ── Subscription Status ────────────────────────────────────────────────

    def get_subscription_statuses(self, app_id: str) -> dict[str, Any]:
        """Get subscription statuses.

        API: ``GET /v1/apps/{id}/subscriptionStatuses``
        """
        with self._http() as http:
            r = http.get(f"/apps/{app_id}/subscriptionStatuses")
        r.raise_for_status()
        return r.json()


def _client() -> AppStoreClient:
    return AppStoreClient()

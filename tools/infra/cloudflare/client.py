from __future__ import annotations

from typing import Any

import httpx

from centaur_sdk import secret

_CF_API_BASE = "https://api.cloudflare.com/client/v4"


class CloudflareClient:
    """Cloudflare API v4 client for zone analytics, DNS, and Workers.

    API: https://developers.cloudflare.com/api/
    Auth: ``CLOUDFLARE_API_TOKEN`` (bearer token with zone read scopes).
    """

    def __init__(self, api_token: str | None = None):
        self.api_token = api_token or secret("CLOUDFLARE_API_TOKEN", "")
        if not self.api_token:
            raise RuntimeError(
                "CLOUDFLARE_API_TOKEN not set. Set it in your .env file "
                "or inject it via the Centaur secrets system."
            )
        self._http = httpx.Client(
            base_url=_CF_API_BASE,
            headers={
                "Authorization": f"Bearer {self.api_token}",
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    # ── Zones ─────────────────────────────────────────────────────────────

    def list_zones(self, *, name: str | None = None) -> dict[str, Any]:
        """List all zones."""
        params = {}
        if name: params["name"] = name
        r = self._http.get("/zones", params=params)
        r.raise_for_status()
        return r.json()

    def get_zone(self, zone_id: str) -> dict[str, Any]:
        """Get zone details."""
        r = self._http.get(f"/zones/{zone_id}")
        r.raise_for_status()
        return r.json()

    # ── Zone Analytics ────────────────────────────────────────────────────

    def get_zone_analytics(
        self,
        zone_id: str,
        *,
        since: str | None = None,
        until: str | None = None,
    ) -> dict[str, Any]:
        """Get zone analytics (requests, bandwidth, threats, pageviews).

        API: ``GET /zones/{zone_id}/analytics/dashboard``
        """
        params: dict[str, Any] = {}
        if since: params["since"] = since
        if until: params["until"] = until
        r = self._http.get(
            f"/zones/{zone_id}/analytics/dashboard", params=params
        )
        r.raise_for_status()
        return r.json()

    def get_zone_analytics_by_colo(
        self, zone_id: str, *, since: str | None = None, until: str | None = None
    ) -> dict[str, Any]:
        """Get analytics grouped by datacenter (colo).

        API: ``GET /zones/{zone_id}/analytics/colos``
        """
        params: dict[str, Any] = {}
        if since: params["since"] = since
        if until: params["until"] = until
        r = self._http.get(f"/zones/{zone_id}/analytics/colos", params=params)
        r.raise_for_status()
        return r.json()

    # ── DNS ───────────────────────────────────────────────────────────────

    def list_dns_records(
        self, zone_id: str, *, type: str | None = None
    ) -> dict[str, Any]:
        """List DNS records for a zone."""
        params: dict[str, Any] = {}
        if type: params["type"] = type
        r = self._http.get(f"/zones/{zone_id}/dns_records", params=params)
        r.raise_for_status()
        return r.json()

    # ── GraphQL Analytics ─────────────────────────────────────────────────

    def graphql_query(self, query: str) -> dict[str, Any]:
        """Run a GraphQL analytics query.

        API: ``POST /graphql``
        """
        r = self._http.post(
            "https://api.cloudflare.com/client/v4/graphql",
            json={"query": query},
        )
        r.raise_for_status()
        return r.json()

    # ── Firewall Rules ────────────────────────────────────────────────────

    def list_firewall_rules(self, zone_id: str) -> dict[str, Any]:
        """List firewall rules for a zone."""
        r = self._http.get(f"/zones/{zone_id}/firewall/rules")
        r.raise_for_status()
        return r.json()

    # ── Workers ───────────────────────────────────────────────────────────

    def list_workers(self, account_id: str) -> dict[str, Any]:
        """List Cloudflare Workers scripts for an account."""
        r = self._http.get(f"/accounts/{account_id}/workers/scripts")
        r.raise_for_status()
        return r.json()


def _client() -> CloudflareClient:
    return CloudflareClient()

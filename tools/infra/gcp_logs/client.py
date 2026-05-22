from __future__ import annotations

import json
import time
from typing import Any

import httpx

from centaur_sdk import secret

_LOGGING_API_BASE = "https://logging.googleapis.com/v2"


class GCPLogsClient:
    """GCP Cloud Logging API v2 client for querying infrastructure logs.

    API: https://cloud.google.com/logging/docs/reference/v2/rest
    Auth: Service account JWT signed with ``GOOGLE_SERVICE_ACCOUNT_JSON``.
          The client signs a JWT and exchanges it for an OAuth2 access token.

    Scope: https://www.googleapis.com/auth/logging.read
    """

    def __init__(self, service_account_json: str | None = None):
        self.sa_json = service_account_json or secret("GOOGLE_SERVICE_ACCOUNT_JSON", "")
        if not self.sa_json:
            raise RuntimeError(
                "GOOGLE_SERVICE_ACCOUNT_JSON not set. Set it in your .env file."
            )
        self._access_token: str | None = None
        self._token_expiry = 0

    def _http(self) -> httpx.Client:
        token = self._get_access_token()
        return httpx.Client(
            base_url=_LOGGING_API_BASE,
            headers={"Authorization": f"Bearer {token}"},
            timeout=30.0,
        )

    def _get_access_token(self) -> str:
        if self._access_token and time.time() < self._token_expiry - 60:
            return self._access_token

        import jwt as pyjwt
        sa = json.loads(self.sa_json)
        now = int(time.time())
        assertion = pyjwt.encode(
            {
                "iss": sa["client_email"],
                "sub": sa["client_email"],
                "scope": "https://www.googleapis.com/auth/logging.read",
                "aud": "https://oauth2.googleapis.com/token",
                "iat": now,
                "exp": now + 3600,
            },
            sa["private_key"],
            algorithm="RS256",
        )

        r = httpx.post(
            "https://oauth2.googleapis.com/token",
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": assertion,
            },
        )
        r.raise_for_status()
        data = r.json()
        self._access_token = data["access_token"]
        self._token_expiry = time.time() + data.get("expires_in", 3600) - 120
        return self._access_token

    # ── Log Entries ───────────────────────────────────────────────────────

    def list_log_entries(
        self,
        *,
        filter: str | None = None,
        resource_names: list[str] | None = None,
        order_by: str = "timestamp desc",
        page_size: int = 50,
    ) -> dict[str, Any]:
        """List log entries with optional filter.

        API: ``POST /v2/entries:list``

        Args:
            filter: Logging query filter (e.g. ``'severity>=ERROR'``,
                    ``'resource.type="k8s_container"'``).
            resource_names: Project resource names (e.g. ``["projects/my-project"]``).
            order_by: Sort order.
            page_size: Results per page.
        """
        body: dict[str, Any] = {
            "pageSize": min(page_size, 500),
            "orderBy": order_by,
        }
        if filter:
            body["filter"] = filter
        if resource_names:
            body["resourceNames"] = resource_names

        with self._http() as http:
            r = http.post("/entries:list", json=body)
        r.raise_for_status()
        return r.json()

    def query_logs(
        self,
        project_id: str,
        filter: str,
        *,
        page_size: int = 50,
    ) -> dict[str, Any]:
        """Query logs for a specific GCP project.

        Convenience method wrapping ``list_log_entries``
        with ``resourceNames=["projects/{project_id}"]``.
        """
        return self.list_log_entries(
            filter=filter,
            resource_names=[f"projects/{project_id}"],
            page_size=page_size,
        )

    def get_gke_logs(
        self,
        project_id: str,
        *,
        cluster_name: str | None = None,
        namespace: str | None = None,
        container_name: str | None = None,
        severity: str = "ERROR",
        page_size: int = 50,
    ) -> dict[str, Any]:
        """Get GKE container logs.

        Builds a filter from the provided parameters.
        """
        parts = [
            'resource.type="k8s_container"',
            f'severity>={severity}',
        ]
        if cluster_name:
            parts.append(f'resource.labels.cluster_name="{cluster_name}"')
        if namespace:
            parts.append(f'resource.labels.namespace_name="{namespace}"')
        if container_name:
            parts.append(f'resource.labels.container_name="{container_name}"')

        return self.list_log_entries(
            filter="\n".join(parts),
            resource_names=[f"projects/{project_id}"],
            page_size=page_size,
        )

    def get_cloud_run_logs(
        self,
        project_id: str,
        *,
        service_name: str | None = None,
        severity: str = "ERROR",
        page_size: int = 50,
    ) -> dict[str, Any]:
        """Get Cloud Run revision logs."""
        parts = [
            'resource.type="cloud_run_revision"',
            f'severity>={severity}',
        ]
        if service_name:
            parts.append(f'resource.labels.service_name="{service_name}"')

        return self.list_log_entries(
            filter="\n".join(parts),
            resource_names=[f"projects/{project_id}"],
            page_size=page_size,
        )

    def get_audit_logs(
        self,
        project_id: str,
        *,
        page_size: int = 50,
    ) -> dict[str, Any]:
        """Get Cloud Audit Logs (admin activity + data access)."""
        return self.list_log_entries(
            filter='logName:"cloudaudit.googleapis.com"',
            resource_names=[f"projects/{project_id}"],
            page_size=page_size,
        )


def _client() -> GCPLogsClient:
    return GCPLogsClient()

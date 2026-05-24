from __future__ import annotations

from typing import Any

import httpx

_LOGGING_API_BASE = "https://logging.googleapis.com/v2"


class GCPLogsClient:
    """GCP Cloud Logging API v2 client for querying infrastructure logs.

    API: https://cloud.google.com/logging/docs/reference/v2/rest

    Auth: handled by iron-proxy's ``gcp_auth`` transform. The proxy loads the
    ``GOOGLE_SERVICE_ACCOUNT_JSON`` service-account keyfile, mints a short-lived
    OAuth2 access token for the ``logging.read`` scope, and injects it as the
    ``Authorization: Bearer`` header on outbound requests to
    ``logging.googleapis.com``. The tool itself sends no credentials, so the
    private key never reaches the sandbox.

    Scope: https://www.googleapis.com/auth/logging.read
    """

    def __init__(self) -> None:
        self._http = httpx.Client(base_url=_LOGGING_API_BASE, timeout=30.0)

    def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        try:
            r = self._http.request(method, path, **kwargs)
            r.raise_for_status()
            return r.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(
                f"GCP Logging API error: {e.response.status_code} - {e.response.text}"
            ) from e
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}") from e

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

        return self._request("POST", "/entries:list", json=body)

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
            f"severity>={severity}",
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
            f"severity>={severity}",
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

from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlencode

import httpx

from centaur_sdk import secret

_SENTRY_API_BASE = "https://sentry.io/api/0"


class SentryClient:
    """Sentry API client for error tracking, issue management, and releases.

    Uses Sentry auth tokens (https://docs.sentry.io/api/auth/).
    Requires auth token scope ``event:read`` for most operations.

    Base URL defaults to ``https://sentry.io/api/0/``.
    Set ``SENTRY_API_BASE`` env var for region-specific domains
    (e.g. ``https://us.sentry.io/api/0/``, ``https://de.sentry.io/api/0/``).

    API reference: https://docs.sentry.io/api/
    """

    def __init__(self, auth_token: str | None = None):
        self.auth_token = auth_token or secret("SENTRY_AUTH_TOKEN", "")
        if not self.auth_token:
            raise RuntimeError(
                "SENTRY_AUTH_TOKEN not set. Set it in your .env file "
                "or inject it via the Centaur secrets system."
            )
        # SENTRY_API_BASE is non-secret config (region selection), not a
        # credential, so it is read from the environment rather than the secret
        # manager. The auth token still comes from secret() above.
        base_url = os.getenv("SENTRY_API_BASE", _SENTRY_API_BASE).strip().rstrip("/")  # noqa: TID251
        self._http = httpx.Client(
            base_url=base_url,
            headers={
                "Authorization": f"Bearer {self.auth_token}",
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    # ── Projects ──────────────────────────────────────────────────────────

    def list_projects(self, organization_slug: str) -> list[dict[str, Any]]:
        """List all projects in an organization.

        API: ``GET /api/0/organizations/{org}/projects/``
        """
        r = self._http.get(f"/organizations/{organization_slug}/projects/")
        r.raise_for_status()
        return r.json()

    # ── Issues ────────────────────────────────────────────────────────────

    def list_issues(
        self,
        organization_slug: str,
        *,
        project_slug: str | None = None,
        query: str | None = None,
        stats_period: str | None = None,
        sort: str | None = None,
        limit: int = 100,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        """List issues for an organization (optionally filtered by project).

        API: ``GET /api/0/organizations/{org}/issues/``

        Args:
            organization_slug: Organization slug (from Sentry URL).
            project_slug: Optional project slug to filter by.
            query: Sentry structured search query
                   (e.g. ``"is:unresolved"``, ``"is:resolved"``,
                   ``"assigned:me"``, ``"error.handled:unhandled"``).
                   Defaults to ``"is:unresolved"`` when not provided.
            stats_period: Stats time window - ``"24h"``, ``"14d"``, or ``""`` for none.
            sort: Sort order (e.g. ``"date"``, ``"new"``, ``"freq"``).
            limit: Max results per page (1-100).
            cursor: Pagination cursor from previous response headers.

        Returns a dict with ``body`` (list of issue dicts) and
        ``pagination`` metadata including ``next_cursor`` for the next page.
        """
        params: dict[str, Any] = {"limit": min(limit, 100)}
        if query is not None:
            params["query"] = query
        if project_slug:
            params["project"] = project_slug
        if stats_period is not None:
            params["statsPeriod"] = stats_period
        if sort:
            params["sort"] = sort
        if cursor:
            params["cursor"] = cursor

        qs = urlencode(params, doseq=True)
        r = self._http.get(f"/organizations/{organization_slug}/issues/?{qs}")
        r.raise_for_status()
        body = r.json()
        return {"body": body, "pagination": self._pagination(r)}

    def get_issue(self, organization_slug: str, issue_id: str) -> dict[str, Any]:
        """Get full details for a single issue.

        API: ``GET /api/0/organizations/{org}/issues/{issue_id}/``

        Includes activity log, tags, stats (24h + 30d), first/last seen,
        assigned user, project info, metadata, and stack trace info.
        """
        r = self._http.get(f"/organizations/{organization_slug}/issues/{issue_id}/")
        r.raise_for_status()
        return r.json()

    def update_issue(
        self,
        organization_slug: str,
        issue_id: str,
        *,
        status: str | None = None,
        assigned_to: str | None = None,
        has_seen: bool | None = None,
        is_bookmarked: bool | None = None,
        is_subscribed: bool | None = None,
    ) -> dict[str, Any]:
        """Update an issue's status, assignment, or metadata.

        API: ``PUT /api/0/organizations/{org}/issues/{issue_id}/``

        Args:
            status: ``"resolved"``, ``"unresolved"``, or ``"ignored"``.
            assigned_to: User ID or ``"me"`` to assign to the calling user.
        """
        body: dict[str, Any] = {}
        if status is not None:
            body["status"] = status
        if assigned_to is not None:
            body["assignedTo"] = assigned_to
        if has_seen is not None:
            body["hasSeen"] = has_seen
        if is_bookmarked is not None:
            body["isBookmarked"] = is_bookmarked
        if is_subscribed is not None:
            body["isSubscribed"] = is_subscribed

        r = self._http.put(
            f"/organizations/{organization_slug}/issues/{issue_id}/",
            json=body,
        )
        r.raise_for_status()
        return r.json()

    def remove_issue(self, organization_slug: str, issue_id: str) -> None:
        """Remove (permanently delete) an issue.

        API: ``DELETE /api/0/organizations/{org}/issues/{issue_id}/``
        """
        r = self._http.delete(f"/organizations/{organization_slug}/issues/{issue_id}/")
        r.raise_for_status()

    # ── Issue Events ──────────────────────────────────────────────────────

    def list_issue_events(
        self,
        organization_slug: str,
        issue_id: str,
    ) -> list[dict[str, Any]]:
        """List individual events for an issue.

        API: ``GET /api/0/organizations/{org}/issues/{issue_id}/events/``

        Returns a list of event objects with ``eventID``, ``dateCreated``,
        ``message``, ``title``, tags, and user info.
        """
        r = self._http.get(f"/organizations/{organization_slug}/issues/{issue_id}/events/")
        r.raise_for_status()
        return r.json()

    def get_issue_event(
        self, organization_slug: str, issue_id: str, event_id: str
    ) -> dict[str, Any]:
        """Get a single event from an issue.

        API: ``GET /api/0/organizations/{org}/issues/{issue_id}/events/{event_id}/``

        Returns the full event payload including stack trace, context,
        tags, user, and breadcrumbs.
        """
        r = self._http.get(
            f"/organizations/{organization_slug}/issues/{issue_id}/events/{event_id}/"
        )
        r.raise_for_status()
        return r.json()

    # ── Issue Tags ────────────────────────────────────────────────────────

    def get_issue_tags(self, organization_slug: str, issue_id: str) -> list[dict[str, Any]]:
        """List all tag keys and their top values for an issue.

        API: ``GET /api/0/organizations/{org}/issues/{issue_id}/tags/``

        Returns tags with ``key``, ``totalValues``, and ``topValues[]``
        containing ``value``, ``count``, ``lastSeen``, ``firstSeen``.
        """
        r = self._http.get(f"/organizations/{organization_slug}/issues/{issue_id}/tags/")
        r.raise_for_status()
        return r.json()

    def get_issue_tag_values(
        self, organization_slug: str, issue_id: str, tag_key: str
    ) -> list[dict[str, Any]]:
        """List all values for a specific tag key on an issue.

        API: ``GET /api/0/organizations/{org}/issues/{issue_id}/tags/{key}/``
        """
        r = self._http.get(f"/organizations/{organization_slug}/issues/{issue_id}/tags/{tag_key}/")
        r.raise_for_status()
        return r.json()

    # ── Issue Hashes ──────────────────────────────────────────────────────

    def list_issue_hashes(
        self,
        organization_slug: str,
        issue_id: str,
    ) -> list[dict[str, Any]]:
        """List hashes for an issue.

        API: ``GET /api/0/organizations/{org}/issues/{issue_id}/hashes/``

        Hash objects include ``id``, ``latestEvent`` (timestamp), and counts
        (``eventCount``, ``userCount``, ``stats``).
        """
        r = self._http.get(f"/organizations/{organization_slug}/issues/{issue_id}/hashes/")
        r.raise_for_status()
        return r.json()

    # ── Events ────────────────────────────────────────────────────────────

    def get_event(self, organization_slug: str, project_slug: str, event_id: str) -> dict[str, Any]:
        """Retrieve a single event by ID from a project.

        API: ``GET /api/0/projects/{org}/{project}/events/{event_id}/``

        Returns full event data: tags, user, contexts, breadcrumbs, entries
        (stacktrace, request, exception), and metadata.
        """
        r = self._http.get(f"/projects/{organization_slug}/{project_slug}/events/{event_id}/")
        r.raise_for_status()
        return r.json()

    def list_project_events(
        self,
        organization_slug: str,
        project_slug: str,
        *,
        full: bool = False,
    ) -> list[dict[str, Any]]:
        """List error events for a project.

        API: ``GET /api/0/projects/{org}/{project}/events/``

        Args:
            full: If True, returns full event payloads.
                  If False, returns summaries only.
        """
        r = self._http.get(
            f"/projects/{organization_slug}/{project_slug}/events/",
            params={"full": "true"} if full else None,
        )
        r.raise_for_status()
        return r.json()

    # ── Releases ──────────────────────────────────────────────────────────

    def list_releases(
        self,
        organization_slug: str,
        *,
        query: str | None = None,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        """List releases for an organization.

        API: ``GET /api/0/organizations/{org}/releases/``

        Args:
            query: Optional "starts with" filter on version string.
            cursor: Pagination cursor.

        Returns dict with ``body`` (release list) and ``pagination``.
        """
        params: dict[str, Any] = {}
        if query:
            params["query"] = query
        if cursor:
            params["cursor"] = cursor

        qs = urlencode(params) if params else ""
        r = self._http.get(f"/organizations/{organization_slug}/releases/{'?' + qs if qs else ''}")
        r.raise_for_status()
        body = r.json()
        return {"body": body, "pagination": self._pagination(r)}

    def get_release(self, organization_slug: str, version: str) -> dict[str, Any]:
        """Get details for a specific release by version.

        API: ``GET /api/0/organizations/{org}/releases/{version}/``

        Includes ``version``, ``dateCreated``, ``dateReleased``, ``ref``,
        ``commitCount``, ``deployCount``, ``newGroups``, project list, and
        file/commit info.
        """
        r = self._http.get(f"/organizations/{organization_slug}/releases/{version}/")
        r.raise_for_status()
        return r.json()

    def list_release_deploys(self, organization_slug: str, version: str) -> list[dict[str, Any]]:
        """List deploys for a release.

        API: ``GET /api/0/organizations/{org}/releases/{version}/deploys/``
        """
        r = self._http.get(f"/organizations/{organization_slug}/releases/{version}/deploys/")
        r.raise_for_status()
        return r.json()

    def list_release_commits(self, organization_slug: str, version: str) -> list[dict[str, Any]]:
        """List commits associated with a release.

        API: ``GET /api/0/organizations/{org}/releases/{version}/commits/``
        """
        r = self._http.get(f"/organizations/{organization_slug}/releases/{version}/commits/")
        r.raise_for_status()
        return r.json()

    # ── Discovery (Performance / Advanced Queries) ────────────────────────

    def discover_query(
        self,
        organization_slug: str,
        *,
        query: str,
        fields: list[str] | None = None,
        sort: str | None = None,
        stats_period: str = "24h",
        limit: int = 100,
    ) -> dict[str, Any]:
        """Run a Discover query against Sentry performance/event data.

        API: ``GET /api/0/organizations/{org}/events/``

        Args:
            query: The Discover search query.
            fields: List of field names to return.
            sort: Sort expression (e.g. ``"-timestamp"``).
            stats_period: Time window - ``"24h"``, ``"14d"``, ``"90d"``.
            limit: Max results.

        Returns ``{"data": [...], "meta": {...}}`` with fields metadata.
        """
        params: dict[str, Any] = {"limit": min(limit, 100)}
        params["statsPeriod"] = stats_period
        if query:
            params["query"] = query
        if fields:
            params["field"] = fields
        if sort:
            params["sort"] = sort

        r = self._http.get(
            f"/organizations/{organization_slug}/events/",
            params=params,
        )
        r.raise_for_status()
        return r.json()

    # ── Pagination helper ─────────────────────────────────────────────────

    @staticmethod
    def _pagination(response: httpx.Response) -> dict[str, Any]:
        """Extract pagination metadata from Link header and response body."""
        link = response.headers.get("link", "")
        result: dict[str, Any] = {"has_next": False}
        if 'rel="next"' in link:
            result["has_next"] = True
        # The actual cursor comes from the last item in the returned list's ID
        body = response.json()
        if isinstance(body, list) and body:
            result["last_id"] = body[-1].get("id")
        # Cursor-based pagination: extract cursor from URL in Link header
        for part in link.split(","):
            if 'rel="next"' in part:
                start = part.find("<")
                end = part.find(">")
                if start >= 0 and end > start:
                    next_url = part[start + 1 : end]
                    if "&cursor=" in next_url:
                        result["next_cursor"] = next_url.split("&cursor=")[-1].split("&")[0]
        return result


def _client() -> SentryClient:
    return SentryClient()

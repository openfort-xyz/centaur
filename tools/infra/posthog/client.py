"""PostHog API client."""

import os

import httpx

from centaur_sdk import secret


class PostHogClient:

    """Client for PostHog API.

    Uses HogQL queries for flexible analytics. Requires a personal API key
    with Query Read permissions. The PostHog project is passed per call —
    a single account often has multiple projects and the agent picks the
    right one at query time.
    """

    def __init__(
        self,
        api_key: str | None = None,
        host: str | None = None,
        timeout: float = 60.0,
    ):
        """Initialize the PostHog client.

        Args:
            api_key: Personal API key (or set POSTHOG_API_KEY)
            host: API host (default: eu.posthog.com; override with POSTHOG_HOST)
            timeout: Request timeout in seconds
        """
        self._api_key = api_key
        self._host = host
        self.timeout = timeout
        self._client: httpx.Client | None = None

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(timeout=self.timeout)
        return self._client

    @property
    def api_key(self) -> str:
        """Get API key from instance or env var."""
        if self._api_key:
            return self._api_key
        key = secret("POSTHOG_API_KEY", "")
        if key:
            return key
        raise RuntimeError("POSTHOG_API_KEY not set.")

    @property
    def host(self) -> str:
        """Get API host."""
        if self._host:
            return self._host
        return os.getenv("POSTHOG_HOST", "eu.posthog.com")  # noqa: TID251

    @property
    def base_url(self) -> str:
        return f"https://{self.host}"

    def _request(
        self,
        method: str,
        endpoint: str,
        json_data: dict | None = None,
        params: dict | None = None,
    ) -> dict | list:
        """Make an authenticated API request."""
        url = f"{self.base_url}{endpoint}"
        headers = {"Authorization": f"Bearer {self.api_key}"}

        try:
            response = self.client.request(
                method, url, headers=headers, json=json_data, params=params
            )
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"API error: {e.response.status_code} - {e.response.text}")
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}")

    def query(self, project_id: str | int, sql: str, name: str | None = None) -> dict:
        """Execute a HogQL query against a specific project.

        Args:
            project_id: PostHog project id (numeric). Required.
            sql: HogQL SQL query
            name: Optional query name for logging
        """
        payload: dict = {
            "query": {
                "kind": "HogQLQuery",
                "query": sql,
            }
        }
        if name:
            payload["name"] = name

        return self._request("POST", f"/api/projects/{project_id}/query/", json_data=payload)

    def events(
        self,
        project_id: str | int,
        event: str | None = None,
        properties: dict | None = None,
        limit: int = 100,
        after: str | None = None,
        before: str | None = None,
    ) -> dict:
        """Query events using HogQL."""
        conditions = []
        if event:
            conditions.append(f"event = '{event}'")
        if after:
            conditions.append(f"timestamp >= '{after}'")
        if before:
            conditions.append(f"timestamp <= '{before}'")

        where_clause = " AND ".join(conditions) if conditions else "1=1"
        sql = f"""
            SELECT timestamp, event, distinct_id, properties
            FROM events
            WHERE {where_clause}
            ORDER BY timestamp DESC
            LIMIT {limit}
        """
        return self.query(project_id, sql, name="events_query")

    def breakdown(
        self,
        project_id: str | int,
        event: str | None = None,
        property: str = "$browser",
        days: int = 7,
        limit: int = 20,
    ) -> dict:
        """Get event breakdown by a property."""
        event_filter = f"AND event = '{event}'" if event else ""
        sql = f"""
            SELECT
                properties.{property} AS value,
                count() AS count,
                round(count() * 100.0 / sum(count()) OVER (), 2) AS percentage
            FROM events
            WHERE timestamp >= now() - INTERVAL {days} DAY
            {event_filter}
            GROUP BY value
            ORDER BY count DESC
            LIMIT {limit}
        """
        return self.query(project_id, sql, name=f"breakdown_{property}")

    def pageviews(
        self,
        project_id: str | int,
        url_pattern: str | None = None,
        days: int = 7,
        limit: int = 20,
    ) -> dict:
        """Get pageview analytics."""
        url_filter = f"AND properties.$current_url LIKE '%{url_pattern}%'" if url_pattern else ""
        sql = f"""
            SELECT
                properties.$current_url AS url,
                count() AS views,
                uniq(distinct_id) AS unique_visitors
            FROM events
            WHERE event = '$pageview'
            AND timestamp >= now() - INTERVAL {days} DAY
            {url_filter}
            GROUP BY url
            ORDER BY views DESC
            LIMIT {limit}
        """
        return self.query(project_id, sql, name="pageviews")

    def user_agents(
        self,
        project_id: str | int,
        url_pattern: str | None = None,
        event: str = "$pageview",
        days: int = 7,
        limit: int = 20,
    ) -> dict:
        """Get user-agent breakdown."""
        url_filter = f"AND properties.$current_url LIKE '%{url_pattern}%'" if url_pattern else ""
        sql = f"""
            SELECT
                properties.$browser AS browser,
                properties.$os AS os,
                count() AS count,
                round(count() * 100.0 / sum(count()) OVER (), 2) AS percentage
            FROM events
            WHERE event = '{event}'
            AND timestamp >= now() - INTERVAL {days} DAY
            {url_filter}
            GROUP BY browser, os
            ORDER BY count DESC
            LIMIT {limit}
        """
        return self.query(project_id, sql, name="user_agents")

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()



def _client() -> PostHogClient:
    api_key = secret("POSTHOG_API_KEY", "")
    return PostHogClient(api_key=api_key)

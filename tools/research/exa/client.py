from __future__ import annotations

from typing import Any

import httpx

from centaur_sdk import secret


class ExaClient:
    """Exa semantic search client.

    API: https://docs.exa.ai/reference
    Auth: ``EXA_API_KEY`` (bearer token).
    """

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or secret("EXA_API_KEY", "")
        if not self.api_key:
            raise RuntimeError(
                "EXA_API_KEY not set. Set it in your .env file."
            )
        self._http = httpx.Client(
            base_url="https://api.exa.ai",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    def semantic_search(
        self,
        query: str,
        *,
        num_results: int = 10,
        include_domains: list[str] | None = None,
        exclude_domains: list[str] | None = None,
        use_autoprompt: bool = False,
        type: str = "auto",
    ) -> dict[str, Any]:
        """Semantic search the web.

        API: ``POST /search``

        Args:
            query: Natural language search query.
            num_results: Number of results.
            include_domains: Restrict to these domains.
            exclude_domains: Exclude these domains.
            use_autoprompt: Let Exa optimize the search query.
            type: Result type — ``"auto"``, ``"neural"``, or ``"keyword"``.
        """
        body: dict[str, Any] = {
            "query": query,
            "numResults": min(num_results, 25),
            "useAutoprompt": use_autoprompt,
            "type": type,
        }
        if include_domains:
            body["includeDomains"] = include_domains
        if exclude_domains:
            body["excludeDomains"] = exclude_domains

        r = self._http.post("/search", json=body)
        r.raise_for_status()
        return r.json()

    def get_contents(
        self,
        urls: list[str],
        *,
        text: bool = True,
        highlights: bool = False,
    ) -> dict[str, Any]:
        """Get page contents by URL.

        API: ``POST /contents``

        Args:
            urls: List of URLs to retrieve.
            text: Include full text content.
            highlights: Include highlighted snippets.
        """
        r = self._http.post(
            "/contents",
            json={
                "urls": urls,
                "text": text,
                "highlights": highlights,
            },
        )
        r.raise_for_status()
        return r.json()

    def find_similar(
        self,
        url: str,
        *,
        num_results: int = 10,
    ) -> dict[str, Any]:
        """Find pages similar to a given URL.

        API: ``POST /findSimilar``
        """
        r = self._http.post(
            "/findSimilar",
            json={
                "url": url,
                "numResults": min(num_results, 25),
            },
        )
        r.raise_for_status()
        return r.json()


def _client() -> ExaClient:
    return ExaClient()

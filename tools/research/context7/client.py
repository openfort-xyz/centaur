from __future__ import annotations

from typing import Any

import httpx


class Context7Client:
    """Context7 client for searching library documentation.

    Queries the Context7 MCP server for up-to-date library docs.
    No authentication required (anonymous access via MCP).

    API: https://mcp.context7.com
    """

    def __init__(self):
        self._http = httpx.Client(
            base_url="https://mcp.context7.com",
            headers={"Content-Type": "application/json"},
            timeout=30.0,
        )

    def search_docs(
        self,
        query: str,
        *,
        library: str | None = None,
        top_k: int = 5,
    ) -> dict[str, Any]:
        """Search library documentation.

        Args:
            query: Natural language search query.
            library: Optional library name to scope the search.
            top_k: Number of results to return (default 5).
        """
        body: dict[str, Any] = {
            "query": query,
            "top_k": top_k,
        }
        if library:
            body["library"] = library

        r = self._http.post("/search", json=body)
        r.raise_for_status()
        return r.json()

    def get_library_docs(
        self,
        library: str,
        *,
        topic: str | None = None,
    ) -> dict[str, Any]:
        """Get documentation for a specific library or topic.

        Args:
            library: Library identifier (e.g. "react", "python", "kubernetes").
            topic: Optional topic within the library.
        """
        params: dict[str, str] = {}
        if topic:
            params["topic"] = topic

        r = self._http.get(f"/docs/{library}", params=params)
        r.raise_for_status()
        return r.json()


def _client() -> Context7Client:
    return Context7Client()

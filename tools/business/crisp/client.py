from __future__ import annotations

from typing import Any

import httpx

from centaur_sdk import secret

_CRISP_API_BASE = "https://api.crisp.chat/v1"


class CrispClient:
    """Crisp Chat REST API v1 client for customer support management.

    Uses plugin tier authentication with identifier:key pairs.
    API reference: https://docs.crisp.chat/api/v1/

    Auth: Set ``CRISP_API_CREDENTIALS`` to the base64-encoded ``identifier:key``
    pair (i.e. the HTTP Basic token value, ``base64("identifier:key")``). The
    client sends it verbatim as ``Authorization: Basic <token>`` with an
    ``X-Crisp-Tier: plugin`` header. The value is sent unencoded so the
    iron-proxy placeholder survives intact and the firewall can swap in the
    real credential in the sandbox.
    """

    def __init__(self, credentials: str | None = None):
        self.credentials = credentials or secret("CRISP_API_CREDENTIALS", "")
        if not self.credentials:
            raise RuntimeError(
                "CRISP_API_CREDENTIALS not set. Set it to base64(identifier:key) "
                "in your .env file or inject it via the Centaur secrets system."
            )
        self._http = httpx.Client(
            base_url=_CRISP_API_BASE,
            headers={
                "Authorization": f"Basic {self.credentials}",
                "X-Crisp-Tier": "plugin",
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )

    # ── Website ───────────────────────────────────────────────────────────

    def get_website(self, website_id: str) -> dict[str, Any]:
        """Get website information.

        API: ``GET /v1/website/{website_id}``
        """
        r = self._http.get(f"/website/{website_id}")
        r.raise_for_status()
        return r.json()

    # ── Conversations ─────────────────────────────────────────────────────

    def list_conversations(
        self,
        website_id: str,
        page: int = 1,
        *,
        search_query: str | None = None,
        filter_unread: bool = False,
        filter_resolved: bool = False,
        filter_not_resolved: bool = False,
        filter_assigned: str | None = None,
        filter_unassigned: bool = False,
        filter_date_start: str | None = None,
        filter_date_end: str | None = None,
        per_page: int = 20,
    ) -> dict[str, Any]:
        """List conversations for a website with filtering and pagination.

        API: ``GET /v1/website/{website_id}/conversations/{page}``

        Args:
            website_id: The website identifier.
            page: Page number (starting from 1).
            search_query: Full-text search query across conversations.
            filter_unread: Only unread conversations.
            filter_resolved: Only resolved conversations.
            filter_not_resolved: Only unresolved conversations.
            filter_assigned: Operator user ID to filter by assignment.
            filter_unassigned: Only unassigned conversations.
            filter_date_start: ISO 8601 start date.
            filter_date_end: ISO 8601 end date.
            per_page: Results per page (20-50).
        """
        params: dict[str, str] = {"per_page": str(max(20, min(per_page, 50)))}
        if search_query:
            params["search_query"] = search_query
        if filter_unread:
            params["filter_unread"] = "1"
        if filter_resolved:
            params["filter_resolved"] = "1"
        if filter_not_resolved:
            params["filter_not_resolved"] = "1"
        if filter_assigned:
            params["filter_assigned"] = filter_assigned
        if filter_unassigned:
            params["filter_unassigned"] = "1"
        if filter_date_start:
            params["filter_date_start"] = filter_date_start
        if filter_date_end:
            params["filter_date_end"] = filter_date_end

        r = self._http.get(f"/website/{website_id}/conversations/{page}", params=params)
        r.raise_for_status()
        return r.json()

    def search_conversations(
        self,
        website_id: str,
        query: str,
        page: int = 1,
    ) -> dict[str, Any]:
        """Search conversations by text query.

        API: ``GET /v1/website/{website_id}/conversations/{page}?search_query=...``
        """
        return self.list_conversations(website_id, page, search_query=query)

    def get_conversation(self, website_id: str, session_id: str) -> dict[str, Any]:
        """Get full conversation details.

        API: ``GET /v1/website/{website_id}/conversation/{session_id}``

        Returns conversation metadata: state, availability, last message,
        assigned operator, visitor info (nickname, email, phone, geolocation,
        device), segments, created/updated timestamps, unread counts.
        """
        r = self._http.get(f"/website/{website_id}/conversation/{session_id}")
        r.raise_for_status()
        return r.json()

    def get_conversation_messages(self, website_id: str, session_id: str) -> dict[str, Any]:
        """Get all messages in a conversation.

        API: ``GET /v1/website/{website_id}/conversation/{session_id}/messages``

        Returns list of messages with ``type``, ``from`` (user/operator),
        ``content``, ``timestamp``, ``origin``, ``user`` info.
        """
        r = self._http.get(f"/website/{website_id}/conversation/{session_id}/messages")
        r.raise_for_status()
        return r.json()

    def send_message(
        self,
        website_id: str,
        session_id: str,
        content: str,
        *,
        message_type: str = "text",
    ) -> dict[str, Any]:
        """Send a message in a conversation.

        API: ``POST /v1/website/{website_id}/conversation/{session_id}/message``

        Args:
            content: The message text content.
            message_type: ``"text"`` (default), ``"note"`` (internal note),
                          ``"picker"``, ``"field"``, ``"carousel"``.
        """
        r = self._http.post(
            f"/website/{website_id}/conversation/{session_id}/message",
            json={
                "type": message_type,
                "content": content,
                "from": "operator",
            },
        )
        r.raise_for_status()
        return r.json()

    def send_internal_note(self, website_id: str, session_id: str, content: str) -> dict[str, Any]:
        """Add an internal note (not visible to the customer).

        Wraps ``send_message`` with ``message_type="note"``.
        """
        return self.send_message(website_id, session_id, content, message_type="note")

    def change_conversation_state(
        self, website_id: str, session_id: str, state: str
    ) -> dict[str, Any]:
        """Change conversation state.

        API: ``PATCH /v1/website/{website_id}/conversation/{session_id}/state``

        Args:
            state: ``"pending"``, ``"unresolved"``, or ``"resolved"``.
        """
        r = self._http.patch(
            f"/website/{website_id}/conversation/{session_id}/state",
            json={"state": state},
        )
        r.raise_for_status()
        return r.json()

    def resolve_conversation(self, website_id: str, session_id: str) -> dict[str, Any]:
        """Resolve a conversation (mark as done)."""
        return self.change_conversation_state(website_id, session_id, "resolved")

    def reopen_conversation(self, website_id: str, session_id: str) -> dict[str, Any]:
        """Reopen a resolved conversation."""
        return self.change_conversation_state(website_id, session_id, "unresolved")

    def get_conversation_metas(self, website_id: str, session_id: str) -> dict[str, Any]:
        """Get metadata for a conversation (nickname, email, phone, address, data).

        API: ``GET /v1/website/{website_id}/conversation/{session_id}/meta``
        """
        r = self._http.get(f"/website/{website_id}/conversation/{session_id}/meta")
        r.raise_for_status()
        return r.json()

    def update_conversation_metas(
        self,
        website_id: str,
        session_id: str,
        *,
        nickname: str | None = None,
        email: str | None = None,
        phone: str | None = None,
        address: str | None = None,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Update conversation metadata.

        API: ``PATCH /v1/website/{website_id}/conversation/{session_id}/meta``
        """
        body: dict[str, Any] = {}
        if nickname is not None:
            body["nickname"] = nickname
        if email is not None:
            body["email"] = email
        if phone is not None:
            body["phone"] = phone
        if address is not None:
            body["address"] = address
        if data is not None:
            body["data"] = data

        r = self._http.patch(
            f"/website/{website_id}/conversation/{session_id}/meta",
            json=body,
        )
        r.raise_for_status()
        return r.json()

    def get_conversation_routing(self, website_id: str, session_id: str) -> dict[str, Any]:
        """Get routing assignment for a conversation.

        API: ``GET /v1/website/{website_id}/conversation/{session_id}/routing``
        """
        r = self._http.get(f"/website/{website_id}/conversation/{session_id}/routing")
        r.raise_for_status()
        return r.json()

    def assign_conversation(self, website_id: str, session_id: str, user_id: str) -> dict[str, Any]:
        """Assign a conversation to an operator.

        API: ``PATCH /v1/website/{website_id}/conversation/{session_id}/routing``
        """
        r = self._http.patch(
            f"/website/{website_id}/conversation/{session_id}/routing",
            json={"assigned": [{"user_id": user_id}]},
        )
        r.raise_for_status()
        return r.json()

    def mark_messages_read(self, website_id: str, session_id: str) -> dict[str, Any]:
        """Mark all messages in a conversation as read.

        API: ``PATCH /v1/website/{website_id}/conversation/{session_id}/read``
        """
        r = self._http.patch(
            f"/website/{website_id}/conversation/{session_id}/read",
            json={"from": "operator"},
        )
        r.raise_for_status()
        return r.json()

    # ── People (Customer Profiles) ───────────────────────────────────────

    def get_people_profile(self, website_id: str, people_id: str) -> dict[str, Any]:
        """Get a people profile by ID.

        API: ``GET /v1/website/{website_id}/people/profile/{people_id}``
        """
        r = self._http.get(f"/website/{website_id}/people/profile/{people_id}")
        r.raise_for_status()
        return r.json()

    def list_people_profiles(
        self,
        website_id: str,
        page: int = 1,
        *,
        search_query: str | None = None,
    ) -> dict[str, Any]:
        """List people profiles with optional search.

        API: ``GET /v1/website/{website_id}/people/profiles/{page}``
        """
        params: dict[str, str] = {}
        if search_query:
            params["search_query"] = search_query
        r = self._http.get(f"/website/{website_id}/people/profiles/{page}", params=params)
        r.raise_for_status()
        return r.json()

    def get_people_conversations(self, website_id: str, people_id: str) -> dict[str, Any]:
        """List conversations for a people profile.

        API: ``GET /v1/website/{website_id}/people/conversations/{people_id}``
        """
        r = self._http.get(f"/website/{website_id}/people/conversations/{people_id}")
        r.raise_for_status()
        return r.json()

    def get_people_data(self, website_id: str, people_id: str) -> dict[str, Any]:
        """Get data attached to a people profile.

        API: ``GET /v1/website/{website_id}/people/data/{people_id}``
        """
        r = self._http.get(f"/website/{website_id}/people/data/{people_id}")
        r.raise_for_status()
        return r.json()

    def update_people_data(
        self,
        website_id: str,
        people_id: str,
        data: dict[str, Any],
    ) -> dict[str, Any]:
        """Update data on a people profile.

        API: ``PATCH /v1/website/{website_id}/people/data/{people_id}``
        """
        r = self._http.patch(
            f"/website/{website_id}/people/data/{people_id}",
            json={"data": data},
        )
        r.raise_for_status()
        return r.json()

    # ── Operators ────────────────────────────────────────────────────────

    def list_operators(self, website_id: str) -> dict[str, Any]:
        """List operators for a website.

        API: ``GET /v1/website/{website_id}/operators/list``
        """
        r = self._http.get(f"/website/{website_id}/operators/list")
        r.raise_for_status()
        return r.json()

    # ── Segments (Tags) ──────────────────────────────────────────────────

    def list_segments(self, website_id: str, page: int = 1) -> dict[str, Any]:
        """List suggested conversation segments (tags/categories).

        API: ``GET /v1/website/{website_id}/conversations/suggest/segments/{page}``
        """
        r = self._http.get(f"/website/{website_id}/conversations/suggest/segments/{page}")
        r.raise_for_status()
        return r.json()

    # ── Analytics ────────────────────────────────────────────────────────

    def generate_analytics(
        self,
        website_id: str,
        *,
        date_start: str,
        date_end: str,
        dimension: str | None = None,
        metrics: list[str] | None = None,
    ) -> dict[str, Any]:
        """Generate analytics data for a website.

        API: ``POST /v1/website/{website_id}/analytics/generate``

        Args:
            date_start: Start date ISO 8601.
            date_end: End date ISO 8601.
            dimension: Optional grouping dimension.
            metrics: List of metric names to compute.
        """
        body: dict[str, Any] = {
            "date_start": date_start,
            "date_end": date_end,
        }
        if dimension:
            body["dimension"] = dimension
        if metrics:
            body["metrics"] = metrics

        r = self._http.post(f"/website/{website_id}/analytics/generate", json=body)
        r.raise_for_status()
        return r.json()


def _client() -> CrispClient:
    return CrispClient()

from __future__ import annotations

import json
import random
import time
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import urlencode

# Google Chat is a Google Workspace API, so it reuses the same proxy-routed
# httplib2 transport the Drive/Calendar ETLs use. Only the transport helper is
# shared; this package stays the messaging analog of workflows/slack.
from workflows.gsuite.http import build_http

CHAT_API_BASE = "https://chat.googleapis.com/v1"
# Bound every Chat call so a blocked egress rule fails fast instead of hanging
# the workflow indefinitely (httplib2 has no default timeout).
CHAT_HTTP_TIMEOUT_SECONDS = 60.0
MAX_GET_ATTEMPTS = 3
MAX_RETRY_DELAY_SECONDS = 30.0

# App-authentication is minted by iron-proxy's gcp_auth transform, exactly like
# the Drive/Calendar ETLs. Opt-in private-DM sync uses WorkflowContext's
# subject-bound api-rs broker; the service-account key stays in googlechatbot.
#
# The grant must request these scopes (configured on the proxy, not here):
#   https://www.googleapis.com/auth/chat.bot
#   https://www.googleapis.com/auth/chat.app.messages.readonly
# chat.app.messages.readonly is what permits history reads, and REQUIRES a
# one-time Workspace-admin install of the app's Marketplace listing — the
# self-granted chat.bot scope alone is rejected with 403 for history.


class GoogleChatReadonlyClient:
    """Read-only Google Chat REST client used by the ETL workflow.

    Uses raw REST (not the discovery client) because the bundled
    google-api-python-client static discovery does not always include Chat v1.
    App-auth requests rely on iron-proxy; opt-in DM reads use subject-bound DWD.
    """

    def __init__(self, ctx: Any) -> None:
        self._ctx = ctx
        self._http: Any = None

    def _transport(self) -> Any:
        if self._http is None:
            self._http = build_http(timeout=CHAT_HTTP_TIMEOUT_SECONDS)
        return self._http

    def _get(self, url: str) -> dict[str, Any]:
        for attempt in range(MAX_GET_ATTEMPTS):
            response, content = self._transport().request(url, method="GET")
            if response.status < 400:
                return json.loads(content) if content else {}
            if response.status not in {429, 500, 502, 503, 504} or attempt == MAX_GET_ATTEMPTS - 1:
                body = content.decode("utf-8", "replace") if content else ""
                raise RuntimeError(f"Chat API GET {url} failed: {response.status} {body}")
            time.sleep(_retry_delay_seconds(response, attempt))
        raise RuntimeError("unreachable")

    def list_spaces(
        self,
        *,
        page_size: int = 100,
        page_token: str | None = None,
    ) -> dict[str, Any]:
        """List spaces the Chat app is a member of."""
        params: dict[str, Any] = {"pageSize": page_size}
        if page_token:
            params["pageToken"] = page_token
        return self._get(f"{CHAT_API_BASE}/spaces?{urlencode(params)}")

    def list_messages(
        self,
        space_name: str,
        *,
        page_size: int = 100,
        page_token: str | None = None,
        filter: str | None = None,
        show_deleted: bool = False,
    ) -> dict[str, Any]:
        """List messages in a space, oldest-first. Pass filter='createTime >
        "<rfc3339>"' for incremental sync."""
        params: dict[str, Any] = {"pageSize": page_size, "orderBy": "createTime ASC"}
        if page_token:
            params["pageToken"] = page_token
        if filter:
            params["filter"] = filter
        if show_deleted:
            params["showDeleted"] = "true"
        return self._get(f"{CHAT_API_BASE}/{space_name}/messages?{urlencode(params)}")

    def list_members(
        self,
        space_name: str,
        *,
        page_size: int = 100,
        page_token: str | None = None,
    ) -> dict[str, Any]:
        """List memberships in a space (used to resolve human sender names)."""
        params: dict[str, Any] = {"pageSize": page_size}
        if page_token:
            params["pageToken"] = page_token
        return self._get(f"{CHAT_API_BASE}/{space_name}/members?{urlencode(params)}")

    async def list_reactions(
        self,
        message_name: str,
        *,
        page_size: int = 100,
        page_token: str | None = None,
    ) -> dict[str, Any]:
        result = await self._ctx.google_chat_dwd_read(
            "",
            "list_reactions",
            resource_name=message_name,
            page_size=page_size,
            page_token=page_token,
        )
        return result if isinstance(result, dict) else {}


class GoogleChatDelegatedClient:
    """DWD reader whose only transport is the trusted WorkflowContext RPC."""

    def __init__(self, ctx: Any, subject: str) -> None:
        self._ctx = ctx
        self._subject = subject

    async def _read(
        self,
        operation: str,
        resource_name: str = "",
        *,
        page_size: int,
        page_token: str | None = None,
        filter: str | None = None,
    ) -> dict[str, Any]:
        result = await self._ctx.google_chat_dwd_read(
            self._subject,
            operation,
            resource_name=resource_name,
            page_size=page_size,
            page_token=page_token,
            filter=filter,
        )
        return result if isinstance(result, dict) else {}

    async def list_spaces(
        self, *, page_size: int = 100, page_token: str | None = None
    ) -> dict[str, Any]:
        return await self._read(
            "list_spaces", page_size=page_size, page_token=page_token
        )

    async def list_messages(
        self,
        space_name: str,
        *,
        page_size: int = 100,
        page_token: str | None = None,
        filter: str | None = None,
        show_deleted: bool = False,
    ) -> dict[str, Any]:
        return await self._read(
            "list_messages",
            space_name,
            page_size=page_size,
            page_token=page_token,
            filter=filter,
            **({"show_deleted": True} if show_deleted else {}),
        )

    async def list_members(
        self,
        space_name: str,
        *,
        page_size: int = 100,
        page_token: str | None = None,
    ) -> dict[str, Any]:
        return await self._read(
            "list_members", space_name, page_size=page_size, page_token=page_token
        )

    async def list_reactions(
        self,
        message_name: str,
        *,
        page_size: int = 100,
        page_token: str | None = None,
    ) -> dict[str, Any]:
        return await self._read(
            "list_reactions", message_name, page_size=page_size, page_token=page_token
        )


def _retry_delay_seconds(response: Any, attempt: int) -> float:
    raw = getattr(response, "get", lambda *_args: None)("retry-after")
    if raw:
        try:
            delay = float(raw)
        except (TypeError, ValueError):
            try:
                delay = parsedate_to_datetime(str(raw)).timestamp() - time.time()
            except (TypeError, ValueError, OverflowError):
                delay = -1
        if delay >= 0:
            return min(delay, MAX_RETRY_DELAY_SECONDS)
    if getattr(response, "status", None) == 429:
        return min(MAX_RETRY_DELAY_SECONDS, 2**attempt + random.random())
    return random.random() * min(MAX_RETRY_DELAY_SECONDS, 0.25 * 2**attempt)

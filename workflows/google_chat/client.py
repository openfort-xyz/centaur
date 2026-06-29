from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlencode

# Google Chat is a Google Workspace API, so it reuses the same proxy-routed
# httplib2 transport the Drive/Calendar ETLs use. Only the transport helper is
# shared; this package stays the messaging analog of workflows/slack.
from workflows.gsuite.http import build_http

CHAT_API_BASE = "https://chat.googleapis.com/v1"

# Authentication is minted by iron-proxy's gcp_auth transform, exactly like the
# Drive/Calendar ETLs (GOOGLE_TOKEN_JSON) and the gsc/gcp_logs tools: the proxy
# loads GOOGLE_SERVICE_ACCOUNT_JSON, mints an OAuth token for the Chat scopes,
# and injects `Authorization: Bearer` on outbound requests to chat.googleapis.com.
# The workflow host never holds the service-account key.
#
# The grant must request these scopes (configured on the proxy, not here):
#   https://www.googleapis.com/auth/chat.bot
#   https://www.googleapis.com/auth/chat.app.messages.readonly
# chat.app.messages.readonly is what permits history reads, and REQUIRES a
# one-time Workspace-admin install of the app's Marketplace listing — the
# self-granted chat.bot scope alone is rejected with 403 for history.


def _space_id(space_name: str) -> str:
    """Accept either a bare id ("AAQA…") or a resource name ("spaces/AAQA…")."""
    return space_name.rsplit("/", 1)[-1] if space_name else space_name


class GoogleChatReadonlyClient:
    """Read-only Google Chat REST client used by the ETL workflow.

    Uses raw REST (not the discovery client) because the bundled
    google-api-python-client static discovery does not always include Chat v1.
    Requests carry no credentials; iron-proxy injects the bearer at the edge.
    """

    def __init__(self) -> None:
        self._http: Any = None

    def _transport(self) -> Any:
        if self._http is None:
            self._http = build_http()
        return self._http

    def _get(self, url: str) -> dict[str, Any]:
        response, content = self._transport().request(url, method="GET")
        status = int(getattr(response, "status", 0) or 0)
        if status >= 400:
            body = content.decode("utf-8", "replace") if content else ""
            raise RuntimeError(f"Chat API GET {url} failed: {status} {body}")
        if not content:
            return {}
        return json.loads(content)

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
        order_by: str = "createTime asc",
    ) -> dict[str, Any]:
        """List messages in a space. Pass filter='createTime > "<rfc3339>"' for
        incremental sync; order_by 'createTime asc' walks history oldest-first."""
        params: dict[str, Any] = {"pageSize": page_size, "orderBy": order_by}
        if page_token:
            params["pageToken"] = page_token
        if filter:
            params["filter"] = filter
        return self._get(
            f"{CHAT_API_BASE}/spaces/{_space_id(space_name)}/messages?{urlencode(params)}"
        )

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
        return self._get(
            f"{CHAT_API_BASE}/spaces/{_space_id(space_name)}/members?{urlencode(params)}"
        )

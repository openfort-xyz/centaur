from __future__ import annotations

import json
import os
import re
from typing import Any

from centaur_sdk import secret

# In-cluster default for the googlechatbot outbound relay (send/update/delete).
# Read from the environment, NOT secret(): in server mode the secret backend is
# a stub that returns the KEY NAME for any key absent from the env and never
# None, so `secret("CHATBOT_URL", default)` would return the literal
# "CHATBOT_URL" and the default would be dead code (httpx then lowercases the
# host to `chatbot_url`). os.environ.get honors a real override and falls back
# to the real default.
_DEFAULT_CHATBOT_URL = "http://centaur-centaur-googlechatbot:3002"

# The real Google Chat API. Reads (list) and uploads go straight here, NOT
# through the in-cluster bot relay: a sandbox's egress is a CONNECT/HTTPS-only
# firewall (iron-proxy) that cannot reach the plain-HTTP relay, but CAN MITM
# this real public host and INJECT credentials at the edge from its gcp_auth
# grants (app-auth token on GET reads, a domain-wide-delegation token on POST
# uploads). The tool therefore sends NO auth header of its own and never holds a
# real credential. This mirrors the Slack tool (which talks to slack.com).
_GOOGLE_CHAT_API_BASE = "https://chat.googleapis.com"

_MIME_TYPE_RE = re.compile(r"^[\w.+-]+/[\w.+-]+$")


def _safe_mime_type(value: str | None) -> str:
    """A ``type/subtype`` token with no CR/LF, safe to place in a part header.

    Falls back to a generic binary type for anything malformed or
    injection-shaped, so a caller-supplied mime type can't smuggle extra
    multipart headers into the request body.
    """
    return value if value and _MIME_TYPE_RE.match(value) else "application/octet-stream"


def _space_id(space_name: str) -> str:
    """Strip the ``spaces/`` prefix, accepting bare ids or resource names."""
    return space_name[len("spaces/") :] if space_name.startswith("spaces/") else space_name


def _base_url() -> str:
    """Resolve CHATBOT_URL and guarantee an http(s) scheme.

    A bare host like ``chatbot:3002`` makes httpx read ``chatbot`` as the URL
    scheme and raise UnsupportedProtocol, so prepend ``http://`` when no
    http(s) scheme is present.
    """

    url = (os.environ.get("CHATBOT_URL", _DEFAULT_CHATBOT_URL) or _DEFAULT_CHATBOT_URL).strip()
    if not url.startswith(("http://", "https://")):
        url = f"http://{url}"
    return url.rstrip("/")


class GoogleChatClient:
    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or secret("CHATBOT_API_KEY", "")
        if not self.api_key:
            raise RuntimeError(
                "CHATBOT_API_KEY not set. Set it in your .env file "
                "or inject it via the Centaur secrets system."
            )

    def send_message(
        self,
        space_name: str,
        text: str,
        *,
        thread_name: str | None = None,
    ) -> dict[str, Any]:
        import httpx

        base_url = _base_url()
        body: dict[str, Any] = {
            "space_name": space_name,
            "text": text,
        }
        if thread_name:
            body["thread_name"] = thread_name

        response = httpx.post(
            f"{base_url}/api/chat/messages",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json=body,
            timeout=30.0,
        )
        response.raise_for_status()
        return response.json() if response.text else {}

    def list_messages(
        self,
        space_name: str,
        *,
        page_size: int = 20,
        filter: str | None = None,
    ) -> dict[str, Any]:
        """List messages in a space, reading the real Chat API directly.

        Goes to chat.googleapis.com (NOT the bot relay, which a sandbox's
        CONNECT-only egress firewall can't reach): iron-proxy MITMs this real
        host and injects the app-auth read token from its gcp_auth GET grant, so
        the tool sends NO auth header. App auth cannot read DM spaces (Google
        returns 400 there) — DM history reaches the agent via the bot's session
        context instead; this path serves multi-party SPACE reads.

        Returns the Chat API `{messages, nextPageToken}` shape unchanged.
        `filter` scopes to a thread, e.g. ``thread.name="spaces/S/threads/T"``.
        """
        import httpx

        space_id = _space_id(space_name)
        params: dict[str, Any] = {"pageSize": page_size}
        if filter:
            params["filter"] = filter
        response = httpx.get(
            f"{_GOOGLE_CHAT_API_BASE}/v1/spaces/{space_id}/messages",
            params=params,
            headers={"Content-Type": "application/json"},
            timeout=30.0,
        )
        response.raise_for_status()
        return response.json() if response.text else {}

    def update_message(
        self,
        message_name: str,
        text: str,
    ) -> dict[str, Any]:
        import httpx

        base_url = _base_url()
        response = httpx.patch(
            f"{base_url}/api/chat/messages",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json={
                "message_name": message_name,
                "text": text,
            },
            timeout=30.0,
        )
        response.raise_for_status()
        return response.json() if response.text else {}

    def delete_message(
        self,
        message_name: str,
    ) -> dict[str, Any]:
        import httpx

        base_url = _base_url()
        response = httpx.request(
            "DELETE",
            f"{base_url}/api/chat/messages",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json={"message_name": message_name},
            timeout=30.0,
        )
        response.raise_for_status()
        return response.json() if response.text else {}

    def upload_attachment(
        self,
        space_name: str,
        filename: str,
        content: bytes,
        *,
        mime_type: str | None = None,
        text: str | None = None,
        thread_name: str | None = None,
    ) -> dict[str, Any]:
        """Upload a file into a space, posting directly to the real Google Chat API.

        Two-call flow, ported from the bot's uploadAttachment/createAttachmentMessage:
        1. multipart media upload to ``/upload/v1/.../attachments:upload``
        2. message create referencing the returned attachment data ref

        Both requests go to chat.googleapis.com with NO Authorization header —
        iron-proxy's gcp_auth grant injects the domain-wide-delegation bearer at
        the edge (Google's media.upload rejects app auth). Longer timeout
        because uploads can be large.
        """
        import uuid
        from urllib.parse import quote

        import httpx

        space_id = _space_id(space_name)

        # 1. Upload the media. multipart/related: JSON metadata part (the
        # required UploadAttachmentRequest `filename`) then the raw file bytes.
        # filename is JSON-escaped and mime_type is validated to a token/token
        # grammar so neither can inject CRLF or extra part headers into the body.
        boundary = f"centaur-upload-{uuid.uuid4()}"
        head = (
            f"--{boundary}\r\n"
            "Content-Type: application/json; charset=UTF-8\r\n\r\n"
            f"{json.dumps({'filename': filename})}\r\n"
            f"--{boundary}\r\n"
            f"Content-Type: {_safe_mime_type(mime_type)}\r\n\r\n"
        ).encode("utf-8")
        tail = f"\r\n--{boundary}--\r\n".encode("utf-8")
        upload_body = head + content + tail

        upload_response = httpx.post(
            f"{_GOOGLE_CHAT_API_BASE}/upload/v1/spaces/{quote(space_id, safe='')}"
            "/attachments:upload?uploadType=multipart",
            headers={"Content-Type": f"multipart/related; boundary={boundary}"},
            content=upload_body,
            timeout=120.0,
        )
        upload_response.raise_for_status()
        attachment = upload_response.json() if upload_response.text else {}

        # 2. Post a message carrying the uploaded attachment. Must reference the
        # whole UploadAttachmentResponse; runs on the same injected credential.
        message_body: dict[str, Any] = {"attachment": [attachment]}
        if text:
            message_body["text"] = text
        url = f"{_GOOGLE_CHAT_API_BASE}/v1/spaces/{space_id}/messages"
        if thread_name:
            message_body["thread"] = {"name": thread_name}
            url += "?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"

        message_response = httpx.post(
            url,
            headers={"Content-Type": "application/json"},
            json=message_body,
            timeout=120.0,
        )
        message_response.raise_for_status()
        return message_response.json() if message_response.text else {}

    def health(self) -> dict[str, Any]:
        """Check the real read path end-to-end: a 1-message read of a known
        SPACE via chat.googleapis.com, exercising edge credential injection.

        The old relay /health is unreachable from a sandbox (CONNECT-only
        firewall), so health now verifies the transport the tool actually uses.
        Uses the first id in GOOGLE_CHAT_SPACE_IDS (the ETL's configured spaces);
        without it, falls back to asserting the API host is reachable.
        """
        import httpx

        space_ids = [s.strip() for s in os.environ.get("GOOGLE_CHAT_SPACE_IDS", "").split(",") if s.strip()]
        if space_ids:
            response = httpx.get(
                f"{_GOOGLE_CHAT_API_BASE}/v1/spaces/{_space_id(space_ids[0])}/messages",
                params={"pageSize": 1},
                headers={"Content-Type": "application/json"},
                timeout=10.0,
            )
            response.raise_for_status()
            return {"reachable": True, "space": space_ids[0], "via": "chat.googleapis.com"}
        # No configured space to probe: a bare reachability check. A 4xx still
        # proves we reached Google (transport + TLS MITM), just without a target.
        response = httpx.get(f"{_GOOGLE_CHAT_API_BASE}/v1/spaces", timeout=10.0)
        return {"reachable": True, "status": response.status_code, "via": "chat.googleapis.com"}


def _client() -> GoogleChatClient:
    return GoogleChatClient()

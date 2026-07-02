from __future__ import annotations

import json
import re
from typing import Any

from centaur_sdk import secret

# In-cluster default for the googlechatbot outbound API. Overridable via the
# CHATBOT_URL secret (e.g. the `chatbot` iron-proxy alias).
_DEFAULT_CHATBOT_URL = "http://centaur-centaur-googlechatbot:3002"

# The real Google Chat API. Uploads go straight here (not through the bot
# relay): iron-proxy's gcp_auth grant mints a domain-wide-delegation OAuth
# token and INJECTS `Authorization: Bearer` on POSTs to this host, so the tool
# sends NO auth header of its own and never holds a real credential (Google's
# media.upload rejects app auth, hence the impersonated-user token at the edge).
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

    url = (secret("CHATBOT_URL", _DEFAULT_CHATBOT_URL) or _DEFAULT_CHATBOT_URL).strip()
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
    ) -> dict[str, Any]:
        import httpx

        base_url = _base_url()
        response = httpx.get(
            f"{base_url}/api/chat/messages",
            params={"space_name": space_name, "page_size": page_size},
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
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
        """Read the bot's unauthenticated /health endpoint."""
        import httpx

        response = httpx.get(f"{_base_url()}/health", timeout=10.0)
        response.raise_for_status()
        return response.json() if response.text else {}


def _client() -> GoogleChatClient:
    return GoogleChatClient()

from __future__ import annotations

import json
from typing import Any

from centaur_sdk import secret

# In-cluster default for the googlechatbot outbound API. Overridable via the
# CHATBOT_URL secret (e.g. the `chatbot` iron-proxy alias).
_DEFAULT_CHATBOT_URL = "http://centaur-centaur-googlechatbot:3002"


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


def _client() -> GoogleChatClient:
    return GoogleChatClient()

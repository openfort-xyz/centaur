from __future__ import annotations

import base64
import re
from typing import Any
from urllib.parse import quote

from centaur_sdk import secret

_MESSAGE_NAME_RE = re.compile(r"^spaces/([^/]+)/messages/([^/]+)$")
_THREAD_NAME_RE = re.compile(r"^spaces/([^/]+)/threads/([^/]+)$")
_ATTACHMENT_NAME_RE = re.compile(
    r"^spaces/([^/]+)/messages/([^/]+)/attachments/([^/]+)$"
)
_TARGET_RE = re.compile(r"^[^\s/@]+@[^\s/@]+$")
_DEFAULT_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024


class GoogleChatApiError(RuntimeError):
    def __init__(self, status: int | None, category: str) -> None:
        self.status = status
        self.category = category
        super().__init__(
            f"Google Chat proxy request failed ({category}{f', HTTP {status}' if status else ''})"
        )


def _space_id(space_name: str) -> str:
    value = space_name.removeprefix("spaces/").strip()
    if not value or "/" in value:
        raise ValueError("space_name must be a resource like spaces/AAAA")
    return value


def _message_ids(message_name: str) -> tuple[str, str]:
    match = _MESSAGE_NAME_RE.fullmatch(message_name.strip())
    if not match:
        raise ValueError("message_name must be a resource like spaces/AAAA/messages/BBBB")
    return match.group(1), match.group(2)


def _thread_ids(thread_name: str) -> tuple[str, str]:
    match = _THREAD_NAME_RE.fullmatch(thread_name.strip())
    if not match:
        raise ValueError("thread_name must be a resource like spaces/AAAA/threads/BBBB")
    return match.group(1), match.group(2)


def _target_identity(value: str) -> str:
    target = value.strip().lower()
    if not _TARGET_RE.fullmatch(target):
        raise ValueError("target must be an email address")
    return target


def _attachment_ids(attachment_name: str) -> tuple[str, str, str]:
    match = _ATTACHMENT_NAME_RE.fullmatch(attachment_name.strip())
    if not match:
        raise ValueError(
            "attachment_name must be a resource like "
            "spaces/AAAA/messages/BBBB/attachments/CCCC"
        )
    return match.group(1), match.group(2), match.group(3)


def _api_url() -> str:
    return secret("CENTAUR_API_URL", "http://api:8000").rstrip("/")


def _headers() -> dict[str, str]:
    headers = {"Accept": "application/json"}
    # `secret()` returns the sentinel name in sandboxes; iron-proxy replaces the
    # resulting header with the principal-scoped short-lived Console JWT.
    bearer = secret("CENTAUR_API_BEARER_TOKEN", "").strip()
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    return headers


def _raise_for_status(response: Any) -> None:
    try:
        response.raise_for_status()
    except Exception as exc:
        status = getattr(response, "status_code", None)
        category = (
            "unauthenticated"
            if status == 401
            else "permission_denied"
            if status == 403
            else "rate_limited"
            if status == 429
            else "upstream"
            if status is not None and status >= 500
            else "request"
        )
        raise GoogleChatApiError(status, category) from exc


class GoogleChatClient:
    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        import httpx

        response = httpx.request(
            method,
            f"{_api_url()}{path}",
            headers={
                **_headers(),
                **({"Content-Type": "application/json"} if json is not None else {}),
            },
            params={key: value for key, value in (params or {}).items() if value is not None},
            json=json,
            timeout=timeout,
        )
        _raise_for_status(response)
        return response.json() if response.text else {}

    def _download_request(
        self,
        path: str,
        *,
        max_bytes: int = _DEFAULT_DOWNLOAD_MAX_BYTES,
    ) -> dict[str, Any]:
        import httpx

        if max_bytes < 1:
            raise ValueError("max_bytes must be at least 1")
        with httpx.stream(
            "GET",
            f"{_api_url()}{path}",
            headers=_headers(),
            timeout=120.0,
        ) as response:
            _raise_for_status(response)
            content_type = response.headers.get("content-type", "application/octet-stream")
            if content_type.lower().startswith("text/html"):
                raise GoogleChatApiError(response.status_code, "unexpected_content")
            content = bytearray()
            for chunk in response.iter_bytes():
                content.extend(chunk)
                if len(content) > max_bytes:
                    raise GoogleChatApiError(response.status_code, "response_too_large")
            disposition = response.headers.get("content-disposition", "")
            filename_match = re.search(r'filename="([^"\\/]*)"', disposition)
            filename = filename_match.group(1) if filename_match else "attachment"
            return {
                "filename": "attachment" if filename in {"", ".", ".."} else filename,
                "content_type": content_type,
                "size_bytes": len(content),
                "content": bytes(content),
            }

    @staticmethod
    def _page_token(result: dict[str, Any]) -> str | None:
        return result.get("next_page_token") or result.get("nextPageToken")

    @classmethod
    def _with_page_token(cls, result: dict[str, Any]) -> dict[str, Any]:
        token = cls._page_token(result)
        return {**result, "next_page_token": token}

    def list_spaces(self, *, page_size: int = 20, page_token: str | None = None) -> dict[str, Any]:
        self._validate_page_size(page_size)
        return self._with_page_token(
            self._request(
                "GET",
                "/api/google-chat/spaces",
                params={"page_size": page_size, "page_token": page_token},
            )
        )

    def get_space(self, space_name: str) -> dict[str, Any]:
        space = quote(_space_id(space_name), safe="")
        return self._request("GET", f"/api/google-chat/spaces/{space}")

    def send_message(
        self,
        space_name: str,
        text: str,
        *,
        thread_name: str | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"text": text}
        if thread_name:
            body["thread_name"] = thread_name
        space = quote(_space_id(space_name), safe="")
        return self._request("POST", f"/api/google-chat/spaces/{space}/messages", json=body)

    def list_messages(
        self,
        space_name: str,
        *,
        page_size: int = 20,
        page_token: str | None = None,
        filter: str | None = None,
        order_by: str | None = None,
    ) -> dict[str, Any]:
        self._validate_page_size(page_size)
        space = quote(_space_id(space_name), safe="")
        return self._with_page_token(
            self._request(
                "GET",
                f"/api/google-chat/spaces/{space}/messages",
                params={
                    "page_size": page_size,
                    "page_token": page_token,
                    "filter": filter,
                    "order_by": order_by,
                },
            )
        )

    def list_members(
        self, space_name: str, *, page_size: int = 20, page_token: str | None = None
    ) -> dict[str, Any]:
        self._validate_page_size(page_size)
        space = quote(_space_id(space_name), safe="")
        return self._with_page_token(
            self._request(
                "GET",
                f"/api/google-chat/spaces/{space}/members",
                params={"page_size": page_size, "page_token": page_token},
            )
        )

    def list_thread_messages(
        self, thread_name: str, *, page_size: int = 20, page_token: str | None = None
    ) -> dict[str, Any]:
        self._validate_page_size(page_size)
        space_id, thread_id = _thread_ids(thread_name)
        return self._with_page_token(
            self._request(
                "GET",
                f"/api/google-chat/spaces/{quote(space_id, safe='')}/threads/{quote(thread_id, safe='')}",
                params={"page_size": page_size, "page_token": page_token},
            )
        )

    def list_message_reactions(
        self,
        message_name: str,
        *,
        page_size: int = 20,
        page_token: str | None = None,
    ) -> dict[str, Any]:
        self._validate_page_size(page_size)
        space_id, message_id = _message_ids(message_name)
        return self._with_page_token(
            self._request(
                "GET",
                "/api/google-chat/spaces/{}/messages/{}/reactions".format(
                    quote(space_id, safe=""), quote(message_id, safe="")
                ),
                params={"page_size": page_size, "page_token": page_token},
            )
        )

    def list_reactions(
        self,
        space_name: str,
        *,
        page_size: int = 100,
        max_pages: int = 5,
    ) -> dict[str, Any]:
        scan = self.scan_messages(space_name, page_size=page_size, max_pages=max_pages)
        reactions: list[dict[str, Any]] = []
        incomplete = scan["truncated"]
        for message in scan["messages"]:
            message_name = message.get("name")
            if not isinstance(message_name, str):
                continue
            page = self.list_message_reactions(message_name, page_size=page_size)
            reactions.extend(
                {**item, "messageName": message_name} for item in page.get("reactions") or []
            )
            incomplete = incomplete or bool(self._page_token(page))
        return {
            "reactions": reactions,
            "pages_scanned": scan["pages_scanned"],
            "truncated": bool(incomplete),
            "next_page_token": scan["next_page_token"],
        }

    def setup_dm(self, target_identity: str) -> dict[str, Any]:
        target = _target_identity(target_identity)
        return self._request(
            "POST",
            "/api/google-chat/dms/setup",
            params={"target_identity": target},
            json={},
        )

    def send_dm(self, target_identity: str, text: str) -> dict[str, Any]:
        target = _target_identity(target_identity)
        return self._request(
            "POST",
            "/api/google-chat/dms/messages",
            params={"target_identity": target},
            json={"text": text},
        )

    def list_files(
        self,
        space_name: str,
        *,
        page_size: int = 100,
        page_token: str | None = None,
    ) -> dict[str, Any]:
        self._validate_page_size(page_size)
        space = quote(_space_id(space_name), safe="")
        return self._with_page_token(
            self._request(
                "GET",
                f"/api/google-chat/spaces/{space}/files",
                params={"page_size": page_size, "page_token": page_token},
            )
        )

    def search_files(
        self,
        space_name: str,
        query: str,
        *,
        page_size: int = 100,
        max_pages: int = 5,
    ) -> dict[str, Any]:
        if max_pages < 1:
            raise ValueError("max_pages must be at least 1")
        if not query.strip():
            raise ValueError("query must not be empty")
        token: str | None = None
        files: list[dict[str, Any]] = []
        pages_scanned = 0
        seen_tokens: set[str] = set()
        for _ in range(max_pages):
            pages_scanned += 1
            page = self.list_files(space_name, page_size=page_size, page_token=token)
            files.extend(page.get("files") or [])
            token = self._page_token(page)
            if not token:
                break
            if token in seen_tokens:
                raise RuntimeError("Google Chat pagination token repeated")
            seen_tokens.add(token)
        needle = query.casefold()
        matches = [
            file
            for file in files
            if needle
            in " ".join(
                str(file.get(key) or "")
                for key in ("contentName", "filename", "contentType", "attachment_id")
            ).casefold()
        ]
        matches.sort(
            key=lambda file: (
                str(file.get("message_create_time") or ""),
                str(file.get("attachment_id") or ""),
            ),
            reverse=True,
        )
        return {
            "files": matches,
            "query": query,
            "pages_scanned": pages_scanned,
            "truncated": bool(token),
            "next_page_token": token,
        }

    def file_info(self, attachment_name: str) -> dict[str, Any]:
        space_id, message_id, attachment_id = _attachment_ids(attachment_name)
        return self._request(
            "GET",
            "/api/google-chat/spaces/{}/messages/{}/attachments/{}".format(
                quote(space_id, safe=""),
                quote(message_id, safe=""),
                quote(attachment_id, safe=""),
            ),
        )

    def download_file(
        self,
        attachment_name: str,
        *,
        max_bytes: int = _DEFAULT_DOWNLOAD_MAX_BYTES,
    ) -> dict[str, Any]:
        space_id, message_id, attachment_id = _attachment_ids(attachment_name)
        return self._download_request(
            "/api/google-chat/spaces/{}/messages/{}/attachments/{}/download".format(
                quote(space_id, safe=""),
                quote(message_id, safe=""),
                quote(attachment_id, safe=""),
            ),
            max_bytes=max_bytes,
        )

    def scan_messages(
        self,
        space_name: str,
        *,
        page_size: int = 100,
        max_pages: int = 5,
        filter: str | None = None,
    ) -> dict[str, Any]:
        if max_pages < 1:
            raise ValueError("max_pages must be at least 1")
        token: str | None = None
        messages: list[dict[str, Any]] = []
        seen_tokens: set[str] = set()
        pages_scanned = 0
        for _ in range(max_pages):
            pages_scanned += 1
            page = self.list_messages(
                space_name, page_size=page_size, page_token=token, filter=filter
            )
            messages.extend(page.get("messages") or [])
            token = self._page_token(page)
            if not token:
                break
            if token in seen_tokens:
                raise RuntimeError("Google Chat pagination token repeated")
            seen_tokens.add(token)
        messages.sort(
            key=lambda message: (
                str(message.get("createTime") or ""),
                str(message.get("name") or ""),
            ),
            reverse=True,
        )
        return {
            "messages": messages,
            "pages_scanned": pages_scanned,
            "truncated": bool(token),
            "next_page_token": token,
        }

    def search_messages(
        self,
        space_name: str,
        query: str,
        *,
        page_size: int = 100,
        max_pages: int = 5,
    ) -> dict[str, Any]:
        scan = self.scan_messages(space_name, page_size=page_size, max_pages=max_pages)
        needle = query.casefold()
        return {
            **scan,
            "query": query,
            "messages": [
                self._normalize_message(space_name, message)
                for message in scan["messages"]
                if needle in str(message.get("text") or "").casefold()
            ],
        }

    def questions(
        self, space_name: str, *, page_size: int = 100, max_pages: int = 5
    ) -> dict[str, Any]:
        scan = self.scan_messages(space_name, page_size=page_size, max_pages=max_pages)
        prefixes = (
            "how",
            "why",
            "what",
            "when",
            "where",
            "who",
            "which",
            "can ",
            "could ",
            "should ",
            "is there",
            "does anyone",
            "has anyone",
        )
        questions = []
        for message in scan["messages"]:
            text = str(message.get("text") or "").strip()
            lowered = text.casefold()
            if len(text) > 10 and (text.endswith("?") or lowered.startswith(prefixes)):
                questions.append(self._normalize_message(space_name, message))
        return {**scan, "space": space_name, "messages": questions, "questions": questions}

    def dump(
        self,
        space_name: str,
        *,
        page_size: int = 100,
        max_pages: int = 5,
        max_threads: int = 50,
    ) -> dict[str, Any]:
        if max_threads < 0:
            raise ValueError("max_threads cannot be negative")
        space = self.get_space(space_name)
        scan = self.scan_messages(space_name, page_size=page_size, max_pages=max_pages)
        reactions = self.list_reactions(space_name, page_size=page_size, max_pages=max_pages)
        by_message: dict[str, list[dict[str, Any]]] = {}
        for reaction in reactions.get("reactions") or []:
            by_message.setdefault(str(reaction.get("messageName") or ""), []).append(reaction)
        messages = [
            self._normalize_message(space_name, item, by_message) for item in scan["messages"]
        ]
        thread_names = list(
            dict.fromkeys(
                str(item.get("thread", {}).get("name"))
                for item in scan["messages"]
                if item.get("thread", {}).get("name")
            )
        )
        expanded = 0
        for thread_name in thread_names[:max_threads]:
            thread_page = self.list_thread_messages(thread_name, page_size=page_size)
            replies = [
                self._normalize_message(space_name, item, by_message)
                for item in thread_page.get("messages") or []
            ]
            for message in messages:
                if message.get("thread_ts") == thread_name:
                    message["replies"] = replies
                    message["replies_has_more"] = bool(self._page_token(thread_page))
            expanded += 1
        incomplete = bool(
            scan["truncated"] or reactions.get("truncated") or len(thread_names) > max_threads
        )
        return {
            "channel": space.get("displayName") or space.get("name") or space_name,
            "channel_id": space_name,
            "messages": messages,
            "has_more": scan["truncated"],
            "next_cursor": scan["next_page_token"],
            "continuation_available": incomplete,
            "truncated": incomplete,
            "limits": {
                "message_pages": max_pages,
                "page_size": page_size,
                "thread_limit": max_threads,
            },
            "stats": {
                "total_messages": len(messages),
                "threads_expanded": expanded,
                "threads_skipped_by_limit": max(0, len(thread_names) - max_threads),
                "total_reactions": sum(len(items) for items in by_message.values()),
            },
        }

    def feedback(
        self, space_name: str, *, page_size: int = 100, max_pages: int = 5
    ) -> dict[str, Any]:
        dump = self.dump(space_name, page_size=page_size, max_pages=max_pages)
        negative = ("wrong", "broken", "doesn't work", "failed", "error", "incorrect", "try again")
        positive = ("thanks", "great", "perfect", "worked", "awesome")
        items = []
        for message in dump["messages"]:
            text = str(message.get("text") or "")
            lowered = text.casefold()
            reaction_names = {
                str(reaction.get("emoji", {}).get("unicode") or "")
                for reaction in message.get("reactions") or []
            }
            category = (
                "issue"
                if any(word in lowered for word in negative) or "👎" in reaction_names
                else "success"
                if any(word in lowered for word in positive) or "👍" in reaction_names
                else None
            )
            if category:
                items.append(
                    {
                        "channel": dump["channel"],
                        "channel_id": space_name,
                        "thread_ts": message.get("thread_ts") or message.get("timestamp"),
                        "permalink": message.get("permalink"),
                        "category": category,
                        "severity": "medium" if category == "issue" else "low",
                        "summary": text[:200],
                        "evidence": {"reactions": message.get("reactions") or []},
                        "reporter_user": message.get("user"),
                        "status": "new",
                    }
                )
        return {
            "channel": dump["channel"],
            "channel_id": space_name,
            "items": items,
            "truncated": dump["truncated"],
            "continuation_available": dump["continuation_available"],
        }

    @staticmethod
    def _validate_page_size(page_size: int) -> None:
        if not 1 <= page_size <= 1000:
            raise ValueError("page_size must be between 1 and 1000")

    @staticmethod
    def _normalize_message(
        space_name: str,
        message: dict[str, Any],
        reactions: dict[str, list[dict[str, Any]]] | None = None,
    ) -> dict[str, Any]:
        sender = message.get("sender") or {}
        name = str(message.get("name") or "")
        thread_name = str((message.get("thread") or {}).get("name") or "") or None
        message_id = name.rsplit("/", 1)[-1] if name else ""
        return {
            "user": sender.get("displayName") or sender.get("name") or "",
            "user_id": sender.get("name") or "",
            "text": message.get("text") or "",
            "timestamp": message.get("createTime") or "",
            "permalink": f"https://mail.google.com/chat/u/0/#chat/space/{_space_id(space_name)}/{message_id}",
            "channel_id": space_name,
            "thread_ts": thread_name,
            "reply_count": 0,
            "reactions": (reactions or {}).get(name, []),
            "type": "message",
            "subtype": None,
        }

    def update_message(self, message_name: str, text: str) -> dict[str, Any]:
        space_id, message_id = _message_ids(message_name)
        path = "/api/google-chat/spaces/{}/messages/{}".format(
            quote(space_id, safe=""), quote(message_id, safe="")
        )
        return self._request("PATCH", path, json={"text": text})

    def delete_message(self, message_name: str) -> dict[str, Any]:
        space_id, message_id = _message_ids(message_name)
        path = "/api/google-chat/spaces/{}/messages/{}".format(
            quote(space_id, safe=""), quote(message_id, safe="")
        )
        return self._request("DELETE", path)

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
        space = quote(_space_id(space_name), safe="")
        return self._request(
            "POST",
            f"/api/google-chat/spaces/{space}/attachments",
            json={
                "filename": filename,
                "content_base64": base64.b64encode(content).decode("ascii"),
                "mime_type": mime_type or "application/octet-stream",
                "text": text,
                "thread_name": thread_name,
            },
            timeout=120.0,
        )

    def health(self) -> dict[str, Any]:
        result = self._request(
            "GET", "/api/google-chat/spaces", params={"page_size": 1}, timeout=10.0
        )
        return {"reachable": True, "via": "api-rs", "spaces": len(result.get("spaces", []))}


def _client() -> GoogleChatClient:
    return GoogleChatClient()

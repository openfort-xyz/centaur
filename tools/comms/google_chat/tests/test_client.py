import json
import sys
from pathlib import Path

import google_chat.client as gc
import pytest


class _FakeResponse:
    def __init__(
        self,
        payload: dict | None = None,
        status_code: int = 200,
        *,
        content: bytes = b"",
        headers: dict[str, str] | None = None,
    ) -> None:
        self._payload = payload or {}
        self.text = json.dumps(self._payload) if payload is not None else ""
        self.status_code = status_code
        self.content = content
        self.headers = headers or {}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError("HTTP failure")

    def json(self) -> dict:
        return self._payload

    def iter_bytes(self):
        yield from (self.content[index : index + 3] for index in range(0, len(self.content), 3))

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None


class _FakeHttpx:
    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.responses: list[_FakeResponse] = []

    def request(self, method: str, url: str, **kwargs) -> _FakeResponse:
        self.calls.append({"method": method, "url": url, **kwargs})
        if self.responses:
            return self.responses.pop(0)
        return _FakeResponse({"spaces": []} if url.endswith("/spaces") else {"name": "ok"})

    def stream(self, method: str, url: str, **kwargs) -> _FakeResponse:
        self.calls.append({"method": method, "url": url, **kwargs})
        if self.responses:
            return self.responses.pop(0)
        return _FakeResponse(
            None,
            content=b"file",
            headers={
                "content-type": "application/octet-stream",
                "content-disposition": 'attachment; filename="attachment"',
            },
        )


@pytest.fixture
def fake_httpx(monkeypatch) -> _FakeHttpx:
    fake = _FakeHttpx()
    monkeypatch.setenv("CENTAUR_API_URL", "http://api.internal:8080")
    monkeypatch.delenv("CENTAUR_API_BEARER_TOKEN", raising=False)
    sys.modules["httpx"] = fake
    return fake


def test_every_command_uses_scoped_api_proxy(fake_httpx: _FakeHttpx) -> None:
    client = gc.GoogleChatClient()
    client.send_message("spaces/AAAA", "hello", thread_name="spaces/AAAA/threads/T")
    client.list_messages(
        "AAAA",
        page_size=7,
        page_token="next",
        filter="thread.name = spaces/AAAA/threads/T",
        order_by="createTime DESC",
    )
    client.update_message("spaces/AAAA/messages/M.1", "edited")
    client.delete_message("spaces/AAAA/messages/M.1")
    client.upload_attachment("spaces/AAAA", "report.pdf", b"PDF", mime_type="application/pdf")
    client.health()

    assert [call["method"] for call in fake_httpx.calls] == [
        "POST",
        "GET",
        "PATCH",
        "DELETE",
        "POST",
        "GET",
    ]
    assert all(
        call["url"].startswith("http://api.internal:8080/api/google-chat/")
        for call in fake_httpx.calls
    )
    assert all(
        "chat.googleapis.com" not in call["url"] and "googlechatbot" not in call["url"]
        for call in fake_httpx.calls
    )
    assert all(
        call["headers"]["Authorization"] == "Bearer CENTAUR_API_BEARER_TOKEN"
        for call in fake_httpx.calls
    )
    assert fake_httpx.calls[0]["json"] == {
        "text": "hello",
        "thread_name": "spaces/AAAA/threads/T",
    }
    assert fake_httpx.calls[1]["params"] == {
        "page_size": 7,
        "page_token": "next",
        "filter": "thread.name = spaces/AAAA/threads/T",
        "order_by": "createTime DESC",
    }
    assert fake_httpx.calls[4]["json"]["content_base64"] == "UERG"


def test_local_bearer_uses_console_jwt_contract(monkeypatch, fake_httpx: _FakeHttpx) -> None:
    monkeypatch.setenv("CENTAUR_API_BEARER_TOKEN", "test-console-jwt")

    gc.GoogleChatClient().list_messages("spaces/AAAA")

    assert fake_httpx.calls[0]["headers"]["Authorization"] == "Bearer test-console-jwt"


@pytest.mark.parametrize(
    "call",
    [
        lambda client: client.send_message("spaces/A/B", "x"),
        lambda client: client.update_message("messages/M", "x"),
        lambda client: client.delete_message("spaces/A/messages/M/extra"),
        lambda client: client.list_messages("spaces/A", page_size=0),
    ],
)
def test_malformed_resources_fail_before_network(fake_httpx: _FakeHttpx, call) -> None:
    with pytest.raises(ValueError):
        call(gc.GoogleChatClient())
    assert fake_httpx.calls == []


def test_manifest_has_no_sandbox_google_or_relay_credentials() -> None:
    manifest = Path(gc.__file__.replace("client.py", "pyproject.toml"))
    text = manifest.read_text(encoding="utf-8")
    assert "GOOGLE_SERVICE_ACCOUNT_JSON" not in text
    assert "CHATBOT_API_KEY" not in text
    assert "chat.googleapis.com" not in text
    assert "@openfort.xyz" not in text


def test_conversation_resources_use_distinct_scoped_proxy_routes(fake_httpx: _FakeHttpx) -> None:
    client = gc.GoogleChatClient()
    client.list_spaces(page_size=5, page_token="space next")
    client.get_space("spaces/A")
    client.list_members("spaces/A", page_token="member next")
    client.list_thread_messages("spaces/A/threads/T.1", page_token="thread next")
    fake_httpx.responses = [
        _FakeResponse({"messages": [{"name": "spaces/A/messages/M"}]}),
        _FakeResponse({"reactions": [{"name": "spaces/A/messages/M/reactions/R"}]}),
    ]
    client.list_reactions("spaces/A", max_pages=1)

    assert [call["url"].removeprefix("http://api.internal:8080") for call in fake_httpx.calls] == [
        "/api/google-chat/spaces",
        "/api/google-chat/spaces/A",
        "/api/google-chat/spaces/A/members",
        "/api/google-chat/spaces/A/threads/T.1",
        "/api/google-chat/spaces/A/messages",
        "/api/google-chat/spaces/A/messages/M/reactions",
    ]
    assert fake_httpx.calls[0]["params"]["page_token"] == "space next"
    assert fake_httpx.calls[2]["params"]["page_token"] == "member next"
    assert fake_httpx.calls[3]["params"]["page_token"] == "thread next"
    assert "page_token" not in fake_httpx.calls[5]["params"]


def test_bounded_search_is_newest_first_and_explicitly_truncated(fake_httpx: _FakeHttpx) -> None:
    fake_httpx.responses = [
        _FakeResponse(
            {
                "messages": [
                    {
                        "name": "spaces/A/messages/1",
                        "text": "needle old",
                        "createTime": "2025-01-01T00:00:00Z",
                    },
                    {
                        "name": "spaces/A/messages/2",
                        "text": "ignore",
                        "createTime": "2025-03-01T00:00:00Z",
                    },
                ],
                "nextPageToken": "two",
            }
        ),
        _FakeResponse(
            {
                "messages": [
                    {
                        "name": "spaces/A/messages/3",
                        "text": "Needle new",
                        "createTime": "2025-02-01T00:00:00Z",
                    }
                ],
                "nextPageToken": "three",
            }
        ),
    ]

    result = gc.GoogleChatClient().search_messages("spaces/A", "needle", max_pages=2)

    assert [message["text"] for message in result["messages"]] == ["Needle new", "needle old"]
    assert result["truncated"] is True
    assert result["next_page_token"] == "three"
    assert fake_httpx.calls[1]["params"]["page_token"] == "two"


def test_dm_uses_exact_target_gate_then_send_claim_route(fake_httpx: _FakeHttpx) -> None:
    fake_httpx.responses = [
        _FakeResponse(
            {
                "space": {"name": "spaces/DM"},
                "message": {"name": "spaces/DM/messages/M1"},
            }
        ),
    ]

    result = gc.GoogleChatClient().send_dm("Person@Example.com", "hello")

    assert result["message"]["name"] == "spaces/DM/messages/M1"
    assert fake_httpx.calls[0]["url"].endswith("/api/google-chat/dms/messages")
    assert fake_httpx.calls[0]["params"] == {"target_identity": "person@example.com"}
    assert fake_httpx.calls[0]["json"] == {"text": "hello"}


@pytest.mark.parametrize("target", ["users/123456789", "users/person@example.com"])
def test_dm_rejects_user_resource_targets_before_network(
    fake_httpx: _FakeHttpx, target: str
) -> None:
    with pytest.raises(ValueError, match="email address"):
        gc.GoogleChatClient().send_dm(target, "hello")
    assert fake_httpx.calls == []


def test_file_routes_are_exact_bounded_and_raw(fake_httpx: _FakeHttpx) -> None:
    fake_httpx.responses = [
        _FakeResponse(
            {
                "files": [{"contentName": "old.pdf", "attachment_id": "A1"}],
                "next_page_token": "two",
            }
        ),
        _FakeResponse(
            {
                "files": [{"contentName": "new report.pdf", "attachment_id": "A2"}],
                "next_page_token": "three",
            }
        ),
        _FakeResponse({"name": "spaces/S/messages/M/attachments/A"}),
        _FakeResponse(
            None,
            content=b"raw-pdf",
            headers={
                "content-type": "application/pdf",
                "content-disposition": 'attachment; filename="report.pdf"',
            },
        ),
    ]
    client = gc.GoogleChatClient()

    found = client.search_files("spaces/S", "report", max_pages=2)
    info = client.file_info("spaces/S/messages/M/attachments/A")
    downloaded = client.download_file("spaces/S/messages/M/attachments/A")

    assert found["truncated"] is True and found["next_page_token"] == "three"
    assert [item["attachment_id"] for item in found["files"]] == ["A2"]
    assert info["name"] == "spaces/S/messages/M/attachments/A"
    assert downloaded == {
        "filename": "report.pdf",
        "content_type": "application/pdf",
        "size_bytes": 7,
        "content": b"raw-pdf",
    }
    assert [call["url"].removeprefix("http://api.internal:8080") for call in fake_httpx.calls] == [
        "/api/google-chat/spaces/S/files",
        "/api/google-chat/spaces/S/files",
        "/api/google-chat/spaces/S/messages/M/attachments/A",
        "/api/google-chat/spaces/S/messages/M/attachments/A/download",
    ]
    assert fake_httpx.calls[1]["params"]["page_token"] == "two"
    assert all(call["headers"]["Authorization"] == "Bearer CENTAUR_API_BEARER_TOKEN" for call in fake_httpx.calls)


def test_download_rejects_html_and_cli_size_overflow(fake_httpx: _FakeHttpx) -> None:
    client = gc.GoogleChatClient()
    fake_httpx.responses = [
        _FakeResponse(None, content=b"<html>", headers={"content-type": "text/html"}),
        _FakeResponse(
            None,
            content=b"12345",
            headers={"content-type": "application/octet-stream"},
        ),
    ]
    with pytest.raises(gc.GoogleChatApiError, match="unexpected_content"):
        client.download_file("spaces/S/messages/M/attachments/A")
    with pytest.raises(gc.GoogleChatApiError, match="response_too_large"):
        client.download_file("spaces/S/messages/M/attachments/A", max_bytes=4)


@pytest.mark.parametrize(
    ("status", "category"),
    [
        (401, "unauthenticated"),
        (403, "permission_denied"),
        (429, "rate_limited"),
        (503, "upstream"),
    ],
)
@pytest.mark.parametrize(
    "call",
    [
        lambda client: client.list_spaces(),
        lambda client: client.download_file("spaces/S/messages/M/attachments/A"),
    ],
)
def test_proxy_failures_are_classified_without_response_body(
    fake_httpx: _FakeHttpx, status: int, category: str, call
) -> None:
    fake_httpx.responses = [_FakeResponse({"secret": "must-not-leak"}, status)]

    with pytest.raises(gc.GoogleChatApiError) as caught:
        call(gc.GoogleChatClient())

    assert caught.value.category == category
    assert "must-not-leak" not in str(caught.value)


@pytest.mark.parametrize(
    "call",
    [
        lambda client: client.list_thread_messages("spaces/A/messages/M"),
        lambda client: client.setup_dm("users/A/B"),
        lambda client: client.scan_messages("spaces/A", max_pages=0),
        lambda client: client.file_info("spaces/A/attachments/F"),
        lambda client: client.download_file("spaces/A/messages/M/attachments/A", max_bytes=0),
        lambda client: client.search_files("spaces/A", "x", max_pages=0),
        lambda client: client.search_files("spaces/A", "  "),
    ],
)
def test_new_malformed_inputs_fail_before_network(fake_httpx: _FakeHttpx, call) -> None:
    with pytest.raises(ValueError):
        call(gc.GoogleChatClient())
    assert fake_httpx.calls == []


def test_dump_questions_feedback_keep_platform_neutral_fields(monkeypatch) -> None:
    client = gc.GoogleChatClient()
    messages = [
        {
            "name": "spaces/A/messages/M1",
            "text": "Why is this broken?",
            "createTime": "2025-01-01T00:00:00Z",
            "sender": {"name": "users/U1", "displayName": "Alice"},
            "thread": {"name": "spaces/A/threads/T1"},
        }
    ]
    monkeypatch.setattr(client, "get_space", lambda *_: {"name": "spaces/A", "displayName": "Team"})
    monkeypatch.setattr(
        client,
        "scan_messages",
        lambda *_a, **_k: {
            "messages": messages,
            "pages_scanned": 1,
            "truncated": True,
            "next_page_token": "next",
        },
    )
    monkeypatch.setattr(
        client,
        "list_reactions",
        lambda *_a, **_k: {
            "reactions": [{"messageName": "spaces/A/messages/M1", "emoji": {"unicode": "👎"}}],
            "next_page_token": None,
            "truncated": False,
        },
    )
    monkeypatch.setattr(
        client,
        "list_thread_messages",
        lambda *_a, **_k: {"messages": messages, "next_page_token": None},
    )

    questions = client.questions("spaces/A")
    dump = client.dump("spaces/A")
    feedback = client.feedback("spaces/A")

    neutral = {
        "user",
        "user_id",
        "text",
        "timestamp",
        "permalink",
        "channel_id",
        "thread_ts",
        "reply_count",
        "reactions",
        "type",
        "subtype",
    }
    assert neutral <= questions["questions"][0].keys()
    assert neutral <= dump["messages"][0].keys()
    assert dump["truncated"] is True and dump["continuation_available"] is True
    assert dump["messages"][0]["reactions"][0]["emoji"]["unicode"] == "👎"
    assert feedback["items"][0]["category"] == "issue"
    assert feedback["truncated"] is True

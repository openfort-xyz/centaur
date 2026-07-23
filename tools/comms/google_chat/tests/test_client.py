import json

import google_chat.client as gc


class _FakeResponse:
    def __init__(self, payload: dict) -> None:
        self._payload = payload
        self.text = json.dumps(payload)

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._payload


class _FakeHttpx:
    """Records every httpx call so tests can assert URL/headers/body."""

    def __init__(self, responses: dict[str, dict]) -> None:
        self._responses = responses
        self.calls: list[dict] = []

    def _record(self, method: str, url: str, **kwargs) -> _FakeResponse:
        self.calls.append({"method": method, "url": url, **kwargs})
        # Return the upload attachment ref for the upload URL, else a message.
        payload = (
            self._responses["upload"]
            if "attachments:upload" in url
            else self._responses.get("default", {"name": "spaces/AAAA/messages/BBBB"})
        )
        return _FakeResponse(payload)

    def post(self, url, **kwargs):
        return self._record("POST", url, **kwargs)

    def get(self, url, **kwargs):
        return self._record("GET", url, **kwargs)

    def patch(self, url, **kwargs):
        return self._record("PATCH", url, **kwargs)

    def request(self, method, url, **kwargs):
        return self._record(method, url, **kwargs)


def _client() -> gc.GoogleChatClient:
    return gc.GoogleChatClient(api_key="test-key")


def _patch_httpx(monkeypatch, responses: dict[str, dict]) -> _FakeHttpx:
    fake = _FakeHttpx(responses)
    monkeypatch.setattr(gc, "httpx", fake, raising=False)
    import sys

    sys.modules["httpx"] = fake  # method-local `import httpx` picks this up
    return fake


def test_upload_posts_multipart_to_google_then_message(monkeypatch) -> None:
    fake = _patch_httpx(
        monkeypatch,
        {"upload": {"attachmentDataRef": {"resourceName": "abc"}}},
    )

    client = _client()
    result = client.upload_attachment(
        "spaces/AAAA",
        "report.pdf",
        b"PDFBYTES",
        mime_type="application/pdf",
        text="here it is",
    )

    assert len(fake.calls) == 2
    upload, message = fake.calls

    # (a) upload: direct to the real Google upload endpoint, multipart body,
    # raw bytes present, and NO Authorization header (iron-proxy injects it).
    assert upload["method"] == "POST"
    assert upload["url"] == (
        "https://chat.googleapis.com/upload/v1/spaces/AAAA"
        "/attachments:upload?uploadType=multipart"
    )
    assert upload["headers"]["Content-Type"].startswith("multipart/related; boundary=")
    assert "Authorization" not in upload["headers"]
    body = upload["content"]
    assert isinstance(body, bytes)
    assert b"PDFBYTES" in body
    assert b'"filename": "report.pdf"' in body
    assert b"Content-Type: application/pdf" in body

    # (b) message create: direct to the real Google messages endpoint, carrying
    # the whole upload response as the attachment, still no Authorization.
    assert message["method"] == "POST"
    assert message["url"] == "https://chat.googleapis.com/v1/spaces/AAAA/messages"
    assert "Authorization" not in message["headers"]
    assert message["json"] == {
        "attachment": [{"attachmentDataRef": {"resourceName": "abc"}}],
        "text": "here it is",
    }
    assert result == {"name": "spaces/AAAA/messages/BBBB"}


def test_upload_threaded_adds_reply_option_and_thread(monkeypatch) -> None:
    fake = _patch_httpx(monkeypatch, {"upload": {"attachmentDataRef": {}}})

    client = _client()
    client.upload_attachment(
        "AAAA",  # bare id, no spaces/ prefix
        "c.png",
        b"x",
        mime_type="image/png",
        thread_name="spaces/AAAA/threads/TTTT",
    )

    _, message = fake.calls
    assert message["url"] == (
        "https://chat.googleapis.com/v1/spaces/AAAA/messages"
        "?messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD"
    )
    assert message["json"]["thread"] == {"name": "spaces/AAAA/threads/TTTT"}


def test_bad_mime_type_falls_back_to_octet_stream(monkeypatch) -> None:
    fake = _patch_httpx(monkeypatch, {"upload": {}})

    client = _client()
    client.upload_attachment("spaces/AAAA", "f", b"x", mime_type="not a\r\nmime")

    body = fake.calls[0]["content"]
    assert b"Content-Type: application/octet-stream" in body
    assert b"not a" not in body  # injection-shaped value is dropped


def test_send_update_delete_hit_bot_relay(monkeypatch) -> None:
    fake = _patch_httpx(monkeypatch, {"upload": {}, "default": {"name": "ok"}})
    monkeypatch.setattr(gc, "_base_url", lambda: "http://chatbot:3002")

    client = _client()
    client.send_message("spaces/AAAA", "hi")
    client.update_message("spaces/AAAA/messages/M", "edit")
    client.delete_message("spaces/AAAA/messages/M")

    for call in fake.calls:
        assert call["url"].startswith("http://chatbot:3002/api/chat/")
        assert call["headers"]["Authorization"] == "Bearer test-key"


def test_list_messages_reads_chat_api_directly(monkeypatch) -> None:
    # Reads go to the real Chat API (edge-injected app auth), NOT the relay a
    # sandbox's CONNECT-only firewall cannot reach — so no Authorization header.
    fake = _patch_httpx(monkeypatch, {"upload": {}, "default": {"messages": []}})

    _client().list_messages("spaces/AAAA", page_size=7, filter='thread.name="spaces/AAAA/threads/T"')

    call = fake.calls[0]
    assert call["method"] == "GET"
    assert call["url"] == "https://chat.googleapis.com/v1/spaces/AAAA/messages"
    assert call["params"] == {"pageSize": 7, "filter": 'thread.name="spaces/AAAA/threads/T"'}
    assert "Authorization" not in call["headers"]


def test_list_messages_forwards_page_token(monkeypatch) -> None:
    fake = _patch_httpx(monkeypatch, {"upload": {}, "default": {"messages": []}})

    _client().list_messages("spaces/AAAA", page_token="TOK123")

    assert fake.calls[0]["params"] == {"pageSize": 20, "pageToken": "TOK123"}


def test_parse_chat_link_extracts_space_and_thread() -> None:
    space, thread = gc.parse_chat_link(
        "https://chat.google.com/room/AAQA42QLdws/2yHD6g35vtw/2yHD6g35vtw?cls=10"
    )
    assert (space, thread) == ("AAQA42QLdws", "2yHD6g35vtw")

    # Room-only link (no thread segment) and a non-link both degrade gracefully.
    assert gc.parse_chat_link("https://chat.google.com/room/AAQA42QLdws") == ("AAQA42QLdws", None)
    assert gc.parse_chat_link("spaces/AAAA") == (None, None)


def test_resolve_space_and_thread_from_pasted_link() -> None:
    # The reported bug: pasting the thread URL should scope to that thread with
    # no hand-built filter and no separate space argument.
    space_id, thread_name = gc.resolve_space_and_thread(
        "https://chat.google.com/room/AAQA42QLdws/2yHD6g35vtw/2yHD6g35vtw?cls=10"
    )
    assert space_id == "AAQA42QLdws"
    assert thread_name == "spaces/AAQA42QLdws/threads/2yHD6g35vtw"


def test_resolve_space_and_thread_variants() -> None:
    # Bare space, no thread.
    assert gc.resolve_space_and_thread("spaces/AAAA") == ("AAAA", None)
    # Bare thread id resolves against the given space.
    assert gc.resolve_space_and_thread("spaces/AAAA", "TTTT") == (
        "AAAA",
        "spaces/AAAA/threads/TTTT",
    )
    # Full thread resource name passes through unchanged.
    assert gc.resolve_space_and_thread("AAAA", "spaces/AAAA/threads/TTTT") == (
        "AAAA",
        "spaces/AAAA/threads/TTTT",
    )
    # An explicit --thread link wins and carries its own space.
    assert gc.resolve_space_and_thread(
        "spaces/IGNORED", "https://chat.google.com/room/BBBB/TTTT/TTTT"
    ) == ("BBBB", "spaces/BBBB/threads/TTTT")


def test_health_probes_chat_api_with_configured_space(monkeypatch) -> None:
    fake = _patch_httpx(monkeypatch, {"upload": {}, "default": {"messages": []}})
    monkeypatch.setenv("GOOGLE_CHAT_SPACE_IDS", "AAQA42QLdws,AAQAOs")

    result = _client().health()

    call = fake.calls[0]
    assert call["url"] == "https://chat.googleapis.com/v1/spaces/AAQA42QLdws/messages"
    assert "Authorization" not in call["headers"]
    assert result["reachable"] is True and result["space"] == "AAQA42QLdws"

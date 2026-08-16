from __future__ import annotations

import asyncio
import datetime as dt
import importlib
import json
import os
import sys
import time
import types
from pathlib import Path


def _install_api_stubs() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    # Sibling test modules (test_attio_sync, test_company_context_documents_
    # attachments, the slack ETL tests) stub these into sys.modules at import
    # time, and some stubs lack the record_etl_items_* names. Evict them so
    # this module imports the real implementations regardless of collection
    # order.
    for stubbed in ("workflows.etl_metrics", "workflows.slack.shared"):
        sys.modules.pop(stubbed, None)

    runtime_control = sys.modules.get("api.runtime_control") or types.ModuleType(
        "api.runtime_control"
    )
    runtime_control.canonical_json = lambda value: json.dumps(value, sort_keys=True)
    runtime_control.decode_jsonb = lambda value, default: (
        value if value is not None else default
    )

    metrics = types.ModuleType("api.metrics")
    metrics.increment_metric = lambda *_args, **_kwargs: None
    metrics.set_gauge = lambda *_args, **_kwargs: None
    metrics.observe_histogram = lambda *_args, **_kwargs: None

    workflow_engine = types.ModuleType("api.workflow_engine")
    workflow_engine.WorkflowContext = object

    centaur_sdk = sys.modules.get("centaur_sdk") or types.ModuleType("centaur_sdk")
    centaur_sdk.secret = lambda name, default=None: default

    api_module = sys.modules.get("api") or types.ModuleType("api")
    api_module.runtime_control = runtime_control
    api_module.metrics = metrics
    api_module.workflow_engine = workflow_engine
    sys.modules["api"] = api_module
    sys.modules["api.runtime_control"] = runtime_control
    sys.modules["api.metrics"] = metrics
    sys.modules["api.workflow_engine"] = workflow_engine
    sys.modules["centaur_sdk"] = centaur_sdk


_install_api_stubs()
projection = importlib.import_module("workflows.company_context_documents")
chat_sync = importlib.import_module("workflows.google_chat.sync")
chat_metrics = importlib.import_module("workflows.google_chat.metrics")
chat_retention = importlib.import_module("workflows.google_chat.retention")


# --------------------------------------------------------------------------- #
# Projection: thread document builder
# --------------------------------------------------------------------------- #
def _msg_row(message_id, sender_id, sender_name, text, created, updated):
    return {
        "space_id": "S1",
        "space_display_name": "Engineering",
        "space_type": "SPACE",
        "message_id": message_id,
        "message_name": f"spaces/S1/messages/{message_id}",
        "thread_id": "T1",
        "sender_id": sender_id,
        "sender_name": sender_name,
        "sender_type": "HUMAN",
        "text_content": text,
        "source_create_time": created,
        "updated_at": updated,
    }


def test_google_chat_thread_document_renders_thread():
    messages = [
        _msg_row(
            "m1",
            "users/1",
            "Alice",
            "Should we ship the paymaster change?",
            dt.datetime(2026, 6, 1, 9, 0, tzinfo=dt.UTC),
            dt.datetime(2026, 6, 1, 9, 5, tzinfo=dt.UTC),
        ),
        _msg_row(
            "m2",
            "users/2",
            "Bob",
            "Yes, after the canary passes.",
            dt.datetime(2026, 6, 1, 9, 2, tzinfo=dt.UTC),
            dt.datetime(2026, 6, 1, 9, 3, tzinfo=dt.UTC),
        ),
    ]

    document = projection._google_chat_thread_document(
        space_id="S1", thread_id="T1", messages=messages
    )

    assert document is not None
    assert document["document_id"] == "google_chat:thread:S1:T1"
    assert document["source"] == "google_chat"
    assert document["source_type"] == "google_chat_thread"
    assert document["source_document_id"] == "S1:T1"
    assert document["title"] == "Should we ship the paymaster change?"
    assert document["author_name"] == "Alice"
    assert document["occurred_at"] == dt.datetime(2026, 6, 1, 9, 0, tzinfo=dt.UTC)
    # source_updated_at is the newest message updated_at across the thread.
    assert document["source_updated_at"] == dt.datetime(2026, 6, 1, 9, 5, tzinfo=dt.UTC)
    assert document["metadata"]["message_count"] == 2
    assert document["metadata"]["participants"] == ["Alice", "Bob"]
    assert document["url"] == ""  # Chat has no stable public message URL
    assert "- Space: Engineering" in document["body"]
    assert "Yes, after the canary passes." in document["body"]


def test_google_chat_thread_document_falls_back_to_sender_id_and_space_title():
    messages = [
        _msg_row(
            "m1",
            "users/9",
            "",  # no display name resolved
            "",  # no text -> title falls back to the space
            dt.datetime(2026, 6, 2, 8, 0, tzinfo=dt.UTC),
            dt.datetime(2026, 6, 2, 8, 0, tzinfo=dt.UTC),
        )
    ]

    document = projection._google_chat_thread_document(
        space_id="S1", thread_id="T9", messages=messages
    )

    assert document is not None
    assert document["title"] == "Chat thread in Engineering"
    assert document["author_name"] == "users/9"


def test_google_chat_attachment_document_is_company_context():
    row = {
        "space_id": "S1",
        "message_id": "M1",
        "attachment_id": "A1",
        "content_name": "runbook.txt",
        "content_text": "restart api-rs",
        "content_type": "text/plain",
        "source_uri": "https://example.invalid/source",
        "download_uri": "",
        "sender_id": "users/1",
        "sender_name": "Alice",
        "source_create_time": dt.datetime(2026, 6, 1, tzinfo=dt.UTC),
        "updated_at": dt.datetime(2026, 6, 2, tzinfo=dt.UTC),
    }
    document = projection._google_chat_attachment_document(row)
    assert document["document_id"] == "google_chat:attachment:S1:M1:A1"
    assert document["source_type"] == "google_chat_attachment"
    assert document["access_scope"] == "company"
    assert document["body"] == "restart api-rs"


def test_google_chat_registered_as_projection_source():
    assert "google_chat_thread" in projection.COMPANY_CONTEXT_SOURCE_TYPES["google_chat"]
    assert (
        projection.ETL_CHECKPOINT_TABLES["google_chat"]
        == "google_chat_sync_checkpoints"
    )


# --------------------------------------------------------------------------- #
# Sync: message extraction + per-space paging/watermark
# --------------------------------------------------------------------------- #
def test_message_text_prefers_text_then_formatted():
    assert chat_sync._message_text({"text": " hi "}) == "hi"
    assert chat_sync._message_text({"formattedText": "*bold*"}) == "*bold*"
    assert chat_sync._message_text({}) == ""


def test_message_text_falls_back_to_card_content_for_app_messages():
    # Chat apps (GitHub, alerting bots) post with empty `text` and all content
    # in cardsV2 — the Chat analogue of Slack attachment-only app messages
    # (upstream #887). The card widgets become the captured text.
    message = {
        "text": "",
        "cardsV2": [
            {
                "cardId": "c1",
                "card": {
                    "header": {"title": "Deploy failed", "subtitle": "prod"},
                    "sections": [
                        {
                            "header": "Details",
                            "widgets": [
                                {"textParagraph": {"text": "build 123 broke"}},
                                {
                                    "decoratedText": {
                                        "topLabel": "Service",
                                        "text": "api-rs",
                                        "bottomLabel": "eu-west",
                                    }
                                },
                                {
                                    "columns": {
                                        "columnItems": [
                                            {
                                                "widgets": [
                                                    {"textParagraph": {"text": "col text"}}
                                                ]
                                            }
                                        ]
                                    }
                                },
                            ],
                        }
                    ],
                },
            }
        ],
    }
    text = chat_sync._message_text(message)
    assert "Deploy failed — prod" in text
    assert "Details" in text
    assert "build 123 broke" in text
    assert "Service\napi-rs\neu-west" in text
    assert "col text" in text
    # Real text still wins over card content.
    assert chat_sync._message_text({**message, "text": "plain"}) == "plain"
    # Cards with no readable widgets stay empty (message is skipped as before).
    assert chat_sync._message_text({"cardsV2": [{"card": {"sections": []}}]}) == ""


def test_python_card_text_matches_shared_fixture():
    fixture = Path(__file__).resolve().parents[2] / "fixtures/google_chat_card_text.json"
    for case in json.loads(fixture.read_text()):
        assert chat_sync._message_text(case["message"]) == case["text"], case["name"]


def test_message_text_uses_official_fallback_and_gif_fields():
    assert chat_sync._message_text({"fallbackText": "Card summary"}) == "Card summary"
    assert chat_sync._message_text({"attachedGifs": [{"uri": "https://example.test/a.gif"}]}) == (
        "https://example.test/a.gif"
    )


def test_resource_id_strips_prefix():
    assert chat_sync._resource_id("spaces/S1/messages/m1") == "m1"
    assert chat_sync._resource_id("") == ""
    # Configured GOOGLE_CHAT_SPACE_IDS entries are normalized through
    # _resource_id before being re-prefixed, so a full resource name in the env
    # cannot produce a "spaces/spaces/<id>" URL.
    assert f"spaces/{chat_sync._resource_id('spaces/S1')}" == "spaces/S1"


def test_space_type_prefers_current_schema_and_maps_deprecated_values():
    assert chat_sync._space_type({"spaceType": "SPACE", "type": "DM"}) == "SPACE"
    assert chat_sync._space_type({"type": "ROOM"}) == "SPACE"
    assert chat_sync._space_type({"type": "DM"}) == "DIRECT_MESSAGE"


class _FakeTransport:
    """Stands in for the httplib2 transport so no network/credentials are needed."""

    def __init__(self):
        self.urls = []

    def request(self, url, method="GET"):
        self.urls.append(url)
        return types.SimpleNamespace(status=200), b"{}"


def test_client_builds_space_scoped_urls():
    from workflows.google_chat.client import GoogleChatReadonlyClient

    client = GoogleChatReadonlyClient(None)
    client._http = transport = _FakeTransport()

    client.list_messages("spaces/S1", page_size=2, filter='createTime > "t"')
    client.list_members("spaces/S1", page_size=2)

    messages_url, members_url = transport.urls
    assert messages_url.startswith("https://chat.googleapis.com/v1/spaces/S1/messages?")
    assert members_url.startswith("https://chat.googleapis.com/v1/spaces/S1/members?")
    # History is always walked oldest-first; the caller no longer passes order_by.
    assert "orderBy=createTime+ASC" in messages_url
    assert "/spaces/spaces/" not in messages_url + members_url


def test_client_requests_deleted_messages_when_enabled():
    from workflows.google_chat.client import GoogleChatReadonlyClient

    client = GoogleChatReadonlyClient(None)
    client._http = transport = _FakeTransport()
    client.list_messages("spaces/DM1", show_deleted=True)
    assert "showDeleted=true" in transport.urls[0]


def test_client_retries_transient_reads_and_honors_retry_after(monkeypatch):
    from workflows.google_chat import client as chat_client

    class Response(dict):
        def __init__(self, status, **headers):
            super().__init__(headers)
            self.status = status

    class Transport:
        def __init__(self):
            self.responses = [
                (Response(429, **{"retry-after": "0"}), b"rate limited"),
                (Response(503), b"unavailable"),
                (Response(200), b'{"spaces":[]}'),
            ]

        def request(self, _url, method="GET"):
            assert method == "GET"
            return self.responses.pop(0)

    sleeps = []
    monkeypatch.setattr(chat_client.time, "sleep", sleeps.append)
    monkeypatch.setattr(chat_client.random, "random", lambda: 0)
    client = chat_client.GoogleChatReadonlyClient(None)
    client._http = Transport()
    assert client.list_spaces() == {"spaces": []}
    assert sleeps == [0.0, 0.0]


def test_client_429_backoff_starts_after_a_full_quota_window(monkeypatch):
    from workflows.google_chat import client as chat_client

    class Response(dict):
        status = 429

    monkeypatch.setattr(chat_client.random, "random", lambda: 0.0)
    assert chat_client._retry_delay_seconds(Response(), 0) == 1.0
    assert chat_client._retry_delay_seconds(Response(), 1) == 2.0


def test_delegated_client_uses_context_broker_without_google_credentials():
    from workflows.google_chat.client import GoogleChatDelegatedClient

    class Ctx:
        def __init__(self):
            self.requests = []

        async def google_chat_dwd_read(self, subject, operation, **kwargs):
            self.requests.append((subject, operation, kwargs))
            return {"messages": []}

    ctx = Ctx()
    client = GoogleChatDelegatedClient(ctx, "alice@example.com")
    result = asyncio.run(
        client.list_messages(
            "spaces/S1",
            page_size=50,
            page_token="next",
            filter='createTime > "2026-08-01T00:00:00Z"',
            show_deleted=True,
        )
    )
    reaction_result = asyncio.run(
        client.list_reactions("spaces/S1/messages/M1", page_size=100)
    )
    assert result == {"messages": []}
    assert reaction_result == {"messages": []}
    assert ctx.requests == [
        (
            "alice@example.com",
            "list_messages",
            {
                "resource_name": "spaces/S1",
                "page_size": 50,
                "page_token": "next",
                "filter": 'createTime > "2026-08-01T00:00:00Z"',
                "show_deleted": True,
            },
        ),
        (
            "alice@example.com",
            "list_reactions",
            {
                "resource_name": "spaces/S1/messages/M1",
                "page_size": 100,
                "page_token": None,
                "filter": None,
            },
        ),
    ]


def test_readonly_reactions_use_fixed_broker_identity():
    from workflows.google_chat.client import GoogleChatReadonlyClient

    class Ctx:
        def __init__(self):
            self.requests = []

        async def google_chat_dwd_read(self, subject, operation, **kwargs):
            self.requests.append((subject, operation, kwargs))
            return {"emojiReactions": []}

    ctx = Ctx()
    result = asyncio.run(
        GoogleChatReadonlyClient(ctx).list_reactions(
            "spaces/S1/messages/M1", page_size=100, page_token="next"
        )
    )

    assert result == {"emojiReactions": []}
    assert ctx.requests == [
        (
            "",
            "list_reactions",
            {
                "resource_name": "spaces/S1/messages/M1",
                "page_size": 100,
                "page_token": "next",
            },
        )
    ]


def test_incremental_filter_matches_the_broker_contract():
    timestamp = dt.datetime(2026, 8, 1, 0, 0, 0, 123456, tzinfo=dt.UTC)
    assert f'createTime > "{chat_sync._rfc3339(timestamp)}"' == (
        'createTime > "2026-08-01T00:00:00.123456Z"'
    )


class FakeChatClient:
    def __init__(self, pages):
        self._pages = pages
        self.calls = []

    def list_members(self, space_name, *, page_size, page_token=None):
        return {"memberships": []}

    def list_reactions(self, message_name, *, page_size, page_token=None):
        return {"emojiReactions": []}

    def list_messages(
        self,
        space_name,
        *,
        page_size,
        page_token=None,
        filter=None,
        show_deleted=False,
        order_by="createTime ASC",
    ):
        self.calls.append(
            {
                "page_token": page_token,
                "filter": filter,
                "show_deleted": show_deleted,
                "order_by": order_by,
            }
        )
        index = 0 if page_token is None else int(page_token)
        return self._pages[index]


class FakeSyncPool:
    def __init__(self):
        self.executed = []
        self.checkpoint_watermark = None
        self.continuation_token = None
        self.continuation_filter = None

    async def fetchrow(self, query, *args):
        # _load_checkpoint -> no existing checkpoint (cold start)
        return None

    async def execute(self, query, *args):
        self.executed.append((query, args))
        if "google_chat_sync_checkpoints" in query and "watermark_time" in query:
            self.checkpoint_watermark = args[2]
            self.continuation_token = args[4]
            self.continuation_filter = args[5]
        return "INSERT 0 1"


def test_sync_space_pages_skips_empty_and_advances_watermark():
    t0 = dt.datetime(2026, 6, 1, 10, 0, tzinfo=dt.UTC)
    t1 = dt.datetime(2026, 6, 1, 10, 1, tzinfo=dt.UTC)
    t2 = dt.datetime(2026, 6, 1, 10, 2, tzinfo=dt.UTC)

    def msg(mid, text, created):
        return {
            "name": f"spaces/S1/messages/{mid}",
            "text": text,
            "thread": {"name": "spaces/S1/threads/T1"},
            "sender": {"name": "users/1", "type": "HUMAN"},
            "createTime": created.isoformat().replace("+00:00", "Z"),
        }

    pages = [
        {
            "messages": [msg("m1", "first", t0), msg("m2", "   ", t1)],  # m2 empty
            "nextPageToken": "1",
        },
        {"messages": [msg("m3", "third", t2)]},
    ]
    client = FakeChatClient(pages)
    pool = FakeSyncPool()
    counts = {"spaces_seen": 1, "spaces_synced": 0, "messages_seen": 0, "messages_upserted": 0}

    watermark = asyncio.run(
        chat_sync._sync_space(
            pool,
            client=client,
            space={"name": "spaces/S1", "displayName": "Eng", "type": "SPACE"},
            run_id="run_1",
            page_size=100,
            overlap_seconds=60,
            max_pages=0,
            explicit_since=None,
            counts=counts,
        )
    )

    assert counts["messages_seen"] == 3
    assert counts["messages_upserted"] == 2  # empty m2 skipped
    assert watermark == t2  # newest createTime processed
    assert pool.checkpoint_watermark == t2
    # Two pages walked (cold start: no createTime filter on the first call).
    assert len(client.calls) == 2
    assert client.calls[0]["filter"] is None
    assert client.calls[0]["show_deleted"] is True
    assert client.calls[0]["order_by"] == "createTime ASC"


def test_scheduled_sync_rescans_old_messages_so_edits_converge():
    class CheckpointPool(FakeSyncPool):
        async def fetchrow(self, query, *args):
            return {
                "watermark_time": dt.datetime(2026, 6, 1, 12, 0, tzinfo=dt.UTC),
                "last_error": "",
            }

    client = FakeChatClient([{"messages": []}])
    pool = CheckpointPool()
    counts = {"spaces_seen": 1, "spaces_synced": 0, "messages_seen": 0, "messages_upserted": 0}

    asyncio.run(
        chat_sync._sync_space(
            pool,
            client=client,
            space={"name": "spaces/S1", "displayName": "Eng", "type": "SPACE"},
            run_id="run_1",
            page_size=100,
            overlap_seconds=60,
            max_pages=0,
            explicit_since=None,
            counts=counts,
        )
    )

    assert client.calls[0]["filter"] is None


def test_deletion_cleanup_is_idempotent_and_removes_retained_content():
    pool = FakeSyncPool()
    for _ in range(2):
        asyncio.run(
            chat_sync._delete_message(
                pool,
                owner_email="alice@example.com",
                space_id="DM1",
                message_id="M1",
            )
        )
    deletes = [(query, args) for query, args in pool.executed if query.startswith("DELETE")]
    assert len(deletes) == 6
    assert all(args == ("alice@example.com", "DM1", "M1") for _, args in deletes)
    assert any("google_chat_sync_messages" in query for query, _ in deletes)


def test_shared_space_tombstone_removes_retained_content_during_sync():
    client = FakeChatClient(
        [
            {
                "messages": [
                    {
                        "name": "spaces/S1/messages/M1",
                        "deleteTime": "2026-08-14T10:00:00Z",
                    }
                ]
            }
        ]
    )
    pool = FakeSyncPool()
    counts = {
        "spaces_seen": 1,
        "spaces_synced": 0,
        "messages_seen": 0,
        "messages_upserted": 0,
    }

    asyncio.run(
        chat_sync._sync_space(
            pool,
            client=client,
            space={"name": "spaces/S1", "displayName": "Eng", "type": "SPACE"},
            run_id="run_1",
            page_size=100,
            overlap_seconds=60,
            max_pages=0,
            explicit_since=None,
            counts=counts,
        )
    )

    deletes = [(query, args) for query, args in pool.executed if query.startswith("DELETE")]
    assert client.calls[0]["show_deleted"] is True
    assert counts["messages_seen"] == 1
    assert counts["messages_upserted"] == 0
    assert len(deletes) == 3
    assert all(args == ("", "S1", "M1") for _, args in deletes)


def test_sync_space_never_regresses_watermark_below_checkpoint():
    # An explicit `since` re-backfill truncated by max_pages must not pull the
    # checkpoint back into already-synced history (upstream #887's watermark
    # non-regression guard, ported to the Chat sync).
    checkpoint_time = dt.datetime(2026, 6, 10, 12, 0, tzinfo=dt.UTC)
    old_created = dt.datetime(2026, 6, 1, 10, 0, tzinfo=dt.UTC)

    class CheckpointPool(FakeSyncPool):
        async def fetchrow(self, query, *args):
            return {"watermark_time": checkpoint_time, "last_error": ""}

    client = FakeChatClient(
        [
            {
                "messages": [
                    {
                        "name": "spaces/S1/messages/m1",
                        "text": "old message",
                        "thread": {"name": "spaces/S1/threads/T1"},
                        "sender": {"name": "users/1", "type": "HUMAN"},
                        "createTime": old_created.isoformat().replace("+00:00", "Z"),
                    }
                ],
                "nextPageToken": "1",
            },
            {"messages": []},
        ]
    )
    pool = CheckpointPool()
    counts = {"spaces_seen": 1, "spaces_synced": 0, "messages_seen": 0, "messages_upserted": 0}

    watermark = asyncio.run(
        chat_sync._sync_space(
            pool,
            client=client,
            space={"name": "spaces/S1", "displayName": "Eng", "type": "SPACE"},
            run_id="run_1",
            page_size=100,
            overlap_seconds=60,
            max_pages=1,  # truncate mid-backfill
            explicit_since=dt.datetime(2026, 5, 1, tzinfo=dt.UTC),
            counts=counts,
        )
    )

    # The old message was still (re-)upserted…
    assert counts["messages_upserted"] == 1
    # …but the stored watermark stays clamped at the pre-run checkpoint.
    assert watermark == checkpoint_time
    assert pool.checkpoint_watermark == checkpoint_time


def test_bounded_sync_persists_and_resumes_page_continuation():
    created = dt.datetime(2026, 6, 1, 10, 0, tzinfo=dt.UTC)

    def msg(mid):
        return {
            "name": f"spaces/S1/messages/{mid}",
            "text": mid,
            "thread": {"name": "spaces/S1/threads/T1"},
            "sender": {"name": "users/1", "type": "HUMAN"},
            "createTime": created.isoformat().replace("+00:00", "Z"),
        }

    pages = [
        {"messages": [msg("m1")], "nextPageToken": "1"},
        {"messages": [msg("m2")]},
    ]
    first_client = FakeChatClient(pages)
    first_pool = FakeSyncPool()
    counts = {"messages_seen": 0, "messages_upserted": 0}
    asyncio.run(
        chat_sync._sync_space(
            first_pool,
            client=first_client,
            space={"name": "spaces/S1", "type": "SPACE"},
            run_id="run_1",
            page_size=1,
            overlap_seconds=60,
            max_pages=1,
            explicit_since=None,
            counts=counts,
        )
    )
    assert first_pool.continuation_token == "1"

    class ResumePool(FakeSyncPool):
        async def fetchrow(self, query, *args):
            return {
                "watermark_time": created,
                "last_error": "",
                "continuation_token": "1",
                "continuation_filter": "",
                "continuation_started_at": created,
            }

    second_client = FakeChatClient(pages)
    second_pool = ResumePool()
    asyncio.run(
        chat_sync._sync_space(
            second_pool,
            client=second_client,
            space={"name": "spaces/S1", "type": "SPACE"},
            run_id="run_2",
            page_size=1,
            overlap_seconds=60,
            max_pages=1,
            explicit_since=None,
            counts={"messages_seen": 0, "messages_upserted": 0},
        )
    )
    assert second_client.calls[0]["page_token"] == "1"
    assert second_client.calls[0]["filter"] is None
    assert second_pool.continuation_token == ""


def test_dm_membership_failure_does_not_block_owner_scoped_sync():
    class BrokenMembers(FakeChatClient):
        def list_members(self, space_name, *, page_size, page_token=None):
            raise RuntimeError("membership denied")

    assert asyncio.run(chat_sync._member_directory(BrokenMembers([]), "spaces/DM")) == {}


def test_malformed_reactions_are_skipped_without_page_index_ids():
    class Reactions(FakeChatClient):
        def list_reactions(self, message_name, *, page_size, page_token=None):
            return {
                "emojiReactions": [
                    {"user": {"name": "users/1"}, "emoji": {"unicode": "👍"}},
                    {
                        "name": "spaces/S1/messages/M1/reactions/R1",
                        "user": {"name": "users/2"},
                        "emoji": {"unicode": "✅"},
                    },
                ]
            }

    pool = FakeSyncPool()
    count = asyncio.run(
        chat_sync._replace_reactions(
            pool,
            client=Reactions([]),
            owner_email="",
            space_id="S1",
            message_id="M1",
            message_name="spaces/S1/messages/M1",
            run_id="run_1",
        )
    )
    assert count == 1
    inserts = [args for sql, args in pool.executed if "INSERT INTO google_chat_sync_reactions" in sql]
    assert [args[3] for args in inserts] == ["R1"]


def test_changed_chat_threads_exclude_owner_scoped_dms():
    class Pool:
        def __init__(self):
            self.queries = []

        async def fetch(self, query, *args):
            self.queries.append(query)
            return []

        async def fetchrow(self, query, *args):
            self.queries.append(query)
            return {"changed_messages": 0, "max_updated_at": None}

    pool = Pool()
    asyncio.run(projection._load_changed_chat_threads(pool, None))
    assert all("owner_email = ''" in query for query in pool.queries)


def test_dm_sync_allowlist_defaults_off_and_intersects_requested(monkeypatch):
    monkeypatch.delenv("GOOGLE_CHAT_DWD_DM_SYNC_ENABLED", raising=False)
    monkeypatch.setenv("GOOGLE_CHAT_DWD_DM_SUBJECTS", "alice@example.com")
    assert chat_sync._dm_subject_allowlist() == set()
    monkeypatch.setenv("GOOGLE_CHAT_DWD_DM_SYNC_ENABLED", "true")
    assert chat_sync._dm_subject_allowlist() == {"alice@example.com"}
    assert chat_sync._selected_dm_subjects(["alice@example.com", "mallory@example.com"]) == [
        "alice@example.com"
    ]
    monkeypatch.setenv("GOOGLE_CHAT_DWD_DM_SUBJECTS", "")
    assert chat_sync._selected_dm_subjects(["alice@example.com"]) == []


def test_failing_dwd_subject_redacts_token_from_logs_and_result(monkeypatch):
    sentinel = "Bearer sentinel-delegated-token"

    class AppClient:
        def list_spaces(self, *, page_size, page_token=None):
            return {"spaces": []}

    class DwdClient:
        def list_spaces(self, *, page_size, page_token=None):
            raise RuntimeError(f"upstream failed Authorization: {sentinel}")

    class Pool:
        async def execute(self, query, *args):
            return "UPDATE 1"

    class Ctx:
        run_id = "workflow-1"
        _pool = Pool()

        def __init__(self):
            self.logs = []

        def log(self, event, **fields):
            self.logs.append((event, fields))

    monkeypatch.setenv("GOOGLE_CHAT_ETL_ENABLED", "true")
    monkeypatch.setenv("GOOGLE_CHAT_DWD_DM_SYNC_ENABLED", "true")
    monkeypatch.setenv("GOOGLE_CHAT_DWD_DM_SUBJECTS", "alice@example.com")
    monkeypatch.setattr(chat_sync, "_client", lambda _ctx: AppClient())
    monkeypatch.setattr(chat_sync, "_delegated_client", lambda _ctx, _subject: DwdClient())
    ctx = Ctx()
    result = asyncio.run(chat_sync.handler(chat_sync.Input(), ctx))
    emitted = json.dumps({"result": result, "logs": ctx.logs})
    assert result["status"] == "failed"
    assert sentinel not in emitted
    assert "sentinel-delegated-token" not in emitted
    assert "Google Chat API request failed" in emitted


def test_dwd_dm_sync_persists_participants_attachments_reactions_idempotently(
    monkeypatch,
):
    database_url = os.getenv("SESSION_SQLX_TEST_DATABASE_URL")
    if not database_url:
        return

    class AppClient:
        def list_spaces(self, *, page_size, page_token=None):
            return {"spaces": []}

    class DwdClient:
        def list_spaces(self, *, page_size, page_token=None):
            return {
                "spaces": [
                    {
                        "name": "spaces/DM1",
                        "type": "DIRECT_MESSAGE",
                    }
                ]
            }

        def list_members(self, space_name, *, page_size, page_token=None):
            return {
                "memberships": [
                    {"member": {"name": "users/1", "displayName": "Alice"}},
                    {"member": {"name": "users/2", "displayName": "Bob"}},
                ]
            }

        def list_messages(
            self, space_name, *, page_size, page_token=None, filter=None, show_deleted=False
        ):
            assert show_deleted is True
            return {
                "messages": [
                    {
                        "name": "spaces/DM1/messages/M1",
                        "text": "see the runbook",
                        "sender": {"name": "users/1", "type": "HUMAN"},
                        "createTime": "2026-08-14T10:00:00Z",
                        "attachment": [
                            {
                                "name": "spaces/DM1/messages/M1/attachments/A1",
                                "contentName": "runbook.txt",
                                "contentType": "text/plain",
                                "attachmentDataRef": {"resourceName": "attachments/A1"},
                            }
                        ],
                    }
                ]
            }

        def list_reactions(self, message_name, *, page_size, page_token=None):
            return {
                "emojiReactions": [
                    {
                        "name": "spaces/DM1/messages/M1/reactions/R1",
                        "user": {"name": "users/2"},
                        "emoji": {"unicode": "✅"},
                    }
                ]
            }

    class Ctx:
        def __init__(self, run_id, pool):
            self.run_id = run_id
            self._pool = pool

        def log(self, _event, **_fields):
            pass

    async def run():
        import asyncpg

        admin = await asyncpg.connect(database_url)
        database = f"centaur_google_chat_dwd_{os.getpid()}_{time.time_ns()}"
        await admin.execute(f'CREATE DATABASE "{database}"')
        conn = None
        try:
            conn = await asyncpg.connect(database_url, database=database)
            migration_dir = (
                Path(__file__).resolve().parents[2]
                / "services/api-rs/crates/centaur-session-sqlx/migrations"
            )
            for migration in sorted(migration_dir.glob("*.sql")):
                await conn.execute(migration.read_text())

            monkeypatch.setenv("GOOGLE_CHAT_ETL_ENABLED", "true")
            monkeypatch.setenv("GOOGLE_CHAT_DWD_DM_SYNC_ENABLED", "true")
            monkeypatch.setenv("GOOGLE_CHAT_DWD_DM_SUBJECTS", "alice@example.com")
            monkeypatch.setattr(chat_sync, "_client", lambda _ctx: AppClient())
            monkeypatch.setattr(
                chat_sync, "_delegated_client", lambda _ctx, _subject: DwdClient()
            )

            for run_id in ("workflow-1", "workflow-2"):
                result = await chat_sync.handler(
                    chat_sync.Input(dm_subjects=["alice@example.com"]),
                    Ctx(run_id, conn),
                )
                assert result["status"] == "completed"
                assert result["files_processed"] == 1
                assert result["reactions_processed"] == 1

            space = await conn.fetchrow(
                "SELECT owner_email, participant_emails FROM google_chat_sync_spaces"
            )
            assert dict(space) == {
                "owner_email": "alice@example.com",
                "participant_emails": ["alice@example.com"],
            }
            assert await conn.fetchval("SELECT COUNT(*) FROM google_chat_sync_messages") == 1
            assert await conn.fetchval("SELECT COUNT(*) FROM google_chat_sync_attachments") == 1
            assert await conn.fetchval("SELECT COUNT(*) FROM google_chat_sync_reactions") == 1
            assert await conn.fetchval(
                "SELECT content_text FROM google_chat_sync_attachments"
            ) == ""
            assert await conn.fetchval(
                "SELECT emoji_unicode FROM google_chat_sync_reactions"
            ) == "✅"
        finally:
            if conn is not None:
                await conn.close()
            await admin.execute(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
            await admin.close()

    asyncio.run(run())


def test_retention_modes_never_call_google_api():
    class Pool:
        def __init__(self):
            self.queries = []

        async def fetchval(self, query, *args):
            self.queries.append(query)
            return 2

    for mode in ("dry_run", "count", "delete"):
        pool = Pool()
        counts = asyncio.run(
            chat_retention.prune_google_chat(
                pool, retention_days=30, mode=mode, batch_limit=10
            )
        )
        assert set(counts) == {
            "documents", "attachments", "reactions", "messages", "checkpoints", "spaces", "runs"
        }
        assert all("chat.googleapis.com" not in query for query in pool.queries)
        assert all("LIMIT $2" in query for query in pool.queries)


def test_retention_db_age_batch_cleanup_and_idempotency():
    database_url = os.getenv("SESSION_SQLX_TEST_DATABASE_URL")
    if not database_url:
        return

    async def run():
        import asyncpg

        admin = await asyncpg.connect(database_url)
        database = f"centaur_google_chat_retention_{os.getpid()}_{time.time_ns()}"
        await admin.execute(f'CREATE DATABASE "{database}"')
        conn = None
        try:
            conn = await asyncpg.connect(database_url, database=database)
            migration_dir = (
                Path(__file__).resolve().parents[2]
                / "services/api-rs/crates/centaur-session-sqlx/migrations"
            )
            for migration in sorted(migration_dir.glob("*.sql")):
                await conn.execute(migration.read_text())
            await conn.execute(
                "INSERT INTO google_chat_sync_runs "
                "(run_id,status,started_at,finished_at) VALUES "
                "('old','completed',NOW()-INTERVAL '40 days',NOW()-INTERVAL '40 days'),"
                "('new','completed',NOW(),NOW())"
            )
            await conn.execute(
                "INSERT INTO google_chat_sync_spaces "
                "(owner_email,space_id,space_name,space_type,last_seen_at) VALUES "
                "('','OLD','spaces/OLD','SPACE',NOW()-INTERVAL '40 days'),"
                "('','NEW','spaces/NEW','SPACE',NOW())"
            )
            await conn.execute(
                "INSERT INTO google_chat_sync_messages "
                "(owner_email,space_id,message_id,message_name,text_content,source_create_time,updated_at) VALUES "
                "('','OLD','OLD','spaces/OLD/messages/OLD','old',NOW()-INTERVAL '40 days',NOW()-INTERVAL '40 days'),"
                "('','NEW','NEW','spaces/NEW/messages/NEW','new',NOW(),NOW())"
            )
            await conn.execute(
                "INSERT INTO google_chat_sync_attachments "
                "(owner_email,space_id,message_id,attachment_id,updated_at) VALUES "
                "('','OLD','OLD','OLD',NOW()-INTERVAL '40 days'),"
                "('','NEW','NEW','NEW',NOW())"
            )
            await conn.execute(
                "INSERT INTO google_chat_sync_reactions "
                "(owner_email,space_id,message_id,reaction_id,updated_at) VALUES "
                "('','OLD','OLD','OLD',NOW()-INTERVAL '40 days'),"
                "('','NEW','NEW','NEW',NOW())"
            )
            await conn.execute(
                "INSERT INTO google_chat_sync_checkpoints "
                "(owner_email,space_id,updated_at) VALUES "
                "('','OLD',NOW()-INTERVAL '40 days'),('','NEW',NOW())"
            )
            await conn.execute(
                "INSERT INTO company_context_documents "
                "(document_id,source,source_type,source_document_id,occurred_at) VALUES "
                "('google_chat:old','google_chat','google_chat_thread','OLD',NOW()-INTERVAL '40 days'),"
                "('google_chat:new','google_chat','google_chat_thread','NEW',NOW())"
            )
            dry = await chat_retention.prune_google_chat(
                conn, retention_days=30, mode="dry_run", batch_limit=1
            )
            counted = await chat_retention.prune_google_chat(
                conn, retention_days=30, mode="count", batch_limit=1
            )
            assert dry == counted
            assert counted == {
                "documents": 1,
                "attachments": 1,
                "reactions": 1,
                "messages": 1,
                "checkpoints": 1,
                "spaces": 0,
                "runs": 1,
            }
            deleted = await chat_retention.prune_google_chat(
                conn, retention_days=30, mode="delete", batch_limit=1
            )
            assert all(value == 1 for value in deleted.values())
            repeated = await chat_retention.prune_google_chat(
                conn, retention_days=30, mode="delete", batch_limit=1
            )
            assert all(value == 0 for value in repeated.values())
            assert await conn.fetchval(
                "SELECT COUNT(*) FROM google_chat_sync_messages"
            ) == 1
            assert await conn.fetchval(
                "SELECT COUNT(*) FROM google_chat_sync_attachments"
            ) == 1
            assert await conn.fetchval(
                "SELECT COUNT(*) FROM google_chat_sync_reactions"
            ) == 1
        finally:
            if conn is not None:
                await conn.close()
            await admin.execute(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
            await admin.close()

    asyncio.run(run())


def test_metrics_have_only_bounded_labels(monkeypatch):
    calls = []
    monkeypatch.setattr(chat_metrics, "increment_metric", lambda name, count, **labels: calls.append((name, labels)))
    chat_metrics.record_api_outcome("spaces/secret", "429-raw-space-id")
    chat_metrics.record_space_failure("spaces/secret")
    chat_metrics.record_items("users/secret", 1)
    assert calls == [
        ("google_chat_etl_api_requests_total", {"operation": "list_messages", "outcome": "error"}),
        ("google_chat_etl_space_failures_total", {"reason": "api_error"}),
        ("google_chat_etl_items_processed_total", {"item_type": "message"}),
    ]

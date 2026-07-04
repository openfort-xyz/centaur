from __future__ import annotations

import asyncio
import datetime as dt
import importlib
import json
import sys
import types
from pathlib import Path


def _install_api_stubs() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))

    runtime_control = sys.modules.get("api.runtime_control") or types.ModuleType(
        "api.runtime_control"
    )
    runtime_control.canonical_json = lambda value: json.dumps(value, sort_keys=True)
    runtime_control.decode_jsonb = lambda value, default: (
        value if value is not None else default
    )

    vm_metrics = types.ModuleType("api.vm_metrics")
    for name in (
        "observe_company_context_document_size",
        "record_company_context_documents_changed",
        "set_company_context_projection_lag",
        "set_etl_active_scopes",
        "set_etl_failed_scopes",
        "set_etl_scope_sync_freshness_seconds",
        "record_etl_items_seen",
        "record_etl_items_upserted",
        "record_etl_items_failed",
        "record_slack_etl_rate_limit",
    ):
        setattr(vm_metrics, name, lambda *_args, **_kwargs: None)

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
    api_module.vm_metrics = vm_metrics
    api_module.metrics = metrics
    api_module.workflow_engine = workflow_engine
    sys.modules["api"] = api_module
    sys.modules["api.runtime_control"] = runtime_control
    sys.modules["api.vm_metrics"] = vm_metrics
    sys.modules["api.metrics"] = metrics
    sys.modules["api.workflow_engine"] = workflow_engine
    sys.modules["centaur_sdk"] = centaur_sdk


_install_api_stubs()
projection = importlib.import_module("workflows.company_context_documents")
chat_sync = importlib.import_module("workflows.google_chat.sync")


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


def test_resource_id_strips_prefix():
    assert chat_sync._resource_id("spaces/S1/messages/m1") == "m1"
    assert chat_sync._resource_id("") == ""


class FakeChatClient:
    def __init__(self, pages):
        self._pages = pages
        self.calls = []

    def list_members(self, space_name, *, page_size, page_token=None):
        return {"memberships": []}

    def list_messages(
        self, space_name, *, page_size, page_token=None, filter=None, order_by="createTime asc"
    ):
        self.calls.append({"page_token": page_token, "filter": filter, "order_by": order_by})
        index = 0 if page_token is None else int(page_token)
        return self._pages[index]


class FakeSyncPool:
    def __init__(self):
        self.executed = []
        self.checkpoint_watermark = None

    async def fetchrow(self, query, *args):
        # _load_checkpoint -> no existing checkpoint (cold start)
        return None

    async def execute(self, query, *args):
        self.executed.append((query, args))
        if "google_chat_sync_checkpoints" in query and "watermark_time" in query:
            # capture watermark passed to _update_checkpoint_success ($2)
            self.checkpoint_watermark = args[1]
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
    assert client.calls[0]["order_by"] == "createTime asc"


def test_sync_space_uses_overlapped_watermark_filter_when_checkpoint_exists():
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

    # 12:00 watermark minus 60s overlap -> filter from 11:59.
    assert client.calls[0]["filter"] == 'createTime > "2026-06-01T11:59:00Z"'


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

"""Workflow: sync Google Chat space history into Postgres.

Mirrors the Slack ETL: enumerate the spaces the Chat app is a member of, then
page each space's message history into raw ``google_chat_sync_*`` tables. A
per-space ``createTime`` watermark makes runs incremental; on first run (no
watermark) it walks the full history oldest-first. A bounded page budget lets a
large first backfill converge across several runs while staying current after.

Reads as the Chat app via GOOGLE_SERVICE_ACCOUNT_JSON + chat.app.messages.readonly
(see workflows/google_chat/client.py), so coverage is limited to app-member
spaces and requires the admin Marketplace install.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import os
from dataclasses import dataclass, field
from typing import Any, Protocol

from api.runtime_control import canonical_json
from api.vm_metrics import (
    record_etl_items_failed,
    record_etl_items_seen,
    record_etl_items_upserted,
)
from api.workflow_engine import WorkflowContext
from workflows.slack.shared import env_flag_enabled, positive_int

WORKFLOW_NAME = "google_chat_sync"
DEFAULT_SYNC_INTERVAL_SECONDS = 4 * 60 * 60
DEFAULT_PAGE_SIZE = 100
DEFAULT_WATERMARK_OVERLAP_SECONDS = 60
# 0 = unlimited (page each space to completion every run, like the Drive ETL).
# Set GOOGLE_CHAT_MAX_PAGES_PER_RUN > 0 to bound a large first backfill so it
# converges across runs instead of in one long run.
DEFAULT_MAX_PAGES_PER_RUN = 0
# Google Chat space types: SPACE (named rooms), GROUP_CHAT, DIRECT_MESSAGE.
# Default to named rooms only — DMs/group chats are private and would land in a
# company-wide corpus, mirroring how Slack DMs are kept out of the shared ETL.
DEFAULT_INCLUDE_SPACE_TYPES = "SPACE"


def _include_space_types() -> set[str]:
    raw = os.getenv("GOOGLE_CHAT_INCLUDE_SPACE_TYPES") or DEFAULT_INCLUDE_SPACE_TYPES
    return {part.strip().upper() for part in raw.split(",") if part.strip()}


SCHEDULE = {
    "schedule_id": "google_chat_sync",
    "interval_seconds": positive_int(
        os.getenv("GOOGLE_CHAT_SYNC_INTERVAL_SECONDS"),
        DEFAULT_SYNC_INTERVAL_SECONDS,
    ),
    "enabled": env_flag_enabled("GOOGLE_CHAT_ETL_ENABLED", default=False),
    "no_delivery": True,
}


@dataclass
class Input:
    """Runtime options for a manual Google Chat sync workflow run."""

    since: str | None = None
    limit: int = DEFAULT_PAGE_SIZE
    watermark_overlap_seconds: int = DEFAULT_WATERMARK_OVERLAP_SECONDS
    max_pages_per_run: int = DEFAULT_MAX_PAGES_PER_RUN
    space_ids: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


class GoogleChatSyncClient(Protocol):
    """Small adapter protocol used by the Chat ETL workflow."""

    def list_spaces(
        self, *, page_size: int, page_token: str | None = None
    ) -> dict[str, Any]: ...

    def list_messages(
        self,
        space_name: str,
        *,
        page_size: int,
        page_token: str | None = None,
        filter: str | None = None,
        order_by: str = "createTime asc",
    ) -> dict[str, Any]: ...

    def list_members(
        self, space_name: str, *, page_size: int, page_token: str | None = None
    ) -> dict[str, Any]: ...


def _client() -> GoogleChatSyncClient:
    from workflows.google_chat.client import GoogleChatReadonlyClient

    return GoogleChatReadonlyClient()


def _parse_datetime(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def _rfc3339(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _content_hash(*parts: Any) -> str:
    return hashlib.sha256(canonical_json(parts).encode("utf-8")).hexdigest()


def _resource_id(resource_name: str) -> str:
    return resource_name.rsplit("/", 1)[-1] if resource_name else ""


def _workflow_run_id_to_sync_run_id(workflow_run_id: str) -> str:
    safe = "".join(char if char.isalnum() else "_" for char in workflow_run_id)
    return f"google_chat_sync_{safe}"


def _scope_ref(space_id: str, reason: str | None = None) -> dict[str, str]:
    result = {"space_id": space_id}
    if reason:
        result["reason"] = reason
    return result


def _message_text(message: dict[str, Any]) -> str:
    return str(message.get("text") or message.get("formattedText") or "").strip()


def _member_display_names(client: GoogleChatSyncClient, space_name: str) -> dict[str, str]:
    """Map 'users/<id>' -> display name. Best effort; empty on auth failure."""
    names: dict[str, str] = {}
    page_token: str | None = None
    try:
        while True:
            page = client.list_members(
                space_name, page_size=DEFAULT_PAGE_SIZE, page_token=page_token
            )
            for membership in page.get("memberships", []):
                member = membership.get("member") if isinstance(membership, dict) else None
                if not isinstance(member, dict):
                    continue
                name = str(member.get("name") or "")
                display = str(member.get("displayName") or "").strip()
                if name and display:
                    names[name] = display
            page_token = page.get("nextPageToken")
            if not page_token:
                break
    except Exception:
        return names
    return names


async def _load_checkpoint(pool, space_id: str) -> dict[str, Any] | None:
    row = await pool.fetchrow(
        "SELECT watermark_time, last_error FROM google_chat_sync_checkpoints "
        "WHERE space_id = $1",
        space_id,
    )
    return dict(row) if row else None


async def _update_checkpoint_success(
    pool, *, space_id: str, watermark_time: dt.datetime | None, run_id: str
) -> None:
    await pool.execute(
        "INSERT INTO google_chat_sync_checkpoints ("
        "space_id, watermark_time, last_run_id, last_success_at, last_error, updated_at"
        ") VALUES ($1, $2, $3, NOW(), '', NOW()) "
        "ON CONFLICT (space_id) DO UPDATE SET "
        "watermark_time = COALESCE(EXCLUDED.watermark_time, google_chat_sync_checkpoints.watermark_time), "
        "last_run_id = EXCLUDED.last_run_id, "
        "last_success_at = NOW(), "
        "last_error = '', "
        "updated_at = NOW()",
        space_id,
        watermark_time,
        run_id,
    )


async def _update_checkpoint_failure(
    pool, *, space_id: str, run_id: str, error: str
) -> None:
    await pool.execute(
        "INSERT INTO google_chat_sync_checkpoints ("
        "space_id, last_run_id, last_error, updated_at"
        ") VALUES ($1, $2, $3, NOW()) "
        "ON CONFLICT (space_id) DO UPDATE SET "
        "last_run_id = EXCLUDED.last_run_id, "
        "last_error = EXCLUDED.last_error, "
        "updated_at = NOW()",
        space_id,
        run_id,
        error,
    )


async def _record_run_start(
    pool,
    *,
    run_id: str,
    workflow_run_id: str,
    scopes_requested: list[dict[str, str]],
    metadata: dict[str, Any],
) -> None:
    await pool.execute(
        "INSERT INTO google_chat_sync_runs ("
        "run_id, workflow_run_id, mode, status, scopes_requested, metadata"
        ") VALUES ($1, $2, 'incremental', 'running', $3::jsonb, $4::jsonb) "
        "ON CONFLICT (run_id) DO UPDATE SET "
        "workflow_run_id = EXCLUDED.workflow_run_id, "
        "status = 'running', "
        "scopes_requested = EXCLUDED.scopes_requested, "
        "scopes_synced = '[]'::jsonb, "
        "scopes_failed = '[]'::jsonb, "
        "spaces_seen = 0, "
        "spaces_synced = 0, "
        "messages_seen = 0, "
        "messages_upserted = 0, "
        "finished_at = NULL, "
        "error_text = '', "
        "metadata = EXCLUDED.metadata",
        run_id,
        workflow_run_id,
        canonical_json(scopes_requested),
        canonical_json(metadata),
    )


async def _record_run_finish(
    pool,
    *,
    run_id: str,
    status: str,
    scopes_synced: list[dict[str, str]],
    scopes_failed: list[dict[str, str]],
    counts: dict[str, int],
    error_text: str = "",
) -> None:
    await pool.execute(
        "UPDATE google_chat_sync_runs SET "
        "status = $2, scopes_synced = $3::jsonb, scopes_failed = $4::jsonb, "
        "spaces_seen = $5, spaces_synced = $6, messages_seen = $7, "
        "messages_upserted = $8, finished_at = NOW(), error_text = $9 "
        "WHERE run_id = $1",
        run_id,
        status,
        canonical_json(scopes_synced),
        canonical_json(scopes_failed),
        counts.get("spaces_seen", 0),
        counts.get("spaces_synced", 0),
        counts.get("messages_seen", 0),
        counts.get("messages_upserted", 0),
        error_text,
    )


async def _upsert_space(pool, *, space: dict[str, Any], run_id: str) -> str:
    space_id = _resource_id(str(space.get("name") or ""))
    await pool.execute(
        "INSERT INTO google_chat_sync_spaces ("
        "space_id, space_name, display_name, space_type, raw_payload, "
        "source_run_id, last_seen_at, last_error, updated_at"
        ") VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW(), '', NOW()) "
        "ON CONFLICT (space_id) DO UPDATE SET "
        "space_name = EXCLUDED.space_name, "
        "display_name = EXCLUDED.display_name, "
        "space_type = EXCLUDED.space_type, "
        "raw_payload = EXCLUDED.raw_payload, "
        "source_run_id = EXCLUDED.source_run_id, "
        "last_seen_at = NOW(), "
        "last_error = '', "
        "updated_at = NOW()",
        space_id,
        str(space.get("name") or ""),
        str(space.get("displayName") or ""),
        str(space.get("type") or space.get("spaceType") or ""),
        canonical_json(space),
        run_id,
    )
    return space_id


async def _upsert_message(
    pool,
    *,
    space_id: str,
    message: dict[str, Any],
    member_names: dict[str, str],
    run_id: str,
) -> bool:
    message_name = str(message.get("name") or "")
    message_id = _resource_id(message_name)
    if not message_id:
        return False
    text = _message_text(message)
    if not text:
        return False

    thread = message.get("thread") if isinstance(message.get("thread"), dict) else {}
    thread_id = _resource_id(str(thread.get("name") or "")) or message_id
    sender = message.get("sender") if isinstance(message.get("sender"), dict) else {}
    sender_id = str(sender.get("name") or "")
    sender_name = str(sender.get("displayName") or member_names.get(sender_id) or "")
    sender_type = str(sender.get("type") or "")
    create_time = _parse_datetime(str(message.get("createTime") or ""))
    last_update_time = _parse_datetime(
        str(message.get("lastUpdateTime") or message.get("createTime") or "")
    )

    await pool.execute(
        "INSERT INTO google_chat_sync_messages ("
        "space_id, message_id, message_name, thread_id, sender_id, sender_name, "
        "sender_type, text_content, content_hash, source_create_time, "
        "source_last_update_time, raw_payload, source_run_id, last_seen_at, "
        "last_error, updated_at"
        ") VALUES ("
        "$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, NOW(), '', NOW()"
        ") ON CONFLICT (space_id, message_id) DO UPDATE SET "
        "message_name = EXCLUDED.message_name, "
        "thread_id = EXCLUDED.thread_id, "
        "sender_id = EXCLUDED.sender_id, "
        "sender_name = EXCLUDED.sender_name, "
        "sender_type = EXCLUDED.sender_type, "
        "text_content = EXCLUDED.text_content, "
        "content_hash = EXCLUDED.content_hash, "
        "source_create_time = EXCLUDED.source_create_time, "
        "source_last_update_time = EXCLUDED.source_last_update_time, "
        "raw_payload = EXCLUDED.raw_payload, "
        "source_run_id = EXCLUDED.source_run_id, "
        "last_seen_at = NOW(), "
        "last_error = '', "
        "updated_at = NOW()",
        space_id,
        message_id,
        message_name,
        thread_id,
        sender_id,
        sender_name,
        sender_type,
        text,
        _content_hash(text, sender_id, thread_id),
        create_time,
        last_update_time,
        canonical_json(message),
        run_id,
    )
    return True


async def _sync_space(
    pool,
    *,
    client: GoogleChatSyncClient,
    space: dict[str, Any],
    run_id: str,
    page_size: int,
    overlap_seconds: int,
    max_pages: int,
    explicit_since: dt.datetime | None,
    counts: dict[str, int],
) -> dt.datetime | None:
    """Page one space's messages into the sync tables; return its new watermark."""
    space_id = await _upsert_space(pool, space=space, run_id=run_id)
    space_name = str(space.get("name") or f"spaces/{space_id}")

    checkpoint = await _load_checkpoint(pool, space_id)
    watermark = explicit_since
    if watermark is None and checkpoint and checkpoint.get("watermark_time"):
        watermark = checkpoint["watermark_time"].astimezone(dt.timezone.utc)
    effective = watermark
    if effective is not None:
        effective = effective - dt.timedelta(seconds=overlap_seconds)
    msg_filter = f'createTime > "{_rfc3339(effective)}"' if effective else None

    member_names = _member_display_names(client, space_name)

    successful_watermark: dt.datetime | None = None
    page_token: str | None = None
    pages = 0
    while True:
        page = client.list_messages(
            space_name,
            page_size=page_size,
            page_token=page_token,
            filter=msg_filter,
            order_by="createTime asc",
        )
        messages = [m for m in page.get("messages", []) if isinstance(m, dict)]
        counts["messages_seen"] += len(messages)
        record_etl_items_seen("google_chat", "message", "message", len(messages))
        for message in messages:
            upserted = await _upsert_message(
                pool,
                space_id=space_id,
                message=message,
                member_names=member_names,
                run_id=run_id,
            )
            if upserted:
                counts["messages_upserted"] += 1
                record_etl_items_upserted("google_chat", "message", "message", 1)
            created = _parse_datetime(str(message.get("createTime") or ""))
            if created and (
                successful_watermark is None or created > successful_watermark
            ):
                successful_watermark = created
        pages += 1
        page_token = page.get("nextPageToken")
        if not page_token:
            break
        if max_pages and pages >= max_pages:
            break

    await _update_checkpoint_success(
        pool,
        space_id=space_id,
        watermark_time=successful_watermark,
        run_id=run_id,
    )
    return successful_watermark


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    """Sync Google Chat space history into raw Chat sync tables."""
    if not env_flag_enabled("GOOGLE_CHAT_ETL_ENABLED", default=False):
        ctx.log("google_chat_sync_skipped_disabled")
        return {"status": "skipped", "reason": "google_chat_etl_disabled"}

    page_size = positive_int(inp.limit, DEFAULT_PAGE_SIZE)
    overlap_seconds = max(int(inp.watermark_overlap_seconds), 0)
    max_pages = max(
        int(inp.max_pages_per_run),
        positive_int(os.getenv("GOOGLE_CHAT_MAX_PAGES_PER_RUN"), DEFAULT_MAX_PAGES_PER_RUN)
        if inp.max_pages_per_run == DEFAULT_MAX_PAGES_PER_RUN
        else 0,
    )
    explicit_since = _parse_datetime(inp.since)
    run_id = _workflow_run_id_to_sync_run_id(ctx.run_id)
    include_types = _include_space_types()
    # Pinned spaces come from the input, falling back to GOOGLE_CHAT_SPACE_IDS
    # (comma-separated) so scheduled runs — which pass no input — still cover the
    # spaces the app reads but is not a listed member of.
    explicit_space_ids = {sid.strip() for sid in inp.space_ids if sid.strip()}
    if not explicit_space_ids:
        explicit_space_ids = {
            sid.strip()
            for sid in (os.getenv("GOOGLE_CHAT_SPACE_IDS") or "").split(",")
            if sid.strip()
        }

    # Record the run before any Chat call so an enumeration failure (auth,
    # blocked egress) lands in the ledger instead of disappearing silently.
    await _record_run_start(
        ctx._pool,
        run_id=run_id,
        workflow_run_id=ctx.run_id,
        scopes_requested=[],
        metadata={**inp.metadata, "page_size": page_size, "max_pages": max_pages},
    )

    client = _client()

    spaces: list[dict[str, Any]] = []

    # Pinned spaces: sync them directly without spaces.list. An app only appears
    # in spaces.list for spaces it is a formal *member* of; it can still read
    # message history (with chat.app.messages.readonly) in spaces it was added to
    # or @mentioned in. Pinning lets the ETL cover those without membership.
    if explicit_space_ids:
        spaces = [
            {"name": f"spaces/{sid}", "type": "SPACE"}
            for sid in sorted(explicit_space_ids)
        ]

    # Otherwise enumerate the member spaces the app can see (filtered to types).
    page_token: str | None = None
    try:
        while not explicit_space_ids:
            page = client.list_spaces(page_size=DEFAULT_PAGE_SIZE, page_token=page_token)
            for space in page.get("spaces", []):
                if not isinstance(space, dict):
                    continue
                space_id = _resource_id(str(space.get("name") or ""))
                if not space_id:
                    continue
                if explicit_space_ids and space_id not in explicit_space_ids:
                    continue
                space_type = str(space.get("type") or space.get("spaceType") or "").upper()
                if (
                    not explicit_space_ids
                    and include_types
                    and space_type not in include_types
                ):
                    continue
                spaces.append(space)
            page_token = page.get("nextPageToken")
            if not page_token:
                break
    except Exception as exc:
        error = str(exc)
        record_etl_items_failed("google_chat", "message", "spaces", "api_error")
        await _record_run_finish(
            ctx._pool,
            run_id=run_id,
            status="failed",
            scopes_synced=[],
            scopes_failed=[],
            counts={"spaces_seen": 0, "spaces_synced": 0, "messages_seen": 0, "messages_upserted": 0},
            error_text=f"list_spaces failed: {error}",
        )
        ctx.log("google_chat_sync_list_spaces_failed", error=error)
        return {"status": "failed", "run_id": run_id, "error": error}

    counts = {
        "spaces_seen": len(spaces),
        "spaces_synced": 0,
        "messages_seen": 0,
        "messages_upserted": 0,
    }
    synced: list[dict[str, str]] = []
    failed: list[dict[str, str]] = []

    for space in spaces:
        space_id = _resource_id(str(space.get("name") or ""))
        try:
            watermark = await _sync_space(
                ctx._pool,
                client=client,
                space=space,
                run_id=run_id,
                page_size=page_size,
                overlap_seconds=overlap_seconds,
                max_pages=max_pages,
                explicit_since=explicit_since,
                counts=counts,
            )
            counts["spaces_synced"] += 1
            synced.append(_scope_ref(space_id))
            ctx.log(
                "google_chat_sync_space_completed",
                space_id=space_id,
                messages_seen=counts["messages_seen"],
                messages_upserted=counts["messages_upserted"],
                watermark=_rfc3339(watermark) if watermark else "",
            )
        except Exception as exc:
            error = str(exc)
            failed.append(_scope_ref(space_id, error))
            record_etl_items_failed(
                "google_chat",
                "message",
                "space",
                "permission_error"
                if "403" in error or "permission" in error.lower()
                else "api_error",
            )
            await _update_checkpoint_failure(
                ctx._pool, space_id=space_id, run_id=run_id, error=error
            )
            ctx.log("google_chat_sync_space_failed", space_id=space_id, error=error)

    status = "completed"
    error_text = ""
    if failed and synced:
        status = "partial_failed"
        error_text = f"{len(failed)} Chat space(s) failed"
    elif failed:
        status = "failed"
        error_text = f"{len(failed)} Chat space(s) failed"

    await _record_run_finish(
        ctx._pool,
        run_id=run_id,
        status=status,
        scopes_synced=synced,
        scopes_failed=failed,
        counts=counts,
        error_text=error_text,
    )

    return {
        "status": status,
        "run_id": run_id,
        "spaces_synced": len(synced),
        "spaces_failed": len(failed),
        **counts,
    }

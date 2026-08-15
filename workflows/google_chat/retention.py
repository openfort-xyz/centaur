"""Prune Centaur-derived Google Chat ETL rows; never mutates Google Chat."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

from api.workflow_engine import WorkflowContext
from workflows.google_chat.metrics import record_retention
from workflows.slack.shared import env_flag_enabled, positive_int

WORKFLOW_NAME = "google_chat_retention"
DEFAULT_INTERVAL_MINUTES = 60
DEFAULT_BATCH_LIMIT = 1_000


def _nonnegative_int(value: int | str | None, default: int = 0) -> int:
    try:
        parsed = int(value) if value is not None else default
    except (TypeError, ValueError):
        return default
    return parsed if parsed >= 0 else default


def _configured_days() -> int:
    return _nonnegative_int(os.getenv("GOOGLE_CHAT_RETENTION_DAYS"))


def _configured_batch_limit() -> int:
    return positive_int(
        os.getenv("GOOGLE_CHAT_RETENTION_BATCH_LIMIT"), DEFAULT_BATCH_LIMIT
    )


SCHEDULE = {
    "schedule_id": WORKFLOW_NAME,
    "interval_seconds": positive_int(
        os.getenv("GOOGLE_CHAT_RETENTION_INTERVAL_MINUTES"), DEFAULT_INTERVAL_MINUTES
    )
    * 60,
    "enabled": env_flag_enabled("GOOGLE_CHAT_RETENTION_ENABLED", default=True)
    and _configured_days() > 0,
    "no_delivery": True,
}


@dataclass
class Input:
    retention_days: int | None = None
    mode: str = "delete"
    batch_limit: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


_TARGETS = (
    (
        "documents",
        "company_context_documents",
        "source = 'google_chat' AND occurred_at < NOW() - make_interval(days => $1)",
    ),
    (
        "attachments",
        "google_chat_sync_attachments",
        "updated_at < NOW() - make_interval(days => $1)",
    ),
    (
        "reactions",
        "google_chat_sync_reactions",
        "updated_at < NOW() - make_interval(days => $1)",
    ),
    (
        "messages",
        "google_chat_sync_messages",
        "COALESCE(source_create_time, updated_at) < NOW() - make_interval(days => $1)",
    ),
    (
        "checkpoints",
        "google_chat_sync_checkpoints",
        "continuation_token = '' AND updated_at < NOW() - make_interval(days => $1)",
    ),
    (
        "spaces",
        "google_chat_sync_spaces s",
        "s.last_seen_at < NOW() - make_interval(days => $1) "
        "AND NOT EXISTS (SELECT 1 FROM google_chat_sync_messages m "
        "WHERE m.owner_email=s.owner_email AND m.space_id=s.space_id) "
        "AND NOT EXISTS (SELECT 1 FROM google_chat_sync_checkpoints c "
        "WHERE c.owner_email=s.owner_email AND c.space_id=s.space_id)",
    ),
    (
        "runs",
        "google_chat_sync_runs",
        "status <> 'running' AND COALESCE(finished_at, started_at) "
        "< NOW() - make_interval(days => $1)",
    ),
)


async def prune_google_chat(
    pool, *, retention_days: int, mode: str, batch_limit: int
) -> dict[str, int]:
    if mode not in {"dry_run", "count", "delete"}:
        raise ValueError("mode must be dry_run, count, or delete")
    if retention_days <= 0:
        return {name: 0 for name, _, _ in _TARGETS}
    limit = max(int(batch_limit), 1)
    counts: dict[str, int] = {}
    for name, table, predicate in _TARGETS:
        if mode == "delete":
            sql = (
                f"WITH candidates AS (SELECT ctid FROM {table} WHERE {predicate} LIMIT $2), "
                f"deleted AS (DELETE FROM {table.split()[0]} WHERE ctid IN "
                "(SELECT ctid FROM candidates) RETURNING 1) SELECT COUNT(*) FROM deleted"
            )
            value = await pool.fetchval(sql, retention_days, limit)
        else:
            value = await pool.fetchval(
                f"SELECT COUNT(*) FROM (SELECT 1 FROM {table} WHERE {predicate} LIMIT $2) rows",
                retention_days,
                limit,
            )
        counts[name] = int(value or 0)
        record_retention(mode, name, counts[name])
    return counts


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    days = (
        _nonnegative_int(inp.retention_days)
        if inp.retention_days is not None
        else _configured_days()
    )
    counts = await prune_google_chat(
        ctx._pool,
        retention_days=days,
        mode=inp.mode,
        batch_limit=(
            positive_int(inp.batch_limit, DEFAULT_BATCH_LIMIT)
            if inp.batch_limit is not None
            else _configured_batch_limit()
        ),
    )
    return {
        "ok": True,
        "mode": inp.mode,
        "retention_days": days,
        "counts": counts,
        "metadata": inp.metadata,
    }

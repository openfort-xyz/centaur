from __future__ import annotations

from api.metrics import increment_metric, observe_histogram, set_gauge

_DURATION_BUCKETS = [1, 5, 10, 30, 60, 120, 300, 600, 1_200]
_OUTCOMES = {"success", "error", "rate_limited"}
_STATUSES = {"started", "completed", "partial_failed", "failed", "skipped"}
_FAILURE_REASONS = {"api_error", "permission_error", "rate_limited"}
_OPERATIONS = {"list_spaces", "list_dm_spaces", "list_messages", "list_reactions"}


def _bounded(value: str, allowed: set[str], fallback: str) -> str:
    return value if value in allowed else fallback


def record_run(status: str, count: int = 1) -> None:
    increment_metric(
        "google_chat_etl_runs_total",
        count,
        status=_bounded(status, _STATUSES, "failed"),
    )


def observe_run_duration(status: str, duration_s: float) -> None:
    observe_histogram(
        "google_chat_etl_run_duration_seconds",
        max(float(duration_s), 0.0),
        _DURATION_BUCKETS,
        status=_bounded(status, _STATUSES, "failed"),
    )


def record_api_outcome(operation: str, outcome: str, count: int = 1) -> None:
    increment_metric(
        "google_chat_etl_api_requests_total",
        count,
        operation=_bounded(operation, _OPERATIONS, "list_messages"),
        outcome=_bounded(outcome, _OUTCOMES, "error"),
    )
    if outcome == "rate_limited":
        increment_metric(
            "google_chat_etl_rate_limits_total",
            count,
            operation=_bounded(operation, _OPERATIONS, "list_messages"),
        )


def record_items(item_type: str, count: int) -> None:
    increment_metric(
        "google_chat_etl_items_processed_total",
        max(int(count), 0),
        item_type=item_type if item_type in {"message", "file", "reaction"} else "message",
    )


def record_space_failure(reason: str, count: int = 1) -> None:
    increment_metric(
        "google_chat_etl_space_failures_total",
        count,
        reason=_bounded(reason, _FAILURE_REASONS, "api_error"),
    )


def set_continuation_age(age_s: float) -> None:
    set_gauge("google_chat_etl_continuation_age_seconds", max(float(age_s), 0.0))


def set_watermark_lag(lag_s: float) -> None:
    set_gauge("google_chat_etl_watermark_lag_seconds", max(float(lag_s), 0.0))


def set_failed_spaces(count: int) -> None:
    set_gauge("google_chat_etl_failed_spaces", max(int(count), 0))


def set_last_failure_time(timestamp_s: float) -> None:
    set_gauge(
        "google_chat_etl_last_failure_timestamp_seconds",
        max(float(timestamp_s), 0.0),
    )


def record_retention(mode: str, item_type: str, count: int) -> None:
    increment_metric(
        "google_chat_retention_items_total",
        max(int(count), 0),
        mode=mode if mode in {"dry_run", "count", "delete"} else "count",
        item_type=item_type
        if item_type
        in {"documents", "attachments", "reactions", "messages", "checkpoints", "spaces", "runs"}
        else "messages",
    )

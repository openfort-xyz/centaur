"""Workflow: sync Google Chat space history into Postgres.

Mirrors the Slack ETL: enumerate spaces the Chat app is a member of, then page
each space's message history into raw ``google_chat_sync_*`` tables. Scheduled
runs rescan history because Chat's list filter is based on ``createTime`` and
cannot select old messages edited later. Explicit manual ``since`` runs remain
bounded by a per-space watermark. A page budget persists continuation tokens so
large scans converge across several runs.

Reads shared spaces as the Chat app through iron-proxy. Optional DM reads cross
the WorkflowContext RPC to api-rs and then googlechatbot, which alone holds the
DWD service-account credential.
"""

from __future__ import annotations

import datetime as dt
import inspect
import os
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

from api.runtime_control import canonical_json
from workflows.etl_metrics import (
    record_etl_items_failed,
    record_etl_items_seen,
    record_etl_items_upserted,
)
from workflows.google_chat.metrics import (
    observe_run_duration,
    record_api_outcome,
    record_items,
    record_run,
    record_space_failure,
    set_continuation_age,
    set_failed_spaces,
    set_last_failure_time,
    set_watermark_lag,
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
# Reclaim runs orphaned in `running` by a dead workflow host after this long.
# Must exceed the longest plausible run (~1h, bounded by the queue claim lease)
# and stay under DEFAULT_SYNC_INTERVAL_SECONDS so the next run does the cleanup.
RUN_STALE_RUNNING_HOURS = 3


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
    dm_subjects: list[str] = field(default_factory=list)
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
        show_deleted: bool = False,
    ) -> dict[str, Any]: ...

    def list_members(
        self, space_name: str, *, page_size: int, page_token: str | None = None
    ) -> dict[str, Any]: ...

    def list_reactions(
        self,
        message_name: str,
        *,
        page_size: int,
        page_token: str | None = None,
    ) -> dict[str, Any]: ...


def _client(ctx: WorkflowContext) -> GoogleChatSyncClient:
    from workflows.google_chat.client import GoogleChatReadonlyClient

    return GoogleChatReadonlyClient(ctx)


def _delegated_client(ctx: WorkflowContext, subject: str) -> GoogleChatSyncClient:
    from workflows.google_chat.client import GoogleChatDelegatedClient

    return GoogleChatDelegatedClient(ctx, subject)


async def _call_client(method: Any, *args: Any, **kwargs: Any) -> dict[str, Any]:
    result = method(*args, **kwargs)
    if inspect.isawaitable(result):
        result = await result
    return result if isinstance(result, dict) else {}


def _dm_subject_allowlist() -> set[str]:
    if not env_flag_enabled("GOOGLE_CHAT_DWD_DM_SYNC_ENABLED", default=False):
        return set()
    return {
        value.strip().lower()
        for value in (os.getenv("GOOGLE_CHAT_DWD_DM_SUBJECTS") or "").split(",")
        if value.strip()
    }


def _selected_dm_subjects(requested: list[str]) -> list[str]:
    allowlisted = _dm_subject_allowlist()
    selected = {value.strip().lower() for value in requested if value.strip()}
    return sorted(allowlisted & selected if selected else allowlisted)


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


def _resource_id(resource_name: str) -> str:
    return resource_name.rsplit("/", 1)[-1] if resource_name else ""


def _space_type(space: dict[str, Any]) -> str:
    value = str(space.get("spaceType") or space.get("type") or "").upper()
    return {"ROOM": "SPACE", "DM": "DIRECT_MESSAGE"}.get(value, value)


def _workflow_run_id_to_sync_run_id(workflow_run_id: str) -> str:
    safe = "".join(char if char.isalnum() else "_" for char in workflow_run_id)
    return f"google_chat_sync_{safe}"


def _scope_ref(space_id: str, reason: str | None = None) -> dict[str, str]:
    result = {"space_id": space_id}
    if reason:
        result["reason"] = reason
    return result


def _error_status(error: Exception) -> int | None:
    """HTTP status of a `GoogleChatApiError`, or None for a transport failure."""
    status = getattr(error, "status", None)
    return status if isinstance(status, int) else None


def _error_kind(error: Exception) -> str:
    """Classify a Chat failure into a `_FAILURE_REASONS` label.

    Prefers the HTTP status carried by `GoogleChatApiError`; the string sniffing
    is only a fallback for transport errors (timeouts, DNS) that never got one.
    """
    status = _error_status(error)
    if status is not None:
        return {429: "rate_limited", 403: "permission_error"}.get(status, "api_error")
    message = str(error).lower()
    if "rate limit" in message:
        return "rate_limited"
    if "permission" in message or "denied" in message:
        return "permission_error"
    return "api_error"


def _safe_error(error: Exception) -> str:
    """Operator-facing failure text with no URL, token or response body in it."""
    kind = _error_kind(error)
    if kind == "rate_limited":
        return "Google Chat API rate limited"
    if kind == "permission_error":
        return "Google Chat API permission denied"
    status = _error_status(error)
    # Without this the generic bucket is undiagnosable: every 4xx, 5xx and
    # timeout collapses into one string with nothing left to tell them apart.
    detail = f"HTTP {status}" if status is not None else type(error).__name__
    return f"Google Chat API request failed ({detail})"


def _card_fallback_text(message: dict[str, Any]) -> str:
    """Plain-text stand-in for app messages whose content lives in cards.

    Chat apps (GitHub, alerting integrations, our own bots) often post with an
    empty top-level `text` and put everything in `cardsV2` (or deprecated
    `cards`) widgets — the Chat analogue of Slack's legacy attachment-only app
    messages (upstream #887). Collect documented rendered/default/accessibility
    strings so the message is captured instead of dropped.
    """
    parts: list[str] = []

    def _push(value: Any) -> None:
        if isinstance(value, str) and (value := value.strip()):
            parts.append(value)

    def _push_fields(value: Any, fields: tuple[str, ...]) -> None:
        if isinstance(value, dict):
            for field in fields:
                _push(value.get(field))

    def _collect_icon(value: Any) -> None:
        if isinstance(value, dict):
            _push(value.get("altText"))

    def _collect_text_paragraph(value: Any) -> None:
        if isinstance(value, dict):
            _push(value.get("text"))

    def _collect_on_click(value: Any) -> None:
        if not isinstance(value, dict):
            return
        menu = value.get("overflowMenu")
        if not isinstance(menu, dict) or not isinstance(menu.get("items"), list):
            return
        for item in menu["items"]:
            if isinstance(item, dict):
                _collect_icon(item.get("startIcon"))
                _push(item.get("text"))

    def _collect_button(value: Any) -> None:
        if not isinstance(value, dict):
            return
        _push(value.get("text"))
        _collect_icon(value.get("icon"))
        _push(value.get("altText"))
        _collect_on_click(value.get("onClick"))

    def _collect_buttons(value: Any) -> None:
        if isinstance(value, dict) and isinstance(value.get("buttons"), list):
            for button in value["buttons"]:
                _collect_button(button)

    def _collect_widgets(widgets: Any) -> None:
        if not isinstance(widgets, list):
            return
        for widget in widgets:
            if not isinstance(widget, dict):
                continue
            _collect_text_paragraph(widget.get("textParagraph"))
            image = widget.get("image")
            if isinstance(image, dict):
                _push(image.get("altText"))
                _collect_on_click(image.get("onClick"))

            decorated = widget.get("decoratedText")
            if isinstance(decorated, dict):
                _collect_icon(decorated.get("icon"))
                _collect_icon(decorated.get("startIcon"))
                _push(decorated.get("topLabel"))
                _collect_text_paragraph(decorated.get("topLabelText"))
                _push(decorated.get("text"))
                _collect_text_paragraph(decorated.get("contentText"))
                _push(decorated.get("bottomLabel"))
                _collect_text_paragraph(decorated.get("bottomLabelText"))
                _collect_button(decorated.get("button"))
                _collect_icon(decorated.get("endIcon"))
                _collect_on_click(decorated.get("onClick"))

            _collect_buttons(widget.get("buttonList"))

            text_input = widget.get("textInput")
            if isinstance(text_input, dict):
                _push_fields(
                    text_input, ("label", "value", "hintText", "placeholderText")
                )
                suggestions = text_input.get("initialSuggestions")
                if isinstance(suggestions, dict) and isinstance(
                    suggestions.get("items"), list
                ):
                    for item in suggestions["items"]:
                        if isinstance(item, dict):
                            _push(item.get("text"))

            selection = widget.get("selectionInput")
            if isinstance(selection, dict):
                _push_fields(selection, ("label", "hintText"))
                if isinstance(selection.get("items"), list):
                    for item in selection["items"]:
                        _push_fields(item, ("text", "bottomText"))

            _push_fields(widget.get("dateTimePicker"), ("label", "valueMsEpoch"))

            grid = widget.get("grid")
            if isinstance(grid, dict):
                _push(grid.get("title"))
                if isinstance(grid.get("items"), list):
                    for item in grid["items"]:
                        if not isinstance(item, dict):
                            continue
                        _push_fields(item, ("title", "subtitle"))
                        _collect_icon(item.get("image"))
                _collect_on_click(grid.get("onClick"))

            columns = widget.get("columns")
            if isinstance(columns, dict):
                for item in columns.get("columnItems") or []:
                    if isinstance(item, dict):
                        _collect_widgets(item.get("widgets"))

            carousel = widget.get("carousel")
            if isinstance(carousel, dict):
                for card in carousel.get("carouselCards") or []:
                    if isinstance(card, dict):
                        _collect_widgets(card.get("widgets"))
                        _collect_widgets(card.get("footerWidgets"))

            chip_list = widget.get("chipList")
            if isinstance(chip_list, dict):
                for chip in chip_list.get("chips") or []:
                    if not isinstance(chip, dict):
                        continue
                    _push(chip.get("label"))
                    _collect_icon(chip.get("icon"))
                    _push(chip.get("altText"))
                    _collect_on_click(chip.get("onClick"))

    def _collect_header(value: Any) -> None:
        if not isinstance(value, dict):
            return
        title = str(value.get("title") or "").strip()
        subtitle = str(value.get("subtitle") or "").strip()
        joined = " — ".join(piece for piece in (title, subtitle) if piece)
        if joined:
            parts.append(joined)
        _push(value.get("imageAltText"))

    def _collect_card(card: Any) -> None:
        if not isinstance(card, dict):
            return
        _collect_header(card.get("header"))
        _collect_header(card.get("peekCardHeader"))
        for action in card.get("cardActions") or []:
            if isinstance(action, dict):
                _push(action.get("actionLabel"))
        for section in card.get("sections") or []:
            if not isinstance(section, dict):
                continue
            _push(section.get("header"))
            collapse = section.get("collapseControl")
            if isinstance(collapse, dict):
                _collect_button(collapse.get("expandButton"))
                _collect_button(collapse.get("collapseButton"))
            _collect_widgets(section.get("widgets"))
        footer = card.get("fixedFooter")
        if isinstance(footer, dict):
            _collect_button(footer.get("primaryButton"))
            _collect_button(footer.get("secondaryButton"))

    def _collect_legacy_button(value: Any) -> None:
        if not isinstance(value, dict):
            return
        text_button = value.get("textButton")
        image_button = value.get("imageButton")
        if isinstance(text_button, dict):
            _push(text_button.get("text"))
        if isinstance(image_button, dict):
            _push(image_button.get("name"))

    def _collect_legacy_card(card: Any) -> None:
        if not isinstance(card, dict):
            return
        _collect_header(card.get("header"))
        for action in card.get("cardActions") or []:
            if isinstance(action, dict):
                _push(action.get("actionLabel"))
        for section in card.get("sections") or []:
            if not isinstance(section, dict):
                continue
            _push(section.get("header"))
            for widget in section.get("widgets") or []:
                if not isinstance(widget, dict):
                    continue
                _collect_text_paragraph(widget.get("textParagraph"))
                key_value = widget.get("keyValue")
                if isinstance(key_value, dict):
                    _push_fields(key_value, ("topLabel", "content", "bottomLabel"))
                    _collect_legacy_button(key_value.get("button"))
                for button in widget.get("buttons") or []:
                    _collect_legacy_button(button)

    for entry in message.get("cardsV2") or []:
        if not isinstance(entry, dict):
            continue
        _collect_card(entry.get("card"))
    for card in message.get("cards") or []:
        _collect_legacy_card(card)
    return "\n".join(parts)


def _message_text(message: dict[str, Any]) -> str:
    text = str(
        message.get("text")
        or message.get("formattedText")
        or message.get("fallbackText")
        or ""
    ).strip()
    if text:
        return text
    card_text = _card_fallback_text(message).strip()
    if card_text:
        return card_text
    return "\n".join(
        str(gif.get("uri") or "").strip()
        for gif in message.get("attachedGifs") or []
        if isinstance(gif, dict) and str(gif.get("uri") or "").strip()
    )


async def _member_directory(
    client: GoogleChatSyncClient, space_name: str
) -> dict[str, str]:
    """Return canonical-user display names; Chat membership resources expose no email."""
    names: dict[str, str] = {}
    page_token: str | None = None
    try:
        while True:
            page = await _call_client(
                client.list_members,
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


async def _load_checkpoint(
    pool, space_id: str, owner_email: str = ""
) -> dict[str, Any] | None:
    row = await pool.fetchrow(
        "SELECT watermark_time, last_error, continuation_token, "
        "continuation_filter, continuation_started_at, continuation_updated_at "
        "FROM google_chat_sync_checkpoints WHERE owner_email = $1 AND space_id = $2",
        owner_email,
        space_id,
    )
    return dict(row) if row else None


async def _update_checkpoint_success(
    pool,
    *,
    space_id: str,
    owner_email: str,
    watermark_time: dt.datetime | None,
    run_id: str,
    continuation_token: str = "",
    continuation_filter: str = "",
    continuation_started_at: dt.datetime | None = None,
) -> None:
    await pool.execute(
        "INSERT INTO google_chat_sync_checkpoints ("
        "owner_email, space_id, watermark_time, last_run_id, last_success_at, last_error, "
        "continuation_token, continuation_filter, continuation_started_at, "
        "continuation_updated_at, updated_at"
        ") VALUES ($1, $2, $3, $4, NOW(), '', $5, $6, $7, "
        "CASE WHEN $5 = '' THEN NULL ELSE NOW() END, NOW()) "
        "ON CONFLICT (owner_email, space_id) DO UPDATE SET "
        "watermark_time = COALESCE(EXCLUDED.watermark_time, google_chat_sync_checkpoints.watermark_time), "
        "last_run_id = EXCLUDED.last_run_id, "
        "last_success_at = NOW(), "
        "last_error = '', "
        "continuation_token = EXCLUDED.continuation_token, "
        "continuation_filter = EXCLUDED.continuation_filter, "
        "continuation_started_at = EXCLUDED.continuation_started_at, "
        "continuation_updated_at = EXCLUDED.continuation_updated_at, "
        "updated_at = NOW()",
        owner_email,
        space_id,
        watermark_time,
        run_id,
        continuation_token,
        continuation_filter,
        continuation_started_at,
    )


async def _update_checkpoint_failure(
    pool, *, space_id: str, owner_email: str, run_id: str, error: str
) -> None:
    await pool.execute(
        "INSERT INTO google_chat_sync_checkpoints ("
        "owner_email, space_id, last_run_id, last_error, updated_at"
        ") VALUES ($1, $2, $3, $4, NOW()) "
        "ON CONFLICT (owner_email, space_id) DO UPDATE SET "
        "last_run_id = EXCLUDED.last_run_id, "
        "last_error = EXCLUDED.last_error, "
        "updated_at = NOW()",
        owner_email,
        space_id,
        run_id,
        error,
    )


async def _reap_abandoned_runs(pool) -> None:
    """Close runs the workflow host died inside of, mirroring Slack backfill jobs.

    A run row is written before the first API call and updated at the end, so a
    host that dies mid-run strands it in `running` forever — no `except` is left
    to run. A broken-pipe stretch on 2026-08-17 piled up 25 such rows. Nothing
    else touches this table, so the next run reclaims them.
    """
    await pool.execute(
        "UPDATE google_chat_sync_runs SET "
        "status = 'failed', finished_at = NOW(), "
        "error_text = 'run abandoned: workflow host exited before finishing' "
        "WHERE status = 'running' AND started_at < "
        f"NOW() - INTERVAL '{RUN_STALE_RUNNING_HOURS} hours'"
    )


async def _record_run_start(
    pool,
    *,
    run_id: str,
    workflow_run_id: str,
    metadata: dict[str, Any],
) -> None:
    await _reap_abandoned_runs(pool)
    await pool.execute(
        "INSERT INTO google_chat_sync_runs ("
        "run_id, workflow_run_id, mode, status, scopes_requested, metadata"
        ") VALUES ($1, $2, 'incremental', 'running', '[]'::jsonb, $3::jsonb) "
        "ON CONFLICT (run_id) DO UPDATE SET "
        "workflow_run_id = EXCLUDED.workflow_run_id, "
        "status = 'running', "
        "scopes_requested = '[]'::jsonb, "
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


async def _upsert_space(
    pool,
    *,
    space: dict[str, Any],
    run_id: str,
    owner_email: str = "",
    participant_emails: list[str] | None = None,
) -> str:
    space_id = _resource_id(str(space.get("name") or ""))
    await pool.execute(
        "INSERT INTO google_chat_sync_spaces ("
        "owner_email, space_id, space_name, display_name, space_type, participant_emails, "
        "raw_payload, source_run_id, last_seen_at, last_error, updated_at"
        ") VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW(), '', NOW()) "
        "ON CONFLICT (owner_email, space_id) DO UPDATE SET "
        "space_name = EXCLUDED.space_name, "
        "display_name = EXCLUDED.display_name, "
        "space_type = EXCLUDED.space_type, "
        "participant_emails = EXCLUDED.participant_emails, "
        "raw_payload = EXCLUDED.raw_payload, "
        "source_run_id = EXCLUDED.source_run_id, "
        "last_seen_at = NOW(), "
        "last_error = '', "
        "updated_at = NOW()",
        owner_email,
        space_id,
        str(space.get("name") or ""),
        str(space.get("displayName") or ""),
        _space_type(space),
        participant_emails or [],
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
    owner_email: str = "",
) -> bool:
    message_name = str(message.get("name") or "")
    message_id = _resource_id(message_name)
    if not message_id:
        return False
    text = _message_text(message)
    if not text and not message.get("attachment"):
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
        "owner_email, space_id, message_id, message_name, thread_id, sender_id, sender_name, "
        "sender_type, text_content, source_create_time, "
        "source_last_update_time, raw_payload, source_run_id, last_seen_at, "
        "last_error, updated_at"
        ") VALUES ("
        "$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, NOW(), '', NOW()"
        ") ON CONFLICT (owner_email, space_id, message_id) DO UPDATE SET "
        "message_name = EXCLUDED.message_name, "
        "thread_id = EXCLUDED.thread_id, "
        "sender_id = EXCLUDED.sender_id, "
        "sender_name = EXCLUDED.sender_name, "
        "sender_type = EXCLUDED.sender_type, "
        "text_content = EXCLUDED.text_content, "
        "source_create_time = EXCLUDED.source_create_time, "
        "source_last_update_time = EXCLUDED.source_last_update_time, "
        "raw_payload = EXCLUDED.raw_payload, "
        "source_run_id = EXCLUDED.source_run_id, "
        "last_seen_at = NOW(), "
        "last_error = '', "
        "updated_at = CASE WHEN google_chat_sync_messages.raw_payload "
        "IS DISTINCT FROM EXCLUDED.raw_payload "
        "THEN NOW() ELSE google_chat_sync_messages.updated_at END",
        owner_email,
        space_id,
        message_id,
        message_name,
        thread_id,
        sender_id,
        sender_name,
        sender_type,
        text,
        create_time,
        last_update_time,
        canonical_json(message),
        run_id,
    )
    return True


async def _replace_attachments(
    pool,
    *,
    owner_email: str,
    space_id: str,
    message_id: str,
    message: dict[str, Any],
    run_id: str,
) -> int:
    attachment_ids: list[str] = []
    for index, attachment in enumerate(message.get("attachment") or []):
        if not isinstance(attachment, dict):
            continue
        data_ref = attachment.get("attachmentDataRef")
        drive_ref = attachment.get("driveDataRef")
        data_ref = data_ref if isinstance(data_ref, dict) else {}
        drive_ref = drive_ref if isinstance(drive_ref, dict) else {}
        attachment_name = str(attachment.get("name") or data_ref.get("resourceName") or "")
        attachment_id = (
            _resource_id(attachment_name)
            or str(drive_ref.get("driveFileId") or "")
            or f"attachment-{index}"
        )
        attachment_ids.append(attachment_id)
        await pool.execute(
            "INSERT INTO google_chat_sync_attachments ("
            "owner_email, space_id, message_id, attachment_id, attachment_name, "
            "content_name, content_type, source_uri, download_uri, size_bytes, "
            "content_text, raw_payload, source_run_id, last_seen_at, updated_at"
            ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,NOW(),NOW()) "
            "ON CONFLICT (owner_email, space_id, message_id, attachment_id) DO UPDATE SET "
            "attachment_name=EXCLUDED.attachment_name, content_name=EXCLUDED.content_name, "
            "content_type=EXCLUDED.content_type, source_uri=EXCLUDED.source_uri, "
            "download_uri=EXCLUDED.download_uri, size_bytes=EXCLUDED.size_bytes, "
            "content_text=EXCLUDED.content_text, raw_payload=EXCLUDED.raw_payload, "
            "source_run_id=EXCLUDED.source_run_id, last_seen_at=NOW(), updated_at=NOW()",
            owner_email,
            space_id,
            message_id,
            attachment_id,
            attachment_name,
            str(attachment.get("contentName") or ""),
            str(attachment.get("contentType") or ""),
            "",
            str(attachment.get("downloadUri") or ""),
            None,
            "",
            canonical_json(attachment),
            run_id,
        )
    await pool.execute(
        "DELETE FROM google_chat_sync_attachments WHERE owner_email=$1 AND space_id=$2 "
        "AND message_id=$3 AND NOT (attachment_id = ANY($4::text[]))",
        owner_email,
        space_id,
        message_id,
        attachment_ids,
    )
    return len(attachment_ids)


async def _replace_reactions(
    pool,
    *,
    client: GoogleChatSyncClient,
    owner_email: str,
    space_id: str,
    message_id: str,
    message_name: str,
    run_id: str,
) -> int:
    reaction_ids: list[str] = []
    page_token: str | None = None
    while True:
        page = await _call_client(
            client.list_reactions,
            message_name, page_size=DEFAULT_PAGE_SIZE, page_token=page_token
        )
        for reaction in page.get("emojiReactions") or page.get("reactions") or []:
            if not isinstance(reaction, dict):
                continue
            reaction_name = str(reaction.get("name") or "")
            user = reaction.get("user") if isinstance(reaction.get("user"), dict) else {}
            emoji = reaction.get("emoji") if isinstance(reaction.get("emoji"), dict) else {}
            custom = emoji.get("customEmoji") if isinstance(emoji.get("customEmoji"), dict) else {}
            reaction_id = _resource_id(reaction_name)
            if not reaction_id:
                continue
            reaction_ids.append(reaction_id)
            await pool.execute(
                "INSERT INTO google_chat_sync_reactions ("
                "owner_email,space_id,message_id,reaction_id,user_id,emoji_unicode,"
                "custom_emoji_uid,raw_payload,source_run_id,last_seen_at,updated_at"
                ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,NOW(),NOW()) "
                "ON CONFLICT (owner_email,space_id,message_id,reaction_id) DO UPDATE SET "
                "user_id=EXCLUDED.user_id,emoji_unicode=EXCLUDED.emoji_unicode,"
                "custom_emoji_uid=EXCLUDED.custom_emoji_uid,raw_payload=EXCLUDED.raw_payload,"
                "source_run_id=EXCLUDED.source_run_id,last_seen_at=NOW(),updated_at=NOW()",
                owner_email,
                space_id,
                message_id,
                reaction_id,
                str(user.get("name") or ""),
                str(emoji.get("unicode") or ""),
                str(custom.get("uid") or ""),
                canonical_json(reaction),
                run_id,
            )
        page_token = page.get("nextPageToken")
        if not page_token:
            break
    await pool.execute(
        "DELETE FROM google_chat_sync_reactions WHERE owner_email=$1 AND space_id=$2 "
        "AND message_id=$3 AND NOT (reaction_id = ANY($4::text[]))",
        owner_email,
        space_id,
        message_id,
        reaction_ids,
    )
    return len(reaction_ids)


async def _delete_message(
    pool, *, owner_email: str, space_id: str, message_id: str
) -> None:
    """Remove retained content when a showDeleted tombstone arrives."""
    for table in ("google_chat_sync_attachments", "google_chat_sync_reactions"):
        await pool.execute(
            f"DELETE FROM {table} WHERE owner_email=$1 AND space_id=$2 AND message_id=$3",
            owner_email,
            space_id,
            message_id,
        )
    await pool.execute(
        "DELETE FROM google_chat_sync_messages "
        "WHERE owner_email=$1 AND space_id=$2 AND message_id=$3",
        owner_email,
        space_id,
        message_id,
    )


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
    owner_email: str = "",
) -> dt.datetime | None:
    """Page one space's messages into the sync tables; return its new watermark."""
    space_id = _resource_id(str(space.get("name") or ""))
    space_name = str(space.get("name") or f"spaces/{space_id}")
    member_names = await _member_directory(client, space_name)
    await _upsert_space(
        pool,
        space=space,
        run_id=run_id,
        owner_email=owner_email,
        # Google exposes the verified delegated owner email, but not other
        # members' emails. Canonical member names remain in message sender IDs.
        participant_emails=[owner_email] if owner_email else [],
    )

    checkpoint = await _load_checkpoint(pool, space_id, owner_email)
    checkpoint_watermark: dt.datetime | None = None
    if checkpoint and checkpoint.get("watermark_time"):
        checkpoint_watermark = checkpoint["watermark_time"].astimezone(dt.timezone.utc)
    stored_token = str((checkpoint or {}).get("continuation_token") or "")
    stored_filter = str((checkpoint or {}).get("continuation_filter") or "")
    continuation_started_at = (checkpoint or {}).get("continuation_started_at")
    watermark = explicit_since if explicit_since is not None else checkpoint_watermark
    effective = watermark - dt.timedelta(seconds=overlap_seconds) if watermark else None
    # Scheduled runs rescan history so old edits converge; createTime cannot
    # select messages edited after their creation. Explicit `since` remains a
    # bounded manual-backfill option.
    msg_filter = stored_filter if stored_token else (
        f'createTime > "{_rfc3339(effective)}"' if explicit_since and effective else ""
    )

    successful_watermark: dt.datetime | None = None
    page_token: str | None = stored_token or None
    pages = 0
    while True:
        try:
            page = await _call_client(
                client.list_messages,
                space_name,
                page_size=page_size,
                page_token=page_token,
                filter=msg_filter or None,
                show_deleted=True,
            )
            record_api_outcome("list_messages", "success")
        except Exception as exc:
            outcome = "rate_limited" if "429" in str(exc) else "error"
            record_api_outcome("list_messages", outcome)
            raise
        messages = [m for m in page.get("messages", []) if isinstance(m, dict)]
        counts["messages_seen"] += len(messages)
        record_etl_items_seen("google_chat", "message", "message", len(messages))
        record_items("message", len(messages))
        for message in messages:
            message_id = _resource_id(str(message.get("name") or ""))
            if message_id and (message.get("deleteTime") or message.get("deletionMetadata")):
                await _delete_message(
                    pool,
                    owner_email=owner_email,
                    space_id=space_id,
                    message_id=message_id,
                )
                continue
            upserted = await _upsert_message(
                pool,
                space_id=space_id,
                message=message,
                member_names=member_names,
                run_id=run_id,
                owner_email=owner_email,
            )
            if upserted:
                counts["messages_upserted"] += 1
                record_etl_items_upserted("google_chat", "message", "message", 1)
                attachment_count = await _replace_attachments(
                    pool,
                    owner_email=owner_email,
                    space_id=space_id,
                    message_id=message_id,
                    message=message,
                    run_id=run_id,
                )
                reaction_count = await _replace_reactions(
                    pool,
                    client=client,
                    owner_email=owner_email,
                    space_id=space_id,
                    message_id=message_id,
                    message_name=str(message.get("name") or ""),
                    run_id=run_id,
                )
                counts["files_processed"] = counts.get("files_processed", 0) + attachment_count
                counts["reactions_processed"] = (
                    counts.get("reactions_processed", 0) + reaction_count
                )
                record_items("file", attachment_count)
                record_items("reaction", reaction_count)
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

    # Never let the stored watermark regress past the pre-run checkpoint: an
    # explicit `since` re-backfill truncated by max_pages would otherwise pull
    # the checkpoint back into already-synced history (upstream #887 adds the
    # same guard to the Slack sync watermark). COALESCE in the upsert already
    # handles the None case; this handles the "older but not None" case.
    if (
        successful_watermark is not None
        and checkpoint_watermark is not None
        and successful_watermark < checkpoint_watermark
    ):
        successful_watermark = checkpoint_watermark
    continuing = bool(page_token)
    if continuing and continuation_started_at is None:
        continuation_started_at = dt.datetime.now(dt.timezone.utc)
    await _update_checkpoint_success(
        pool,
        space_id=space_id,
        owner_email=owner_email,
        watermark_time=successful_watermark,
        run_id=run_id,
        continuation_token=str(page_token or ""),
        continuation_filter=msg_filter if continuing else "",
        continuation_started_at=continuation_started_at if continuing else None,
    )
    if continuing and continuation_started_at:
        set_continuation_age(
            (dt.datetime.now(dt.timezone.utc) - continuation_started_at).total_seconds()
        )
    else:
        set_continuation_age(0)
    final_watermark = successful_watermark or checkpoint_watermark
    if final_watermark:
        set_watermark_lag(
            (dt.datetime.now(dt.timezone.utc) - final_watermark).total_seconds()
        )
    return successful_watermark


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    """Sync Google Chat space history into raw Chat sync tables."""
    started_at = time.monotonic()
    record_run("started")
    if not env_flag_enabled("GOOGLE_CHAT_ETL_ENABLED", default=False):
        ctx.log("google_chat_sync_skipped_disabled")
        record_run("skipped")
        observe_run_duration("skipped", time.monotonic() - started_at)
        return {"status": "skipped", "reason": "google_chat_etl_disabled"}

    page_size = positive_int(inp.limit, DEFAULT_PAGE_SIZE)
    overlap_seconds = max(int(inp.watermark_overlap_seconds), 0)
    max_pages = positive_int(
        inp.max_pages_per_run,
        positive_int(os.getenv("GOOGLE_CHAT_MAX_PAGES_PER_RUN"), DEFAULT_MAX_PAGES_PER_RUN),
    )
    explicit_since = _parse_datetime(inp.since)
    run_id = _workflow_run_id_to_sync_run_id(ctx.run_id)
    include_types = _include_space_types()
    # Pinned spaces come from the input, falling back to GOOGLE_CHAT_SPACE_IDS
    # (comma-separated) so scheduled runs — which pass no input — still cover the
    # known member spaces without relying on spaces.list. _resource_id lets either
    # a bare id or a full "spaces/<id>" resource name be configured.
    explicit_space_ids = {_resource_id(sid.strip()) for sid in inp.space_ids if sid.strip()}
    if not explicit_space_ids:
        explicit_space_ids = {
            _resource_id(sid.strip())
            for sid in (os.getenv("GOOGLE_CHAT_SPACE_IDS") or "").split(",")
            if sid.strip()
        }

    # Record the run before any Chat call so an enumeration failure (auth,
    # blocked egress) lands in the ledger instead of disappearing silently.
    await _record_run_start(
        ctx._pool,
        run_id=run_id,
        workflow_run_id=ctx.run_id,
        metadata={**inp.metadata, "page_size": page_size, "max_pages": max_pages},
    )

    client = _client(ctx)

    work: list[tuple[GoogleChatSyncClient, dict[str, Any], str]] = []

    # Pinned spaces: sync configured spaces directly without spaces.list. Chat
    # still requires the app to be a member of every space it reads.
    if explicit_space_ids:
        work = [
            (client, {"name": f"spaces/{sid}", "type": "SPACE"}, "")
            for sid in sorted(explicit_space_ids)
        ]

    # Otherwise enumerate the member spaces the app can see (filtered to types).
    page_token: str | None = None
    try:
        if not explicit_space_ids:
            while True:
                page = await _call_client(
                    client.list_spaces,
                    page_size=DEFAULT_PAGE_SIZE, page_token=page_token
                )
                for space in page.get("spaces", []):
                    if not isinstance(space, dict):
                        continue
                    if not _resource_id(str(space.get("name") or "")):
                        continue
                    space_type = _space_type(space)
                    if include_types and space_type not in include_types:
                        continue
                    if space_type == "DIRECT_MESSAGE":
                        continue
                    work.append((client, space, ""))
                page_token = page.get("nextPageToken")
                if not page_token:
                    break
    except Exception as exc:
        kind = _error_kind(exc)
        error = _safe_error(exc)
        record_api_outcome("list_spaces", "rate_limited" if kind == "rate_limited" else "error")
        record_etl_items_failed("google_chat", "message", "spaces", kind)
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
        record_run("failed")
        set_last_failure_time(dt.datetime.now(dt.timezone.utc).timestamp())
        observe_run_duration("failed", time.monotonic() - started_at)
        return {"status": "failed", "run_id": run_id, "error": error}

    if not explicit_space_ids:
        record_api_outcome("list_spaces", "success")

    dm_subjects = _selected_dm_subjects(inp.dm_subjects)
    enumeration_failures: list[dict[str, str]] = []
    for subject in dm_subjects:
        dm_client = _delegated_client(ctx, subject)
        page_token = None
        try:
            while True:
                page = await _call_client(
                    dm_client.list_spaces,
                    page_size=DEFAULT_PAGE_SIZE, page_token=page_token
                )
                for space in page.get("spaces", []):
                    if not isinstance(space, dict):
                        continue
                    space_type = _space_type(space)
                    if space_type == "DIRECT_MESSAGE" and _resource_id(
                        str(space.get("name") or "")
                    ):
                        work.append((dm_client, space, subject))
                page_token = page.get("nextPageToken")
                if not page_token:
                    break
            record_api_outcome("list_dm_spaces", "success")
        except Exception as exc:
            kind = _error_kind(exc)
            error = _safe_error(exc)
            record_api_outcome(
                "list_dm_spaces", "rate_limited" if kind == "rate_limited" else "error"
            )
            record_space_failure(kind)
            set_last_failure_time(dt.datetime.now(dt.timezone.utc).timestamp())
            enumeration_failures.append(_scope_ref("direct_messages", error))
            ctx.log("google_chat_sync_dm_subject_failed", owner_email=subject, error=error)

    counts = {
        "spaces_seen": len(work),
        "spaces_synced": 0,
        "messages_seen": 0,
        "messages_upserted": 0,
        "files_processed": 0,
        "reactions_processed": 0,
    }
    synced: list[dict[str, str]] = []
    failed: list[dict[str, str]] = enumeration_failures

    for space_client, space, owner_email in work:
        space_id = _resource_id(str(space.get("name") or ""))
        try:
            watermark = await _sync_space(
                ctx._pool,
                client=space_client,
                space=space,
                run_id=run_id,
                page_size=page_size,
                overlap_seconds=overlap_seconds,
                max_pages=max_pages,
                explicit_since=explicit_since,
                counts=counts,
                owner_email=owner_email,
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
            kind = _error_kind(exc)
            error = _safe_error(exc)
            failed.append(_scope_ref(space_id, error))
            record_etl_items_failed("google_chat", "message", "space", kind)
            record_space_failure(kind)
            set_last_failure_time(dt.datetime.now(dt.timezone.utc).timestamp())
            await _update_checkpoint_failure(
                ctx._pool,
                space_id=space_id,
                owner_email=owner_email,
                run_id=run_id,
                error=error,
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
    record_run(status)
    set_failed_spaces(len(failed))
    if not failed:
        set_last_failure_time(0)
    observe_run_duration(status, time.monotonic() - started_at)

    return {
        "status": status,
        "run_id": run_id,
        "spaces_synced": len(synced),
        "spaces_failed": len(failed),
        **counts,
    }

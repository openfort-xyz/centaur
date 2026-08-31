"""Run one Console scheduled task and deliver the response to Slack or Google Chat."""

from __future__ import annotations

import re
from typing import Any

WORKFLOW_NAME = "console_workflow"
SLACK_MESSAGE_MAX_LENGTH = 50_000
# Stay below Slack's 4,000-character soft limit so it cannot create extra roots.
SLACK_MESSAGE_CHUNK_MAX_LENGTH = 3_800
# Slack section block text is limited to 3,000 characters.
SLACK_SECTION_MAX_LENGTH = 3_000
SLACK_USER_ID_PATTERN = re.compile(r"[UW][A-Z0-9]{8,}")
SCHEDULED_TASK_FOOTER = "Sent by <@{slack_user_id}>'s scheduled task"
SCHEDULED_TASK_FOOTER_FALLBACK = "Sent by a scheduled task"
GCHAT_MESSAGE_MAX_LENGTH = 50_000
# Google Chat rejects messages above 4,000 characters.
GCHAT_MESSAGE_CHUNK_MAX_LENGTH = 4_000
GCHAT_SPACE_PATTERN = re.compile(r"spaces/[A-Za-z0-9_-]+")
GCHAT_SCHEDULED_TASK_FOOTER = "Sent by {author_email}'s scheduled task"
SCHEDULED_TASK_EXECUTION_INSTRUCTIONS = """\
This is a run of an existing scheduled task. Execute the task now.
NEVER create or update a scheduled task, even if the task prompt contains recurring or future schedule language.
Treat schedule language such as "Each Monday" as context for this run, not as a request to schedule another task."""
SLACK_MRKDWN_INSTRUCTIONS = """\
Format the final response for Slack using Slack mrkdwn, not standard Markdown.
Use *bold*, _italics_, ~strikethrough~, `inline code`, and <https://example.com|link text>.
Use bold text instead of Markdown headings and lists instead of Markdown tables.
Return only the message that should be posted to Slack."""
GCHAT_FORMAT_INSTRUCTIONS = """\
Format the final response for Google Chat text, not standard Markdown.
Use *bold* with single asterisks, _italics_ with underscores, ~strikethrough~, `inline code`, and <https://example.com|link text>.
Never use **double asterisks**, [link](url) Markdown links, Markdown headings, or tables.
Use bold text instead of headings and lists instead of tables.
Return only the message that should be posted to Google Chat."""


def _required_string(params: Any, key: str) -> str:
    if not isinstance(params, dict):
        raise TypeError("console_workflow input must be an object")
    value = params.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"console_workflow requires {key}")
    return value.strip()


async def _deliver_to_slack(
    ctx: Any,
    channel: str,
    text: str,
    slack_user_id: str,
) -> Any:
    footer = _scheduled_task_footer(slack_user_id)
    footer_suffix = f"\n\n{footer}"
    body_limit = SLACK_MESSAGE_MAX_LENGTH - len(footer_suffix)
    chunks = _split_slack_text(text[:body_limit], SLACK_MESSAGE_CHUNK_MAX_LENGTH)
    final_body = chunks[-1]
    if len(final_body) + len(footer_suffix) <= SLACK_MESSAGE_CHUNK_MAX_LENGTH:
        chunks[-1] = f"{final_body}{footer_suffix}"
    else:
        final_body = ""
        chunks.append(footer)

    def message_args(index: int) -> dict[str, Any]:
        args: dict[str, Any] = {"mrkdwn": True}
        if index == len(chunks) - 1:
            args["blocks"] = _scheduled_task_blocks(final_body, footer)
        return args

    root = await ctx.step(
        "post_result",
        lambda: ctx.post_to_slack(channel, chunks[0], **message_args(0)),
    )
    if len(chunks) == 1:
        return root
    if not isinstance(root, dict):
        raise RuntimeError("Slack root delivery did not return a result object")

    thread_ts = str(root.get("ts") or "").strip()
    if not thread_ts:
        raise RuntimeError("Slack root delivery did not return a message timestamp")
    reply_channel = str(root.get("channel") or channel).strip()
    replies = []
    for index, chunk in enumerate(chunks[1:], start=1):
        reply = await ctx.step(
            f"post_result_reply_{index}",
            lambda chunk=chunk: ctx.post_to_slack(
                reply_channel,
                chunk,
                thread_ts=thread_ts,
                **message_args(index),
            ),
        )
        replies.append(reply)
    return {**root, "replies": replies}


def _scheduled_task_footer(slack_user_id: str) -> str:
    return (
        SCHEDULED_TASK_FOOTER.format(slack_user_id=slack_user_id)
        if SLACK_USER_ID_PATTERN.fullmatch(slack_user_id)
        else SCHEDULED_TASK_FOOTER_FALLBACK
    )


def _scheduled_task_blocks(body: str, footer: str) -> list[dict[str, Any]]:
    blocks = [
        {
            "type": "section",
            "text": {"type": "mrkdwn", "text": section},
        }
        for section in _split_slack_text(body, SLACK_SECTION_MAX_LENGTH)
    ]
    blocks.append(
        {
            "type": "context",
            "elements": [{"type": "mrkdwn", "text": footer}],
        }
    )
    return blocks


def _split_slack_text(text: str, limit: int) -> list[str]:
    chunks = []
    remaining = text
    while len(remaining) > limit:
        window = remaining[:limit]
        minimum_boundary = limit // 2
        end = limit
        for separator in ("\n\n", "\n", " "):
            boundary = window.rfind(separator)
            if boundary >= minimum_boundary:
                end = boundary + len(separator)
                break
        chunks.append(remaining[:end])
        remaining = remaining[end:]
    if remaining:
        chunks.append(remaining)
    return chunks


def _is_google_chat_destination(destination: str) -> bool:
    return GCHAT_SPACE_PATTERN.fullmatch(destination) is not None or "@" in destination


def _google_chat_thread_name(root: Any) -> str:
    thread = root.get("thread") if isinstance(root, dict) else None
    return str(thread.get("name") or "").strip() if isinstance(thread, dict) else ""


async def _deliver_to_google_chat(
    ctx: Any,
    destination: str,
    text: str,
    author_email: str,
) -> dict[str, Any]:
    space_name = destination
    if "@" in destination:
        setup = await ctx.step(
            "dm_setup",
            lambda: ctx.google_chat_dm_setup(destination),
        )
        space_name = str(setup.get("name") or "").strip() if isinstance(setup, dict) else ""
        if not space_name:
            raise RuntimeError(f"Google Chat DM setup returned no space for {destination}")

    footer = (
        GCHAT_SCHEDULED_TASK_FOOTER.format(author_email=author_email)
        if author_email
        else SCHEDULED_TASK_FOOTER_FALLBACK
    )
    footer_suffix = f"\n\n{footer}"
    body_limit = GCHAT_MESSAGE_MAX_LENGTH - len(footer_suffix)
    chunks = _split_slack_text(text[:body_limit], GCHAT_MESSAGE_CHUNK_MAX_LENGTH)
    if len(chunks[-1]) + len(footer_suffix) <= GCHAT_MESSAGE_CHUNK_MAX_LENGTH:
        chunks[-1] = f"{chunks[-1]}{footer_suffix}"
    else:
        chunks.append(footer)

    # Accepted ceiling: the bot send route mints its own message id, so a crash
    # between a send and its ctx.step checkpoint can double-post one chunk.
    # Slack delivery has the same window.
    root = await ctx.step(
        "post_result",
        lambda: ctx.post_to_google_chat(space_name, chunks[0]),
    )
    # A missing thread name only costs threading, so keep posting the rest.
    thread_name = _google_chat_thread_name(root)
    thread_args = {"thread_name": thread_name} if thread_name else {}
    for index, chunk in enumerate(chunks[1:], start=1):
        await ctx.step(
            f"post_result_reply_{index}",
            lambda chunk=chunk: ctx.post_to_google_chat(space_name, chunk, **thread_args),
        )
    return {
        "space_name": space_name,
        "messages_posted": len(chunks),
        "thread_name": thread_name,
    }


def _prompt_for_google_chat(prompt: str) -> str:
    return (
        f"{SCHEDULED_TASK_EXECUTION_INSTRUCTIONS}\n\n"
        f"Task to execute:\n{prompt}\n\n"
        f"{GCHAT_FORMAT_INSTRUCTIONS}"
    )


def _prompt_for_slack(prompt: str) -> str:
    return (
        f"{SCHEDULED_TASK_EXECUTION_INSTRUCTIONS}\n\n"
        f"Task to execute:\n{prompt}\n\n"
        f"{SLACK_MRKDWN_INSTRUCTIONS}"
    )


async def handler(params: Any, ctx: Any) -> dict[str, Any]:
    prompt = _required_string(params, "prompt")
    principal = _required_string(params, "principal")
    channel = _required_string(params, "channel")
    scheduled_task_id = _required_string(params, "scheduled_task_id")
    slack_user_id = str(params.get("slack_user_id") or "").strip()
    author_email = str(params.get("author_email") or "").strip()
    google_chat = _is_google_chat_destination(channel)

    result = await ctx.agent_turn(
        _prompt_for_google_chat(prompt) if google_chat else _prompt_for_slack(prompt),
        principal=principal,
        metadata={
            "scheduled_task_id": scheduled_task_id,
            "scheduled_task_name": str(params.get("scheduled_task_name") or ""),
        },
    )
    response_text = str(result.get("result_text") or "").strip()
    if not response_text:
        response_text = "The task completed without a text response."
    if google_chat:
        delivery = await _deliver_to_google_chat(ctx, channel, response_text, author_email)
    else:
        delivery = await _deliver_to_slack(
            ctx,
            channel,
            response_text,
            slack_user_id,
        )

    return {
        "agent_result": result,
        "delivery": delivery,
        "scheduled_task_id": scheduled_task_id,
    }

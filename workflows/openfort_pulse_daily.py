"""Workflow: daily Openfort pulse digest (skeleton).

Posts a daily digest to a configured Slack channel. The current implementation
is a deployment-ready skeleton; the prompt and any tracking lists are placeholders
that the operator should populate per Openfort's interests before enabling the
schedule. Ships with ``SCHEDULE.enabled = False`` so it does not fire until the
prompt is filled in.

To enable:
1. Replace ``DIGEST_PROMPT`` with the actual instructions for the agent (what
   to search for, which channels/portfolio companies/keywords matter, output
   shape).
2. Set ``SLACK_CHANNEL`` (or pass it as input) and ensure the bot is in that
   channel.
3. Flip ``SCHEDULE["enabled"]`` to ``True`` and redeploy, or update the
   ``workflow_schedules`` row directly.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse

if TYPE_CHECKING:
    from api.workflow_engine import WorkflowContext

WORKFLOW_NAME = "openfort_pulse_daily"

# Default Slack channel for the digest. Override per-run by passing
# ``slack_channel`` in the workflow input or via the OPENFORT_PULSE_DAILY_SLACK_CHANNEL
# env var (read by the schedule registration code).
SLACK_CHANNEL = "openfort-pulse"

SCHEDULE = {
    # 07:45 in Openfort's primary working timezone — adjust as needed.
    "cron": "45 7 * * *",
    "timezone": "Europe/Madrid",
    "slack_channel": SLACK_CHANNEL,
    # Disabled until the operator fills in DIGEST_PROMPT below.
    "enabled": False,
}

_MAX_BLOCK_TEXT = 2900
_MARKDOWN_LINK_RE = re.compile(r"\[([^\]]+)\]\((https?://[^\s]+)\)")
_SLACK_LINK_RE = re.compile(r"<(https?://[^>|]+)\|([^>]+)>")
_ANGLE_LINK_RE = re.compile(r"<(https?://[^>|]+)>")
_BARE_URL_RE = re.compile(r"(?<!<)(https?://[^\s<>\]]+)")


# TODO(operator): write the prompt for the daily digest. Describe the signals
# the agent should sweep (news, portfolio companies, team activity, anything
# else relevant to Openfort), the output shape, and any tone/length notes. The
# digest is rendered as Slack mrkdwn — the helpers below convert markdown
# links and bare URLs into Slack hyperlink syntax automatically.
DIGEST_PROMPT = (
    "Generate today's Openfort pulse digest. "
    "Use Centaur tools to gather fresh signals relevant to Openfort, "
    "summarise in concise Slack-ready markdown, and avoid low-signal filler."
)


def _format_slack_link(url: str, label: str) -> str:
    return f"<{url}|{label}>"


def _label_for_url(url: str) -> str:
    parsed = urlparse(url)
    host = parsed.netloc.lower().removeprefix("www.")
    path_parts = [part for part in parsed.path.split("/") if part]

    if host in {"x.com", "twitter.com"} and path_parts:
        return f"@{path_parts[0]}"
    if path_parts:
        return f"{host}/{path_parts[-1]}"
    return host


def _split_trailing_url_suffix(text: str) -> tuple[str, str]:
    url = text
    suffix = ""

    while url and url[-1] in ".,;:!?":
        suffix = url[-1] + suffix
        url = url[:-1]

    while url.endswith(")") and url.count("(") < url.count(")"):
        suffix = ")" + suffix
        url = url[:-1]

    return url, suffix


def _replace_bare_url(match: re.Match[str]) -> str:
    original = match.group(1)
    url, suffix = _split_trailing_url_suffix(original)
    return f"{_format_slack_link(url, _label_for_url(url))}{suffix}"


def _normalize_label(url: str, label: str) -> str:
    cleaned = label.strip().strip("<>")
    if cleaned.startswith(("http://", "https://")):
        return _label_for_url(url)
    return cleaned


def _split_markdown_link(label: str, url: str) -> tuple[str, str]:
    trimmed_url, _suffix = _split_trailing_url_suffix(url)
    return trimmed_url, _normalize_label(trimmed_url, label)


def _slackify_links(text: str) -> str:
    """Convert markdown and bare URLs into Slack mrkdwn hyperlinks."""

    converted = _MARKDOWN_LINK_RE.sub(
        lambda match: _format_slack_link(
            *_split_markdown_link(match.group(1), match.group(2))
        ),
        text,
    )
    converted = _SLACK_LINK_RE.sub(
        lambda match: _format_slack_link(match.group(1), _normalize_label(match.group(1), match.group(2))),
        converted,
    )
    converted = _ANGLE_LINK_RE.sub(
        lambda match: _format_slack_link(match.group(1), _label_for_url(match.group(1))),
        converted,
    )
    return _BARE_URL_RE.sub(_replace_bare_url, converted)


def _section_block(text: str) -> dict[str, Any]:
    return {
        "type": "section",
        "text": {"type": "mrkdwn", "text": text.strip(), "verbatim": True},
    }


def _build_blocks(text: str) -> list[dict[str, Any]]:
    """Render the digest as Block Kit so Slack won't unfurl article links."""

    blocks: list[dict[str, Any]] = []
    chunk = ""

    for line in text.splitlines():
        candidate = line if not chunk else f"{chunk}\n{line}"
        if len(candidate) <= _MAX_BLOCK_TEXT:
            chunk = candidate
            continue

        if chunk.strip():
            blocks.append(_section_block(chunk))

        if len(line) <= _MAX_BLOCK_TEXT:
            chunk = line
            continue

        for start in range(0, len(line), _MAX_BLOCK_TEXT):
            piece = line[start : start + _MAX_BLOCK_TEXT].strip()
            if piece:
                blocks.append(_section_block(piece))
        chunk = ""

    if chunk.strip():
        blocks.append(_section_block(chunk))

    return blocks


async def handler(inp: dict[str, Any], ctx: "WorkflowContext") -> dict[str, Any]:
    channel = inp.get("slack_channel") or SLACK_CHANNEL

    result = await ctx.agent_turn(DIGEST_PROMPT)
    text = str(result.get("result_text") or "").strip()
    if not text:
        return result

    slack_text = _slackify_links(text)
    args: dict[str, Any] = {
        "channel": channel,
        "text": slack_text,
        "no_attribution": True,
        "blocks": _build_blocks(slack_text),
        "unfurl_links": False,
        "unfurl_media": False,
    }
    await ctx.call_tool("slack", "send_message", args)
    result["slack_text"] = slack_text
    return result

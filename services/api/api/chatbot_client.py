from __future__ import annotations

import asyncio
import os
from typing import Any

import httpx
import structlog

log = structlog.get_logger()

_RETRYABLE_STATUS = frozenset({408, 429, 500, 502, 503, 504})
_RETRY_ATTEMPTS = 3
_RETRY_BASE_DELAY_S = 0.25


def _base_url() -> str:
    return os.getenv("CHATBOT_URL", "").strip().rstrip("/")


def _api_key() -> str:
    return os.getenv("CHATBOT_API_KEY", "").strip()


def enabled() -> bool:
    """Whether the chatbot transport is wired up.

    Returns ``False`` when ``CHATBOT_ENABLED`` is explicitly turned off — a kill
    switch that ops can flip to disable live-delivery into Google Chat without
    redeploying or unsetting the URL/key. Otherwise the transport is enabled
    when both the chatbot service URL and shared API key are set.
    """
    enabled_flag = os.getenv("CHATBOT_ENABLED", "true").strip().lower()
    if enabled_flag in {"0", "false", "no", "off"}:
        return False
    return bool(_base_url() and _api_key())


async def post(
    path: str,
    body: dict[str, Any],
    *,
    timeout: httpx.Timeout | None = None,
) -> dict[str, Any] | None:
    if not enabled():
        return None
    base_url = _base_url()
    api_key = _api_key()
    if not base_url or not api_key:
        return None
    request_timeout = timeout or httpx.Timeout(8.0, connect=2.0)
    last_status: int | None = None
    last_response: str | None = None
    last_error: str | None = None
    for attempt in range(_RETRY_ATTEMPTS):
        try:
            async with httpx.AsyncClient(timeout=request_timeout) as client:
                response = await client.post(
                    f"{base_url}{path}",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                    },
                    json=body,
                )
                text = response.text
                if response.is_success:
                    if not text:
                        return {}
                    data = response.json()
                    return data if isinstance(data, dict) else {}
                last_status = response.status_code
                last_response = text[:500]
                if response.status_code not in _RETRYABLE_STATUS:
                    log.warning(
                        "chatbot_call_failed",
                        path=path,
                        status=response.status_code,
                        response=last_response,
                    )
                    return None
        except Exception as exc:
            last_error = str(exc)
        if attempt + 1 < _RETRY_ATTEMPTS:
            await asyncio.sleep(_RETRY_BASE_DELAY_S * (2**attempt))
    log.warning(
        "chatbot_call_failed",
        path=path,
        status=last_status,
        response=last_response,
        error=last_error,
        attempts=_RETRY_ATTEMPTS,
    )
    return None


def is_chat_delivery(delivery: dict[str, Any] | None) -> bool:
    return isinstance(delivery, dict) and str(delivery.get("platform") or "") == "google-chat"


def space_name(delivery: dict[str, Any]) -> str:
    return str(delivery.get("space_name") or delivery.get("spaceName") or "").strip()


async def open_agent_session(
    *,
    delivery: dict[str, Any],
    metadata: dict[str, Any],
    thread_key: str,
) -> dict[str, str] | None:
    """Open a chatbot ack session, returning {session_id, message_name}.

    The chatbot posts a single "_Centaur is thinking…_" placeholder message
    and returns its resource name. The caller is expected to store the name
    in execution metadata so the final-delivery outbox row can carry it; the
    chatbot's outbox poller then PATCHes that same message with the canonical
    final answer, giving the user a single-bubble UX.
    """
    if not enabled() or not is_chat_delivery(delivery):
        return None
    target_space = space_name(delivery)
    if not target_space:
        return None
    body: dict[str, Any] = {"space_name": target_space}
    thread_name = str(delivery.get("thread_name") or "").strip()
    if thread_name:
        body["thread_name"] = thread_name
    result = await post("/api/chat/agent-sessions", body)
    if not result:
        return None
    session_id = str(result.get("session_id") or "").strip()
    message_name = str(result.get("message_name") or "").strip()
    if not session_id:
        return None
    return {"session_id": session_id, "message_name": message_name}


async def session_text(session_id: str | None, markdown: str) -> None:
    if not session_id or not markdown.strip():
        return
    await post(f"/api/chat/agent-sessions/{session_id}/text", {"markdown": markdown})


async def session_step(
    session_id: str | None,
    *,
    step_id: str,
    title: str,
    status: str = "in_progress",
    details: str | None = None,
    output: str | None = None,
) -> None:
    if not session_id or not step_id or not title:
        return
    body: dict[str, Any] = {
        "id": step_id,
        "title": title,
        "status": status,
    }
    if details:
        body["details"] = details
    if output:
        body["output"] = output
    await post(f"/api/chat/agent-sessions/{session_id}/step", body)


async def session_done(session_id: str | None) -> None:
    if not session_id:
        return
    await post(f"/api/chat/agent-sessions/{session_id}/done", {})

from __future__ import annotations

from contextlib import contextmanager
from typing import Any


def set_trace_context(
    *,
    user_id: str | None = None,
    session_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    pass


@contextmanager
def start_span(
    *,
    name: str = "",
    span_type: str = "DEFAULT",
    metadata: dict[str, Any] | None = None,
    trace_id: str | None = None,
):
    yield

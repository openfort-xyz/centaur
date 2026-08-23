import json

import httpx
import pytest
from notion import cli
from notion.client import NotionClient
from typer.testing import CliRunner

PAGE_ID = "3a5101a89b118165b717f5c11ef2d19c"


def _paged_transport(total: int, page_size: int = 100):
    """Serve `total` children across as many pages as Notion's cap requires."""
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        cursor = int(request.url.params.get("start_cursor") or 0)
        chunk = [
            {"id": f"block-{i}", "type": "paragraph", "paragraph": {"rich_text": []}}
            for i in range(cursor, min(cursor + page_size, total))
        ]
        nxt = cursor + len(chunk)
        seen.append({"cursor": cursor, "n": len(chunk)})
        return httpx.Response(
            200,
            json={
                "results": chunk,
                "has_more": nxt < total,
                "next_cursor": str(nxt) if nxt < total else None,
            },
        )

    return handler, seen


@pytest.fixture
def client_factory(monkeypatch):
    def build(total: int):
        client = NotionClient(api_key="test-key")
        handler, seen = _paged_transport(total)
        client._http = httpx.Client(
            base_url="https://api.notion.com/v1",
            transport=httpx.MockTransport(handler),
        )
        monkeypatch.setattr(cli, "get_client", lambda: client)
        return seen

    return build


def test_blocks_reads_past_the_hundred_child_cap(client_factory):
    """One request caps at 100 and hides the rest behind `has_more`.

    A ledger page read short is then rewritten short, so the unread rows are
    orphaned by the very run that was supposed to preserve them.
    """
    seen = client_factory(150)
    result = CliRunner().invoke(cli.app, ["blocks", PAGE_ID, "--json"])

    assert result.exit_code == 0, result.output
    assert len(json.loads(result.stdout)) == 150
    assert len(seen) == 2


def test_blocks_limit_still_truncates_on_request(client_factory):
    client_factory(150)
    result = CliRunner().invoke(cli.app, ["blocks", PAGE_ID, "--json", "-n", "20"])

    assert result.exit_code == 0, result.output
    assert len(json.loads(result.stdout)) == 20

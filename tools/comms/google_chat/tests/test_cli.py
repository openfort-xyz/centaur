import json

import google_chat.cli as cli
from typer.testing import CliRunner


def test_list_messages_forwards_query_options(monkeypatch) -> None:
    captured = {}

    class FakeClient:
        def list_messages(self, space_name, **kwargs):
            captured.update(space_name=space_name, **kwargs)
            return {"messages": [], "nextPageToken": "another-page"}

    monkeypatch.setattr(cli, "_client", FakeClient)
    result = CliRunner().invoke(
        cli.app,
        [
            "list-messages",
            "spaces/AAAA",
            "--page-size",
            "1000",
            "--page-token",
            "next-page",
            "--filter",
            'createTime > "2026-08-13T00:00:00Z"',
            "--order-by",
            "DESC",
            "--json",
        ],
    )

    assert result.exit_code == 0
    assert captured == {
        "space_name": "spaces/AAAA",
        "page_size": 1000,
        "page_token": "next-page",
        "filter": 'createTime > "2026-08-13T00:00:00Z"',
        "order_by": "DESC",
    }
    assert json.loads(result.stdout)["nextPageToken"] == "another-page"

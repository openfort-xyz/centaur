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


def test_list_messages_all_pages_follows_tokens(monkeypatch) -> None:
    calls = []

    class FakeClient:
        def list_messages(self, space_name, **kwargs):
            calls.append({"space_name": space_name, **kwargs})
            token = kwargs["page_token"]
            if token is None:
                return {"messages": [{"name": "messages/1"}], "nextPageToken": "page-2"}
            return {"messages": [{"name": "messages/2"}]}

    monkeypatch.setattr(cli, "_client", FakeClient)
    result = CliRunner().invoke(
        cli.app,
        [
            "list-messages",
            "spaces/AAAA",
            "--page-size",
            "1000",
            "--filter",
            'createTime > "2026-08-13T00:00:00Z"',
            "--order-by",
            "DESC",
            "--all-pages",
            "--json",
        ],
    )

    assert result.exit_code == 0
    assert [call["page_token"] for call in calls] == [None, "page-2"]
    assert all(call["page_size"] == 1000 for call in calls)
    assert json.loads(result.stdout) == {
        "messages": [{"name": "messages/1"}, {"name": "messages/2"}],
        "pagesFetched": 2,
    }


def test_list_messages_all_pages_keeps_resume_token_at_cap(monkeypatch) -> None:
    class FakeClient:
        def list_messages(self, space_name, **kwargs):
            token = kwargs["page_token"] or "start"
            return {"messages": [{"name": token}], "nextPageToken": f"{token}-next"}

    monkeypatch.setattr(cli, "_client", FakeClient)
    result = CliRunner().invoke(
        cli.app,
        ["list-messages", "spaces/AAAA", "--all-pages", "--max-pages", "2", "--json"],
    )

    assert result.exit_code == 0
    payload = json.loads(result.stdout)
    assert payload["pagesFetched"] == 2
    assert payload["nextPageToken"] == "start-next-next"


def test_list_messages_all_pages_rejects_repeated_token(monkeypatch) -> None:
    class FakeClient:
        def list_messages(self, space_name, **kwargs):
            return {"messages": [], "nextPageToken": "same"}

    monkeypatch.setattr(cli, "_client", FakeClient)
    result = CliRunner().invoke(
        cli.app,
        ["list-messages", "spaces/AAAA", "--all-pages", "--json"],
    )

    assert result.exit_code == 1
    assert isinstance(result.exception, RuntimeError)
    assert "repeated page token" in str(result.exception)

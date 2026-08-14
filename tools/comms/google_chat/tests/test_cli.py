import inspect
import json

import pytest
from google_chat import cli
from typer.testing import CliRunner


class FakeClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple, dict]] = []

    def _result(self, name: str, args: tuple, kwargs: dict, result: dict) -> dict:
        self.calls.append((name, args, kwargs))
        return result

    def list_spaces(self, *args, **kwargs):
        return self._result(
            "spaces",
            args,
            kwargs,
            {"spaces": [{"name": "spaces/A", "displayName": "Team"}], "next_page_token": "next"},
        )

    def list_messages(self, *args, **kwargs):
        return self._result(
            "list-messages",
            args,
            kwargs,
            {"messages": [], "next_page_token": "next"},
        )

    def get_space(self, *args, **kwargs):
        return self._result(
            "space-info",
            args,
            kwargs,
            {"name": "spaces/A", "displayName": "Team", "spaceType": "SPACE"},
        )

    def list_members(self, *args, **kwargs):
        return self._result(
            "members",
            args,
            kwargs,
            {
                "memberships": [{"name": "spaces/A/members/U1", "state": "JOINED"}],
                "next_page_token": "next",
            },
        )

    def list_thread_messages(self, *args, **kwargs):
        return self._result(
            "thread",
            args,
            kwargs,
            {
                "messages": [{"name": "spaces/A/messages/M", "text": "reply"}],
                "next_page_token": "next",
            },
        )

    def search_messages(self, *args, **kwargs):
        return self._result(
            "search",
            args,
            kwargs,
            {
                "messages": [{"name": "spaces/A/messages/M", "text": "match"}],
                "truncated": True,
                "next_page_token": "next",
            },
        )

    def list_reactions(self, *args, **kwargs):
        return self._result(
            "reactions",
            args,
            kwargs,
            {
                "reactions": [{"name": "reactions/R", "emoji": {"unicode": "👍"}}],
                "next_page_token": "next",
                "truncated": True,
            },
        )

    def send_dm(self, *args, **kwargs):
        return self._result(
            "dm",
            args,
            kwargs,
            {"space": {"name": "spaces/DM"}, "message": {"name": "spaces/DM/messages/M"}},
        )

    def questions(self, *args, **kwargs):
        return self._result(
            "questions",
            args,
            kwargs,
            {"questions": [{"timestamp": "now", "text": "Why?"}], "truncated": True},
        )

    def dump(self, *args, **kwargs):
        return self._result(
            "dump", args, kwargs, {"channel_id": "spaces/A", "messages": [], "truncated": True}
        )

    def feedback(self, *args, **kwargs):
        return self._result(
            "feedback",
            args,
            kwargs,
            {"items": [{"timestamp": "now", "summary": "broken"}], "truncated": True},
        )

    def list_files(self, *args, **kwargs):
        return self._result(
            "files",
            args,
            kwargs,
            {"files": [{"name": "attachments/A", "contentName": "report.pdf"}]},
        )

    def search_files(self, *args, **kwargs):
        return self._result(
            "search-files",
            args,
            kwargs,
            {"files": [{"name": "attachments/A", "contentName": "report.pdf"}], "truncated": True},
        )

    def file_info(self, *args, **kwargs):
        return self._result(
            "file-info",
            args,
            kwargs,
            {"name": "spaces/A/messages/M/attachments/F", "contentName": "report.pdf"},
        )

    def download_file(self, *args, **kwargs):
        return self._result(
            "download",
            args,
            kwargs,
            {
                "filename": "report.pdf",
                "content_type": "application/pdf",
                "size_bytes": 3,
                "content": b"PDF",
            },
        )


runner = CliRunner()


def test_every_new_command_has_machine_readable_output(monkeypatch) -> None:
    client = FakeClient()
    monkeypatch.setattr(cli, "_client", lambda: client)
    invocations = [
        ["spaces", "--json", "--page-token", "space-next"],
        ["space-info", "spaces/A", "--json"],
        ["members", "spaces/A", "--json", "--page-token", "member-next"],
        ["thread", "spaces/A/threads/T", "--json", "--page-token", "thread-next"],
        ["search", "spaces/A", "match", "--json", "--max-pages", "2"],
        ["reactions", "spaces/A", "--json", "--max-pages", "2"],
        ["dm", "person@example.com", "hello", "--json"],
        ["questions", "spaces/A", "--json", "--max-pages", "2"],
        ["dump", "spaces/A", "--max-pages", "2"],
        ["feedback", "spaces/A", "--json", "--max-pages", "2"],
        ["files", "spaces/A", "--json"],
        ["search-files", "spaces/A", "report", "--json", "--max-pages", "2"],
        ["file-info", "spaces/A/messages/M/attachments/F", "--json"],
    ]

    for invocation in invocations:
        result = runner.invoke(cli.app, invocation)
        assert result.exit_code == 0, result.output
        assert result.output.lstrip().startswith("{")

    assert [call[0] for call in client.calls] == [
        "spaces",
        "space-info",
        "members",
        "thread",
        "search",
        "reactions",
        "dm",
        "questions",
        "dump",
        "feedback",
        "files",
        "search-files",
        "file-info",
    ]
    assert client.calls[0][2]["page_token"] == "space-next"
    assert client.calls[2][2]["page_token"] == "member-next"
    assert client.calls[3][2]["page_token"] == "thread-next"
    assert client.calls[4][2]["max_pages"] == 2
    assert client.calls[5][2]["max_pages"] == 2


def test_list_messages_forwards_query_options(monkeypatch) -> None:
    client = FakeClient()
    monkeypatch.setattr(cli, "_client", lambda: client)
    result = runner.invoke(
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
            "createTime DESC",
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    assert client.calls == [
        (
            "list-messages",
            ("spaces/AAAA",),
            {
                "page_size": 1000,
                "page_token": "next-page",
                "filter": 'createTime > "2026-08-13T00:00:00Z"',
                "order_by": "createTime DESC",
            },
        )
    ]
    assert json.loads(result.stdout)["next_page_token"] == "next"


def test_list_messages_all_pages_follows_tokens_without_changing_options(monkeypatch) -> None:
    calls = []

    class PaginatedClient:
        def list_messages(self, space_name, **kwargs):
            calls.append({"space_name": space_name, **kwargs})
            if kwargs["page_token"] is None:
                return {"messages": [{"name": "messages/1"}], "nextPageToken": "page-2"}
            return {"messages": [{"name": "messages/2"}]}

    monkeypatch.setattr(cli, "_client", PaginatedClient)
    result = runner.invoke(
        cli.app,
        [
            "list-messages",
            "spaces/AAAA",
            "--page-size",
            "1000",
            "--filter",
            'createTime > "2026-08-13T00:00:00Z"',
            "--order-by",
            "createTime DESC",
            "--all-pages",
            "--json",
        ],
    )

    assert result.exit_code == 0, result.output
    assert [call["page_token"] for call in calls] == [None, "page-2"]
    assert all(
        call["page_size"] == 1000
        and call["filter"] == 'createTime > "2026-08-13T00:00:00Z"'
        and call["order_by"] == "createTime DESC"
        for call in calls
    )
    assert json.loads(result.stdout) == {
        "messages": [{"name": "messages/1"}, {"name": "messages/2"}],
        "pagesFetched": 2,
    }


def test_list_messages_all_pages_keeps_resume_token_at_cap(monkeypatch) -> None:
    class PaginatedClient:
        def list_messages(self, _space_name, **kwargs):
            token = kwargs["page_token"] or "start"
            return {"messages": [{"name": token}], "next_page_token": f"{token}-next"}

    monkeypatch.setattr(cli, "_client", PaginatedClient)
    result = runner.invoke(
        cli.app,
        ["list-messages", "spaces/AAAA", "--all-pages", "--max-pages", "2", "--json"],
    )

    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert payload["pagesFetched"] == 2
    assert payload["nextPageToken"] == "start-next-next"


def test_list_messages_all_pages_rejects_repeated_token(monkeypatch) -> None:
    class PaginatedClient:
        def list_messages(self, _space_name, **_kwargs):
            return {"messages": [], "nextPageToken": "same"}

    monkeypatch.setattr(cli, "_client", PaginatedClient)
    result = runner.invoke(
        cli.app,
        ["list-messages", "spaces/AAAA", "--all-pages", "--json"],
    )

    assert result.exit_code == 1
    assert isinstance(result.exception, RuntimeError)
    assert "repeated page token" in str(result.exception)


def test_new_commands_render_human_output_and_bounds(monkeypatch) -> None:
    client = FakeClient()
    monkeypatch.setattr(cli, "_client", lambda: client)
    invocations = [
        ["spaces"],
        ["space-info", "spaces/A"],
        ["members", "spaces/A"],
        ["thread", "spaces/A/threads/T"],
        ["search", "spaces/A", "match", "--max-pages", "1"],
        ["reactions", "spaces/A"],
        ["dm", "person@example.com", "hello"],
        ["questions", "spaces/A", "--max-pages", "1"],
        ["feedback", "spaces/A", "--max-pages", "1"],
        ["files", "spaces/A"],
        ["search-files", "spaces/A", "report", "--max-pages", "1"],
        ["file-info", "spaces/A/messages/M/attachments/F"],
    ]

    for invocation in invocations:
        result = runner.invoke(cli.app, invocation)
        assert result.exit_code == 0, result.output
        assert result.output.strip()

    assert "Next page token" in runner.invoke(cli.app, ["spaces"]).output
    assert (
        "truncated"
        in runner.invoke(
            cli.app, ["search", "spaces/A", "match", "--max-pages", "1"]
        ).output.lower()
    )


def test_download_writes_raw_bytes_without_overwrite(monkeypatch, tmp_path) -> None:
    client = FakeClient()
    monkeypatch.setattr(cli, "_client", lambda: client)
    result = runner.invoke(
        cli.app,
        ["download", "spaces/A/messages/M/attachments/F", "--output", str(tmp_path), "--json"],
    )
    assert result.exit_code == 0, result.output
    assert (tmp_path / "report.pdf").read_bytes() == b"PDF"
    assert '"content":' not in result.output
    repeated = runner.invoke(
        cli.app,
        ["download", "spaces/A/messages/M/attachments/F", "--output", str(tmp_path)],
    )
    assert repeated.exit_code != 0


def test_every_registered_command_uses_only_the_scoped_client() -> None:
    commands = {command.name or command.callback.__name__.replace("_", "-"): command.callback for command in cli.app.registered_commands}
    assert set(commands) == {
        "send-message",
        "list-messages",
        "spaces",
        "space-info",
        "members",
        "thread",
        "reactions",
        "search",
        "dm",
        "questions",
        "dump",
        "feedback",
        "update-message",
        "delete-message",
        "upload",
        "files",
        "search-files",
        "file-info",
        "download",
        "health",
    }
    for name, callback in commands.items():
        source = inspect.getsource(callback)
        assert "_client()" in source, name
        assert "httpx" not in source and "chat.googleapis.com" not in source, name


@pytest.mark.parametrize(
    ("status", "category"),
    [(403, "permission_denied"), (429, "rate_limited"), (503, "upstream")],
)
def test_cli_surfaces_proxy_failure_categories(monkeypatch, status: int, category: str) -> None:
    from google_chat.client import GoogleChatApiError

    class DeniedClient(FakeClient):
        def list_members(self, *_args, **_kwargs):
            raise GoogleChatApiError(status, category)

    monkeypatch.setattr(cli, "_client", DeniedClient)
    denied = runner.invoke(cli.app, ["members", "spaces/A", "--json"])
    assert denied.exit_code == 1
    assert isinstance(denied.exception, GoogleChatApiError)
    assert denied.exception.category == category


def test_cli_rejects_malformed_resource(monkeypatch) -> None:
    from google_chat.client import GoogleChatClient

    monkeypatch.setattr(cli, "_client", GoogleChatClient)
    malformed = runner.invoke(cli.app, ["thread", "spaces/A/messages/M", "--json"])
    assert malformed.exit_code == 1
    assert isinstance(malformed.exception, ValueError)

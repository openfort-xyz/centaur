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


# -----------------------------------------------------------------------------
# Property writes and @mentions
#
# Both paths fail quietly in the Notion API when they are wrong: an unknown
# property key is ignored on write, and a name that does not resolve to a user
# renders as ordinary text that notifies nobody. Every test below pins a case
# where "it looked like it worked" would otherwise be the outcome.
# -----------------------------------------------------------------------------

PEOPLE = [
    {
        "id": "u-jaume",
        "name": "Jaume Alavedra",
        "type": "person",
        "person": {"email": "jaume@openfort.xyz"},
    },
    {
        "id": "u-joan",
        "name": "Joan Alavedra",
        "type": "person",
        "person": {"email": "joan@openfort.xyz"},
    },
    {"id": "u-arnau", "name": "Arnau Briet", "type": "person", "person": {}},
    {"id": "b-condor", "name": "condor", "type": "bot", "bot": {}},
]

SCHEMA = {
    "Task name": {"type": "title"},
    "Assignee": {"type": "people"},
    "Status": {"type": "status"},
    "Priority": {"type": "select"},
    "Tags": {"type": "select"},
    "Due": {"type": "date"},
    "AI summary": {"type": "rich_text"},
    "Sprint": {"type": "relation"},
    "Cycle Time(days)": {"type": "formula"},
}


def _resolver(name):
    return NotionClient.pick_user(PEOPLE, name)


def test_people_property_resolves_names_to_user_ids():
    assert NotionClient.build_property_value("people", "Jaume Alavedra", _resolver) == {
        "people": [{"object": "user", "id": "u-jaume"}]
    }


def test_people_property_accepts_several_assignees():
    built = NotionClient.build_property_value("people", "Jaume Alavedra, Arnau Briet", _resolver)
    assert [p["id"] for p in built["people"]] == ["u-jaume", "u-arnau"]


def test_select_status_and_date_carry_the_shape_notion_demands():
    assert NotionClient.build_property_value("status", "In progress") == {
        "status": {"name": "In progress"}
    }
    assert NotionClient.build_property_value("date", "2026-09-23") == {
        "date": {"start": "2026-09-23"}
    }
    assert NotionClient.build_property_value("date", "2026-09-23..2026-09-24") == {
        "date": {"start": "2026-09-23", "end": "2026-09-24"}
    }


def test_multi_select_and_relation_split_on_commas():
    assert NotionClient.build_property_value("multi_select", "dns, email") == {
        "multi_select": [{"name": "dns"}, {"name": "email"}]
    }
    assert NotionClient.build_property_value("relation", "abc, def") == {
        "relation": [{"id": "abc"}, {"id": "def"}]
    }


def test_unsupported_property_type_refuses_rather_than_guessing():
    """A formula is computed by Notion. Writing it would be silently dropped."""
    with pytest.raises(ValueError, match="formula"):
        NotionClient.build_property_value("formula", "3")


def test_property_name_match_is_case_insensitive():
    assert NotionClient.resolve_property_name(SCHEMA, "assignee") == "Assignee"


def test_unknown_property_name_raises_and_lists_the_real_ones():
    """Notion ignores an unknown key, so a typo would look like a clean write."""
    with pytest.raises(KeyError) as exc:
        NotionClient.resolve_property_name(SCHEMA, "Asignee")
    assert "Assignee" in str(exc.value)


def test_pick_user_matches_on_email_and_ignores_bots():
    assert NotionClient.pick_user(PEOPLE, "jaume@openfort.xyz") == "u-jaume"
    with pytest.raises(ValueError, match="no workspace member"):
        NotionClient.pick_user(PEOPLE, "condor")


def test_pick_user_refuses_an_ambiguous_surname():
    """Two Alavedras. Picking one at random would tag the wrong person."""
    with pytest.raises(ValueError, match="ambiguous"):
        NotionClient.pick_user(PEOPLE, "Alavedra")


def test_pick_user_reports_the_roster_when_nobody_matches():
    with pytest.raises(ValueError, match="Arnau Briet"):
        NotionClient.pick_user(PEOPLE, "Nobody Here")


def test_mention_splits_text_around_the_user_node():
    rich = NotionClient.make_rich_text_with_mentions("over to @[Jaume Alavedra] for DNS", _resolver)
    assert [p["type"] for p in rich] == ["text", "mention", "text"]
    assert rich[1]["mention"]["user"]["id"] == "u-jaume"
    assert rich[0]["text"]["content"] == "over to "
    assert rich[2]["text"]["content"] == " for DNS"


def test_mention_handles_several_people_and_a_leading_mention():
    rich = NotionClient.make_rich_text_with_mentions(
        "@[Jaume Alavedra] and @[Arnau Briet]", _resolver
    )
    assert [p["type"] for p in rich] == ["mention", "text", "mention"]
    assert [p["mention"]["user"]["id"] for p in rich if p["type"] == "mention"] == [
        "u-jaume",
        "u-arnau",
    ]


def test_plain_text_is_left_alone():
    assert NotionClient.make_rich_text_with_mentions("no mentions here", _resolver) == [
        {"type": "text", "text": {"content": "no mentions here"}}
    ]


def test_a_bare_at_name_is_not_treated_as_a_mention():
    """Only the bracket form is a mention, so prose survives untouched."""
    rich = NotionClient.make_rich_text_with_mentions("email @ jaume later", _resolver)
    assert [p["type"] for p in rich] == ["text"]


def _schema_transport(record):
    """Serve a database schema and a user list; record every write."""

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.startswith("/v1/databases/"):
            return httpx.Response(200, json={"properties": SCHEMA})
        if path.startswith("/v1/users"):
            return httpx.Response(200, json={"results": PEOPLE, "has_more": False})
        if path.startswith("/v1/pages/") and request.method == "GET":
            return httpx.Response(200, json={"parent": {"database_id": "db-1"}})
        if path.startswith("/v1/pages/") and request.method == "PATCH":
            record.append(json.loads(request.content))
            return httpx.Response(200, json={"id": PAGE_ID, "url": "u", "properties": {}})
        if path.startswith("/v1/comments"):
            record.append(json.loads(request.content))
            return httpx.Response(200, json={"id": "c-1"})
        return httpx.Response(404, json={})

    return handler


@pytest.fixture
def writing_client(monkeypatch):
    record: list[dict] = []
    client = NotionClient(api_key="test-key")
    client._http = httpx.Client(
        base_url="https://api.notion.com/v1",
        transport=httpx.MockTransport(_schema_transport(record)),
    )
    monkeypatch.setattr(cli, "get_client", lambda: client)
    return record


def test_set_props_patches_the_assignee(writing_client):
    result = CliRunner().invoke(cli.app, ["set-props", PAGE_ID, "--set", "Assignee=Jaume Alavedra"])

    assert result.exit_code == 0, result.output
    assert writing_client == [
        {"properties": {"Assignee": {"people": [{"object": "user", "id": "u-jaume"}]}}}
    ]


def test_set_props_on_an_unknown_property_writes_nothing(writing_client):
    """The whole point: a typo must not PATCH a page and report success."""
    result = CliRunner().invoke(cli.app, ["set-props", PAGE_ID, "--set", "Asignee=Jaume Alavedra"])

    assert result.exit_code != 0
    assert writing_client == []


def test_comment_with_an_unresolvable_mention_posts_nothing(writing_client):
    """Better no comment than one that names someone and notifies nobody."""
    result = CliRunner().invoke(cli.app, ["comment", PAGE_ID, "@[Nobody Here] please look"])

    assert result.exit_code != 0
    assert writing_client == []


def test_comment_sends_a_real_mention_node(writing_client):
    result = CliRunner().invoke(cli.app, ["comment", PAGE_ID, "@[Jaume Alavedra] yours"])

    assert result.exit_code == 0, result.output
    rich = writing_client[0]["rich_text"]
    assert rich[0]["mention"]["user"]["id"] == "u-jaume"


def test_api_errors_carry_notions_explanation():
    """A bare 400 does not say which property Notion objected to; the body does."""
    from notion.client import NotionAPIError

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400, json={"message": "Not started is not a valid select option for Status"}
        )

    client = NotionClient(api_key="test-key")
    client._http = httpx.Client(
        base_url="https://api.notion.com/v1", transport=httpx.MockTransport(handler)
    )
    with pytest.raises(NotionAPIError, match="not a valid select option"):
        client.page("abc")

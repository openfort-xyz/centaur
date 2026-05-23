"""Crisp Chat CLI for customer support."""

import json
from datetime import UTC, datetime

import typer
from dotenv import load_dotenv
from rich.console import Console

from centaur_sdk import Table

load_dotenv()

app = typer.Typer(name="crisp", help="Crisp Chat customer support CLI")
console = Console()


def _ts_fmt(ts: int | float | None) -> str:
    if not ts:
        return ""
    return datetime.fromtimestamp(ts / 1000, tz=UTC).strftime("%Y-%m-%d %H:%M")


@app.command()
def list_conversations(
    website_id: str = typer.Argument(..., help="Crisp website ID"),
    page: int = typer.Option(1, "--page", "-p", help="Page number"),
    search: str | None = typer.Option(None, "--search", "-s", help="Search query"),
    unread: bool = typer.Option(False, "--unread", help="Only unread conversations"),
    resolved: bool = typer.Option(False, "--resolved", help="Only resolved conversations"),
    unassigned: bool = typer.Option(False, "--unassigned", help="Only unassigned conversations"),
    per_page: int = typer.Option(20, "--per-page", "-n", help="Results per page (20-50)"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
    markdown: bool = typer.Option(False, "--markdown", "-m", help="Output as markdown"),
):
    """List conversations for a website."""
    from .client import _client

    client = _client()
    result = client.list_conversations(
        website_id,
        page,
        search_query=search,
        filter_unread=unread,
        filter_resolved=resolved,
        filter_unassigned=unassigned,
        per_page=per_page,
    )
    conversations = result.get("data", [])

    if json_output:
        print(json.dumps(result, indent=2))
        return

    if markdown:
        print("| Session ID | State | Last Message | Visitor | Created |")
        print("|------------|-------|--------------|---------|---------|")
        for conv in conversations:
            meta = conv.get("meta", {})
            print(
                f"| {conv.get('session_id', '')[:12]} "
                f"| {conv.get('state', '')} "
                f"| {(conv.get('last_message', '') or '')[:40]} "
                f"| {meta.get('nickname', '') or meta.get('email', '') or ''} "
                f"| {_ts_fmt(conv.get('created_at'))} |"
            )
        return

    table = Table(title=f"Conversations — {website_id}")
    table.add_column("Session ID", style="cyan")
    table.add_column("State", style="yellow")
    table.add_column("Last Message", style="white")
    table.add_column("Visitor", style="green")
    table.add_column("Created", style="blue")
    for conv in conversations:
        meta = conv.get("meta", {})
        table.add_row(
            str(conv.get("session_id", ""))[:12],
            str(conv.get("state", "")),
            (conv.get("last_message", "") or "")[:50],
            meta.get("nickname", "") or meta.get("email", "") or "",
            _ts_fmt(conv.get("created_at")),
        )
    console.print(table)


@app.command()
def get_conversation(
    website_id: str = typer.Argument(..., help="Crisp website ID"),
    session_id: str = typer.Argument(..., help="Conversation session ID"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Get full conversation details."""
    from .client import _client

    client = _client()
    result = client.get_conversation(website_id, session_id)
    data = result.get("data", result)

    if json_output:
        print(json.dumps(data, indent=2))
        return

    meta = data.get("meta", {})
    assigned = data.get("assigned", {})
    console.print(f"[bold cyan]Conversation {session_id}[/bold cyan]")
    console.print(f"  State: {data.get('state')}  Status: {data.get('status')}")
    console.print(f"  Visitor: {meta.get('nickname', '')} ({meta.get('email', '')})")
    if assigned:
        console.print(f"  Assigned: {assigned.get('user_id', '')}")
    console.print(f"  Segments: {', '.join(data.get('segments', []))}")
    console.print(f"  Created: {_ts_fmt(data.get('created_at'))}")
    console.print(f"  Updated: {_ts_fmt(data.get('updated_at'))}")
    console.print(f"  URL: https://app.crisp.chat/website/{website_id}/inbox/{session_id}/")


@app.command()
def get_messages(
    website_id: str = typer.Argument(..., help="Crisp website ID"),
    session_id: str = typer.Argument(..., help="Conversation session ID"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Get messages in a conversation."""
    from .client import _client

    client = _client()
    result = client.get_conversation_messages(website_id, session_id)
    messages = result.get("data", [])

    if json_output:
        print(json.dumps(messages, indent=2))
        return

    table = Table(title=f"Messages — {session_id}")
    table.add_column("From", style="cyan")
    table.add_column("Type", style="yellow")
    table.add_column("Content", style="white")
    table.add_column("Time", style="blue")
    for msg in messages:
        from_field = msg.get("from", "")
        nickname = (msg.get("user") or {}).get("nickname", "")
        sender = f"{from_field}"
        if nickname:
            sender = f"{from_field} ({nickname})"
        table.add_row(
            sender,
            str(msg.get("type", "")),
            (msg.get("content", "") or "")[:80],
            _ts_fmt(msg.get("timestamp")),
        )
    console.print(table)


@app.command()
def send_message(
    website_id: str = typer.Argument(..., help="Crisp website ID"),
    session_id: str = typer.Argument(..., help="Conversation session ID"),
    content: str = typer.Argument(..., help="Message text"),
    note: bool = typer.Option(False, "--note", help="Send as internal note instead"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Send a message to a conversation."""
    from .client import _client

    client = _client()
    if note:
        result = client.send_internal_note(website_id, session_id, content)
    else:
        result = client.send_message(website_id, session_id, content)

    if json_output:
        print(json.dumps(result, indent=2))
        return

    console.print(f"[green]Message sent to {session_id}[/green]")


@app.command()
def resolve_conversation(
    website_id: str = typer.Argument(..., help="Crisp website ID"),
    session_id: str = typer.Argument(..., help="Conversation session ID"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Resolve a conversation (mark as done)."""
    from .client import _client

    client = _client()
    result = client.resolve_conversation(website_id, session_id)

    if json_output:
        print(json.dumps(result, indent=2))
        return

    console.print(f"[green]Conversation {session_id} resolved.[/green]")


@app.command()
def get_profile(
    website_id: str = typer.Argument(..., help="Crisp website ID"),
    people_id: str = typer.Argument(..., help="People profile ID"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Get a people (customer) profile."""
    from .client import _client

    client = _client()
    result = client.get_people_profile(website_id, people_id)
    data = result.get("data", result)

    if json_output:
        print(json.dumps(data, indent=2))
        return

    console.print(f"[bold cyan]Profile: {people_id}[/bold cyan]")
    for key in ("nickname", "email", "phone", "address", "company", "role"):
        val = data.get(key, "")
        if val:
            console.print(f"  {key.capitalize()}: {val}")
    console.print(f"  Segments: {', '.join(data.get('segments', []))}")
    console.print(f"  Created: {_ts_fmt(data.get('created_at'))}")


@app.command()
def assign_conversation(
    website_id: str = typer.Argument(..., help="Crisp website ID"),
    session_id: str = typer.Argument(..., help="Conversation session ID"),
    user_id: str = typer.Argument(..., help="Operator user ID to assign"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Assign a conversation to an operator."""
    from .client import _client

    client = _client()
    result = client.assign_conversation(website_id, session_id, user_id)

    if json_output:
        print(json.dumps(result, indent=2))
        return

    console.print(f"[green]Conversation {session_id} assigned to {user_id}.[/green]")

"""Google Chat CLI."""

from dotenv import load_dotenv

load_dotenv()

import json
import typer
from rich.console import Console
from rich.table import Table

app = typer.Typer(name="google-chat", help="Google Chat CLI for AI agents")
console = Console()


@app.command()
def send_message(
    space_name: str = typer.Argument(..., help="Google Chat space resource name"),
    text: str = typer.Argument(..., help="Message text to send"),
    thread_name: str | None = typer.Option(None, "--thread", help="Thread resource name"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Send a message to a Google Chat space."""
    from .client import _client

    client = _client()
    result = client.send_message(space_name, text, thread_name=thread_name)

    if json_output:
        print(json.dumps(result, indent=2))
        return

    console.print(f"[green]Message sent[/green] → {result.get('name', 'unknown')}")


@app.command()
def list_messages(
    space_name: str = typer.Argument(
        ...,
        help="Space resource name, bare id, or a chat.google.com link (a link scopes to its thread)",
    ),
    thread: str | None = typer.Option(
        None,
        "--thread",
        "-t",
        help="Scope to one thread: resource name, bare thread id, or chat.google.com link",
    ),
    page_size: int = typer.Option(20, "--page-size", "-n", help="Number of messages per page"),
    page_token: str | None = typer.Option(
        None, "--page-token", help="nextPageToken from a prior call, to fetch the next page"
    ),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """List messages in a Google Chat space, or a single thread within it.

    Examples:
        google-chat list-messages spaces/AAAA
        google-chat list-messages spaces/AAAA -t spaces/AAAA/threads/TTTT
        google-chat list-messages "https://chat.google.com/room/AAAA/TTTT/TTTT"
    """
    from .client import _client, resolve_space_and_thread

    space_id, thread_name = resolve_space_and_thread(space_name, thread)
    filter_expr = f'thread.name = "{thread_name}"' if thread_name else None

    client = _client()
    result = client.list_messages(
        space_id, page_size=page_size, filter=filter_expr, page_token=page_token
    )

    if json_output:
        print(json.dumps(result, indent=2))
        return

    messages = result.get("messages", [])
    table = Table(title=f"Messages in {thread_name or f'spaces/{space_id}'}")
    table.add_column("Time", style="dim")
    table.add_column("Sender", style="green")
    table.add_column("Text", style="white")
    for msg in messages:
        table.add_row(
            (msg.get("createTime", "") or "")[:19],
            (msg.get("sender", {}).get("displayName", "") or "")[:20],
            (msg.get("text", "") or "")[:100],
        )
    console.print(table)

    next_token = result.get("nextPageToken")
    if next_token:
        console.print(f"[dim]more: --page-token {next_token}[/dim]")


@app.command()
def update_message(
    message_name: str = typer.Argument(..., help="Message resource name"),
    text: str = typer.Argument(..., help="New message text"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Update a message in a Google Chat space."""
    from .client import _client

    client = _client()
    result = client.update_message(message_name, text)

    if json_output:
        print(json.dumps(result, indent=2))
        return

    console.print(f"[green]Message updated[/green] → {result.get('name', 'unknown')}")


@app.command()
def delete_message(
    message_name: str = typer.Argument(..., help="Message resource name"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Delete a message from a Google Chat space."""
    from .client import _client

    client = _client()
    result = client.delete_message(message_name)

    if json_output:
        print(json.dumps(result, indent=2))
        return

    console.print(f"[green]Message deleted[/green] → {message_name}")


@app.command()
def upload(
    space_name: str = typer.Argument(..., help="Google Chat space resource name, e.g. spaces/AAAA"),
    file: str = typer.Argument(..., help="Path of the file to upload"),
    thread_name: str | None = typer.Option(None, "--thread", help="Thread resource name to reply into"),
    text: str | None = typer.Option(None, "--text", "-t", help="Caption to post with the file"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Upload a file into a Google Chat space (optionally threaded).

    Examples:
        google-chat upload spaces/AAAA report.pdf --thread spaces/AAAA/threads/BBBB
        google-chat upload spaces/AAAA chart.png -t "Latency over the last week"
    """
    import mimetypes
    from pathlib import Path

    from .client import _client

    path = Path(file)
    if not path.is_file():
        console.print(f"[red]Error: no such file: {file}[/red]")
        raise typer.Exit(1)

    mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    client = _client()
    result = client.upload_attachment(
        space_name,
        path.name,
        path.read_bytes(),
        mime_type=mime_type,
        text=text,
        thread_name=thread_name,
    )

    if json_output:
        print(json.dumps(result, indent=2))
        return

    console.print(f"[green]File uploaded[/green] → {result.get('name', 'unknown')}")


@app.command()
def health():
    """Assert googlechatbot connectivity with the unauthenticated health check."""
    from .client import _client

    try:
        details = _client().health()
        payload = {"ok": True, "tool": "google_chat", "error": None, "details": details}
    except Exception as exc:
        payload = {"ok": False, "tool": "google_chat", "error": str(exc), "details": {}}
        print(json.dumps(payload, indent=2, ensure_ascii=False, default=str))
        raise typer.Exit(1) from exc
    print(json.dumps(payload, indent=2, ensure_ascii=False, default=str))

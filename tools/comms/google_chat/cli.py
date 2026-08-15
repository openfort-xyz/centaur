"""Google Chat CLI."""

from dotenv import load_dotenv

load_dotenv()

import json  # noqa: E402

import typer  # noqa: E402
from rich.console import Console  # noqa: E402
from rich.table import Table  # noqa: E402

from .client import _client  # noqa: E402

app = typer.Typer(name="google-chat", help="Google Chat CLI for AI agents")
console = Console()


def _print_result(result: dict, json_output: bool, title: str, key: str) -> None:
    if json_output:
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return
    items = result.get(key) or []
    table = Table(title=title)
    table.add_column("Name", style="cyan")
    table.add_column("Details")
    for item in items:
        table.add_row(
            str(item.get("name") or item.get("messageName") or item.get("timestamp") or "")[:70],
            str(
                item.get("text")
                or item.get("displayName")
                or item.get("state")
                or item.get("emoji")
                or ""
            )[:120],
        )
    console.print(table)
    if result.get("next_page_token"):
        console.print(f"[yellow]Next page token:[/] {result['next_page_token']}")
    if result.get("truncated"):
        console.print(
            "[yellow]Scan truncated; continue with the returned token or a higher bound.[/]"
        )


@app.command()
def send_message(
    space_name: str = typer.Argument(..., help="Google Chat space resource name"),
    text: str = typer.Argument(..., help="Message text to send"),
    thread_name: str | None = typer.Option(None, "--thread", help="Thread resource name"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Send a message to a Google Chat space."""
    client = _client()
    result = client.send_message(space_name, text, thread_name=thread_name)

    if json_output:
        print(json.dumps(result, indent=2))
        return

    console.print(f"[green]Message sent[/green] → {result.get('name', 'unknown')}")


@app.command()
def list_messages(
    space_name: str = typer.Argument(..., help="Google Chat space resource name"),
    page_size: int = typer.Option(20, "--page-size", "-n", help="Number of messages per page"),
    page_token: str | None = typer.Option(None, "--page-token", help="Token from nextPageToken"),
    filter: str | None = typer.Option(None, "--filter", help="Google Chat message filter"),
    order_by: str | None = typer.Option(None, "--order-by", help="Message order: ASC or DESC"),
    all_pages: bool = typer.Option(False, "--all-pages", help="Follow nextPageToken automatically"),
    max_pages: int = typer.Option(20, "--max-pages", min=1, help="Safety cap with --all-pages"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """List messages in a Google Chat space."""
    client = _client()
    if all_pages:
        messages = []
        pages_fetched = 0
        token = page_token
        seen_tokens = {token} if token else set()
        while pages_fetched < max_pages:
            result = client.list_messages(
                space_name,
                page_size=page_size,
                page_token=token,
                filter=filter,
                order_by=order_by,
            )
            messages.extend(result.get("messages") or [])
            pages_fetched += 1
            token = result.get("next_page_token") or result.get("nextPageToken")
            if not token:
                break
            if token in seen_tokens:
                raise RuntimeError(f"Google Chat repeated page token {token!r}")
            seen_tokens.add(token)
        result = {"messages": messages, "pagesFetched": pages_fetched}
        if token:
            result["nextPageToken"] = token
    else:
        result = client.list_messages(
            space_name,
            page_size=page_size,
            page_token=page_token,
            filter=filter,
            order_by=order_by,
        )

    if json_output:
        print(json.dumps(result, indent=2))
        return

    messages = result.get("messages", [])
    table = Table(title=f"Messages in {space_name}")
    table.add_column("Name", style="cyan")
    table.add_column("Text", style="white")
    for msg in messages[:20]:
        table.add_row(
            msg.get("name", "unknown")[:50],
            (msg.get("text", "") or "")[:100],
        )
    console.print(table)
    if result.get("next_page_token"):
        console.print(f"[yellow]Next page token:[/] {result['next_page_token']}")


@app.command()
def spaces(
    page_size: int = typer.Option(20, "--page-size", "-n"),
    page_token: str | None = typer.Option(None, "--page-token"),
    json_output: bool = typer.Option(False, "--json"),
):
    """List spaces authorized for this principal."""
    result = _client().list_spaces(page_size=page_size, page_token=page_token)
    _print_result(result, json_output, "Authorized Google Chat spaces", "spaces")


@app.command("space-info")
def space_info(
    space_name: str = typer.Argument(...),
    json_output: bool = typer.Option(False, "--json"),
):
    """Get metadata for one authorized space."""
    result = _client().get_space(space_name)
    if json_output:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        console.print(f"[bold]{result.get('displayName') or result.get('name') or space_name}[/]")
        console.print(f"Type: {result.get('spaceType') or result.get('type') or 'unknown'}")


@app.command()
def members(
    space_name: str = typer.Argument(...),
    page_size: int = typer.Option(20, "--page-size", "-n"),
    page_token: str | None = typer.Option(None, "--page-token"),
    json_output: bool = typer.Option(False, "--json"),
):
    """List members of an authorized space."""
    result = _client().list_members(space_name, page_size=page_size, page_token=page_token)
    _print_result(result, json_output, f"Members in {space_name}", "memberships")


@app.command()
def thread(
    thread_name: str = typer.Argument(...),
    page_size: int = typer.Option(20, "--page-size", "-n"),
    page_token: str | None = typer.Option(None, "--page-token"),
    json_output: bool = typer.Option(False, "--json"),
):
    """List messages in one authorized thread."""
    result = _client().list_thread_messages(thread_name, page_size=page_size, page_token=page_token)
    _print_result(result, json_output, thread_name, "messages")


@app.command()
def reactions(
    space_name: str = typer.Argument(...),
    page_size: int = typer.Option(100, "--page-size", "-n"),
    max_pages: int = typer.Option(5, "--max-pages", min=1),
    json_output: bool = typer.Option(False, "--json"),
):
    """List reaction summaries; reaction mutation is intentionally unsupported."""
    result = _client().list_reactions(space_name, page_size=page_size, max_pages=max_pages)
    _print_result(result, json_output, f"Reactions in {space_name}", "reactions")


@app.command()
def search(
    space_name: str = typer.Argument(...),
    query: str = typer.Argument(...),
    page_size: int = typer.Option(100, "--page-size", "-n"),
    max_pages: int = typer.Option(5, "--max-pages", min=1),
    json_output: bool = typer.Option(False, "--json"),
):
    """Search an authorized, bounded history scan."""
    result = _client().search_messages(space_name, query, page_size=page_size, max_pages=max_pages)
    _print_result(result, json_output, f"Matches for {query!r}", "messages")


@app.command()
def dm(
    target: str = typer.Argument(..., help="Authorized user email address"),
    text: str = typer.Argument(...),
    json_output: bool = typer.Option(False, "--json"),
):
    """Create or reuse an authorized DM, then send a message."""
    result = _client().send_dm(target, text)
    if json_output:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        console.print(f"[green]Message sent[/green] → {result['message'].get('name', 'unknown')}")


@app.command()
def questions(
    space_name: str = typer.Argument(...),
    page_size: int = typer.Option(100, "--page-size", "-n"),
    max_pages: int = typer.Option(5, "--max-pages", min=1),
    json_output: bool = typer.Option(False, "--json"),
):
    """Find question-like messages in bounded authorized history."""
    result = _client().questions(space_name, page_size=page_size, max_pages=max_pages)
    _print_result(result, json_output, f"Questions in {space_name}", "questions")


@app.command()
def dump(
    space_name: str = typer.Argument(...),
    page_size: int = typer.Option(100, "--page-size", "-n"),
    max_pages: int = typer.Option(5, "--max-pages", min=1),
    max_threads: int = typer.Option(50, "--max-threads", min=0),
):
    """Dump bounded space history with threads and reactions as JSON."""
    result = _client().dump(
        space_name, page_size=page_size, max_pages=max_pages, max_threads=max_threads
    )
    print(json.dumps(result, indent=2, ensure_ascii=False))


@app.command()
def feedback(
    space_name: str = typer.Argument(...),
    page_size: int = typer.Option(100, "--page-size", "-n"),
    max_pages: int = typer.Option(5, "--max-pages", min=1),
    json_output: bool = typer.Option(False, "--json"),
):
    """Extract bounded reaction/text feedback signals from one authorized space."""
    result = _client().feedback(space_name, page_size=page_size, max_pages=max_pages)
    _print_result(result, json_output, f"Feedback in {space_name}", "items")


@app.command()
def update_message(
    message_name: str = typer.Argument(..., help="Message resource name"),
    text: str = typer.Argument(..., help="New message text"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Update a message in a Google Chat space."""
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
    thread_name: str | None = typer.Option(
        None, "--thread", help="Thread resource name to reply into"
    ),
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
def files(
    space_name: str = typer.Argument(..., help="Google Chat space resource name"),
    page_size: int = typer.Option(100, "--page-size", "-n", min=1, max=1000),
    page_token: str | None = typer.Option(None, "--page-token"),
    json_output: bool = typer.Option(False, "--json"),
):
    """List attachments derived from messages in one authorized space."""
    result = _client().list_files(space_name, page_size=page_size, page_token=page_token)
    _print_result(result, json_output, f"Files in {space_name}", "files")


@app.command("search-files")
def search_files(
    space_name: str = typer.Argument(..., help="Google Chat space resource name"),
    query: str = typer.Argument(..., help="Filename or MIME-type search"),
    page_size: int = typer.Option(100, "--page-size", "-n", min=1, max=1000),
    max_pages: int = typer.Option(5, "--max-pages", min=1),
    json_output: bool = typer.Option(False, "--json"),
):
    """Search a bounded number of attachment pages in one authorized space."""
    result = _client().search_files(
        space_name, query, page_size=page_size, max_pages=max_pages
    )
    _print_result(result, json_output, f"Files matching {query!r}", "files")


@app.command("file-info")
def file_info(
    attachment_name: str = typer.Argument(..., help="Full attachment resource name"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Get metadata for one message-qualified attachment."""
    result = _client().file_info(attachment_name)
    if json_output:
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return
    table = Table(title="Google Chat file")
    table.add_column("Field", style="cyan")
    table.add_column("Value")
    for key in ("name", "contentName", "contentType", "source"):
        if result.get(key) not in (None, ""):
            table.add_row(key, str(result[key]))
    console.print(table)


@app.command()
def download(
    attachment_name: str = typer.Argument(..., help="Full attachment resource name"),
    output: str = typer.Option(".", "--output", "-o", help="Output directory"),
    max_bytes: int = typer.Option(
        10 * 1024 * 1024, "--max-bytes", min=1, help="Maximum downloaded bytes"
    ),
    json_output: bool = typer.Option(False, "--json"),
):
    """Download raw attachment bytes through the scoped API proxy."""
    from pathlib import Path

    result = _client().download_file(attachment_name, max_bytes=max_bytes)
    output_dir = Path(output)
    output_dir.mkdir(parents=True, exist_ok=True)
    filename = Path(str(result["filename"])).name or "attachment"
    destination = output_dir / filename
    if destination.exists():
        raise typer.BadParameter(f"refusing to overwrite existing file: {destination}")
    destination.write_bytes(result["content"])
    metadata = {key: value for key, value in result.items() if key != "content"}
    metadata["path"] = str(destination)
    if json_output:
        print(json.dumps(metadata, indent=2, ensure_ascii=False))
        return
    console.print(f"[green]Downloaded[/green] → {destination} ({result['size_bytes']} bytes)")


@app.command()
def health():
    """Assert Google Chat connectivity through the scoped api-rs proxy."""
    try:
        details = _client().health()
        payload = {"ok": True, "tool": "google_chat", "error": None, "details": details}
    except Exception as exc:
        payload = {"ok": False, "tool": "google_chat", "error": str(exc), "details": {}}
        print(json.dumps(payload, indent=2, ensure_ascii=False, default=str))
        raise typer.Exit(1) from exc
    print(json.dumps(payload, indent=2, ensure_ascii=False, default=str))

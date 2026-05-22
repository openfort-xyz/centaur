"""App Store Connect CLI."""

from dotenv import load_dotenv
load_dotenv()

import json
import typer
from rich.console import Console
from centaur_sdk import Table

app = typer.Typer(name="app-store", help="App Store Connect CLI")
console = Console()


@app.command()
def list_apps(json_output: bool = typer.Option(False, "--json")):
    """List apps."""
    from .client import _client
    c = _client()
    result = c.list_apps()
    apps = result.get("data", [])
    if json_output: print(json.dumps(apps, indent=2)); return
    table = Table(title="App Store Apps")
    table.add_column("ID", style="cyan"); table.add_column("Name", style="white"); table.add_column("Bundle ID", style="green")
    for app in apps:
        attrs = app.get("attributes", {})
        table.add_row(app.get("id", "")[:10], attrs.get("name", ""), attrs.get("bundleId", ""))
    console.print(table)


@app.command()
def customer_reviews(
    app_id: str = typer.Argument(..., help="App Store app ID"),
    limit: int = typer.Option(20, "--limit", "-n"),
    json_output: bool = typer.Option(False, "--json"),
):
    """List customer reviews."""
    from .client import _client
    c = _client()
    result = c.list_customer_reviews(app_id, limit=limit)
    reviews = result.get("data", [])
    if json_output: print(json.dumps(reviews, indent=2)); return
    for rev in reviews[:20]:
        attrs = rev.get("attributes", {})
        rating = attrs.get("rating", "?")
        title = attrs.get("title", "")[:60]
        body = (attrs.get("body", "") or "")[:100]
        console.print(f"[bold]{'⭐' * rating} {title}[/bold]")
        console.print(f"  {body}")


@app.command()
def builds(
    app_id: str = typer.Argument(..., help="App Store app ID"),
    limit: int = typer.Option(20, "--limit", "-n"),
    json_output: bool = typer.Option(False, "--json"),
):
    """List builds (TestFlight)."""
    from .client import _client
    c = _client()
    result = c.list_builds(app_id, limit=limit)
    builds = result.get("data", [])
    if json_output: print(json.dumps(builds, indent=2)); return
    table = Table(title=f"Builds — {app_id}")
    table.add_column("Version", style="cyan"); table.add_column("Uploaded", style="white"); table.add_column("Processing State", style="green")
    for b in builds:
        attrs = b.get("attributes", {})
        table.add_row(attrs.get("version", ""), (attrs.get("uploadedDate", "") or "")[:19], attrs.get("processingState", ""))
    console.print(table)

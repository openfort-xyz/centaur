"""Cloudflare CLI for zone analytics."""

import json

import typer
from dotenv import load_dotenv
from rich.console import Console

from centaur_sdk import Table

load_dotenv()

app = typer.Typer(name="cloudflare", help="Cloudflare zone analytics CLI")
console = Console()


@app.command()
def list_zones(
    json_output: bool = typer.Option(False, "--json"),
):
    """List Cloudflare zones."""
    from .client import _client

    c = _client()
    result = c.list_zones()
    zones = result.get("result", [])
    if json_output:
        print(json.dumps(zones, indent=2))
        return
    table = Table(title="Cloudflare Zones")
    table.add_column("ID", style="cyan")
    table.add_column("Name", style="white")
    table.add_column("Status", style="green")
    table.add_column("Plan", style="blue")
    for z in zones:
        table.add_row(
            z.get("id", "")[:20],
            z.get("name", ""),
            z.get("status", ""),
            (z.get("plan", {}) or {}).get("name", ""),
        )
    console.print(table)


@app.command()
def zone_analytics(
    zone_id: str = typer.Argument(..., help="Zone ID"),
    since: str | None = typer.Option(None, "--since", help="Start time (ISO 8601 or -6h)"),
    until: str | None = typer.Option(None, "--until"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Get zone analytics dashboard data."""
    from .client import _client

    c = _client()
    result = c.get_zone_analytics(zone_id, since=since, until=until)
    if json_output:
        print(json.dumps(result, indent=2))
        return
    data = result.get("result", {})
    timeseries = data.get("timeseries", [])
    totals = data.get("totals", {})
    console.print("[bold]Analytics Totals[/bold]")
    for k in ("requests", "bandwidth", "threats", "pageviews", "visitors"):
        v = totals.get(k, {})
        if isinstance(v, dict):
            console.print(f"  {k}: total/all={v.get('all', '?')}")
    if timeseries:
        console.print(
            f"[bold]Timeseries ({len(timeseries)} points)[/bold]: "
            f"first={timeseries[0]}, last={timeseries[-1]}"
        )


@app.command()
def list_dns(
    zone_id: str = typer.Argument(..., help="Zone ID"),
    json_output: bool = typer.Option(False, "--json"),
):
    """List DNS records."""
    from .client import _client

    c = _client()
    result = c.list_dns_records(zone_id)
    records = result.get("result", [])
    if json_output:
        print(json.dumps(records, indent=2))
        return
    table = Table(title="DNS Records")
    table.add_column("Type", style="cyan")
    table.add_column("Name", style="white")
    table.add_column("Content", style="green")
    table.add_column("Proxied", style="blue")
    for r in records:
        table.add_row(
            r.get("type", ""),
            r.get("name", "")[:40],
            r.get("content", "")[:50],
            str(r.get("proxied", False)),
        )
    console.print(table)

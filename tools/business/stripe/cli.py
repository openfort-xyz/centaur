"""Stripe CLI for billing data."""

import json
from datetime import UTC, datetime

import typer
from dotenv import load_dotenv
from rich.console import Console

from centaur_sdk import Table

load_dotenv()

app = typer.Typer(name="stripe", help="Stripe billing and subscription CLI")
console = Console()


def _amt(a: dict) -> str:
    amt = a.get("amount", 0)
    cur = a.get("currency", "usd").upper()
    return f"{(amt / 100):.2f} {cur}"


def _ts(ts: int | None) -> str:
    if not ts:
        return ""
    return datetime.fromtimestamp(ts, tz=UTC).strftime("%Y-%m-%d")


@app.command()
def list_customers(
    email: str | None = typer.Option(None, "--email"),
    limit: int = typer.Option(10, "--limit", "-n"),
    json_output: bool = typer.Option(False, "--json"),
):
    """List customers."""
    from .client import _client

    c = _client()
    result = c.list_customers(email=email, limit=limit)
    customers = result.get("data", [])
    if json_output:
        print(json.dumps(customers, indent=2))
        return
    table = Table(title="Stripe Customers")
    table.add_column("ID", style="cyan")
    table.add_column("Email", style="white")
    table.add_column("Name", style="green")
    table.add_column("Created", style="blue")
    for cu in customers:
        table.add_row(
            cu.get("id", ""),
            (cu.get("email", "") or "")[:40],
            (cu.get("name", "") or "")[:30],
            _ts(cu.get("created")),
        )
    console.print(table)


@app.command()
def list_subscriptions(
    customer_id: str | None = typer.Option(None, "--customer", "-c"),
    status: str | None = typer.Option(None, "--status", "-s"),
    limit: int = typer.Option(10, "--limit", "-n"),
    json_output: bool = typer.Option(False, "--json"),
):
    """List subscriptions."""
    from .client import _client

    c = _client()
    result = c.list_subscriptions(customer_id=customer_id, status=status, limit=limit)
    subs = result.get("data", [])
    if json_output:
        print(json.dumps(subs, indent=2))
        return
    table = Table(title="Subscriptions")
    table.add_column("ID", style="cyan")
    table.add_column("Status", style="yellow")
    table.add_column("Amount", style="green")
    table.add_column("Customer", style="white")
    for s in subs:
        items = s.get("items", {}).get("data")
        price = items[0].get("price", {}) if items else s.get("plan", {})
        table.add_row(
            s.get("id", "")[:20],
            s.get("status", ""),
            _amt(price),
            (s.get("customer", "") or "")[:20],
        )
    console.print(table)


@app.command()
def list_invoices(
    customer_id: str | None = typer.Option(None, "--customer", "-c"),
    status: str | None = typer.Option(None, "--status", "-s"),
    limit: int = typer.Option(10, "--limit", "-n"),
    json_output: bool = typer.Option(False, "--json"),
):
    """List invoices."""
    from .client import _client

    c = _client()
    result = c.list_invoices(customer_id=customer_id, status=status, limit=limit)
    invoices = result.get("data", [])
    if json_output:
        print(json.dumps(invoices, indent=2))
        return
    table = Table(title="Invoices")
    table.add_column("ID", style="cyan")
    table.add_column("Amount", style="green")
    table.add_column("Status", style="yellow")
    table.add_column("Due", style="blue")
    for inv in invoices:
        table.add_row(
            inv.get("id", "")[:20],
            _amt(inv),
            inv.get("status", ""),
            (inv.get("due_date", "") or ""),
        )
    console.print(table)


@app.command()
def get_balance(json_output: bool = typer.Option(False, "--json")):
    """Get account balance."""
    from .client import _client

    c = _client()
    result = c.get_balance()
    if json_output:
        print(json.dumps(result, indent=2))
        return
    for bal in result.get("available", []):
        console.print(f"Available: {_amt(bal)}")
    for bal in result.get("pending", []):
        console.print(f"Pending: {_amt(bal)}")

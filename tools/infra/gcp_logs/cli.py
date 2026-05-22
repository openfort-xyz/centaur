"""GCP Cloud Logging CLI."""

from dotenv import load_dotenv
load_dotenv()

import json
import typer
from rich.console import Console
from centaur_sdk import Table

app = typer.Typer(name="gcp-logs", help="GCP Cloud Logging query CLI")
console = Console()


@app.command()
def query(
    project_id: str = typer.Argument(..., help="GCP project ID"),
    filter: str = typer.Argument(..., help="Logging query filter"),
    page_size: int = typer.Option(50, "--limit", "-n"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Query logs for a GCP project."""
    from .client import _client
    c = _client()
    result = c.query_logs(project_id, filter, page_size=page_size)
    entries = result.get("entries", [])
    if json_output: print(json.dumps(result, indent=2)); return
    console.print(f"[bold]{len(entries)} log entries[/bold]")
    for entry in entries[:20]:
        ts = entry.get("timestamp", "")[:19]
        severity = entry.get("severity", "")
        msg = (entry.get("textPayload", "") or json.dumps(entry.get("jsonPayload", {})))[:120]
        console.print(f"  [{severity}] {ts}: {msg}")


@app.command()
def gke_logs(
    project_id: str = typer.Argument(..., help="GCP project ID"),
    cluster: str | None = typer.Option(None, "--cluster"),
    namespace: str | None = typer.Option(None, "--namespace"),
    container: str | None = typer.Option(None, "--container"),
    severity: str = typer.Option("ERROR", "--severity"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Get GKE container logs."""
    from .client import _client
    c = _client()
    result = c.get_gke_logs(project_id, cluster_name=cluster, namespace=namespace, container_name=container, severity=severity)
    entries = result.get("entries", [])
    if json_output: print(json.dumps(entries, indent=2)); return
    console.print(f"[bold]{len(entries)} GKE log entries[/bold]")
    for entry in entries[:20]:
        ts = entry.get("timestamp", "")[:19]
        severity = entry.get("severity", "")
        labels = entry.get("resource", {}).get("labels", {})
        pod = labels.get("pod_name", "")
        msg = (entry.get("textPayload", "") or "")[:100]
        console.print(f"  [{severity}] {ts} | {pod} | {msg}")


@app.command()
def cloud_run_logs(
    project_id: str = typer.Argument(..., help="GCP project ID"),
    service: str | None = typer.Option(None, "--service"),
    severity: str = typer.Option("ERROR", "--severity"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Get Cloud Run revision logs."""
    from .client import _client
    c = _client()
    result = c.get_cloud_run_logs(project_id, service_name=service, severity=severity)
    entries = result.get("entries", [])
    if json_output: print(json.dumps(entries, indent=2)); return
    for entry in entries[:20]:
        ts = entry.get("timestamp", "")[:19]
        msg = (entry.get("textPayload", "") or "")[:120]
        console.print(f"  {ts}: {msg}")

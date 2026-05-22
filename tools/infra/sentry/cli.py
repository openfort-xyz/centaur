"""Sentry CLI for error monitoring and issue triage."""

from dotenv import load_dotenv

load_dotenv()

import json
import typer
from rich.console import Console
from centaur_sdk import Table, render_text_table

app = typer.Typer(name="sentry", help="Sentry error tracking and issue management CLI")
console = Console()


def _format_issue_summary(issue: dict) -> dict:
    return {
        "id": issue.get("id"),
        "short_id": issue.get("shortId"),
        "title": issue.get("title", ""),
        "level": issue.get("level"),
        "status": issue.get("status"),
        "count": issue.get("count"),
        "user_count": issue.get("userCount", 0),
        "first_seen": issue.get("firstSeen"),
        "last_seen": issue.get("lastSeen"),
        "culprit": issue.get("culprit", ""),
        "project": (issue.get("project") or {}).get("slug", ""),
        "permalink": issue.get("permalink", ""),
    }


def _print_issue_table(issues: list[dict], title: str = "Issues") -> None:
    if not issues:
        console.print("[yellow]No issues found.[/yellow]")
        return
    table = Table(title=title)
    table.add_column("ID", style="cyan")
    table.add_column("Short ID", style="magenta")
    table.add_column("Title", style="white")
    table.add_column("Level", style="red")
    table.add_column("Status", style="yellow")
    table.add_column("Events", style="green")
    table.add_column("Users", style="blue")
    for issue in issues[:50]:
        s = _format_issue_summary(issue)
        table.add_row(
            str(s["id"] or ""),
            str(s["short_id"] or ""),
            (s["title"] or "")[:60],
            str(s["level"] or ""),
            str(s["status"] or ""),
            str(s["count"] or ""),
            str(s["user_count"] or ""),
        )
    console.print(table)


# ── Issues ────────────────────────────────────────────────────────────────

@app.command()
def list_issues(
    organization_slug: str = typer.Argument(..., help="Organization slug"),
    project_slug: str | None = typer.Option(None, "--project", "-p", help="Filter by project slug"),
    query: str | None = typer.Option(None, "--query", "-q", help='Search query (e.g. "is:unresolved")'),
    stats_period: str | None = typer.Option(None, "--stats-period", help="Stats window: 24h, 14d, or empty string"),
    sort: str | None = typer.Option(None, "--sort", help='Sort order: "date", "new", "freq"'),
    limit: int = typer.Option(100, "--limit", "-n", help="Max results (1-100)"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
    markdown: bool = typer.Option(False, "--markdown", "-m", help="Output as markdown table"),
):
    """List issues in a Sentry organization."""
    from .client import _client

    client = _client()
    result = client.list_issues(
        organization_slug,
        project_slug=project_slug,
        query=query,
        stats_period=stats_period,
        sort=sort,
        limit=limit,
    )
    issues = result["body"]

    if json_output:
        print(json.dumps(issues, indent=2))
        return

    if markdown:
        print("| ID | Short ID | Title | Level | Status | Events | Users |")
        print("|----|----------|-------|-------|--------|--------|-------|")
        for issue in issues[:50]:
            s = _format_issue_summary(issue)
            print(
                f"| {s['id']} | {s['short_id']} | {(s['title'] or '')[:50]} "
                f"| {s['level']} | {s['status']} | {s['count']} | {s['user_count']} |"
            )
        return

    _print_issue_table(issues)


@app.command()
def get_issue(
    organization_slug: str = typer.Argument(..., help="Organization slug"),
    issue_id: str = typer.Argument(..., help="Issue ID"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Get full details for a single issue."""
    from .client import _client

    client = _client()
    issue = client.get_issue(organization_slug, issue_id)

    if json_output:
        print(json.dumps(issue, indent=2))
        return

    console.print(f"[bold cyan]{issue.get('title', 'Unknown')}[/bold cyan]")
    console.print(f"  ID: {issue.get('id')}  Short ID: {issue.get('shortId')}")
    console.print(f"  Level: {issue.get('level')}  Status: {issue.get('status')}")
    console.print(f"  Events: {issue.get('count')}  Users: {issue.get('userCount', 0)}")
    console.print(f"  First seen: {issue.get('firstSeen')}  Last seen: {issue.get('lastSeen')}")
    console.print(f"  Culprit: {issue.get('culprit', '')}")
    console.print(f"  Permalink: {issue.get('permalink', '')}")
    if issue.get("metadata"):
        console.print(f"  Metadata: {json.dumps(issue['metadata'], indent=2)}")


@app.command()
def update_issue(
    organization_slug: str = typer.Argument(..., help="Organization slug"),
    issue_id: str = typer.Argument(..., help="Issue ID"),
    status: str | None = typer.Option(None, "--status", help='New status: "resolved", "unresolved", "ignored"'),
    assigned_to: str | None = typer.Option(None, "--assign", help='User ID or "me" to self-assign'),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Update an issue's status or assignment."""
    from .client import _client

    client = _client()
    result = client.update_issue(
        organization_slug, issue_id, status=status, assigned_to=assigned_to
    )

    if json_output:
        print(json.dumps(result, indent=2))
        return

    console.print(f"[green]Issue {issue_id} updated.[/green] Status: {result.get('status')}")


@app.command()
def list_issue_events(
    organization_slug: str = typer.Argument(..., help="Organization slug"),
    issue_id: str = typer.Argument(..., help="Issue ID"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """List individual events for an issue."""
    from .client import _client

    client = _client()
    events = client.list_issue_events(organization_slug, issue_id)

    if json_output:
        print(json.dumps(events, indent=2))
        return

    table = Table(title=f"Issue {issue_id} Events")
    table.add_column("Event ID", style="cyan")
    table.add_column("Date", style="white")
    table.add_column("Title", style="yellow")
    table.add_column("User", style="blue")
    for evt in events[:50]:
        table.add_row(
            str(evt.get("eventID", "") or "")[:32],
            str(evt.get("dateCreated", ""))[:19],
            str(evt.get("title", "") or "")[:60],
            str((evt.get("user") or {}).get("username", "")),
        )
    console.print(table)


@app.command()
def get_issue_tags(
    organization_slug: str = typer.Argument(..., help="Organization slug"),
    issue_id: str = typer.Argument(..., help="Issue ID"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """List tag keys and top values for an issue."""
    from .client import _client

    client = _client()
    tags = client.get_issue_tags(organization_slug, issue_id)

    if json_output:
        print(json.dumps(tags, indent=2))
        return

    table = Table(title=f"Issue {issue_id} Tags")
    table.add_column("Key", style="cyan")
    table.add_column("Total Values", style="green")
    table.add_column("Top Values", style="white")
    for tag in tags:
        top = ", ".join(
            f"{tv.get('value','')}({tv.get('count',0)})"
            for tv in (tag.get("topValues", []) or [])[:5]
        )
        table.add_row(str(tag.get("key", "")), str(tag.get("totalValues", "")), top[:80])
    console.print(table)


# ── Releases ─────────────────────────────────────────────────────────────

@app.command()
def list_releases(
    organization_slug: str = typer.Argument(..., help="Organization slug"),
    query: str | None = typer.Option(None, "--query", "-q", help='"Starts with" filter on version'),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """List releases for an organization."""
    from .client import _client

    client = _client()
    result = client.list_releases(organization_slug, query=query)
    releases = result["body"]

    if json_output:
        print(json.dumps(releases, indent=2))
        return

    table = Table(title=f"Releases for {organization_slug}")
    table.add_column("Version", style="cyan")
    table.add_column("Date Created", style="white")
    table.add_column("Commits", style="green")
    table.add_column("Deploys", style="blue")
    table.add_column("New Groups", style="red")
    for rel in releases[:50]:
        table.add_row(
            str(rel.get("shortVersion") or rel.get("version", ""))[:32],
            str(rel.get("dateCreated", ""))[:19],
            str(rel.get("commitCount", "")),
            str(rel.get("deployCount", "")),
            str(rel.get("newGroups", "")),
        )
    console.print(table)


@app.command()
def get_release(
    organization_slug: str = typer.Argument(..., help="Organization slug"),
    version: str = typer.Argument(..., help="Release version"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Get details for a specific release."""
    from .client import _client

    client = _client()
    release = client.get_release(organization_slug, version)

    if json_output:
        print(json.dumps(release, indent=2))
        return

    console.print(f"[bold cyan]{release.get('shortVersion') or release.get('version')}[/bold cyan]")
    console.print(f"  Date Created: {release.get('dateCreated')}")
    console.print(f"  Date Released: {release.get('dateReleased')}")
    console.print(f"  Ref: {release.get('ref', '')}")
    console.print(f"  Commits: {release.get('commitCount', 0)}  Deploys: {release.get('deployCount', 0)}")
    console.print(f"  New Groups: {release.get('newGroups', 0)}")


# ── Discover ─────────────────────────────────────────────────────────────

@app.command()
def discover(
    organization_slug: str = typer.Argument(..., help="Organization slug"),
    query: str = typer.Argument(..., help="Discover search query"),
    fields: list[str] | None = typer.Option(None, "--field", "-f", help="Fields to return"),
    sort: str | None = typer.Option(None, "--sort", help='Sort expression (e.g. "-timestamp")'),
    limit: int = typer.Option(100, "--limit", "-n", help="Max results"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Run a Discover query against Sentry event data."""
    from .client import _client

    client = _client()
    result = client.discover_query(
        organization_slug,
        query=query,
        fields=fields,
        sort=sort,
        limit=limit,
    )

    if json_output:
        print(json.dumps(result, indent=2))
        return

    data = result.get("data", [])
    if not data:
        console.print("[yellow]No results.[/yellow]")
        return
    meta = result.get("meta", {})
    headers = list(data[0].keys()) if data else []
    table = Table(title="Discover Results")
    for header in headers[:8]:
        table.add_column(header, style="cyan")
    for row in data[:50]:
        table.add_row(*[str(row.get(h, ""))[:40] for h in headers[:8]])
    console.print(table)


# ── Projects ─────────────────────────────────────────────────────────────

@app.command()
def list_projects(
    organization_slug: str = typer.Argument(..., help="Organization slug"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """List all projects in an organization."""
    from .client import _client

    client = _client()
    projects = client.list_projects(organization_slug)

    if json_output:
        print(json.dumps(projects, indent=2))
        return

    table = Table(title=f"Projects in {organization_slug}")
    table.add_column("Slug", style="cyan")
    table.add_column("Name", style="white")
    table.add_column("ID", style="green")
    table.add_column("Platform", style="blue")
    for proj in projects:
        table.add_row(
            str(proj.get("slug", "")),
            str(proj.get("name", "")),
            str(proj.get("id", "")),
            str(proj.get("platform", "") or ""),
        )
    console.print(table)

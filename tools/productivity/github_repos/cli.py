"""GitHub Repos CLI for code and issue operations."""

from dotenv import load_dotenv
load_dotenv()

import json
import typer
from rich.console import Console
from centaur_sdk import Table

app = typer.Typer(name="github-repos", help="GitHub repository operations CLI")
console = Console()


@app.command()
def get_repo(
    owner: str = typer.Argument(..., help="Owner (user or org)"),
    repo: str = typer.Argument(..., help="Repository name"),
    json_output: bool = typer.Option(False, "--json", help="Output as JSON"),
):
    """Get repository details."""
    from .client import _client
    c = _client()
    result = c.get_repo(owner, repo)
    if json_output:
        print(json.dumps(result, indent=2))
        return
    console.print(f"[bold cyan]{result.get('full_name')}[/bold cyan]")
    console.print(f"  Description: {result.get('description', '')}")
    console.print(f"  Stars: {result.get('stargazers_count', 0)}  Forks: {result.get('forks_count', 0)}")
    console.print(f"  Language: {result.get('language', '')}  License: {(result.get('license') or {}).get('spdx_id', '')}")
    console.print(f"  Open Issues: {result.get('open_issues_count', 0)}")


@app.command()
def list_issues(
    owner: str = typer.Argument(..., help="Owner"),
    repo: str = typer.Argument(..., help="Repository"),
    state: str = typer.Option("open", "--state", help="open, closed, all"),
    labels: str | None = typer.Option(None, "--labels", help="Comma-separated labels"),
    per_page: int = typer.Option(30, "--per-page", "-n"),
    json_output: bool = typer.Option(False, "--json"),
    markdown: bool = typer.Option(False, "--markdown", "-m"),
):
    """List issues in a repository."""
    from .client import _client
    c = _client()
    result = c.list_issues(owner, repo, state=state, labels=labels, per_page=per_page)
    issues = result["body"]
    if json_output:
        print(json.dumps(issues, indent=2))
        return
    if markdown:
        print("| # | Title | State | Assignee | Labels |")
        print("|---|-------|-------|----------|--------|")
        for i in issues:
            print(f"| {i.get('number','')} | {(i.get('title','') or '')[:50]} | {i.get('state','')} | {(i.get('assignee') or {}).get('login','')} | {','.join([l.get('name','') for l in i.get('labels',[])])} |")
        return
    table = Table(title=f"Issues — {owner}/{repo}")
    table.add_column("#", style="cyan"); table.add_column("Title", style="white"); table.add_column("State", style="yellow"); table.add_column("Assignee", style="green")
    for i in issues:
        table.add_row(str(i.get("number", "")), (i.get("title", "") or "")[:60], i.get("state", ""), (i.get("assignee") or {}).get("login", ""))
    console.print(table)


@app.command()
def create_issue(
    owner: str = typer.Argument(..., help="Owner"),
    repo: str = typer.Argument(..., help="Repository"),
    title: str = typer.Argument(..., help="Issue title"),
    body: str | None = typer.Option(None, "--body", "-b"),
    labels: list[str] | None = typer.Option(None, "--label"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Create a new issue."""
    from .client import _client
    c = _client()
    result = c.create_issue(owner, repo, title, body=body, labels=labels)
    if json_output: print(json.dumps(result, indent=2)); return
    console.print(f"[green]Created issue #{result.get('number')}[/green]: {result.get('html_url')}")


@app.command()
def list_pull_requests(
    owner: str = typer.Argument(..., help="Owner"),
    repo: str = typer.Argument(..., help="Repository"),
    state: str = typer.Option("open", "--state"),
    per_page: int = typer.Option(30, "--per-page", "-n"),
    json_output: bool = typer.Option(False, "--json"),
    markdown: bool = typer.Option(False, "--markdown", "-m"),
):
    """List pull requests."""
    from .client import _client
    c = _client()
    result = c.list_pull_requests(owner, repo, state=state, per_page=per_page)
    prs = result["body"]
    if json_output: print(json.dumps(prs, indent=2)); return
    if markdown:
        print("| # | Title | Head → Base | Draft |")
        print("|---|-------|-------------|-------|")
        for p in prs: print(f"| {p.get('number','')} | {(p.get('title','') or '')[:50]} | {p.get('head',{}).get('ref','')} → {p.get('base',{}).get('ref','')} | {p.get('draft',False)} |")
        return
    table = Table(title=f"PRs — {owner}/{repo}")
    table.add_column("#", style="cyan"); table.add_column("Title", style="white"); table.add_column("Branch", style="green"); table.add_column("Draft", style="yellow")
    for p in prs: table.add_row(str(p.get("number", "")), (p.get("title", "") or "")[:60], f"{p.get('head',{}).get('ref','')} → {p.get('base',{}).get('ref','')}", str(p.get("draft", False)))
    console.print(table)


@app.command()
def create_pr(
    owner: str = typer.Argument(..., help="Owner"),
    repo: str = typer.Argument(..., help="Repository"),
    title: str = typer.Argument(..., help="PR title"),
    head: str = typer.Argument(..., help="Head branch"),
    base: str = typer.Argument(..., help="Base branch"),
    body: str | None = typer.Option(None, "--body", "-b"),
    draft: bool = typer.Option(False, "--draft"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Create a new pull request."""
    from .client import _client
    c = _client()
    result = c.create_pull_request(owner, repo, title, head, base, body=body, draft=draft)
    if json_output: print(json.dumps(result, indent=2)); return
    console.print(f"[green]Created PR #{result.get('number')}[/green]: {result.get('html_url')}")


@app.command()
def review_pr(
    owner: str = typer.Argument(..., help="Owner"),
    repo: str = typer.Argument(..., help="Repository"),
    pull_number: int = typer.Argument(..., help="PR number"),
    body: str = typer.Argument(..., help="Review comment body"),
    event: str = typer.Option("COMMENT", "--event", help="APPROVE, REQUEST_CHANGES, COMMENT"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Submit a review on a pull request."""
    from .client import _client
    c = _client()
    result = c.create_pr_review(owner, repo, pull_number, body, event=event)
    if json_output: print(json.dumps(result, indent=2)); return
    console.print(f"[green]Review submitted: {result.get('state')}[/green]")


@app.command()
def search_code(
    query: str = typer.Argument(..., help="Search query"),
    per_page: int = typer.Option(30, "--per-page", "-n"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Search code across repositories."""
    from .client import _client
    c = _client()
    result = c.search_code(query, per_page=per_page)
    items = result.get("items", [])
    if json_output: print(json.dumps(items, indent=2)); return
    table = Table(title=f"Code Search: {query}")
    table.add_column("Repo", style="cyan"); table.add_column("Path", style="white"); table.add_column("URL", style="blue")
    for item in items[:30]: table.add_row(item.get("repository", {}).get("full_name", ""), item.get("path", "")[:60], item.get("html_url", "")[:80])
    console.print(table)


@app.command()
def get_file(
    owner: str = typer.Argument(..., help="Owner"),
    repo: str = typer.Argument(..., help="Repository"),
    path: str = typer.Argument(..., help="File path in repo"),
    ref: str | None = typer.Option(None, "--ref", "-r", help="Branch/tag/commit SHA"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Get file contents from a repository."""
    from .client import _client
    c = _client()
    result = c.get_file_content(owner, repo, path, ref=ref)
    if json_output: print(json.dumps(result, indent=2)); return
    if result.get("type") == "directory":
        entries = result.get("entries", [])
        for e in entries: console.print(f"  {'[DIR]' if e.get('type') == 'dir' else '[FILE]'} {e.get('name')}")
    else:
        console.print(result.get("text", "")[:5000])


@app.command()
def list_commits(
    owner: str = typer.Argument(..., help="Owner"),
    repo: str = typer.Argument(..., help="Repository"),
    sha: str | None = typer.Option(None, "--sha", "-s", help="Branch or commit SHA"),
    per_page: int = typer.Option(30, "--per-page", "-n"),
    json_output: bool = typer.Option(False, "--json"),
):
    """List commits."""
    from .client import _client
    c = _client()
    result = c.list_commits(owner, repo, sha=sha, per_page=per_page)
    commits = result["body"]
    if json_output: print(json.dumps(commits, indent=2)); return
    table = Table(title=f"Commits — {owner}/{repo}")
    table.add_column("SHA", style="cyan"); table.add_column("Message", style="white"); table.add_column("Author", style="green")
    for cmt in commits: table.add_row(cmt.get("sha", "")[:8], (cmt.get("commit", {}).get("message", "") or "").split("\n")[0][:60], (cmt.get("commit", {}).get("author", {}).get("name", "") or ""))
    console.print(table)


@app.command()
def list_releases(
    owner: str = typer.Argument(..., help="Owner"),
    repo: str = typer.Argument(..., help="Repository"),
    per_page: int = typer.Option(30, "--per-page", "-n"),
    json_output: bool = typer.Option(False, "--json"),
):
    """List releases."""
    from .client import _client
    c = _client()
    result = c.list_releases(owner, repo, per_page=per_page)
    releases = result["body"]
    if json_output: print(json.dumps(releases, indent=2)); return
    table = Table(title=f"Releases — {owner}/{repo}")
    table.add_column("Tag", style="cyan"); table.add_column("Name", style="white"); table.add_column("Published", style="blue")
    for rel in releases: table.add_row(rel.get("tag_name", ""), (rel.get("name", "") or rel.get("tag_name", ""))[:40], (rel.get("published_at", "") or "")[:19])
    console.print(table)

"""Exa search CLI."""

from dotenv import load_dotenv
load_dotenv()

import json
import typer
from rich.console import Console
from centaur_sdk import Table

app = typer.Typer(name="exa", help="Exa semantic web search CLI")
console = Console()


@app.command()
def search(
    query: str = typer.Argument(..., help="Search query"),
    num: int = typer.Option(10, "--num", "-n"),
    autoprompt: bool = typer.Option(False, "--autoprompt"),
    json_output: bool = typer.Option(False, "--json"),
    markdown: bool = typer.Option(False, "--markdown", "-m"),
):
    """Semantic search the web."""
    from .client import _client
    c = _client()
    result = c.semantic_search(query, num_results=num, use_autoprompt=autoprompt)
    results = result.get("results", [])
    if json_output: print(json.dumps(results, indent=2)); return
    if markdown:
        print("| Title | URL | Score |")
        print("|-------|-----|-------|")
        for r in results: print(f"| {(r.get('title','') or '')[:50]} | {r.get('url','')[:60]} | {r.get('score','')} |")
        return
    table = Table(title=f"Exa: {query}")
    table.add_column("Title", style="white"); table.add_column("Score", style="cyan"); table.add_column("URL", style="blue")
    for r in results: table.add_row((r.get("title", "") or "")[:80], str(r.get("score", ""))[:6], r.get("url", "")[:80])
    console.print(table)

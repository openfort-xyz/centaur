"""Context7 CLI for library documentation search."""

from dotenv import load_dotenv
load_dotenv()

import json
import typer
from rich.console import Console

app = typer.Typer(name="context7", help="Context7 library documentation search")
console = Console()


@app.command()
def search(
    query: str = typer.Argument(..., help="Search query"),
    library: str | None = typer.Option(None, "--library", "-l"),
    top_k: int = typer.Option(5, "--top", "-n"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Search library documentation."""
    from .client import _client
    c = _client()
    result = c.search_docs(query, library=library, top_k=top_k)
    if json_output: print(json.dumps(result, indent=2)); return
    results = result.get("results", [])
    for r in results:
        console.print(f"[bold cyan]{r.get('library', '')} - {r.get('title', '')}[/bold cyan]")
        console.print(f"  {(r.get('snippet', '') or '')[:200]}")
        console.print()

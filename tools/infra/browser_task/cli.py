"""Browser automation CLI."""

from dotenv import load_dotenv
load_dotenv()

import json
import typer
from rich.console import Console

app = typer.Typer(name="browser-task", help="Browser automation via Playwright")
console = Console()


@app.command()
def navigate(
    url: str = typer.Argument(..., help="URL to navigate to"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Navigate to a URL."""
    from .client import _client
    c = _client()
    result = c.navigate(url)
    if json_output: print(json.dumps(result, indent=2)); return
    console.print(result.get("output", "")[:2000])


@app.command()
def screenshot(
    path: str | None = typer.Option(None, "--path", "-p"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Take a screenshot."""
    from .client import _client
    c = _client()
    result = c.screenshot(path)
    if json_output: print(json.dumps(result, indent=2)); return
    console.print(f"Screenshot saved: {result.get('path') or 'stdout'}")


@app.command()
def get_text(
    selector: str | None = typer.Option(None, "--selector", "-s"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Get page text content."""
    from .client import _client
    c = _client()
    result = c.get_text(selector)
    if json_output: print(json.dumps(result, indent=2)); return
    console.print(result.get("text", "")[:5000])


@app.command()
def click(
    selector: str = typer.Argument(..., help="CSS selector to click"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Click an element."""
    from .client import _client
    c = _client()
    result = c.click(selector)
    if json_output: print(json.dumps(result, indent=2)); return
    console.print(result.get("output", ""))


@app.command()
def fill(
    selector: str = typer.Argument(..., help="CSS selector"),
    text: str = typer.Argument(..., help="Text to fill"),
    json_output: bool = typer.Option(False, "--json"),
):
    """Fill a text input."""
    from .client import _client
    c = _client()
    result = c.fill_input(selector, text)
    if json_output: print(json.dumps(result, indent=2)); return
    console.print("Filled input")

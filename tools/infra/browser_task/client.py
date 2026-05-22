from __future__ import annotations

import os
import subprocess
import json
from typing import Any


class BrowserTaskClient:
    """Browser automation via Playwright.

    Drives a headed Chromium browser for web tasks.
    Uses the Playwright MCP server running locally in the sandbox.

    Requires playwright to be installed in the sandbox environment.
    Uses the `agent-browser` CLI already present in Centaur sandboxes.

    Auth: None (sandbox-local, no external API).
    """

    def __init__(self):
        self._browser_bin = self._find_browser()

    @staticmethod
    def _find_browser() -> str:
        for candidate in (
            os.environ.get("AGENT_BROWSER_BIN", ""),
            "agent-browser",
            "npx playwright",
        ):
            if candidate:
                try:
                    subprocess.run(
                        [candidate.split()[0], "--version"],
                        capture_output=True, timeout=5,
                    )
                    return candidate
                except Exception:
                    continue
        return "agent-browser"

    def navigate(self, url: str) -> dict[str, Any]:
        """Navigate to a URL and return page summary."""
        result = subprocess.run(
            [*self._browser_bin.split(), "navigate", url],
            capture_output=True, text=True, timeout=30,
        )
        return {"url": url, "output": result.stdout, "error": result.stderr}

    def screenshot(self, path: str | None = None) -> dict[str, Any]:
        """Take a screenshot of the current page."""
        args = [*self._browser_bin.split(), "screenshot"]
        if path:
            args.append(path)
        result = subprocess.run(args, capture_output=True, text=True, timeout=15)
        return {"path": path, "output": result.stdout}

    def get_text(self, selector: str | None = None) -> dict[str, Any]:
        """Get text content of the page or an element."""
        args = [*self._browser_bin.split(), "text"]
        if selector:
            args.extend(["--selector", selector])
        result = subprocess.run(args, capture_output=True, text=True, timeout=15)
        return {"text": result.stdout}

    def click(self, selector: str) -> dict[str, Any]:
        """Click an element by CSS selector."""
        result = subprocess.run(
            [*self._browser_bin.split(), "click", selector],
            capture_output=True, text=True, timeout=15,
        )
        return {"selector": selector, "output": result.stdout}

    def fill_input(self, selector: str, text: str) -> dict[str, Any]:
        """Fill a text input field."""
        result = subprocess.run(
            [*self._browser_bin.split(), "fill", selector, text],
            capture_output=True, text=True, timeout=15,
        )
        return {"selector": selector, "text": text, "output": result.stdout}

    def execute_script(self, script: str) -> dict[str, Any]:
        """Execute JavaScript on the page."""
        result = subprocess.run(
            [*self._browser_bin.split(), "eval", script],
            capture_output=True, text=True, timeout=15,
        )
        return {"result": result.stdout}


def _client() -> BrowserTaskClient:
    return BrowserTaskClient()

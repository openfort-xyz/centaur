#!/usr/bin/env python3
"""Import-smoke every agent tool CLI against the current centaur_sdk.

Each tool runs in a sandbox where install_tool_shims provisions an isolated
uv environment with centaur_sdk injected. A change to centaur_sdk's public
surface (e.g. upstream #828 removing the Table re-export) can therefore break
a tool's CLI at import time with no build or CI signal — the agent just
silently loses the tool. This script reproduces that environment cheaply:
for every tool with a [project.scripts] entry it builds an isolated uv env
containing only the tool and its declared dependencies, exposes centaur_sdk
the same way the sandbox does (via PYTHONPATH, not as an installed package),
and imports the entrypoint module.

Usage:
    scripts/check_tool_imports.py --sdk centaur_sdk <repo-root> [<repo-root>...]

Roots are scanned at tools/*/*/pyproject.toml, so an overlay repo checkout
can be passed alongside (or instead of) this repo's root.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path


def tool_pyprojects(root: Path):
    yield from sorted(root.glob("tools/*/*/pyproject.toml"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--sdk", required=True, type=Path, help="path to the centaur_sdk source directory"
    )
    parser.add_argument(
        "roots", nargs="+", type=Path, help="repo roots containing a tools/ directory"
    )
    args = parser.parse_args()

    sdk = args.sdk.resolve()
    if not (sdk / "pyproject.toml").exists():
        print(f"error: {sdk} does not look like a centaur_sdk checkout", file=sys.stderr)
        return 2

    checked = 0
    failures: list[tuple[Path, str, str]] = []
    # The sandbox exposes centaur_sdk to tools via PYTHONPATH (/opt/centaur),
    # not as an installed distribution — see install_tool_shims. Mirror that
    # with a scratch dir holding only a centaur_sdk symlink, so nothing else
    # from the repo root leaks onto sys.path.
    with tempfile.TemporaryDirectory() as sdk_parent:
        (Path(sdk_parent) / "centaur_sdk").symlink_to(sdk)
        env = os.environ.copy()
        env["PYTHONPATH"] = sdk_parent
        for root in args.roots:
            for pyproject in tool_pyprojects(root):
                tool_dir = pyproject.parent
                data = tomllib.loads(pyproject.read_text())
                scripts = data.get("project", {}).get("scripts", {})
                modules = [entry.split(":", 1)[0] for entry in scripts.values()]
                # CLI modules usually import their client lazily, so also
                # import the client module ctx.call_tool loads — that's where
                # most centaur_sdk imports (secret, ToolContext) live.
                wheel_sources = (
                    data.get("tool", {})
                    .get("hatch", {})
                    .get("build", {})
                    .get("targets", {})
                    .get("wheel", {})
                    .get("sources", {})
                )
                package = wheel_sources.get(".")
                if package and (tool_dir / "client.py").exists():
                    modules.append(f"{package}.client")
                for module in modules:
                    checked += 1
                    proc = subprocess.run(
                        [
                            "uv",
                            "run",
                            "--no-project",
                            "--isolated",
                            "--with",
                            str(tool_dir),
                            "python",
                            "-c",
                            f"import {module}",
                        ],
                        capture_output=True,
                        text=True,
                        env=env,
                    )
                    if proc.returncode == 0:
                        print(f"ok   {tool_dir} ({module})")
                    else:
                        print(f"FAIL {tool_dir} ({module})")
                        failures.append((tool_dir, module, proc.stderr.strip()))

    print(f"\n{checked} tool entrypoints checked, {len(failures)} failed")
    for tool_dir, module, stderr in failures:
        print(f"\n--- {tool_dir} ({module}) ---\n{stderr[-2000:]}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

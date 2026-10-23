#!/usr/bin/env python3
"""Load immutable Git fixtures before Vitest starts its policy assertions."""

from datetime import datetime
import json
from pathlib import Path
import re
import runpy
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def fixtures():
    caller = (ROOT / ".github/workflows/ci.yml").read_text()
    repository, path, pin = re.search(
        r"uses: ([^/\s]+/[^/\s]+)/(\.github/workflows/fleet-ci(?:-v[0-9]+)?\.yml)@([a-f0-9]{40})",
        caller,
    ).groups()
    comparison = json.loads((ROOT / "scripts/fleet-test-fixtures.json").read_text())[repository]
    return ((pin, path), (comparison["pin"], comparison["path"])), comparison


def fixtures_ready():
    snapshots, _comparison = fixtures()
    # A synthetic PR HEAD may remain shallow after main's evidence is ready.
    # Test the actual snapshots and ancestry, not that unrelated HEAD boundary.
    for pin, path in snapshots:
        for arguments in (("show", f"{pin}:{path}"),
                          ("merge-base", "--is-ancestor", pin, "refs/remotes/origin/main")):
            if subprocess.run(["git", *arguments], cwd=ROOT,
                              capture_output=True).returncode != 0:
                return False
    return True


def fetch_main_history():
    _snapshots, comparison = fixtures()
    # This is an acquisition hint, never a provenance verdict. A cutoff that
    # omits either pin still fails the immutable reads/ancestry assertions.
    # Keep Git's complete blob contents; only older, irrelevant history is cut.
    since = datetime.fromisoformat(comparison["history_since"].replace("Z", "+00:00"))
    if since.tzinfo is None:
        raise ValueError("Fixture history boundary must include a timezone")
    subprocess.run(
        ["git", "fetch", "--no-tags", "--quiet", f"--shallow-since={since.isoformat()}",
         "origin", "+refs/heads/main:refs/remotes/origin/main"], cwd=ROOT, check=True,
    )


def main():
    # One bounded main transfer supplies both snapshots and their ancestry.
    # Do not download the repository's entire historical asset history inside
    # the unchanged setup deadline. Every policy assertion still runs in tests.
    if not fixtures_ready():
        fetch_main_history()

    # Importing the real suites obtains the exact objects they use. Do not
    # run their assertions here: the timed tests still execute both suites.
    direct = runpy.run_path(str(ROOT / "scripts/test-direct-fleet.py"))
    direct["main_contains"](direct["PIN"])
    runpy.run_path(str(ROOT / "scripts/test-merge-queue-routing.py"))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Load immutable Git fixtures before Vitest starts its policy assertions."""

from pathlib import Path
import runpy
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def main():
    # One main-history transfer includes both reachable workflow pins. Loading
    # either suite first can otherwise trigger several serial depth-one fetches
    # inside the existing setup budget. Assertions still run in the timed test.
    shallow = subprocess.check_output(
        ["git", "rev-parse", "--is-shallow-repository"], cwd=ROOT, text=True
    ).strip() == "true"
    has_main = subprocess.run(
        ["git", "rev-parse", "--verify", "refs/remotes/origin/main"],
        cwd=ROOT, capture_output=True,
    ).returncode == 0
    if shallow or not has_main:
        command = ["git", "fetch", "--no-tags", "--quiet"]
        if shallow:
            command.append("--unshallow")
        subprocess.run(command + ["origin", "+refs/heads/main:refs/remotes/origin/main"],
                       cwd=ROOT, check=True)

    # Importing the real suites obtains the exact objects they use. Do not
    # run their assertions here: the timed tests still execute both suites.
    direct = runpy.run_path(str(ROOT / "scripts/test-direct-fleet.py"))
    direct["main_contains"](direct["PIN"])
    runpy.run_path(str(ROOT / "scripts/test-merge-queue-routing.py"))


if __name__ == "__main__":
    main()

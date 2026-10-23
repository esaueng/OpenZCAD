#!/usr/bin/env python3
"""Load immutable Git fixtures before Vitest starts its policy assertions."""

from pathlib import Path
import runpy


ROOT = Path(__file__).resolve().parents[1]


def main():
    # Importing the real suites obtains the exact objects they use. Do not
    # run their assertions here: the timed tests still execute both suites.
    direct = runpy.run_path(str(ROOT / "scripts/test-direct-fleet.py"))
    direct["main_contains"](direct["PIN"])
    runpy.run_path(str(ROOT / "scripts/test-merge-queue-routing.py"))


if __name__ == "__main__":
    main()

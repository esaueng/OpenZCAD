#!/usr/bin/env python3
"""Keep the commit that ci.yml pins fleet-ci.yml to reachable after merge.

A PR that changes fleet-ci.yml pins ci.yml to a commit on its own branch.
GitHub deletes that branch when the PR merges, and Actions can no longer
resolve `fleet-ci.yml@<sha>` for a commit that only `refs/pull/N/head`
reaches: every new ci run then fails at startup, with no jobs, until a
re-pin lands. This gives such a commit a `fleet-ci-pin/<sha>` branch of
its own while the PR is still open.
"""

import json
import os
import re
import subprocess
from base64 import b64decode

PIN = re.compile(
    r"^\s+uses: esaueng/OpenZCAD/\.github/workflows/fleet-ci\.yml@([0-9a-f]{40})$",
    re.M,
)
KEEP_PREFIX = "fleet-ci-pin/"


class NotFound(Exception):
    pass


def keep_pin(api, repository, head_sha, base_ref):
    """Return what was done for the pin in ci.yml at `head_sha`."""
    root = f"repos/{repository}"
    caller = api(f"{root}/contents/.github/workflows/ci.yml?ref={head_sha}")
    match = PIN.search(b64decode(caller["content"]).decode())
    if not match:
        raise SystemExit("ci.yml has no fleet-ci.yml commit pin")
    pin = match[1]
    # A pin the base branch already contains stays reachable through it.
    if api(f"{root}/compare/{base_ref}...{pin}")["status"] in ("behind", "identical"):
        return f"kept by {base_ref}: {pin}"
    # Only a commit this PR carries is kept, never an arbitrary one.
    if api(f"{root}/compare/{pin}...{head_sha}")["status"] not in ("ahead", "identical"):
        raise SystemExit(f"pin {pin} is not in this pull request's history")
    ref = f"heads/{KEEP_PREFIX}{pin}"
    try:
        existing = api(f"{root}/git/ref/{ref}")["object"]["sha"]
    except NotFound:
        api(f"{root}/git/refs", method="POST", fields={"ref": f"refs/{ref}", "sha": pin})
        return f"created {KEEP_PREFIX}{pin}"
    if existing != pin:
        raise SystemExit(f"{KEEP_PREFIX}{pin} points at {existing}")
    return f"already kept: {pin}"


def gh_api(path, method="GET", fields=None):
    command = ["gh", "api", path, "--method", method]
    for key, value in (fields or {}).items():
        command += ["-f", f"{key}={value}"]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        if "HTTP 404" in result.stderr:
            raise NotFound(path)
        raise SystemExit(result.stderr)
    return json.loads(result.stdout) if result.stdout.strip() else None


if __name__ == "__main__":
    print(
        keep_pin(
            gh_api,
            os.environ["REPOSITORY"],
            os.environ["HEAD_SHA"],
            os.environ["BASE_REF"],
        )
    )

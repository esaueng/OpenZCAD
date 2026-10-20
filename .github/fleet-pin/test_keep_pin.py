#!/usr/bin/env python3
"""Exercise keep_pin against a fake GitHub API (no network, no token)."""

import unittest
from base64 import b64encode
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from keep_pin import NotFound, keep_pin  # noqa: E402

REPO = "esaueng/OpenZCAD"
HEAD = "a" * 40
PIN = "b" * 40
OTHER = "c" * 40
CALLER = (
    "jobs:\n  checks:\n"
    f"    uses: esaueng/OpenZCAD/.github/workflows/fleet-ci.yml@{PIN}\n"
)


class FakeApi:
    def __init__(self, base_status="ahead", pr_status="ahead", refs=None, caller=CALLER):
        self.base_status = base_status
        self.pr_status = pr_status
        self.refs = dict(refs or {})
        self.caller = caller
        self.created = []

    def __call__(self, path, method="GET", fields=None):
        root = f"repos/{REPO}/"
        assert path.startswith(root), path
        path = path[len(root):]
        if path == f"contents/.github/workflows/ci.yml?ref={HEAD}":
            return {"content": b64encode(self.caller.encode()).decode()}
        if path == f"compare/main...{PIN}":
            return {"status": self.base_status}
        if path == f"compare/{PIN}...{HEAD}":
            return {"status": self.pr_status}
        if path.startswith("git/ref/heads/"):
            name = path[len("git/ref/heads/"):]
            if name not in self.refs:
                raise NotFound(path)
            return {"object": {"sha": self.refs[name]}}
        if path == "git/refs" and method == "POST":
            self.created.append(fields)
            return {}
        raise AssertionError(f"unexpected call {method} {path}")


def run(api):
    return keep_pin(api, REPO, HEAD, "main")


class KeepPinTests(unittest.TestCase):
    def test_creates_a_keeper_branch_for_a_pr_only_pin(self):
        api = FakeApi()
        self.assertEqual(run(api), f"created fleet-ci-pin/{PIN}")
        self.assertEqual(api.created, [{"ref": f"refs/heads/fleet-ci-pin/{PIN}", "sha": PIN}])

    def test_pin_the_base_already_contains_needs_no_keeper(self):
        for status in ("behind", "identical"):
            api = FakeApi(base_status=status)
            self.assertIn("kept by main", run(api))
            self.assertEqual(api.created, [])

    def test_pin_at_the_pr_head_itself_is_kept(self):
        api = FakeApi(pr_status="identical")
        self.assertEqual(run(api), f"created fleet-ci-pin/{PIN}")

    def test_refuses_a_pin_outside_the_pr_history(self):
        for status in ("behind", "diverged"):
            api = FakeApi(pr_status=status)
            with self.assertRaises(SystemExit):
                run(api)
            self.assertEqual(api.created, [])

    def test_existing_keeper_is_left_alone(self):
        api = FakeApi(refs={f"fleet-ci-pin/{PIN}": PIN})
        self.assertEqual(run(api), f"already kept: {PIN}")
        self.assertEqual(api.created, [])

    def test_keeper_pointing_elsewhere_fails_loudly(self):
        api = FakeApi(refs={f"fleet-ci-pin/{PIN}": OTHER})
        with self.assertRaises(SystemExit):
            run(api)

    def test_caller_without_a_commit_pin_fails(self):
        caller = "    uses: esaueng/OpenZCAD/.github/workflows/fleet-ci.yml@main\n"
        with self.assertRaises(SystemExit):
            run(FakeApi(caller=caller))

    def test_reads_the_real_caller_pin_format(self):
        caller = (Path(__file__).resolve().parents[1] / "workflows/ci.yml").read_text()
        start = caller.index("fleet-ci.yml@") + len("fleet-ci.yml@")
        caller = caller[:start] + PIN + caller[start + 40:]
        self.assertEqual(run(FakeApi(caller=caller)), f"created fleet-ci-pin/{PIN}")


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Exercise the real fixture preparer with disposable shallow Git histories."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
CALLER = (ROOT / ".github/workflows/ci.yml").read_text()
CALLEE, PIN = re.search(
    r"\.github/workflows/(fleet-ci(?:-v[0-9]+)?\.yml)@([0-9a-f]{40})", CALLER,
).groups()
COMPARISONS = json.loads((ROOT / "scripts/fleet-test-fixtures.json").read_text())
PREVIOUS = COMPARISONS["esaueng/OpenZCAD"]
# Exercise complete reads beyond the old acquisition strategy's 128-KiB filter.
WORKFLOW = (ROOT / ".github/workflows" / CALLEE).read_text() + "\n# " + "policy fixture " * 10000 + "\n"
REPOSITORY_ENV = {
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE", "GIT_SHALLOW_FILE",
}
ENV = {key: value for key, value in os.environ.items() if key not in REPOSITORY_ENV}
ENV["GIT_ALLOW_PROTOCOL"] = "file"
PREPARE_DIRECTORY = None
PREPARED_DIRECTORY = None


def git(repo, *args, env=None):
    return subprocess.check_output(
        ["git", *args], cwd=repo, env=env or ENV, text=True, stderr=subprocess.PIPE,
    ).strip()


class FleetCheckoutFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if PREPARED_DIRECTORY is not None:
            cls.root = PREPARED_DIRECTORY
            cls.origin = cls.root / "origin"
            for key, value in json.loads((cls.root / "fixture.json").read_text()).items():
                setattr(cls, key, value)
            return
        if PREPARE_DIRECTORY is None:
            directory = tempfile.TemporaryDirectory(prefix="fleet-checkout-history-")
            cls.addClassCleanup(directory.cleanup)
            cls.root = Path(directory.name)
        else:
            cls.root = PREPARE_DIRECTORY
        cls.origin = cls.root / "origin"
        cls.origin.mkdir()
        git(cls.origin, "init", "--quiet", "--initial-branch=main")
        # Normal commits retain shared hooks and the approved public identity.
        git(cls.origin, "config", "user.name", "petertoday")
        git(cls.origin, "config", "user.email", "171875562+petertoday@users.noreply.github.com")
        workflows = cls.origin / ".github/workflows"
        workflows.mkdir(parents=True)
        (cls.origin / PREVIOUS["path"]).write_text("immutable comparison fixture\n")
        cls.previous = cls.commit("test(ci): comparison fixture", "2026-01-01T12:00:00+00:00")
        (workflows / "fleet-ci.yml").unlink()
        (workflows / CALLEE).write_text(WORKFLOW)
        cls.pin = cls.commit("test(ci): active policy fixture", "2026-01-05T12:00:00+00:00")
        (workflows / "ci.yml").write_text(CALLER.replace(PIN, cls.pin))
        scripts = cls.origin / "scripts"
        scripts.mkdir()
        for name in ("test-direct-fleet.py", "test-merge-queue-routing.py",
                     "prepare-fleet-test-fixtures.py", "merge_queue_policy.py"):
            (scripts / name).write_bytes((ROOT / "scripts" / name).read_bytes())
        comparisons = json.loads(json.dumps(COMPARISONS))
        comparisons["esaueng/OpenZCAD"]["pin"] = cls.previous
        (scripts / "fleet-test-fixtures.json").write_text(json.dumps(comparisons))
        cls.commit("test(ci): caller and preparer fixture", "2026-01-06T12:00:00+00:00")
        git(cls.origin, "checkout", "--quiet", "-b", "unlanded")
        (cls.origin / "unlanded.txt").write_text("outside main\n")
        (cls.origin / PREVIOUS["path"]).write_text("unlanded comparison fixture\n")
        cls.unlanded = cls.commit("test(ci): off-main fixture", "2026-01-07T12:00:00+00:00")
        git(cls.origin, "checkout", "--quiet", "main")
        git(cls.origin, "checkout", "--quiet", "-b", "candidate-fixture")
        (cls.origin / "candidate.txt").write_text("candidate outside main\n")
        cls.commit("test(ci): candidate checkout fixture", "2026-01-10T12:00:00+00:00")
        git(cls.origin, "checkout", "--quiet", "main")
        (cls.root / "fixture.json").write_text(json.dumps({
            "previous": cls.previous, "pin": cls.pin, "unlanded": cls.unlanded,
        }))

    @classmethod
    def commit(cls, message, date):
        git(cls.origin, "add", ".")
        git(cls.origin, "commit", "--quiet", "-m", message,
            env=dict(ENV, GIT_AUTHOR_DATE=date, GIT_COMMITTER_DATE=date))
        return git(cls.origin, "rev-parse", "HEAD")

    def setUp(self):
        self.case = tempfile.TemporaryDirectory(dir=self.root)
        self.addCleanup(self.case.cleanup)
        self.checkout = Path(self.case.name) / "checkout"
        git(self.root, "clone", "--quiet", "--no-local", "--depth=1", "--branch=candidate-fixture",
            self.origin.as_uri(), str(self.checkout))
        self.trace = Path(self.case.name) / "trace.jsonl"
        self.env = dict(ENV, GIT_TRACE2_EVENT=str(self.trace))
        self.assertEqual(git(self.checkout, "rev-parse", "--is-shallow-repository"), "true")
        self.assertNotEqual(subprocess.run(
            ["git", "rev-parse", "--verify", "refs/remotes/origin/main"],
            cwd=self.checkout, env=ENV, capture_output=True,
        ).returncode, 0)
        self.assertNotEqual(subprocess.run(
            ["git", "show", f"{self.previous}:{PREVIOUS['path']}"],
            cwd=self.checkout, env=ENV, capture_output=True,
        ).returncode, 0)

    def run_script(self, name, *args):
        return subprocess.run([sys.executable, "scripts/" + name, *args],
                              cwd=self.checkout, env=self.env, capture_output=True, text=True)

    def provenance(self):
        return self.run_script("test-direct-fleet.py",
                               "DirectFleetTests.test_pin_is_a_commit_main_already_contains")

    def prepare(self):
        result = self.run_script("prepare-fleet-test-fixtures.py")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def fetches(self):
        return [event["argv"] for line in self.trace.read_text().splitlines()
                if (event := json.loads(line)).get("event") == "start"
                and event.get("argv") and Path(event["argv"][0]).name == "git"
                and "fetch" in event["argv"]]

    def comparison_pin(self, pin):
        manifest = self.checkout / "scripts/fleet-test-fixtures.json"
        comparisons = json.loads(manifest.read_text())
        comparisons["esaueng/OpenZCAD"]["pin"] = pin
        manifest.write_text(json.dumps(comparisons))

    def test_cold_prepare_uses_one_main_transfer_and_warm_checkout_stays_offline(self):
        candidate = git(self.checkout, "rev-parse", "HEAD")
        self.prepare()
        fetches = self.fetches()
        self.assertEqual(len(fetches), 1, fetches)
        self.assertIn("--unshallow", fetches[0])
        self.assertIn("+refs/heads/main:refs/remotes/origin/main", fetches[0])
        self.assertEqual(git(self.checkout, "rev-parse", "HEAD"), candidate)
        self.assertNotEqual(candidate, git(self.checkout, "rev-parse", "origin/main"))
        self.assertEqual(git(self.checkout, "show", f"{self.previous}:{PREVIOUS['path']}"),
                         "immutable comparison fixture")
        git(self.checkout, "remote", "set-url", "origin", (self.root / "unavailable").as_uri())
        self.prepare()
        result = self.provenance()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Ran 1 test", result.stderr)
        self.assertEqual(self.fetches(), fetches)

    def test_partly_warm_checkout_still_prepares_comparison(self):
        git(self.checkout, "fetch", "--quiet", "--no-tags", "--depth=1", "origin", self.pin)
        self.prepare()
        self.assertEqual(len(self.fetches()), 1)
        result = self.provenance()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_fetched_off_main_active_pin_is_rejected(self):
        self.prepare()
        git(self.checkout, "fetch", "--quiet", "--no-tags", "origin", self.unlanded)
        caller = self.checkout / ".github/workflows/ci.yml"
        caller.write_text(caller.read_text().replace(self.pin, self.unlanded))
        result = self.provenance()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("which main does not contain", result.stderr)

    def test_fetched_off_main_comparison_pin_is_rejected(self):
        self.prepare()
        git(self.checkout, "fetch", "--quiet", "--no-tags", "origin", self.unlanded)
        self.comparison_pin(self.unlanded)
        result = self.provenance()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("comparison fixture", result.stderr)
        self.assertIn("is not contained in main", result.stderr)

    def test_missing_comparison_fails_instead_of_skipping(self):
        self.comparison_pin("f" * 40)
        result = self.run_script("prepare-fleet-test-fixtures.py")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("CalledProcessError", result.stderr)
        result = self.provenance()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("comparison fixture", result.stderr)

    def test_large_pinned_policy_survives_worktree_edits(self):
        self.assertGreater(len(WORKFLOW), 128 * 1024)
        self.prepare()
        (self.checkout / ".github/workflows" / CALLEE).write_text("untrusted worktree policy\n")
        result = subprocess.run(
            [sys.executable, "-c", "import runpy; print(runpy.run_path('scripts/test-direct-fleet.py')['TEXT'], end='')"],
            cwd=self.checkout, env=self.env, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, WORKFLOW)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--prepare", type=Path)
    mode.add_argument("--origin", type=Path)
    options, tests = parser.parse_known_args()
    PREPARE_DIRECTORY, PREPARED_DIRECTORY = options.prepare, options.origin
    if PREPARE_DIRECTORY is not None:
        FleetCheckoutFixtureTests.setUpClass()
    else:
        unittest.main(argv=[sys.argv[0], *tests])

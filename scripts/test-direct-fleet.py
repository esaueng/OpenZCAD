#!/usr/bin/env python3
"""Evaluate the checked-in scheduling expressions against trusted and hostile events."""

import copy
import ast
import json
import re
import subprocess
import unittest
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CALLER = (ROOT / ".github/workflows/ci.yml").read_text()
CALLEE, PIN = re.search(r"\.github/workflows/(fleet-ci(?:-v[0-9]+)?\.yml)@([a-f0-9]{40})", CALLER).groups()
try:
    TEXT = subprocess.check_output(["git", "show", f"{PIN}:.github/workflows/{CALLEE}"], cwd=ROOT, text=True, stderr=subprocess.DEVNULL)
except subprocess.CalledProcessError:
    subprocess.run(["git", "fetch", "--no-tags", "--depth=1", "origin", PIN], cwd=ROOT, check=True)
    TEXT = subprocess.check_output(["git", "show", f"{PIN}:.github/workflows/{CALLEE}"], cwd=ROOT, text=True)


def main_contains(commit):
    """Whether origin/main reaches `commit`, fetching only the history needed."""
    def contains():
        return subprocess.run(
            ["git", "merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"],
            cwd=ROOT, capture_output=True,
        ).returncode == 0
    if contains():
        return True
    fetch = ["git", "fetch", "--no-tags", "--quiet"]
    shallow = subprocess.check_output(
        ["git", "rev-parse", "--is-shallow-repository"], cwd=ROOT, text=True
    ).strip() == "true"
    if shallow:
        # Main's commits since a day before the pin are enough to walk to it;
        # CI checkouts are shallow and full history is tens of megabytes.
        committed = subprocess.check_output(["git", "show", "-s", "--format=%cI", commit], cwd=ROOT, text=True).strip()
        since = datetime.fromisoformat(committed) - timedelta(days=1)
        fetch.append(f"--shallow-since={since.isoformat()}")
    result = subprocess.run(
        fetch + ["origin", "+refs/heads/main:refs/remotes/origin/main"],
        cwd=ROOT, capture_output=True, text=True,
    )
    if result.returncode:
        # Git cannot unshallow a pinned commit main does not reach ("error in
        # object: unshallow ..."), so this is usually the same answer.
        raise AssertionError(f"could not fetch main back to {commit}: {result.stderr.strip()}")
    return contains()
EXPRESSIONS = re.findall(
    r"^    runs-on: (?:&fleet-runner )?(\$\{\{ fromJSON\(.+\) \}\})$", TEXT, re.M
)
REPO = re.search(r"github.repository == '([^']+)'", TEXT)[1]
REPO_ID = int(re.search(r"github.repository_id == '([0-9]+)'", TEXT)[1])


class Context(dict):
    def __getattr__(self, key):
        value = self.get(key)
        return Context(value) if isinstance(value, dict) else value


def evaluate(expression, github, variables, needs=None):
    source = expression[3:-3].replace("&&", " and ").replace("||", " or ")
    source = re.sub(r"\btrue\b(?!\')", "True", source)
    source = re.sub(r"\bfalse\b(?!\')", "False", source)
    # GitHub permits hyphens in job property names; Python parses subtraction.
    source = source.replace("needs.queue-trust", "needs.queue_trust")
    names = {"github": Context(github), "vars": Context(variables),
             "needs": Context({"queue_trust": (needs or {}).get("queue-trust", {})})}
    def visit(node):
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name) and node.id in names:
            return names[node.id]
        if isinstance(node, ast.Attribute) and not node.attr.startswith("_"):
            value = visit(node.value)
            if value is None:
                # GitHub dereferences a missing object as null.
                return None
            if not isinstance(value, dict):
                raise ValueError("Only context fields are allowed")
            result = value.get(node.attr)
            return Context(result) if isinstance(result, dict) else result
        if isinstance(node, ast.BoolOp):
            result = visit(node.values[0])
            for value in node.values[1:]:
                if isinstance(node.op, ast.And) and not result:
                    return result
                if isinstance(node.op, ast.Or) and result:
                    return result
                result = visit(value)
            return result
        if isinstance(node, ast.Compare) and len(node.ops) == 1 and isinstance(node.ops[0], ast.Eq):
            return visit(node.left) == visit(node.comparators[0])
        if isinstance(node, ast.Compare) and len(node.ops) == 1 and isinstance(node.ops[0], ast.NotEq):
            return visit(node.left) != visit(node.comparators[0])
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
            args = [visit(arg) for arg in node.args]
            if node.func.id == "fromJSON" and len(args) == 1 and isinstance(args[0], str):
                return json.loads(args[0])
            if node.func.id == "format" and len(args) == 2 and isinstance(args[0], str):
                # The reviewed expression uses only the literal {0} placeholder.
                return args[0].replace("{0}", str(args[1]))
        raise ValueError("Unsupported routing expression")
    return visit(ast.parse(source.strip(), mode="eval").body)



class DirectFleetTests(unittest.TestCase):
    def test_staged_merge_queue_routing(self):
        result = subprocess.run(
            ["python3", str(ROOT / "scripts/test-merge-queue-routing.py")],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def setUp(self):
        repo = {"id": REPO_ID, "fork": False}
        self.github = {
            "repository": REPO,
            "repository_id": str(REPO_ID),
            "actor": "petertoday",
            "actor_id": "171875562",
            "triggering_actor": "petertoday",
            "event_name": "pull_request",
            "ref": "refs/pull/7/merge",
            "ref_protected": True,
            "event": {
                "pull_request": {
                    "state": "open",
                    "number": 7,
                    "user": {"login": "petertoday", "id": 171875562},
                    "head": {"repo": copy.deepcopy(repo)},
                    "base": {"repo": repo, "ref": "main"},
                }
            },
        }
        self.variables = {"CI_FLEET_ENABLED": "true", "CI_FLEET_TARGET": "ci-server-jane"}

    def test_trusted_events_choose_exact_group_and_host(self):
        self.assertTrue(EXPRESSIONS)
        for target in ("ci-server-jane", "ci-server-john"):
            self.variables["CI_FLEET_TARGET"] = target
            for expression in EXPRESSIONS:
                self.assertEqual(
                    evaluate(expression, self.github, self.variables),
                    {"group": "ci-trusted-main", "labels": "ci-server-jane-5gb" if target == "ci-server-jane" else target},
                )

    def test_untrusted_events_never_schedule_on_home_fleet(self):
        cases = []
        for key, value in [
            ("repository", "outsider/repo"),
            ("repository_id", "1"),
            ("actor", "outsider"),
            ("actor_id", "1"),
            ("triggering_actor", "outsider"),
            ("event_name", "pull_request_target"),
            ("ref", "refs/pull/7/head"),
        ]:
            altered = copy.deepcopy(self.github)
            altered[key] = value
            cases.append(altered)
        for path, value in [
            (("head", "repo", "id"), 1),
            (("head", "repo", "fork"), True),
            (("base", "repo", "id"), 1),
            (("base", "ref"), "feature"),
            (("user", "id"), 1),
            (("user", "login"), "outsider"),
            (("state",), "closed"),
            (("number",), 8),
        ]:
            altered = copy.deepcopy(self.github)
            obj = altered["event"]["pull_request"]
            for key in path[:-1]:
                obj = obj[key]
            obj[path[-1]] = value
            cases.append(altered)
        for github in cases:
            for expression in EXPRESSIONS:
                with self.subTest(event=github, expression=expression):
                    self.assertIsInstance(evaluate(expression, github, self.variables), str)

    def test_protected_main_and_opt_in_fail_closed(self):
        for event in ("push", "workflow_dispatch"):
            self.github.update(event_name=event, ref="refs/heads/main")
            for expression in EXPRESSIONS:
                self.assertIsInstance(evaluate(expression, self.github, self.variables), dict)
                self.github["ref_protected"] = False
                self.assertIsInstance(evaluate(expression, self.github, self.variables), str)
                self.github["ref_protected"] = True
        for target in ("", "self-hosted", "ci-small", "ci-server-jane-1", "github-hosted"):
            self.variables["CI_FLEET_TARGET"] = target
            for expression in EXPRESSIONS:
                self.assertIsInstance(evaluate(expression, self.github, self.variables), str)
        self.variables.update(CI_FLEET_TARGET="ci-server-jane", CI_FLEET_ENABLED="false")
        for expression in EXPRESSIONS:
            self.assertIsInstance(evaluate(expression, self.github, self.variables), str)

    def test_merge_groups_require_a_successful_exact_sha_probe(self):
        self.github.update(
            event_name="merge_group",
            ref="refs/heads/gh-readonly-queue/main/pr-7-synthetic",
            sha="a" * 40,
            event={"merge_group": {"base_ref": "refs/heads/main"}},
        )
        for expression in EXPRESSIONS:
            for needs in ({}, *(
                {"queue-trust": {"result": result, "outputs": {"sha": "a" * 40}}}
                for result in ("failure", "cancelled", "skipped")
            ), {"queue-trust": {"result": "success", "outputs": {"sha": "b" * 40}}}):
                self.assertEqual(evaluate(expression, self.github, self.variables, needs), "ubuntu-latest")
            verified = {"queue-trust": {"result": "success", "outputs": {"sha": "a" * 40}}}
            self.assertEqual(evaluate(expression, self.github, self.variables, verified),
                             {"group": "ci-trusted-main", "labels": "ci-server-jane-5gb"})
            for variables in (dict(self.variables, CI_FLEET_ENABLED="false"),
                              dict(self.variables, CI_FLEET_TARGET="github-hosted"),
                              dict(self.variables, CI_FLEET_TARGET="ci-server-john")):
                self.assertEqual(evaluate(expression, self.github, variables, verified), "ubuntu-latest")

    def test_queue_checks_have_triggers_and_independent_verdicts(self):
        cloudflare = (ROOT / ".github/workflows/cloudflare.yml").read_text()
        privacy = (ROOT / ".github/workflows/commit-privacy.yml").read_text()
        for workflow in (CALLER, cloudflare, privacy):
            self.assertRegex(workflow, r"(?m)^  merge_group:")
        for workflow in (CALLER, cloudflare):
            self.assertIn("merge_group:\n    types: [checks_requested]", workflow)
            group = re.search(r"^  group: .*?(\$\{\{.+\}\})$", workflow, re.M)[1]
            keys = []
            for event, run_id in (("merge_group", 101), ("merge_group", 102), ("pull_request", 103), ("pull_request", 104)):
                github = dict(self.github, event_name=event, run_id=run_id)
                keys.append(evaluate(group, github, self.variables))
            self.assertNotEqual(keys[0], keys[1])
            self.assertEqual(keys[2], keys[3])
            self.assertIn("cancel-in-progress: ${{ github.event_name == 'pull_request' }}", workflow)

    def test_queue_candidates_cannot_upload_cloudflare_versions(self):
        cloudflare = (ROOT / ".github/workflows/cloudflare.yml").read_text()
        upload = cloudflare.split("\n  upload:\n", 1)[1]
        condition = re.search(r"^    if: (.+)$", upload, re.M)[1]
        for event, ref, expected in (
            ("pull_request", "refs/pull/7/merge", False),
            ("merge_group", "refs/heads/gh-readonly-queue/main/pr-7-synthetic", False),
            ("push", "refs/heads/feature", False),
            ("push", "refs/heads/main", True),
            ("workflow_dispatch", "refs/heads/main", True),
            ("workflow_dispatch", "refs/heads/feature", False),
        ):
            github = dict(self.github, event_name=event, ref=ref)
            self.assertEqual(evaluate("${{ " + condition + " }}", github, self.variables), expected)
        verify = cloudflare.split("\n  verify:\n", 1)[1].split("\n  upload:\n", 1)[0]
        self.assertNotRegex(verify, r"(?m)^    if:")
        self.assertIn("wrangler deploy --dry-run", verify)
        self.assertRegex(upload, r"(?m)^    environment: cloudflare-versions$")

    def test_label_events_keep_required_reusable_checks(self):
        group = re.search(r"^  group: .*?(\$\{\{.+\}\})$", CALLER, re.M)[1]
        checks = CALLER.split("\n  checks:\n", 1)[1]
        # Skipping the reusable caller creates a newer check suite without
        # validate/e2e. GitHub then marks those required contexts Expected,
        # even when an older run on the same head passed both gates.
        self.assertNotRegex(checks, r"(?m)^    if:")
        for action in ("labeled", "unlabeled"):
            for label in ("kernel-bump", "documentation"):
                github = copy.deepcopy(self.github)
                github["event"].update(action=action, label={"name": label})
                with self.subTest(action=action, label=label):
                    keys = {evaluate(group, dict(github, run_id=run_id), self.variables) for run_id in (201, 202)}
                    self.assertEqual(keys, {"refs/pull/7/merge"})

    def test_pin_is_a_commit_main_already_contains(self):
        # GitHub deletes a PR branch at merge, and Actions cannot resolve a
        # reusable workflow at a commit only refs/pull/N/head still reaches:
        # every ci run then fails at startup with no jobs. Stage a versioned
        # callee and activate it from main instead (docs/runner-routing.md).
        self.assertTrue(
            main_contains(PIN),
            f"ci.yml pins {CALLEE}@{PIN}, which main does not contain",
        )

    def test_no_hosted_bootstrap_and_guard_before_checkout(self):
        self.assertNotIn("select-runner.yml", TEXT)
        self.assertNotIn("/routing/v1/target", TEXT)
        self.assertNotIn("needs.route", TEXT)
        self.assertIn("&fleet-isolation", TEXT)
        self.assertNotIn("secrets.", TEXT)
        jobs = re.split(r"^  [\w-]+:\s*$", TEXT.split("\njobs:\n", 1)[1], flags=re.M)[1:]
        for job in jobs:
            alias = re.search(r"^    steps: \*([\w-]+)$", job, re.M)
            if alias:
                # An aliased step list is the anchored job's list verbatim, so
                # that job's text carries the guard this one runs.
                anchored = [other for other in jobs if f"\n    steps: &{alias[1]}\n" in other]
                self.assertEqual(len(anchored), 1, alias[1])
                self.assertIn("runs-on: *fleet-runner", job)
                job = anchored[0]
            if not any(
                marker in job
                for marker in (
                    "runs-on: &fleet-runner",
                    "runs-on: *fleet-runner",
                    "runs-on: ${{ fromJSON(",
                )
            ):
                continue
            guard = (
                "Verify runner isolation"
                if "Verify runner isolation" in job
                else "*fleet-isolation"
            )
            self.assertIn(guard, job)
            if "actions/checkout@" in job:
                self.assertLess(job.index(guard), job.index("actions/checkout@"))
                self.assertIn("persist-credentials: false", job)

    def test_embedded_shell_syntax(self):
        for block in re.findall(r"        run: \|\n((?:          [^\n]*\n|\n)+)", TEXT):
            script = "\n".join(
                line[10:] if line.startswith("          ") else line for line in block.splitlines()
            )
            result = subprocess.run(["bash", "-n"], input=script, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()

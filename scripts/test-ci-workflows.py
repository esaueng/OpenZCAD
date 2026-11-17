#!/usr/bin/env python3
"""Evaluate the CI caller, its checks and the queue-facing workflows against events."""

import ast
import copy
import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from policy_test_tools import bash_executable
CALLER = (ROOT / ".github/workflows/ci.yml").read_text()
CHECKS = (ROOT / ".github/workflows/checks.yml").read_text()


class Context(dict):
    def __getattr__(self, key):
        value = self.get(key)
        return Context(value) if isinstance(value, dict) else value


def evaluate(expression, github):
    source = expression[3:-3].replace("&&", " and ").replace("||", " or ")
    source = re.sub(r"\btrue\b(?!\')", "True", source)
    source = re.sub(r"\bfalse\b(?!\')", "False", source)
    names = {"github": Context(github)}
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



class CIWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.github = {
            "repository": "esaueng/OpenZCAD",
            "event_name": "pull_request",
            "ref": "refs/pull/7/merge",
            "event": {"pull_request": {"number": 7}},
        }

    def test_caller_runs_this_commit_checks_with_read_only_permissions(self):
        checks = CALLER.split("\n  checks:\n", 1)[1]
        # A local path resolves in the commit under test. A repository path
        # pinned to a pull-request commit stops resolving once GitHub deletes
        # the merged branch, and every later ci run then fails at startup.
        self.assertEqual(re.findall(r"(?m)^    uses: (.+)$", checks), ["./.github/workflows/checks.yml"])
        self.assertIn("    permissions:\n      contents: read\n", checks)
        self.assertNotIn(": write", CALLER)
        self.assertNotRegex(CALLER, r"secrets: inherit|runs-on:")
        self.assertRegex(CHECKS, r"(?m)^on:\n  workflow_call:\npermissions:\n  contents: read\njobs:$")
        self.assertNotIn(": write", CHECKS)

    def test_queue_checks_have_triggers_and_independent_verdicts(self):
        cloudflare = (ROOT / ".github/workflows/cloudflare.yml").read_text()
        # The App-bound commit and history verdicts for a queue candidate are
        # requested by this workflow; the read-only duplicate was removed.
        privacy = (ROOT / ".github/workflows/history-privacy-request.yml").read_text()
        for workflow in (CALLER, cloudflare, privacy):
            self.assertRegex(workflow, r"(?m)^  merge_group:")
        for workflow in (CALLER, cloudflare):
            self.assertIn("merge_group:\n    types: [checks_requested]", workflow)
            group = re.search(r"^  group: .*?(\$\{\{.+\}\})$", workflow, re.M)[1]
            keys = []
            for event, run_id in (("merge_group", 101), ("merge_group", 102), ("pull_request", 103), ("pull_request", 104)):
                github = dict(self.github, event_name=event, run_id=run_id)
                keys.append(evaluate(group, github))
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
            self.assertEqual(evaluate("${{ " + condition + " }}", github), expected)
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
                    keys = {evaluate(group, dict(github, run_id=run_id)) for run_id in (201, 202)}
                    self.assertEqual(keys, {"refs/pull/7/merge"})

    def test_every_check_is_hosted_and_checks_out_without_credentials(self):
        self.assertNotIn("secrets.", CHECKS)
        self.assertNotIn("self-hosted", CHECKS)
        runners = re.findall(r"(?m)^    runs-on: (.+)$", CHECKS)
        self.assertEqual(set(runners), {"ubuntu-24.04"})
        jobs = re.split(r"(?m)^  [\w-]+:\s*$", CHECKS.split("\njobs:\n", 1)[1])[1:]
        self.assertEqual(len(runners), len(jobs))
        for job in jobs:
            self.assertEqual(job.count("actions/checkout@"), job.count("persist-credentials: false"))

    def test_embedded_shell_syntax(self):
        for block in re.findall(r"        run: \|\n((?:          [^\n]*\n|\n)+)", CHECKS):
            script = "\n".join(
                line[10:] if line.startswith("          ") else line for line in block.splitlines()
            )
            result = subprocess.run([bash_executable(), "-n"], input=script, text=True, encoding="utf-8", capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()

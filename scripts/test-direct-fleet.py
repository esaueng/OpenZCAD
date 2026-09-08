#!/usr/bin/env python3
"""Evaluate the checked-in scheduling expressions against trusted and hostile events."""

import copy
import json
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEXT = (ROOT / ".github/workflows/fleet-ci.yml").read_text()
CALLER = (ROOT / ".github/workflows/ci.yml").read_text()
EXPRESSIONS = re.findall(
    r"^    runs-on: (?:&fleet-runner )?(\$\{\{ fromJSON\(.+\) \}\})$", TEXT, re.M
)
REPO = re.search(r"github.repository == '([^']+)'", TEXT)[1]
REPO_ID = int(re.search(r"github.repository_id == '([0-9]+)'", TEXT)[1])


class Context(dict):
    def __getattr__(self, key):
        value = self.get(key)
        return Context(value) if isinstance(value, dict) else value


def evaluate(expression, github, variables):
    source = expression[3:-3].replace("&&", " and ").replace("||", " or ")
    source = re.sub(r"\btrue\b(?!\')", "True", source)
    source = re.sub(r"\bfalse\b(?!\')", "False", source)
    return eval(
        source,
        {"__builtins__": {}},
        {
            "github": Context(github),
            "vars": Context(variables),
            "fromJSON": json.loads,
            "format": lambda template, value: template.format(value),
        },
    )


class DirectFleetTests(unittest.TestCase):
    def setUp(self):
        repo = {"id": REPO_ID, "fork": False}
        self.github = {
            "repository": REPO,
            "repository_id": str(REPO_ID),
            "actor": "petergstfsn",
            "actor_id": "171875562",
            "triggering_actor": "petergstfsn",
            "event_name": "pull_request",
            "ref": "refs/pull/7/merge",
            "ref_protected": True,
            "event": {
                "pull_request": {
                    "state": "open",
                    "number": 7,
                    "user": {"login": "petergstfsn", "id": 171875562},
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
                    {"group": "ci-trusted-main", "labels": target},
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

    def test_no_hosted_bootstrap_and_guard_before_checkout(self):
        self.assertNotIn("select-runner.yml", TEXT)
        self.assertNotIn("/routing/v1/target", TEXT)
        self.assertNotIn("needs.route", TEXT)
        self.assertIn("&fleet-isolation", TEXT)
        self.assertNotIn("secrets.", TEXT)
        for job in re.split(r"^  [\w-]+:\s*$", TEXT.split("\njobs:\n", 1)[1], flags=re.M)[1:]:
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

#!/usr/bin/env python3
"""Regression tests for the staged queue policy, scheduling and existing gates."""

import ast
import copy
import importlib.util
import json
import os
import re
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "scripts/merge_queue_policy.py"
spec = importlib.util.spec_from_file_location("queue_policy", SOURCE)
POLICY = importlib.util.module_from_spec(spec)
spec.loader.exec_module(POLICY)
REMUS = POLICY.REPOSITORY == "esaueng/remus"
STAGED = ROOT / (".github/workflows/fleet-ci-v5.yml" if REMUS
                 else ".github/workflows/fleet-ci-v2.yml")
TEXT = STAGED.read_text()
def previous_workflow():
    path = ".github/workflows/fleet-ci-v4.yml" if REMUS else ".github/workflows/fleet-ci.yml"
    previous = ROOT / path
    if previous.exists():
        return previous.read_text()
    # Activation retires the old file; keep comparing its immutable main bytes.
    pin = "9e5b65b9e00f004d83eb583ab3934c863ad7956d" if REMUS else "fe46bdaa8a64c92464fea42034284be34c58ceae"
    command = ["git", "show", f"{pin}:{path}"]
    try:
        return subprocess.check_output(command, cwd=ROOT, text=True, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        subprocess.run(["git", "fetch", "--quiet", "--no-tags", "--depth=1", "origin", pin], cwd=ROOT, check=True)
        return subprocess.check_output(command, cwd=ROOT, text=True)


OLD = previous_workflow()


def jobs(text):
    return dict(re.findall(r"^  ([\w-]+):\n(.*?)(?=^  [\w-]+:\n|\Z)",
                           text.split("\njobs:\n", 1)[1], re.M | re.S))


def fixtures():
    repo = {"nameWithOwner": POLICY.REPOSITORY,
            "databaseId": POLICY.REPOSITORY_ID, "isFork": False}
    owner = {"login": POLICY.OWNER, "databaseId": POLICY.OWNER_ID}
    main, one, two = "a" * 40, "b" * 40, "c" * 40
    entries = []
    for position, base, head in [(1, main, one), (2, one, two)]:
        entries.append({
            "position": position, "state": "AWAITING_CHECKS", "enqueuer": copy.deepcopy(owner),
            "baseCommit": {"oid": base},
            "headCommit": {"oid": head, "parents": {"nodes": [{"oid": base}]}},
            "pullRequest": {"number": position, "state": "OPEN", "baseRefName": "main",
                            "headRefOid": "d" * 40, "isCrossRepository": False,
                            "author": copy.deepcopy(owner),
                            "headRepository": copy.deepcopy(repo),
                            "baseRepository": copy.deepcopy(repo)},
        })
    repository = dict(repo, ref={"target": {"oid": main}},
                      mergeQueue={"entries": {"nodes": entries,
                                              "pageInfo": {"hasNextPage": False}}})
    event = {"action": "checks_requested",
             "sender": {"login": POLICY.OWNER, "id": POLICY.OWNER_ID},
             "merge_group": {"base_ref": "refs/heads/main", "base_sha": one,
                             "head_sha": two,
                             "head_ref": f"refs/heads/gh-readonly-queue/main/pr-2-{one}"}}
    context = {"REPOSITORY": POLICY.REPOSITORY, "REPOSITORY_ID": str(POLICY.REPOSITORY_ID),
               "EVENT_NAME": "merge_group", "ACTOR": POLICY.OWNER,
               "ACTOR_ID": str(POLICY.OWNER_ID), "TRIGGERING_ACTOR": POLICY.OWNER,
               "REF": event["merge_group"]["head_ref"], "SHA": two}
    branch = {"name": "main", "protected": True, "commit": {"sha": main}}
    return event, context, repository, branch


def set_path(obj, path, value):
    for key in path[:-1]:
        obj = obj[key]
    obj[path[-1]] = value


def evaluate(expression, github, variables, needs):
    source = expression.strip().removeprefix("${{").removesuffix("}}")
    source = source.replace("&&", " and ").replace("||", " or ")
    source = re.sub(r"\btrue\b(?!')", "True", source)
    source = re.sub(r"\bfalse\b(?!')", "False", source)
    # Hyphenated job names are valid GitHub property dereferences.
    source = source.replace("needs.queue-trust", "needs.queue_trust")
    contexts = {"github": github, "vars": variables,
                "needs": {"queue_trust": needs.get("queue-trust", {})}}

    def visit(node):
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name) and node.id in contexts:
            return contexts[node.id]
        if isinstance(node, ast.Attribute):
            value = visit(node.value)
            return value.get(node.attr, {}) if isinstance(value, dict) else None
        if isinstance(node, ast.BoolOp):
            value = visit(node.values[0])
            for next_node in node.values[1:]:
                if isinstance(node.op, ast.And) and not value:
                    return value
                if isinstance(node.op, ast.Or) and value:
                    return value
                value = visit(next_node)
            return value
        if isinstance(node, ast.Compare) and len(node.ops) == 1:
            left, right = visit(node.left), visit(node.comparators[0])
            if isinstance(node.ops[0], ast.Eq):
                return left == right
            if isinstance(node.ops[0], ast.NotEq):
                return left != right
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            args = [visit(arg) for arg in node.args]
            if node.func.id == "fromJSON":
                return json.loads(*args)
            if node.func.id == "format":
                return args[0].format(*args[1:])
        raise ValueError(ast.dump(node))
    return visit(ast.parse(source.strip(), mode="eval").body)


class QueuePolicyTests(unittest.TestCase):
    def test_live_owner_only_prefix_binds_exact_candidate(self):
        event, context, repo, branch = fixtures()
        self.assertTrue(POLICY.trusted_candidate(event, context, repo, branch))
        event["merge_group"]["base_sha"] = branch["commit"]["sha"]
        self.assertTrue(POLICY.trusted_candidate(event, context, repo, branch))
        # Later entries are not part of this candidate.
        repo["mergeQueue"]["entries"]["nodes"].append({"untrusted": True})
        self.assertTrue(POLICY.trusted_candidate(event, context, repo, branch))

    def test_each_constituent_requires_owner_and_same_repository(self):
        for index in (0, 1):
            changes = [
                (("position",), 99), (("state",), "QUEUED"),
                (("enqueuer", "login"), "outsider"), (("enqueuer", "databaseId"), 42),
                (("pullRequest", "author", "login"), "outsider"),
                (("pullRequest", "author", "databaseId"), 42),
                (("pullRequest", "state"), "CLOSED"),
                (("pullRequest", "baseRefName"), "feature"),
                (("pullRequest", "number"), True),
                (("pullRequest", "headRefOid"), "main"),
                (("pullRequest", "isCrossRepository"), True),
                (("baseCommit", "oid"), "e" * 40),
                (("headCommit", "parents", "nodes"), []),
                (("headCommit", "parents", "nodes"), [{"oid": "f" * 40}]),
                (("headCommit", "parents", "nodes"), [{"oid": "a" * 40}, {"oid": "d" * 40}]),
            ]
            for side in ("headRepository", "baseRepository"):
                changes.extend([(("pullRequest", side, "isFork"), True),
                                (("pullRequest", side, "isFork"), None),
                                (("pullRequest", side, "databaseId"), 42),
                                (("pullRequest", side, "nameWithOwner"), "other/repo")])
            for path, value in changes:
                with self.subTest(index=index, path=path):
                    event, context, repo, branch = fixtures()
                    set_path(repo["mergeQueue"]["entries"]["nodes"][index], path, value)
                    self.assertFalse(POLICY.trusted_candidate(event, context, repo, branch))

    def test_wrong_event_identity_or_candidate_is_rejected(self):
        event, context, repo, branch = fixtures()
        for key, value in [("ACTOR", "outsider"), ("ACTOR_ID", "42"),
                           ("TRIGGERING_ACTOR", "outsider"), ("REPOSITORY", "other/repo"),
                           ("REPOSITORY_ID", "42"), ("EVENT_NAME", "push"),
                           ("SHA", "f" * 40), ("REF", "refs/heads/main")]:
            with self.subTest(key=key):
                self.assertFalse(POLICY.trusted_candidate(event, dict(context, **{key: value}), repo, branch))
        for path, value in [(("action",), "destroyed"), (("sender", "id"), 42),
                            (("sender", "login"), "outsider"),
                            (("merge_group", "base_ref"), "refs/heads/feature"),
                            (("merge_group", "base_sha"), "f" * 40),
                            (("merge_group", "head_sha"), "f" * 40),
                            (("merge_group", "head_ref"), "refs/heads/feature")]:
            modified = copy.deepcopy(event)
            set_path(modified, path, value)
            with self.subTest(path=path):
                self.assertFalse(POLICY.trusted_candidate(modified, context, repo, branch))
        # A branch-shaped spoof still cannot identify a different PR's candidate.
        event["merge_group"]["head_ref"] = context["REF"] = context["REF"].replace("pr-2-", "pr-99-")
        self.assertFalse(POLICY.trusted_candidate(event, context, repo, branch))

    def test_missing_truncated_stale_or_unprotected_evidence_is_rejected(self):
        changes = [(("mergeQueue", "entries", "pageInfo", "hasNextPage"), True),
                   (("mergeQueue", "entries", "nodes"), []),
                   (("ref", "target", "oid"), "f" * 40),
                   (("databaseId",), 42), (("nameWithOwner",), "other/repo"), (("isFork",), True)]
        for path, value in changes:
            event, context, repo, branch = fixtures()
            set_path(repo, path, value)
            with self.subTest(path=path):
                self.assertFalse(POLICY.trusted_candidate(event, context, repo, branch))
        event, context, repo, branch = fixtures()
        for value in [{}, dict(branch, protected=False), dict(branch, name="feature"),
                      dict(branch, commit={"sha": "f" * 40})]:
            self.assertFalse(POLICY.trusted_candidate(event, context, repo, value))

    def test_api_failure_emits_hosted_fallback_without_logging_credentials(self):
        event, context, _repo, _branch = fixtures()
        with tempfile.TemporaryDirectory() as directory:
            path, output = Path(directory) / "event.json", Path(directory) / "output"
            path.write_text(json.dumps(event))
            env = dict(context, GITHUB_EVENT_PATH=str(path), GITHUB_OUTPUT=str(output), GH_TOKEN="test-placeholder")
            with patch.dict(os.environ, env), patch.object(POLICY, "request", side_effect=OSError):
                POLICY.main()
            self.assertEqual(output.read_text(), "sha=\n")


class QueueWorkflowTests(unittest.TestCase):
    def test_embedded_shell_syntax(self):
        for block in re.findall(r"        run: \|\n((?:          [^\n]*\n|\n)+)", TEXT):
            script = "\n".join(line[10:] if line.startswith("          ") else line for line in block.splitlines())
            result = subprocess.run(["bash", "-n"], input=script, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_immutable_probe_embeds_policy_and_never_executes_candidate_code(self):
        block = jobs(TEXT)["queue-trust"]
        embedded = block.split("python3 - <<'PY'\n", 1)[1].split("\n          PY", 1)[0]
        self.assertEqual(textwrap.dedent(embedded).rstrip(), SOURCE.read_text().rstrip())
        self.assertNotIn("uses:", block)
        self.assertNotIn("checkout", block.split("    steps:\n", 1)[1].split("        env:", 1)[0].replace("before checkout", ""))
        self.assertIn("group: ci-trusted-main", block)
        self.assertIn("labels: ci-server-jane", block)
        self.assertIn("vars.CI_FLEET_ENABLED == 'true'", block)
        self.assertIn("vars.CI_FLEET_TARGET == 'ci-server-jane'", block)
        self.assertIn("github.event_name == 'merge_group'", block)
        self.assertNotIn("secrets.", TEXT)
        self.assertNotIn("id-token: write", block)
        self.assertNotIn("contents: write", block)
        self.assertIn("timeout-minutes: 3", block)

    def test_queue_output_selects_jane_only_for_the_verified_sha_and_overflow_target(self):
        expressions = re.findall(r"^    runs-on: (?:&fleet(?:-light)?-runner )?(\$\{\{ fromJSON\(.+\) \}\})$", TEXT, re.M)
        self.assertTrue(expressions)
        _event, context, _repo, _branch = fixtures()
        github = {"event_name": "merge_group", "sha": context["SHA"]}
        variables = {"CI_FLEET_ENABLED": "true", "CI_FLEET_TARGET": "ci-server-jane"}
        needs = {"queue-trust": {"result": "success", "outputs": {"sha": context["SHA"]}}}
        hosted = "ubuntu-24.04" if REMUS else "ubuntu-latest"
        for expression in expressions:
            self.assertEqual(evaluate(expression, github, variables, needs),
                             {"group": "ci-trusted-main", "labels": "ci-server-jane"})
            for changed_vars, changed_needs in [
                ({**variables, "CI_FLEET_ENABLED": "false"}, needs),
                ({**variables, "CI_FLEET_TARGET": "github-hosted"}, needs),
                (variables, {}), (variables, {"queue-trust": {"result": "success", "outputs": {"sha": "f" * 40}}}),
                (variables, {"queue-trust": {"result": "failure", "outputs": {"sha": context["SHA"]}}})]:
                self.assertEqual(evaluate(expression, github, changed_vars, changed_needs), hosted)
            # The old ordinary-PR/main routing predicate is retained verbatim.
            old_expressions = re.findall(r"^    runs-on: (?:&fleet(?:-light)?-runner )?(\$\{\{ fromJSON\(.+\) \}\})$", OLD, re.M)
            self.assertTrue(any(old[3:-3].removeprefix(" fromJSON(").rstrip()[:-1] in expression
                                for old in old_expressions))

    def test_every_existing_command_and_security_guard_is_preserved(self):
        old_jobs, new_jobs = jobs(OLD), jobs(TEXT)
        self.assertEqual(set(new_jobs), set(old_jobs) | {"queue-trust"})
        old_isolation = re.search(r'^      - &fleet-isolation\n.*?(?=^      - |^  [\w-]+:|\Z)', OLD, re.M | re.S)[0]
        self.assertIn(old_isolation, new_jobs["queue-trust"])
        for name, old in old_jobs.items():
            new = new_jobs[name]
            self.assertRegex(new, r"(?m)^    needs: (?:queue-trust|\[queue-trust, .+\])$")
            self.assertIn("needs.queue-trust.outputs.sha == github.sha", TEXT)
            old_steps = old.split("    steps:", 1)[1].replace(old_isolation, "      - *fleet-isolation\n")
            new_steps = new.split("    steps:", 1)[1]
            new_steps = new_steps.replace('            del(."queue-trust") |\n', '')
            self.assertEqual(new_steps, old_steps, name)
            old_if = re.search(r'^    if: (.*?)(?=^    [\w-]+:|\Z)', old, re.M | re.S)
            old_condition = " ".join(old_if[1].removeprefix(">-").split()) if old_if else None
            if old_condition == "always()":
                self.assertIn("    if: always()\n", new)
            else:
                self.assertIn("!cancelled()", new)
                if old_condition:
                    self.assertIn(old_condition, new)
                old_needs = re.search(r'^    needs: (.+)$', old, re.M)
                for dependency in re.findall(r'[\w-]+', old_needs[1] if old_needs else ''):
                    self.assertIn(f"needs.{dependency}.result == 'success'", new)

    def test_required_gate_still_rejects_application_failure_when_probe_skips_or_fails(self):
        if not REMUS:
            block = jobs(TEXT)["validate"]
            command = block.split("        run: |\n", 1)[1]
            for quality in ("success", "failure", "cancelled", "skipped"):
                result = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", textwrap.dedent(command)],
                    env=dict(os.environ, QUALITY_RESULT=quality, UNIT_RESULT="success", VALIDATION_RESULT="success"),
                    capture_output=True)
                self.assertEqual(result.returncode == 0, quality == "success")
            return
        command = jobs(TEXT)["ci-pass"].split("        run: |\n", 1)[1]
        for probe in ("success", "failure", "cancelled", "skipped"):
            for result in ("success", "failure", "cancelled", "skipped"):
                needs = {"queue-trust": {"result": probe}, "changes": {"result": "success"},
                         "repo-policy": {"result": result}, "secrets-scan": {"result": "success"}}
                status = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", textwrap.dedent(command)],
                    env=dict(os.environ, NEEDS=json.dumps(needs), HEAVY="false", DOCS="false",
                             FULL="false", WASM="false", EVENT="merge_group"), capture_output=True)
                self.assertEqual(status.returncode == 0, result == "success")


if __name__ == "__main__":
    unittest.main()

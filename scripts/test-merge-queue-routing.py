#!/usr/bin/env python3
"""Regression tests for the staged queue policy, scheduling and existing gates."""

import ast
import copy
import functools
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from policy_test_tools import bash_executable, git_command
SOURCE = ROOT / "scripts/merge_queue_policy.py"
spec = importlib.util.spec_from_file_location("queue_policy", SOURCE)
POLICY = importlib.util.module_from_spec(spec)
spec.loader.exec_module(POLICY)
REMUS = POLICY.REPOSITORY == "esaueng/remus"
JANE_LABEL = "ci-server-jane" if REMUS else "ci-server-jane-5gb"
CALLER = (ROOT / ".github/workflows/ci.yml").read_text()
# OpenZCAD checks the callee ci.yml activates, which is the one that schedules
# real jobs. Remus keeps its own staged file.
ACTIVE = ROOT / (".github/workflows/fleet-ci-v5.yml" if REMUS else re.search(
    r"uses: [^/\s]+/[^/\s]+/(\.github/workflows/fleet-ci(?:-v[0-9]+)?\.yml)@[a-f0-9]{40}\n",
    CALLER)[1])
TEXT = ACTIVE.read_text()
# fleet-ci-v4 (#836, #878): every shard installs browser binaries only, and
# merge-queue candidates run no e2e shards, which the e2e gate then accepts.
# fleet-ci-v5 (#882): pull-request shards start beside `quality` instead of
# after it. These exact edits are the whole approved difference in
# application jobs.
APPROVED_STEP_CHANGES = [] if REMUS else [
    ("  # Queue candidates, main pushes and manual dispatches start the shards at\n"
     "  # once, beside the other checks. Pull requests use `e2e-tests-pr` below.\n",
     "  # Main pushes and manual dispatches start the shards at once, beside the\n"
     "  # other checks. Pull requests use `e2e-tests-pr` below. Merge-queue\n"
     "  # candidates run no shards: auto-merge enqueues a PR only once `checks / e2e`\n"
     "  # passed on its head, and running the ~55 runner-minute suite again per\n"
     "  # candidate held six hosted runners while PRs and the next candidate queued\n"
     "  # behind them. Lint, typecheck, both Vitest projects, parity and the build\n"
     "  # still run on every candidate.\n"),
    ("  # On a pull request the shards wait for lint and typecheck. Hosted runners\n"
     "  # are a shared pool of concurrent jobs, and starting six browser shards on\n"
     "  # every push let superseded and lint-red pushes hold them while queue\n"
     "  # candidates waited 15-20 minutes for a runner. A push that `quality`\n"
     "  # rejects, or that a newer push cancels within those minutes, now never\n"
     "  # starts a shard. Queue candidates keep the parallel `e2e-tests` above.\n",
     "  # On a pull request the shards start at once, beside lint and typecheck.\n"
     "  # They used to wait for `quality` so lint-red and superseded pushes would not\n"
     "  # hold six runners of the Free plan's 20; on the Team plan's 60 that wait\n"
     "  # (2-4 minutes per push) cost more than the runners it saved, and a newer\n"
     "  # push still cancels a superseded run's shards. Queue candidates run none.\n"),
    ("      # the new build. `--with-deps` still runs so OS packages stay covered.\n",
     "      # the new build.\n"),
    ("      - run: |\n"
     "          if [ '${{ runner.environment }}' = self-hosted ]; then\n"
     "            pnpm exec playwright install chromium\n"
     "          else\n"
     "            pnpm exec playwright install --with-deps chromium\n"
     "          fi\n",
     "      # Browser binaries only, on both paths. The hosted Ubuntu image already\n"
     "      # carries Chromium's libraries: `--with-deps` added only fonts and\n"
     "      # package upgrades from the Ubuntu mirror, which crawled at ~35 kB/s on\n"
     "      # 17% of shard installs (up to 12 minutes) in October 2026. Self-hosted\n"
     "      # hosts get OS packages from their administrator. A missing library\n"
     "      # fails Chromium's launch outright, never a test silently.\n"
     "      - run: pnpm exec playwright install chromium\n"),
    ("  # run and fail explicitly unless exactly one shard set ran and succeeded.\n",
     "  # run and fail explicitly unless exactly one shard set ran and succeeded.\n"
     "  # Only a merge-queue candidate, which runs no shards, passes with none.\n"),
    ("        env:\n"
     "          DIRECT_RESULT: ${{ needs.e2e-tests.result }}\n",
     "        env:\n"
     "          EVENT_NAME: ${{ github.event_name }}\n"
     "          DIRECT_RESULT: ${{ needs.e2e-tests.result }}\n"),
    ("          echo \"e2e shards: direct $DIRECT_RESULT, pull request $PR_RESULT\"\n"
     "          case \"$DIRECT_RESULT/$PR_RESULT\" in\n"
     "            success/skipped | skipped/success) echo 'all e2e shards green' ;;\n"
     "            skipped/skipped)\n",
     "          echo \"e2e shards ($EVENT_NAME): direct $DIRECT_RESULT, pull request $PR_RESULT\"\n"
     "          case \"$EVENT_NAME/$DIRECT_RESULT/$PR_RESULT\" in\n"
     "            */success/skipped | */skipped/success) echo 'all e2e shards green' ;;\n"
     "            merge_group/skipped/skipped)\n"
     "              echo 'Queue candidate: e2e passed on the pull request head' ;;\n"
     "            */skipped/skipped)\n"),
    ("              echo 'No shard ran; pull-request shards start only after quality passes.' >&2\n",
     "              echo 'No shard ran.' >&2\n"),
]
# fleet-ci-v6 stages only these exact action revisions. Keep every other
# application command and security boundary identical to the approved baseline.
APPROVED_ACTION_UPDATES = [] if REMUS else [
    ("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7",
     "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7", 4),
    ("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1",
     "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2", 2),
]
# Dependencies an approved change removed: v5's PR shards no longer wait for
# `quality`, which still gates `validate` and every queue candidate.
APPROVED_DROPPED_NEEDS = {} if REMUS else {"e2e-tests-pr": {"quality"}}


def approved(text):
    for old, new in APPROVED_STEP_CHANGES:
        # A replacement that matches nothing would silently approve nothing.
        if text.count(old) != 1:
            raise AssertionError(f"Approved change no longer matches once: {old.splitlines()[0]}")
        text = text.replace(old, new)
    for old, new, count in APPROVED_ACTION_UPDATES:
        if text.count(old) != count:
            raise AssertionError(f"Approved action revision must match {count} times: {old}")
        text = text.replace(old, new)
    return text
def immutable_workflow(path, pin):
    previous = ROOT / path
    if previous.exists():
        return previous.read_text()
    # Activation retires the old file; keep comparing its immutable main bytes.
    command = git_command("show", f"{pin}:{path}")
    try:
        return subprocess.check_output(command, cwd=ROOT, text=True, encoding="utf-8", stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        subprocess.run(git_command("fetch", "--quiet", "--no-tags", "--depth=1", "origin", pin), cwd=ROOT, check=True)
        return subprocess.check_output(command, cwd=ROOT, text=True, encoding="utf-8")


def previous_workflow():
    comparison = json.loads((ROOT / "scripts/fleet-test-fixtures.json").read_text())[POLICY.REPOSITORY]
    return immutable_workflow(comparison["path"], comparison["pin"])


OLD = previous_workflow()
# The approved step changes above turn the original fleet-ci.yml into v6
# exactly (#1118, landed at 18b7421 and activated by #1120). Later callees
# (v8, #1295) deliberately restructure the application jobs, so their steps
# are pinned by test/ci-runtime-optimization.test.ts instead. What they must
# keep byte for byte is v6's trust boundary: see
# test_active_callee_keeps_the_lineage_trust_boundary. Read lazily: the
# fixture preparer imports this module and must not fetch a third snapshot.
@functools.cache
def lineage():
    return TEXT if REMUS else immutable_workflow(
        ".github/workflows/fleet-ci-v6.yml", "18b74211da50d21d9089fe08b9f03f4241c2a23d")


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
            result = subprocess.run([bash_executable(), "-n"], input=script, text=True, encoding="utf-8", capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_immutable_probe_embeds_policy_and_never_executes_candidate_code(self):
        block = jobs(TEXT)["queue-trust"]
        embedded = block.split("python3 - <<'PY'\n", 1)[1].split("\n          PY", 1)[0]
        self.assertEqual(textwrap.dedent(embedded).rstrip(), SOURCE.read_text().rstrip())
        self.assertNotIn("uses:", block)
        self.assertNotIn("checkout", block.split("    steps:\n", 1)[1].split("        env:", 1)[0].replace("before checkout", ""))
        self.assertIn("group: ci-trusted-main", block)
        self.assertIn("labels: " + JANE_LABEL, block)
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
                             {"group": "ci-trusted-main", "labels": JANE_LABEL})
            for changed_vars, changed_needs in [
                ({**variables, "CI_FLEET_ENABLED": "false"}, needs),
                ({**variables, "CI_FLEET_TARGET": "github-hosted"}, needs),
                (variables, {}), (variables, {"queue-trust": {"result": "success", "outputs": {"sha": "f" * 40}}}),
                (variables, {"queue-trust": {"result": "failure", "outputs": {"sha": context["SHA"]}}})]:
                self.assertEqual(evaluate(expression, github, changed_vars, changed_needs), hosted)
            # Only the runner selector changes for the approved new profile;
            # all old ordinary-PR/main authorization bytes remain identical.
            authorization = expression.replace(
                '"labels":"' + JANE_LABEL + '"', '"labels":"ci-server-jane"')
            old_expressions = re.findall(r"^    runs-on: (?:&fleet(?:-light)?-runner )?(\$\{\{ fromJSON\(.+\) \}\})$", OLD, re.M)
            self.assertTrue(any(old[3:-3].removeprefix(" fromJSON(").rstrip()[:-1] in authorization
                                for old in old_expressions))

    def test_every_existing_command_and_security_guard_is_preserved(self):
        old_jobs, new_jobs = jobs(approved(OLD)), jobs(lineage())
        self.assertEqual(set(new_jobs), set(old_jobs) | {"queue-trust"})
        old_isolation = re.search(r'^      - &fleet-isolation\n.*?(?=^      - |^  [\w-]+:|\Z)', OLD, re.M | re.S)[0]
        expected_isolation = old_isolation
        if not REMUS:
            # The independently approved three-slot migration changes only
            # this exact profile and the kernel page-alignment calculation.
            # Every other security check and application step stays identical.
            expected_isolation = expected_isolation.replace(
                'ci-server-jane-1|ci-server-jane-2)',
                'ci-server-jane-1|ci-server-jane-2|ci-server-jane-3)')
            expected_isolation = expected_isolation.replace(
                'CI_MEMORY=6442450944', 'CI_MEMORY=5000000000')
            expected_isolation = expected_isolation.replace(
                '          CI_CGROUP=',
                '          CI_MEMORY=$((CI_MEMORY / $(getconf PAGESIZE) * $(getconf PAGESIZE)))\n          CI_CGROUP=')
        self.assertIn(expected_isolation, new_jobs["queue-trust"])
        for name, old in old_jobs.items():
            new = new_jobs[name]
            self.assertRegex(new, r"(?m)^    needs: (?:queue-trust|\[queue-trust, .+\])$")
            self.assertIn("needs.queue-trust.outputs.sha == github.sha", lineage())
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
                    if dependency in APPROVED_DROPPED_NEEDS.get(name, ()):
                        self.assertNotIn(f"needs.{dependency}.", new)
                        continue
                    self.assertIn(f"needs.{dependency}.result == 'success'", new)

    def test_active_callee_keeps_the_lineage_trust_boundary(self):
        if REMUS:
            return
        # Workflow triggers and permissions, the embedded queue probe, the
        # isolation guard and the runner authorization stay v6's exact bytes.
        baseline = lineage()
        self.assertEqual(TEXT.split("\njobs:\n", 1)[0], baseline.split("\njobs:\n", 1)[0])
        active, previous = jobs(TEXT), jobs(baseline)
        self.assertEqual(active["queue-trust"], previous["queue-trust"])
        isolation = r'^      - &fleet-isolation\n.*?(?=^      - |^  [\w-]+:|\Z)'
        self.assertEqual(re.search(isolation, TEXT, re.M | re.S)[0],
                         re.search(isolation, baseline, re.M | re.S)[0])
        runner = r"^    runs-on: &fleet-runner (\$\{\{ fromJSON\(.+\) \}\})$"
        self.assertEqual(re.findall(runner, TEXT, re.M), re.findall(runner, baseline, re.M))
        self.assertEqual(len(re.findall(runner, TEXT, re.M)), 1)
        for name, block in active.items():
            if name == "queue-trust":
                continue
            with self.subTest(job=name):
                self.assertRegex(block, r"(?m)^    needs: (?:queue-trust|\[queue-trust, .+\])$")
                placement = re.search(r"(?m)^    runs-on: (.+)$", block)[1]
                if placement.startswith(("&fleet-runner ", "*fleet-runner")):
                    # Every job that may land on a home slot checks it first.
                    steps = re.search(r"(?m)^    steps: \*([\w-]+)$", block)
                    # A shared step list is checked where its anchor is defined.
                    anchor = rf"(?m)^    steps: &{steps[1]}\n" if steps else r"(?m)^    steps:(?: &[\w-]+)?\n"
                    self.assertRegex(TEXT if steps else block,
                                     anchor + r"      - (?:\*fleet-isolation|&fleet-isolation)\n")
                else:
                    # Anything else is an explicit hosted image, never a home slot.
                    self.assertIn(placement, ("ubuntu-24.04", "ubuntu-latest"))
                    self.assertNotIn("ci-trusted-main", block)

    def test_required_gate_still_rejects_application_failure_when_probe_skips_or_fails(self):
        if not REMUS:
            block = jobs(TEXT)["validate"]
            needs = re.findall(r"[\w-]+", re.search(r"(?m)^    needs: \[(.+)\]$", block)[1])
            results = dict(re.findall(r"(?m)^          (\w+_RESULT): \$\{\{ needs\.([\w-]+)\.result \}\}$", block))
            # The gate reads every job it waits for except the optional probe.
            self.assertEqual(sorted(results.values()), sorted(set(needs) - {"queue-trust"}))
            command = block.split("        run: |\n", 1)[1]
            green = {variable: "success" for variable in results}
            for variable in results:
                for result in ("success", "failure", "cancelled", "skipped", ""):
                    with self.subTest(variable=variable, result=result):
                        status = subprocess.run([bash_executable(), "-e", "-o", "pipefail", "-c", textwrap.dedent(command)],
                            env={**os.environ, **green, variable: result}, capture_output=True)
                        self.assertEqual(status.returncode == 0, result == "success")
            return
        command = jobs(TEXT)["ci-pass"].split("        run: |\n", 1)[1]
        for probe in ("success", "failure", "cancelled", "skipped"):
            for result in ("success", "failure", "cancelled", "skipped"):
                needs = {"queue-trust": {"result": probe}, "changes": {"result": "success"},
                         "repo-policy": {"result": result}, "secrets-scan": {"result": "success"}}
                status = subprocess.run([bash_executable(), "-e", "-o", "pipefail", "-c", textwrap.dedent(command)],
                    env=dict(os.environ, NEEDS=json.dumps(needs), HEAVY="false", DOCS="false",
                             FULL="false", WASM="false", EVENT="merge_group"), capture_output=True)
                self.assertEqual(status.returncode == 0, result == "success")


if __name__ == "__main__":
    unittest.main()

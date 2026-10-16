"""Synthetic regression fixtures only; no real identifiers or historical OIDs."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("history_privacy", Path(__file__).with_name("history_privacy.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
KEY = "ab" * 32
REMOVED = b"fixture-person@example.invalid"


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.env = dict(os.environ, GIT_AUTHOR_NAME="example-user", GIT_COMMITTER_NAME="example-user",
                        GIT_AUTHOR_EMAIL="123+example-user@users.noreply.github.com",
                        GIT_COMMITTER_EMAIL="123+example-user@users.noreply.github.com")
        self.run_git("init", "--quiet")
        # A private temporary test repo has no project hooks to chain. The
        # production repository and its shared hooks are never altered.
        (self.root / "hooks").mkdir()
        self.run_git("config", "core.hooksPath", str(self.root / "hooks"))
        self.commit("safe.txt", b"safe", "fixture baseline")
        self.base = self.oid()
        self.policy_path = self.root / "policy.json"
        self.write_policy()
        self.policy = guard.Policy(self.policy_path, KEY)

    def tearDown(self):
        self.tmp.cleanup()

    def run_git(self, *args, data=None, env=None):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], input=data,
                                       env=env or self.env, stderr=subprocess.DEVNULL)

    def oid(self, ref="HEAD"):
        return self.run_git("rev-parse", ref).decode().strip()

    def commit(self, name, contents, message, env=None):
        (self.repo / name).write_bytes(contents)
        self.run_git("add", "--", name)
        self.run_git("commit", "--quiet", "-m", message, env=env)

    def write_policy(self, banned=("0" * 40,), key=KEY):
        blocked = b"".join(sorted(hashlib.sha256(oid.encode()).digest() for oid in banned))
        self.policy_path.with_name("blocked-history.bin").write_bytes(blocked)
        raw = bytes.fromhex(key)
        self.policy_path.write_text(json.dumps({
            "version": 1, "baseline": self.base,
            "object_ledger_scope": list(guard.PUBLIC_REPOSITORIES),
            "verification_digest": guard.fingerprint(raw, b"key", b"history-privacy-v1"),
            "blocked_file_sha256": hashlib.sha256(blocked).hexdigest(),
            "blocked_object_count": len(banned),
            "identifiers": [{"length": len(REMOVED),
                             "prefix_digest": guard.fingerprint(raw, b"prefix", REMOVED[:2]),
                             "digest": guard.fingerprint(raw, b"value", REMOVED)}]}))

    def inspect(self, *heads):
        return guard.scan(self.repo, self.policy, list(heads) or [self.oid()], [self.base])

    def test_clean_history_and_public_identity_pass(self):
        self.commit("clean.txt", b"normal contribution", "clean change")
        self.assertGreater(self.inspect(), 0)

    def test_dirty_older_commit_cannot_hide_behind_clean_tip(self):
        self.commit("deleted.txt", b"prefix " + REMOVED.upper() + b" suffix", "old data")
        self.run_git("rm", "--quiet", "deleted.txt")
        self.run_git("commit", "--quiet", "-m", "clean tip")
        with self.assertRaises(guard.PrivacyError):
            self.inspect()

    def test_removed_identifier_in_commit_message(self):
        self.commit("clean.txt", b"clean", REMOVED.decode())
        with self.assertRaises(guard.PrivacyError):
            self.inspect()

    def test_unrecognized_author_and_committer_are_scanned(self):
        for field in ("AUTHOR", "COMMITTER"):
            with self.subTest(field=field):
                env = dict(self.env, **{"GIT_" + field + "_EMAIL": REMOVED.decode()})
                self.commit(field + ".txt", b"clean", "metadata fixture", env=env)
                with self.assertRaises(guard.PrivacyError):
                    self.inspect()

    def test_removed_filename(self):
        self.commit(REMOVED.decode(), b"clean", "filename fixture")
        with self.assertRaises(guard.PrivacyError):
            self.inspect()

    def test_binary_and_chunk_boundary(self):
        self.commit("binary.dat", b"\xff\0" + b"x" * 61 + REMOVED + b"\0", "binary fixture")
        with patch.object(guard, "CHUNK", 64):
            with self.assertRaises(guard.PrivacyError):
                self.inspect()

    def test_annotated_and_nested_tags(self):
        self.run_git("tag", "-a", "inner", "-m", REMOVED.decode())
        self.run_git("tag", "-a", "outer", "inner", "-m", "safe outer tag")
        with self.assertRaises(guard.PrivacyError):
            self.inspect(self.oid("outer"))

    def test_reference_name(self):
        with self.assertRaises(guard.PrivacyError):
            guard.scan(self.repo, self.policy, [self.oid()], [self.base], ["refs/heads/" + REMOVED.decode()])

    def test_reintroduced_rewritten_object_is_blocked_without_private_content(self):
        self.commit("old.txt", b"otherwise clean", "replaced history fixture")
        old = self.oid()
        self.write_policy(banned=(old,))
        self.policy = guard.Policy(self.policy_path, KEY)
        with self.assertRaises(guard.PrivacyError):
            self.inspect()

    def test_reference_to_replaced_object_is_also_blocked(self):
        old = "a" * 40
        self.write_policy(banned=(old,))
        self.policy = guard.Policy(self.policy_path, KEY)
        self.commit("pin.txt", old.upper().encode(), "old pin fixture")
        with self.assertRaises(guard.PrivacyError):
            self.inspect()

    def test_cross_repository_retired_pin_is_blocked(self):
        own, foreign = "a" * 40, "b" * 40
        self.write_policy(banned=(own, foreign))
        self.policy = guard.Policy(self.policy_path, KEY)
        self.commit("dependency-pin.txt", foreign.encode(), "foreign repository pin fixture")
        with self.assertRaisesRegex(guard.PrivacyError, "Reference to a replaced Git object"):
            self.inspect()

    def test_object_ledger_must_cover_every_public_repository(self):
        data = json.loads(self.policy_path.read_text())
        data["object_ledger_scope"].pop()
        self.policy_path.write_text(json.dumps(data))
        with self.assertRaises(guard.PrivacyError):
            guard.Policy(self.policy_path, KEY)

    def test_blocked_gitlink_is_rejected_even_when_target_object_is_absent(self):
        old = "1" * 40
        self.write_policy(banned=(old,))
        self.policy = guard.Policy(self.policy_path, KEY)
        self.run_git("update-index", "--add", "--cacheinfo", "160000," + old + ",module")
        self.run_git("commit", "--quiet", "-m", "gitlink fixture")
        for chunk in (guard.CHUNK, 7):
            with self.subTest(chunk=chunk), patch.object(guard, "CHUNK", chunk):
                with self.assertRaisesRegex(guard.PrivacyError, "Reintroduced Git object"):
                    self.inspect()

    def test_clean_gitlink_needs_no_submodule_fetch(self):
        self.run_git("update-index", "--add", "--cacheinfo", "160000," + "2" * 40 + ",module")
        self.run_git("commit", "--quiet", "-m", "clean gitlink fixture")
        self.assertGreater(self.inspect(), 0)

    def test_truncated_binary_tree_fails_closed(self):
        tree = guard.TreeScanner(self.policy)
        tree.feed(b"160000 module\0" + b"\x11" * 19)
        with self.assertRaisesRegex(guard.PrivacyError, "Truncated Git tree"):
            tree.feed(b"", final=True)

    def test_non_fast_forward_history_and_merge_parent_are_checked(self):
        self.commit("old.txt", REMOVED, "dirty side branch")
        old = self.oid()
        self.run_git("checkout", "--quiet", "--detach", self.base)
        self.commit("new.txt", b"clean", "clean branch")
        self.run_git("merge", "--quiet", "--no-ff", "-m", "merge fixture", old)
        with self.assertRaises(guard.PrivacyError):
            self.inspect()

    def test_shallow_and_missing_objects_fail_closed(self):
        with self.assertRaises(guard.PrivacyError):
            self.inspect("1" * 40)
        (self.repo / ".git" / "shallow").write_text(self.base + "\n")
        with self.assertRaises(guard.PrivacyError):
            self.inspect()

    def test_replace_refs_cannot_hide_dirty_commit(self):
        self.commit("dirty.txt", REMOVED, "original fixture")
        old = self.oid()
        self.run_git("replace", old, self.base)
        with self.assertRaises(guard.PrivacyError):
            self.inspect(old)

    def test_policy_missing_secret_wrong_secret_and_corruption_fail_closed(self):
        for key in ("", "cd" * 32):
            with self.assertRaises(guard.PrivacyError):
                guard.Policy(self.policy_path, key)
        self.policy_path.with_name("blocked-history.bin").write_bytes(b"bad")
        with self.assertRaises(guard.PrivacyError):
            guard.Policy(self.policy_path, KEY)

    def test_errors_do_not_echo_private_content_or_oid(self):
        self.commit("dirty.txt", REMOVED, "dirty fixture")
        env = dict(self.env, HISTORY_PRIVACY_HMAC_KEY=KEY)
        result = subprocess.run(["python3", str(Path(guard.__file__)), "--repo", str(self.repo),
                                 "--policy", str(self.policy_path), "--head", self.oid()],
                                env=env, capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(REMOVED, result.stdout + result.stderr)
        self.assertNotIn(self.oid().encode(), result.stdout + result.stderr)

    def test_event_selection_uses_pr_head_and_checks_tag_object(self):
        head = "b" * 40
        event = {"pull_request": {"head": {"sha": head, "ref": "topic"}}}
        self.assertEqual(guard.select_event("pull_request_target", event, self.base), ([head], ["topic"], head))
        self.assertEqual(guard.select_event("push", {"after": head, "ref": "refs/tags/v1"}, self.base),
                         ([head], ["refs/tags/v1"], None))
        self.assertEqual(guard.select_event("push", {"deleted": True}, self.base), ([], [], None))
        self.assertEqual(guard.select_event("merge_group", {"merge_group": {"head_sha": head}}, self.base),
                         ([head], [], head))
        with self.assertRaises(guard.PrivacyError):
            guard.select_event("pull_request", {}, self.base)

    def test_incoming_program_is_never_executed(self):
        marker = self.root / "should-not-exist"
        program = "from pathlib import Path\nPath(" + repr(str(marker)) + ").touch()\n"
        self.commit("incoming.py", program.encode(), "untrusted program fixture")
        self.inspect()
        self.assertFalse(marker.exists())

    def test_ci_failure_is_published_on_exact_pr_head(self):
        event = self.root / "event.json"
        head = "b" * 40
        event.write_text(json.dumps({"pull_request": {"head": {"sha": head, "ref": "topic"}}}))
        env = dict(GITHUB_EVENT_PATH=str(event), GITHUB_EVENT_NAME="pull_request_target",
                   GITHUB_SHA=self.base, GITHUB_REPOSITORY="example/repository",
                   HISTORY_PRIVACY_HMAC_KEY="")
        with patch.dict(os.environ, env), patch.object(guard, "api", return_value={"id": 123}) as api:
            with self.assertRaises(guard.PrivacyError):
                guard.ci(self.policy_path)
        self.assertEqual(api.call_args_list[0].args[2]["head_sha"], head)
        self.assertEqual(api.call_args_list[-1].args[2]["conclusion"], "failure")

    def test_git_subprocesses_do_not_inherit_key_or_token(self):
        with patch.dict(os.environ, HISTORY_PRIVACY_HMAC_KEY=KEY, GH_TOKEN="synthetic-api-token"):
            with patch.object(guard.subprocess, "run") as run:
                run.return_value.returncode = 0
                run.return_value.stdout = b"ok"
                guard.git(self.repo, "rev-parse", "HEAD")
        passed_env = run.call_args.kwargs["env"]
        self.assertNotIn("HISTORY_PRIVACY_HMAC_KEY", passed_env)
        self.assertNotIn("GH_TOKEN", passed_env)


if __name__ == "__main__":
    unittest.main()

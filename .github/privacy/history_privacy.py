#!/usr/bin/env python3
"""Inspect Git objects as data; never check out or execute incoming code."""

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

OID = re.compile(r"[0-9a-f]{40}")
HEX256 = re.compile(r"[0-9a-f]{64}")
OBJECT_REFERENCE = re.compile(rb"(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])")
CHUNK = 1024 * 1024


class PrivacyError(Exception):
    """Errors intentionally contain no incoming content or identifiers."""


def fingerprint(key, domain, value):
    return hmac.digest(key, domain + b"\0" + value, "sha256").hex()


class Policy:
    def __init__(self, path, key):
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
            self.key = bytes.fromhex(key)
            if len(self.key) != 32 or data["version"] != 1:
                raise ValueError()
            if not hmac.compare_digest(data["verification_digest"], fingerprint(self.key, b"key", b"history-privacy-v1")):
                raise ValueError()
            self.baseline = data["baseline"]
            if not OID.fullmatch(self.baseline):
                raise ValueError()
            blocked = Path(path).with_name("blocked-history.bin").read_bytes()
            if (len(blocked) % 32 or not blocked or
                    hashlib.sha256(blocked).hexdigest() != data["blocked_file_sha256"] or
                    len(blocked) // 32 != data["blocked_object_count"]):
                raise ValueError()
            self.blocked = {blocked[i:i + 32] for i in range(0, len(blocked), 32)}
            if len(self.blocked) != data["blocked_object_count"]:
                raise ValueError()
            tokens = data["identifiers"]
            if not tokens:
                raise ValueError()
            wanted = {}
            for token in tokens:
                length = token["length"]
                if (not isinstance(length, int) or not 3 <= length <= 4096 or
                        not HEX256.fullmatch(token["digest"]) or
                        not HEX256.fullmatch(token["prefix_digest"])):
                    raise ValueError()
                wanted.setdefault(token["prefix_digest"], []).append(token)
            # Only two-byte candidate prefixes are recovered, using the secret
            # key. The public policy never contains private strings or old OIDs.
            self.prefixes = {}
            for number in range(65536):
                prefix = number.to_bytes(2, "big")
                digest = fingerprint(self.key, b"prefix", prefix)
                if digest in wanted:
                    self.prefixes[prefix] = wanted.pop(digest)
            if wanted:
                raise ValueError()
            self.find = re.compile(b"(?=(" + b"|".join(re.escape(p) for p in self.prefixes) + b"))")
            self.overlap = max(42, max(t["length"] for t in tokens)) - 1
        except (KeyError, TypeError, ValueError, OSError, OverflowError):
            raise PrivacyError("Privacy policy or secret key is missing, invalid, or mismatched.") from None

    def check_oid(self, oid):
        if not OID.fullmatch(oid):
            raise PrivacyError("Invalid Git object ID.")
        if hashlib.sha256(oid.encode("ascii")).digest() in self.blocked:
            raise PrivacyError("Reintroduced Git object from redacted history; details withheld.")

    def check(self, data):
        folded = data.lower()
        for reference in OBJECT_REFERENCE.finditer(folded):
            if hashlib.sha256(reference[0]).digest() in self.blocked:
                raise PrivacyError("Reference to a replaced Git object found; details withheld.")
        for match in self.find.finditer(folded):
            for token in self.prefixes[match[1]]:
                candidate = folded[match.start():match.start() + token["length"]]
                if len(candidate) == token["length"] and hmac.compare_digest(
                        fingerprint(self.key, b"value", candidate), token["digest"]):
                    raise PrivacyError("Removed identifier found in incoming Git data; details withheld.")


def git(repo, *args, data=None):
    # Do not pass the fingerprint key or API token to Git subprocesses.
    env = {k: v for k, v in os.environ.items() if k not in ("HISTORY_PRIVACY_HMAC_KEY", "GH_TOKEN")}
    env.update(GIT_NO_REPLACE_OBJECTS="1", GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0")
    result = subprocess.run(["git", "-C", str(repo), *args], input=data,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    if result.returncode:
        raise PrivacyError("Git history is unavailable or incomplete; verification refused.")
    return result.stdout


def scan(repo, policy, heads, excludes=(), refs=()):
    if not heads:
        raise PrivacyError("No history selected for verification.")
    for oid in [*heads, *excludes]:
        if not OID.fullmatch(oid):
            raise PrivacyError("Invalid Git range.")
    if git(repo, "rev-parse", "--is-shallow-repository").strip() != b"false":
        raise PrivacyError("Shallow history cannot be verified.")
    for ref in refs:
        policy.check(ref.encode("utf-8"))
    revisions = "\n".join([*heads, *("^" + oid for oid in excludes)]) + "\n"
    objects = git(repo, "rev-list", "--objects", "--no-object-names", "--stdin", data=revisions.encode("ascii"))
    ids = set(objects.decode("ascii").splitlines())
    # Explicitly include annotated tags (including nested tags), even if Git's
    # revision traversal peels them before emitting its object list.
    for head in heads:
        oid = head
        seen = set()
        while True:
            if oid in seen:
                raise PrivacyError("Invalid tag chain.")
            seen.add(oid)
            ids.add(oid)
            kind = git(repo, "cat-file", "-t", oid).strip()
            if kind != b"tag":
                if kind != b"commit":
                    raise PrivacyError("References must resolve to commits.")
                break
            tag = git(repo, "cat-file", "tag", oid)
            policy.check(tag)
            oid = tag.splitlines()[0].split()[1].decode("ascii")
            if not OID.fullmatch(oid):
                raise PrivacyError("Invalid tag target.")
    ordered = sorted(ids)
    for oid in ordered:
        policy.check_oid(oid)
    # Input and error streams are files to avoid pipe deadlocks and accidental
    # printing of attacker-controlled paths/messages. Objects are streamed.
    with tempfile.TemporaryFile() as requests, tempfile.TemporaryFile() as errors:
        requests.write(("\n".join(ordered) + "\n").encode("ascii"))
        requests.seek(0)
        env = {k: v for k, v in os.environ.items() if k not in ("HISTORY_PRIVACY_HMAC_KEY", "GH_TOKEN")}
        env.update(GIT_NO_REPLACE_OBJECTS="1", GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0")
        process = subprocess.Popen(["git", "-C", str(repo), "cat-file", "--batch"], stdin=requests,
                                   stdout=subprocess.PIPE, stderr=errors, env=env)
        try:
            for oid in ordered:
                header = process.stdout.readline().split()
                if len(header) != 3 or header[0].decode("ascii") != oid or header[1] not in (b"commit", b"tree", b"blob", b"tag"):
                    raise PrivacyError("Git object could not be read completely.")
                remaining = int(header[2])
                tail = b""
                while remaining:
                    block = process.stdout.read(min(CHUNK, remaining))
                    if not block:
                        raise PrivacyError("Truncated Git object; verification refused.")
                    remaining -= len(block)
                    joined = tail + block
                    policy.check(joined)
                    tail = joined[-policy.overlap:]
                if process.stdout.read(1) != b"\n":
                    raise PrivacyError("Invalid Git object framing.")
            if process.wait():
                raise PrivacyError("Git object scan failed.")
        finally:
            process.stdout.close()
            if process.poll() is None:
                process.terminate()
                process.wait()
    return len(ordered)


def select_event(name, event, default_head):
    if name == "pull_request_target":
        pr = event["pull_request"]
        return [pr["head"]["sha"]], [pr["head"]["ref"]], pr["head"]["sha"]
    if name == "merge_group":
        head = event["merge_group"]["head_sha"]
        return [head], [], head
    if name == "push":
        if event.get("deleted"):
            return [], [], None
        return [event["after"]], [event["ref"]], None
    if name in ("workflow_dispatch", "schedule"):
        return [default_head], [], default_head
    raise PrivacyError("Unsupported event; verification refused.")


def api(method, path, body):
    repository = os.environ["GITHUB_REPOSITORY"]
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise PrivacyError("Invalid repository context.")
    request = urllib.request.Request("https://api.github.com/repos/" + repository + path,
                                     data=json.dumps(body).encode("utf-8"), method=method, headers={
                                         "Authorization": "Bearer " + os.environ["GH_TOKEN"],
                                         "Accept": "application/vnd.github+json",
                                         "X-GitHub-Api-Version": "2022-11-28"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except (urllib.error.URLError, ValueError):
        raise PrivacyError("GitHub check result could not be published; retry required.") from None


def ci(policy_path):
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(encoding="utf-8"))
    heads, refs, report_head = select_event(os.environ["GITHUB_EVENT_NAME"], event, os.environ["GITHUB_SHA"])
    if not heads:
        print("Reference deletion: no incoming history.")
        return
    check = None
    passed = False
    try:
        if report_head:
            if not OID.fullmatch(report_head):
                raise PrivacyError("Invalid check head.")
            check = api("POST", "/check-runs", {"name": "history-privacy", "head_sha": report_head, "status": "in_progress"})
        policy = Policy(policy_path, os.environ.get("HISTORY_PRIVACY_HMAC_KEY", ""))
        repository = os.environ["GITHUB_REPOSITORY"]
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise PrivacyError("Invalid repository context.")
        with tempfile.TemporaryDirectory(prefix="history-privacy-") as directory:
            git(directory, "init", "--bare", "--quiet", ".")
            git(directory, "remote", "add", "origin", "https://github.com/" + repository + ".git")
            for oid in sorted(set([policy.baseline, *heads])):
                if not OID.fullmatch(oid):
                    raise PrivacyError("Invalid fetch target.")
                git(directory, "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never",
                    "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "origin", oid)
            full_audit = os.environ["GITHUB_EVENT_NAME"] in ("workflow_dispatch", "schedule")
            if full_audit:
                git(directory, "fetch", "--quiet", "--no-recurse-submodules", "origin",
                    "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*")
                advertised = git(directory, "for-each-ref", "--format=%(objectname) %(refname)",
                                 "refs/heads", "refs/tags").decode("utf-8").splitlines()
                heads, refs = [], []
                for line in advertised:
                    oid, ref = line.split(" ", 1)
                    heads.append(oid)
                    refs.append(ref)
            if check is None:
                report_head = git(directory, "rev-parse", "--verify", heads[0] + "^{commit}").decode("ascii").strip()
                check = api("POST", "/check-runs", {"name": "history-privacy", "head_sha": report_head, "status": "in_progress"})
            count = scan(directory, policy, heads, excludes=[] if full_audit else [policy.baseline], refs=refs)
        print(f"PASS: inspected {count} incoming Git objects; privacy details withheld.")
        passed = True
    finally:
        if check is not None:
            api("PATCH", "/check-runs/" + str(check["id"]), {
                "status": "completed", "conclusion": "success" if passed else "failure",
                "output": {"title": "History privacy " + ("passed" if passed else "failed"),
                           "summary": "Replaced history and removed identifiers checked without executing incoming code."
                           if passed else "History privacy verification failed. Values and object IDs are withheld; inspect the trusted audit job."}})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--policy", default=str(Path(__file__).with_name("policy.json")))
    parser.add_argument("--ci", action="store_true")
    parser.add_argument("--repo", default=".")
    parser.add_argument("--head", action="append", default=[])
    parser.add_argument("--full", action="store_true", help="Also inspect the trusted baseline ancestry")
    args = parser.parse_args()
    try:
        if args.ci:
            ci(args.policy)
        else:
            policy = Policy(args.policy, os.environ.get("HISTORY_PRIVACY_HMAC_KEY", ""))
            count = scan(args.repo, policy, args.head, () if args.full else [policy.baseline])
            print(f"PASS: inspected {count} Git objects; privacy details withheld.")
        return 0
    except (PrivacyError, KeyError, TypeError, ValueError, OSError, UnicodeError):
        # Never echo exceptions, Git diagnostics, names, filenames, or object IDs.
        print("::error::History privacy verification failed; values and object IDs withheld.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

# History privacy checks

`history-privacy` prevents replaced Git objects and removed identifiers from
entering protected history. It supplements `commit-privacy` and secret scanning.

## What is inspected

- Incoming raw commits: authors, committers, messages, signatures and merge parents.
- Every newly reachable tree and blob, including filenames, binary data and files
  deleted again before the branch tip.
- Annotated and nested tags and incoming branch/tag names.
- Raw binary tree references, including submodule/gitlink targets that Git's
  object traversal deliberately does not follow. Submodules are never fetched.
- Fingerprints of objects replaced by both October 16, 2026 redaction passes.
- Full-length textual references to those replaced object IDs, including pins.

The blocked-object ledger is the union for all six public Esau repositories.
A dependency pin or gitlink cannot point at another project's retired object
merely because that object is absent from this repository's object database.
The policy requires the complete public-repository scope.

The baseline is an audited, immutable clean commit recorded in `policy.json`.
Incoming history is compared to that fixed commit, rather than trusting the
previous push tip, PR commit-list limits, replace refs, or retained PR/cache refs.
Manual dispatch and the daily audit inspect all advertised owner branches and
tags, including baseline ancestry. The daily default-branch run also detects
old branches/tags whose own history lacks the new push workflow.
Missing objects, shallow history, invalid policy and missing/mismatched
keys fail verification.

`blocked-history.bin` contains sorted 32-byte SHA-256 fingerprints of **old object
IDs**, not the original IDs or their contents. Its checksum and count are recorded
in the policy. This avoids publishing pointers to removed GitHub objects.

Removed identifiers remain in the operator's local private denylist. Public
policy entries contain lengths and domain-separated HMAC-SHA256 fingerprints of
each case-folded byte string and its two-byte prefix. The random 256-bit key is
the repository Actions secret `HISTORY_PRIVACY_HMAC_KEY`. Short prefixes are
recovered in memory using the key; efficient prefix searches select candidates
for full HMAC comparison. Neither private strings nor the key are committed.
Do not replace keyed fingerprints with unsalted hashes of private identifiers.

## Trust and merge enforcement

The audit workflow pins its scanner and policy checkout to a reviewed immutable
commit, retained by an update- and deletion-protected policy tag so squash merges
cannot orphan it. PR events use `pull_request_target` so a PR cannot change its own policy.
Incoming Git objects are fetched into a fresh bare repository as data. The audit
never checks out incoming trees, runs their programs, installs their dependencies,
loads their configuration or uploads their contents as artifacts. Git subprocesses
do not inherit the HMAC key or API token.

The job publishes a separate `history-privacy` check explicitly on the PR head
(or merge-group candidate). This matters because `pull_request_target` itself
runs on the default-branch SHA. The workflow job is named
`history-privacy-audit` to distinguish it from the required head check.

Require `history-privacy` from the GitHub Actions app in the protected-main status
checks, alongside all existing checks. Keep admin enforcement enabled and force
pushes disabled. Preserve active merge queues and their existing review rules.
The key must be provisioned before enabling the required check.

Public fingerprint updates and scanner updates go through review. To update the
pin, first commit the scanner, tests and policy, preserve the source with a new
`history-privacy-policy-*` tag, then pin that commit in a second commit.
Regenerate keyed fingerprints when rotating the key; do not rotate only
the secret. A new redaction must add the replaced objects to the blocked set and
extend local denylist coverage before refreshing the public policy.

## Validation and limits

Run `python3 -m unittest discover -s .github/privacy -p 'test_*.py'`.
Tests use synthetic identifiers and disposable Git repositories only. They do not
require the production key. Local full-history verification can use
`history_privacy.py --repo REPO --head FULL_SHA --full` with the key provided only
through the environment.

CI checks run after GitHub receives a push. Required checks protect merging into
`main`; they cannot retract a public branch/tag upload or replace a server-side
pre-receive hook. Keep the local Git privacy guard installed and verified before
every push. These checks cover known removed identifiers and replaced objects;
they do not infer every possible new secret, encoded representation, or private
identifier. Existing general secret scans continue to serve that separate role.

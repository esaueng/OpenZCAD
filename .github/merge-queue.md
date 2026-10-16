# Main branch merge queue

Main uses squash merges with the PR title as the commit title and the PR
description as the commit body. The active `Bounded merge queue` ruleset has
no bypass actors, builds at most two queue entries concurrently, and uses
`SQUASH` and `ALLGREEN`. It merges one or two passing entries at a time, with
no minimum-group wait and a 180-minute check timeout, matching Remus.

Branch protection retains `checks / validate`, `checks / e2e`, and
`commit-privacy`, their GitHub Actions app bindings, the existing review
requirements, and conversation resolution. The queue validates changes with
the latest main. Strict up-to-date status checks are disabled: being behind
main alone does not require a manual merge or rebase. Resolve actual merge
conflicts, and rerun PR checks whenever its head changes. If restoring these
settings, activate and verify the queue before disabling strict status checks.

Before enqueueing an authorized PR, inspect its current head, reviews,
unresolved threads, and individual CI jobs, including all six browser shards
and Cloudflare `verify`. Then enqueue that PR with its expected head SHA.
Do not use a direct/admin merge, `gh pr merge --auto`, or enqueue unrelated
PRs. The queue’s `merge_group` run must pass the required checks before GitHub
merges it.

CI and Cloudflare verification handle `merge_group: checks_requested` without
replacing pending queue verdicts. The immutable fleet workflow runs queue
candidates on GitHub-hosted runners; its PR-only kernel announcement policy
is checked before enqueueing. Commit privacy already checks the merge-group
base-to-head range. Cloudflare queue runs perform dry-run verification only;
version uploads remain limited to main pushes and manual dispatches. Merging
continues to trigger the repository's existing automatic deployment workflows.

## Enqueue and verify an authorized PR

1. Read live repository settings, branch protection, and the queue ruleset.
   Keep every required context and app binding, review requirement, and
   conversation-resolution setting. Classic `enforce_admins: false` does not
   grant a bypass of the active queue ruleset.
2. Inspect the PR’s current head, reviews, comments, resolved threads, and
   individual jobs. Required contexts are `checks / validate`, `checks / e2e`,
   and `commit-privacy`; also wait for Cloudflare `verify`, Workers Builds,
   audits, public commit metadata, and all six browser shards. A passing suite
   or checks on an older head are insufficient. Cloudflare `verify` remains
   an operational gate rather than a required branch-protection context.
3. Obtain the PR node ID and current head SHA, then recheck them immediately
   before enqueueing. With those verified values in `PR_ID` and `HEAD_SHA`,
   enqueue only that PR with head protection and without jumping the queue:

   ```bash
   gh api graphql \
     -f query='mutation($pr: ID!, $head: GitObjectID!) {
       enqueuePullRequest(input: {
         pullRequestId: $pr, expectedHeadOid: $head, jump: false
       }) { mergeQueueEntry { id state } }
     }' \
     -f pr="$PR_ID" -f head="$HEAD_SHA"
   ```

4. Read the entry’s `headCommit.oid` after it reaches `AWAITING_CHECKS` (it
   can initially be null). Match that SHA to the `merge_group` workflow runs.
   Require the queue candidate’s validation, browser aggregate, and privacy
   checks to pass; verify Cloudflare `verify` succeeds and `upload` is skipped.
   A manual dispatch or green PR checks do not replace these queue verdicts.
5. Verify the PR is merged, the merged commit is the successful candidate,
   and it has one parent with the PR title and description (GitHub may wrap
   body lines). Recheck live protections and report the queued merge. If a
   check fails and the entry is removed, inspect the failure, repair or retry
   as appropriate, and revalidate the head and reviews before re-enqueueing.

## Guide sources

The repository’s `AGENTS.md` is the canonical project guide, and `CLAUDE.md`
is a symlink to it. Update the project guide and this procedure together when
merge policy changes. The separately generated global agent guide is maintained
from its shared core and agent-specific source, outside this repository; update
that source and run its generator instead of editing generated output. Keep
private configuration out of public documentation and pull requests.

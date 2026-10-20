# Main branch merge queue

Main uses squash merges with the PR title as the commit title and the PR
description as the commit body. The active `Bounded merge queue` ruleset has
no bypass actors, builds at most two queue entries concurrently, and uses
`SQUASH` and `ALLGREEN`. It merges one or two passing entries at a time, with
no minimum-group wait and a 180-minute check timeout, matching Remus.

Branch protection requires `checks / validate`, `checks / e2e`,
`commit-privacy`, `history-privacy`, and Cloudflare `verify` (the `verify` job in the
`Cloudflare version` workflow), with both privacy checks bound to the dedicated Esau History Privacy App and
the other checks bound to GitHub Actions. Existing review
requirements and conversation resolution are preserved. The queue validates
changes with the latest main. Strict up-to-date status checks are disabled: being behind
main alone does not require a manual merge or rebase. Resolve actual merge
conflicts, and rerun PR checks whenever its head changes. If restoring these
settings, activate and verify the queue before disabling strict status checks.

Authorized PRs enter the queue through auto-merge: once armed with the
authorized head pinned, GitHub enqueues the PR when its required contexts
pass. Do not use a direct/admin merge, a bypass actor, or `jump`, and do
not arm unrelated PRs. The queue’s `merge_group` run must pass the required
checks before GitHub merges it.

CI and Cloudflare verification handle `merge_group: checks_requested` without
replacing pending queue verdicts. The immutable fleet workflow runs queue
candidates on GitHub-hosted runners; its PR-only kernel announcement policy
is checked before enqueueing. Commit privacy checks the merge-group base-to-head range. History privacy
audits that exact candidate through the default-branch `workflow_run` after the
read-only requester completes; verify the dedicated App verdict on the queue SHA. Cloudflare queue runs perform dry-run verification only;
version uploads remain limited to main pushes and manual dispatches. Merging
continues to trigger the repository's existing automatic deployment workflows.

## Enqueue and verify an authorized PR

1. Read live repository settings, branch protection, and the queue ruleset
   when policy may have changed. Keep every required context and app
   binding, review requirement, and conversation-resolution setting.
   Classic protection enforces administrators; the active queue ruleset has
   no bypass actors.
2. Address the PR’s reviews, comments and threads, and confirm the head you
   are authorizing. The five required contexts are `checks / validate`,
   `checks / e2e`, `commit-privacy`, `history-privacy`, and `verify`; the
   queue waits for them, so pending checks are not a reason to wait before
   arming. Advisory checks (Workers Builds, dependency audits when the PR
   changes a manifest or lockfile, public commit metadata) do not gate the
   queue: if one fails before the merge, disable auto-merge and address it.
3. Arm auto-merge with the head pinned, using the PR node ID in `PR_ID` and
   the authorized head SHA in `HEAD_SHA`:

   ```bash
   gh api graphql \
     -f query='mutation($pr: ID!, $head: GitObjectID!) {
       enablePullRequestAutoMerge(input: {
         pullRequestId: $pr, expectedHeadOid: $head, mergeMethod: SQUASH
       }) { pullRequest { autoMergeRequest { enabledAt } } }
     }' \
     -f pr="$PR_ID" -f head="$HEAD_SHA"
   ```

   `gh pr merge <number> --auto --squash --match-head-commit "$HEAD_SHA"` is
   equivalent. Auto-merge stays armed across later pushes from users with
   write access; disable it (`gh pr merge <number> --disable-auto`) before
   pushing a change outside the authorized scope.
4. Once queued, read the entry’s `headCommit.oid` after it reaches
   `AWAITING_CHECKS` (it can initially be null) and match it to the
   `merge_group` workflow runs. The queue merges only after all five
   required contexts pass on that candidate. A pending or failing Cloudflare
   `verify` blocks the merge; confirm `upload` is skipped, since queue
   candidates perform dry-run verification only. A manual dispatch or green
   PR checks do not replace queue verdicts.
5. Verify the PR is merged, the merged commit is the successful candidate,
   and it has one parent with the PR title and description (GitHub may wrap
   body lines). Do not report arming or enqueueing as a completed merge. If
   a check fails and the queue removes the entry, inspect the failure,
   repair or retry as appropriate, and re-arm auto-merge if the removal
   disarmed it.

## Guide sources

The repository’s `AGENTS.md` is the canonical project guide, and `CLAUDE.md`
is a symlink to it. Update the project guide and this procedure together when
merge policy changes. The separately generated global agent guide is maintained
from its shared core and agent-specific source, outside this repository; update
that source and run its generator instead of editing generated output. Keep
private configuration out of public documentation and pull requests.

# Main branch merge queue

Main uses squash merges with the PR title as the commit title and the PR
description as the commit body. The active `Bounded merge queue` ruleset has
no bypass actors, builds at most two queue entries concurrently, and uses
`SQUASH` and `ALLGREEN`. It merges one or two passing entries at a time, with
no minimum-group wait and a 180-minute check timeout, matching Remus.

Branch protection retains `checks / validate`, `checks / e2e`, and
`commit-privacy`, their GitHub Actions app bindings, the existing review
requirements, and conversation resolution. The queue validates changes with
the latest main, so manually updating every PR branch is unnecessary. Enable
the queue before disabling strict up-to-date status checks.

Before enqueueing an authorized PR, inspect its current head, reviews,
unresolved threads, and individual CI jobs, including all six browser shards
and Cloudflare `verify`. Then enqueue that PR with its expected head SHA.
Do not use an administrator bypass or enqueue unrelated PRs. The queue's
`merge_group` run must pass the required checks before GitHub merges it.

CI and Cloudflare verification handle `merge_group: checks_requested` without
replacing pending queue verdicts. The immutable fleet workflow runs queue
candidates on GitHub-hosted runners; its PR-only kernel announcement policy
is checked before enqueueing. Commit privacy already checks the merge-group
base-to-head range. Cloudflare queue runs perform dry-run verification only;
version uploads remain limited to main pushes and manual dispatches. Merging
continues to trigger the repository's existing automatic deployment workflows.

# Trusted VPS checks

The manual `trusted-vps.yml` pilot benchmarks trusted main-branch code on one
shared 1-vCPU runner. The separate owner-PR quality workflow below now moves lint
and typecheck to this runner for eligible PRs. Required check names and test
coverage are preserved.

For the manual pilot, the organization runner group must enforce selected repositories AND selected
workflow refs. During bootstrap only the reviewed immutable workflow commit is
allowed. The bootstrap branch push trigger cannot grant access by itself.
After merge, an operator may allow this workflow at refs/heads/main and dispatch
it there. Do not allow arbitrary branches, PR merge refs, reusable workflow_call
inputs, or contributor checkout overrides. Never use pull_request_target here.

The runner has root-owned binaries, rootless Docker, no sudo, one active job,
and bounded workspace cleanup. It is for trusted code, not an untrusted-code
sandbox. Deployment credentials must not be passed to this workflow.

Rollback: disable this additive workflow or remove its runner-group allowlist
entry. Existing hosted CI remains intact. Heavy browser/geometry suites are not
claimed to fit until separately measured. No deployment is part of this check.

Docker runs rootless. Individual container cgroup limits are unavailable; the
host CI slice bounds combined execution to one CPU and 3 GiB memory.

## Owner PR quality checks

`ci.yml` now calls `trusted-pr.yml` at a reviewed immutable commit. Only
`petergstfsn`-authored pull requests with a head branch in `esaueng/OpenZCAD`,
triggered and rerun by that same account, can use the VPS. Forks, other authors,
bot events, and manual CI dispatches run the same lint and typecheck commands on
GitHub-hosted runners. The routing policy runs on a hosted runner before any
checkout and accepts no caller inputs, checkout overrides, or deployment secrets.

The runner-group allowlist must include the exact `trusted-pr.yml@<commit>` used
by `ci.yml`. Never grant access to PR merge refs or arbitrary branch versions of
that workflow. Changing its policy requires a new reviewed commit, an explicit
runner-group allowlist update, and an update to the caller pin. Editing the local
workflow file alone does not change the executed policy.

Unit tests, parity, builds, and four browser shards remain hosted. The stable
required `validate` check requires both the reusable quality workflow and hosted
validation to succeed; failed, cancelled, or skipped checks cannot make it green.
VPS install, lint, and typecheck durations are written to the run summary. This
is the initial lightweight migration, not evidence that heavier suites fit.

The VPS has one worker shared across approved repositories. An offline or busy
runner queues owner PR checks rather than silently skipping them. Roll back by
restoring lint and typecheck in hosted validation and removing the reusable call
and its gate dependency, then remove the immutable allowlist entry. Merely
removing the entry blocks owner PR quality jobs until the caller is rolled back.

# Trusted CI fleet

Trusted PR lint and typecheck run on the fleet. Geometry, build and browser validation retain their existing hosted jobs.

The caller pins the reusable job workflow to an immutable commit. Its hosted
policy job runs before checkout and admits only the approved owner's same-repository
PR merge refs. This policy covers PRs; manual validation remains hosted.
Other authors, forks and reruns by other actors remain on GitHub-hosted runners.
No caller-supplied checkout override or inherited secret is accepted.

`CI_FLEET_ENABLED=true` enables the pinned shared selector. The routing service
chooses Jane first, then John only when Jane is unavailable, then GitHub-hosted
when both are unavailable. Busy is available: jobs queue for Jane rather than
spill over. Jane's shared `ci-server-jane` label lets either of its two isolated
slots accept a job. `ci-server-john` identifies the backup. Runner-group policy
must separately authorize the repository and exact immutable job workflow.

An absent/false flag keeps these checks hosted. A failed or invalid routing
response also selects hosted; it never grants arbitrary runner labels. Hosted
selection and hosted-only checks still require GitHub Actions capacity. This is
not a solution for exhausted hosted minutes.

Before checkout on the fleet, the job verifies its non-root identity, read-only
runner files, NoNewPrivileges, fresh storage and empty rootless Docker state,
mount options and exact CPU/memory/swap limits. Jane slots each have six CPU
equivalents and 6 GiB memory; John retains its smaller profile. Guard failure
fails the job instead of silently continuing on an unexpected machine.

## Activation and rollback

This PR prepares the workflows; it does not deploy the routing service, modify
runner access or enable fleet routing. Activation requires:

1. Review the immutable job workflow and approve its exact runner-group entry;
   preserve every existing group restriction and workflow entry.
2. Deploy and validate fleet health routing with both Jane slots and John,
   including unavailable-only behavior and authorized repository identities.
3. Validate real app jobs on the isolated slots, including memory and cleanup,
   before enabling `CI_FLEET_ENABLED` for normal runs.
4. Preserve required check contexts and require the complete application suite.

Already queued jobs keep their selected runner label. Loss of a host after
selection does not retarget that job; queue supervision and a fresh run are
needed. A failing build is a failing build, not an availability failover signal.

Rollback is `CI_FLEET_ENABLED=false`; subsequent jobs use hosted runners. Let
current jobs finish and rerun stranded jobs. Change the caller pin through a PR
when updating or reverting the policy. No application deployment is performed
by this routing change itself; existing main-merge deployment integrations still
apply and need their normal approval.

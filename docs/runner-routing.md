# Trusted CI fleet

Linux CI jobs and their completion gates live in `fleet-ci-v2.yml`, called at an
immutable commit from `ci.yml`. GitHub evaluates the runner expression before
scheduling each job. There is no GitHub-hosted authorization or routing job in
front of the Linux checks, and no routing HTTP request from Actions.

## Changing the fleet workflow

`ci.yml` must pin a commit main already contains. Actions cannot resolve a
reusable workflow at a commit only `refs/pull/N/head` reaches, and GitHub
deletes a PR's branch at merge, so a pin to a PR branch commit fails every
`ci` run at startup, with no jobs, from that merge until a re-pin lands. That
happened on 19 October after #756 and on 20 October after #769.
`scripts/test-direct-fleet.py` fails a pin that main does not contain.

Change it in two PRs, as Remus does:

1. **Stage.** Add the new version as `fleet-ci-vN.yml` (the next unused N),
   with `ci.yml` and the active file unchanged. Add it to the runner map in
   `test/security-workflow.test.ts`. Nothing calls it yet.
2. **Activate.** After the staging PR merges, pin `ci.yml` to
   `fleet-ci-vN.yml@<the staging squash commit on main>` and delete the
   previously active file. This PR's own CI runs the new version before it
   reaches main. Tests read the active file from the pin
   (`test/fleet-workflow.ts`), and the pinned bytes must equal the
   checked-in file.

Old pinned commits stay on main, so earlier runs can still be re-run.

## Trusted merge-queue overflow

`ci.yml` activates `fleet-ci-v2.yml` at the landed #809 commit
`6cd1c223fe3b3ac49f6379e0999f1b4bbe310f04` and grants its `checks` job
`pull-requests: read`. Before this caller runs on Jane, add this exact workflow
entry to the existing `ci-trusted-main` runner group:

```text
esaueng/OpenZCAD/.github/workflows/fleet-ci-v2.yml@6cd1c223fe3b3ac49f6379e0999f1b4bbe310f04
```

The caller activation landed through #819. Runner access is a separate rollout
step; the caller pin alone does not establish that a job ran on Jane.

Retain all existing entries and the selected-repository and selected-workflow
restrictions. The retired `fleet-ci.yml` remains resolvable at its historical
pin for older branches and reruns; it must not gain access to the migrated slots.

The external controller keeps GitHub-hosted execution primary. When it
publishes `CI_FLEET_TARGET=ci-server-jane` under hosted queue pressure, a small
Jane job verifies queue metadata before any candidate code is checked out. It
has only contents/PR read permissions, executes the policy embedded in the
immutable workflow, and retains the existing runner isolation checks. There is
no hosted authorization job in front of the overflow checks.

The policy binds the event ref and SHA to the live queue's exact candidate,
walks its squash-parent chain back to current protected main, and requires the
approved numeric repository identity, owner author and owner enqueuer on every
entry in that prefix. Forks, other authors, changed or missing candidates,
unprotected main, incomplete/truncated queue evidence and API failures select
hosted execution. Queue inspection is bounded to 100 entries. Unsupported
queue layouts also retain hosted execution.

Application jobs accept only the verified event SHA. The probe's skipped or
failed result cannot skip the existing checks: those fall back to hosted, and
the validate/E2E gates still reject application failure or cancellation. All
existing PR/main identity predicates, commands, timeouts, dependencies,
permissions and deployment boundaries remain enforced. Queue-bot main pushes
remain subject to the existing main-push policy; this change authorizes queue
candidates only. Already queued jobs retain their selected runner.

`scripts/test-merge-queue-routing.py` exercises the embedded policy and gate
behavior through the existing direct-fleet test entrypoint. The policy
does not establish live routing; runner-group/label activation and a real
queue run on Jane remain separate rollout steps.

Only the approved owner's open, same-repository PR merge refs are eligible.
Main pushes and manual dispatches also require protected main. Repository name
and numeric identity, PR author, event actor and rerun actor are checked in the
immutable workflow. Forks and other authors remain hosted. The runner group
must separately restrict the exact repository and immutable workflow revision;
a label or repository variable does not grant execution authority.

`CI_FLEET_ENABLED=true` opts in. `CI_FLEET_TARGET` accepts only
`ci-server-jane`, `ci-server-john`, or `github-hosted`. A controller outside
Actions publishes this variable after checking fresh collector health and GitHub
runner connectivity. Production uses hosted-first overflow: GitHub-hosted is
primary, with idle Jane slots selected under verified hosted queue pressure.
There is no configured backup host. The legacy local-first policy and John
target remain available only for separately validated configurations.
Missing/invalid configuration selects hosted. Hosted fallback still depends on
GitHub billing and capacity.

Before checkout, self-hosted jobs verify the non-root identity, protected runner
files, NoNewPrivileges, fresh storage, empty rootless Docker state, mount options
and exact cgroup limits. The active v2 workflow supports Jane's approved three
slots, each with six CPU equivalents and a nominal 5 GB decimal memory cap.
It compares the exact kernel page-aligned limit (4,999,999,488 bytes with 4 KiB
pages). Historical legacy callees require the retired two-slot 6 GiB
profile. The combined v2 selects `ci-server-jane-5gb` while retaining the
canonical `CI_FLEET_TARGET=ci-server-jane` controller preference. Keep the old
shared `ci-server-jane` label withheld so legacy callers cannot reach the
migrated slots. Add the profile selector only after the controller recognizes
it, the compatible callee has landed on main, its exact main revision is
approved in the restricted runner group, and the slot guards are verified.
Runner registration alone does not make the resource contracts compatible.
John retains one CPU equivalent and 3 GiB.
Guard failure fails the job.
Browser suites hold a shared host lock while using fixed localhost test ports.
Browser/native OS dependencies must be installed by the host administrator;
workflow jobs install browser binaries without sudo.

Playwright uses two workers in CI rather than deriving concurrency from the
physical host's CPU count. Browser and geometry workers share each slot's
resource budget; test deadlines and retries retain their existing values.
Local runs keep Playwright's automatic worker count.

## Activation and rollback

One rollout owner coordinates the controller, runner group and shared profile
across both repositories. Before enabling the profile, verify the controller
recognizes `ci-server-jane-5gb`, approve the exact v2 entry above, and validate
each slot's guard. Then add `ci-server-jane-5gb` to each verified registration:
`ci-server-jane-1`, `ci-server-jane-2`, and `ci-server-jane-3`. Keep those runner
names and their individual slot labels. Keep the old shared `ci-server-jane`
label absent from all three slots. Exact workflow restrictions keep legacy
callers quarantined.

The profile label is shared across both repositories. Keep it withheld until
both compatible activation callers and the Remus auxiliary manifest reach
main. If OpenZCAD cuts over first, keep Remus `CI_FLEET_ENABLED=false` until
its combined caller and auxiliary manifest reach main; otherwise the
controller can select Jane for a legacy Remus caller that still requests the
quarantined label. Alternatively merge
both activation PRs using hosted CI, then add the profile label and enable
fleet routing. Older PR branches still need the new caller before using Jane.

After rollout qualification, keep OpenZCAD's `CI_FLEET_ENABLED=true` and let
the hosted-first controller publish the
canonical target `ci-server-jane` under hosted queue pressure; do not set the
target to the profile label. Preserve all required-check names, App bindings,
review requirements and queue protections. New queue candidates use the landed
caller;
older PR branches must pick up its pin before their runs can use v2.

Run an authorized real application job on each Jane slot, verify cleanup,
hosted-first overflow and fork-hosted execution, then enable normal routing. Code merge alone does
not activate the runner group, repository variables, or controller.

Already queued jobs keep their assignment. A host failure after selection needs
a fresh run; this change does not automatically cancel or retry queued jobs.
Controller failure preserves the last target and is shown as stale in the
monitor. A failing build is not an availability outage.

`CI_FLEET_ENABLED=false` returns subsequent jobs to hosted runners. Let active
jobs finish and rerun stranded jobs. Revert workflow pins through a PR. Production
credentials and deployment jobs stay outside the home runners; existing
main-merge deployment integrations still require their normal authorization.

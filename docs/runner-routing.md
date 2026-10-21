# Trusted CI fleet

Linux CI jobs and their completion gates live in `fleet-ci.yml`, called at an
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

Only the approved owner's open, same-repository PR merge refs are eligible.
Main pushes and manual dispatches also require protected main. Repository name
and numeric identity, PR author, event actor and rerun actor are checked in the
immutable workflow. Forks and other authors remain hosted. The runner group
must separately restrict the exact repository and immutable workflow revision;
a label or repository variable does not grant execution authority.

`CI_FLEET_ENABLED=true` opts in. `CI_FLEET_TARGET` accepts only
`ci-server-jane`, `ci-server-john`, or `github-hosted`. A controller outside
Actions publishes this variable after checking fresh collector health and GitHub
runner connectivity. Jane is primary, John the first backup, and GitHub-hosted
the second. Busy Jane remains available; jobs queue for any of her three slots.
Missing/invalid configuration selects hosted. Hosted fallback still depends on
GitHub billing and capacity.

Before checkout, self-hosted jobs verify the non-root identity, protected runner
files, NoNewPrivileges, fresh storage, empty rootless Docker state, mount options
and exact cgroup limits. The staged `fleet-ci-v3.yml` profile recognizes
all three Jane slots, each with six CPU equivalents and a 5,000,000,000-byte
RAM setting. systemd aligns this to whole host pages: 4,999,999,488 bytes on
a 4 KiB-page host. Each slot has a separate 150 GiB image. The coordinated
queue rollout applies this same resource profile to the queue-enabled v2
workflow. Activate that combined workflow at its landed main commit after
normal checks; keep v3 as a resource-only staging reference. Do not replace
a queue-enabled caller with a resource-only workflow. Keep new local
assignments paused until the combined profile and exact runner-group pin
are active; the old workflow expects the legacy two-slot/6-GiB profile.

John has one CPU equivalent and 3 GiB. Guard failure fails the job.
Browser suites hold a shared host lock while using fixed localhost test ports.
Browser/native OS dependencies must be installed by the host administrator;
workflow jobs install browser binaries without sudo.

Playwright uses two workers in CI rather than deriving concurrency from the
physical host's CPU count. Browser and geometry workers share each slot's
resource budget; test deadlines and retries retain their existing values.
Local runs keep Playwright's automatic worker count.

## Activation and rollback

Approve the exact immutable `fleet-ci.yml` runner-group entry without removing
existing restrictions. Configure the external controller's selected repository
identities and dedicated GitHub credential, then validate both hosts. Review
required check names: the new reusable workflow adds the `checks /` prefix.
Change only explicitly approved contexts after checking actual job names;
retain the complete application suite and review requirements.

Run an authorized real application job on each Jane slot, verify cleanup and
unavailable-only selection, then enable normal routing. Code merge alone does
not activate the runner group, repository variables, or controller.

Already queued jobs keep their assignment. A host failure after selection needs
a fresh run; this change does not automatically cancel or retry queued jobs.
Controller failure preserves the last target and is shown as stale in the
monitor. A failing build is not an availability outage.

`CI_FLEET_ENABLED=false` returns subsequent jobs to hosted runners. Let active
jobs finish and rerun stranded jobs. Revert workflow pins through a PR. Production
credentials and deployment jobs stay outside the home runners; existing
main-merge deployment integrations still require their normal authorization.

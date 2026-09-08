# Trusted CI fleet

Linux CI jobs and their completion gates live in `fleet-ci.yml`, called at an
immutable commit from `ci.yml`. GitHub evaluates the runner expression before
scheduling each job. There is no GitHub-hosted authorization or routing job in
front of the Linux checks, and no routing HTTP request from Actions.

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
the second. Busy Jane remains available; jobs queue for either of her two slots.
Missing/invalid configuration selects hosted. Hosted fallback still depends on
GitHub billing and capacity.

Before checkout, self-hosted jobs verify the non-root identity, protected runner
files, NoNewPrivileges, fresh storage, empty rootless Docker state, mount options
and exact cgroup limits. Jane slots each have six CPU equivalents and 6 GiB RAM;
John has one CPU equivalent and 3 GiB. Guard failure fails the job.
Browser suites hold a shared host lock while using fixed localhost test ports.
Browser/native OS dependencies must be installed by the host administrator;
workflow jobs install browser binaries without sudo.

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

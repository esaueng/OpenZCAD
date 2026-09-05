# Trusted VPS checks

This additive, non-deploying workflow benchmarks trusted code on one shared
1-vCPU runner. Existing CI and external pull-request checks stay GitHub-hosted;
this workflow does not replace their required check names or coverage.

The organization runner group must enforce selected repositories AND selected
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

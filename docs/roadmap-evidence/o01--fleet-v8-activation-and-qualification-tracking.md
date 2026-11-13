---
row: O01
---

Fleet v8 activation and daily qualification tracking (this PR): `ci.yml` pins
`fleet-ci-v8.yml` at #1295's landed commit `158a250b` and retires v6, so kernel
updates run complete unit suites before merge. The queue-routing harness now
checks the active callee and pins v8's workflow header, queue probe, isolation
guard and runner expression to v6's bytes; policy tests follow v8's plan
preflight, split typecheck, root partitions and combined-tree queue canaries.
A red scheduled full qualification opens or updates one tracking issue naming
the source SHA and failing files, and the next green run closes it; only a
schedule-gated job holds `issues: write`. Jane routing still needs the v8
runner-group entry; queue-candidate verification remains delivery evidence.

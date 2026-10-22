---
row: O01
---
Jane queue activation landed through #819, with the immutable v2 caller pin,
read-only queue metadata grant and legacy callee retirement. The #818
reconciliation retains the stronger landed routing and permission regressions,
updates the rollout guide to distinguish caller activation from live runner
qualification, and records the shared Remus caller/helper compatibility gate.
Real application jobs, slot cleanup and immutable queue-candidate checks remain
separate rollout evidence; this documentation change does not configure runners.

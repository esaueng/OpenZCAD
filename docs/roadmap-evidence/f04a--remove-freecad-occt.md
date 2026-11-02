---
row: F04a
state: Deferred
---

Native `.FCStd` import is withdrawn at the owner's request. The converter,
OCCT package, reference adapter and worker-specific CSP relaxation are removed.
Use a STEP export from FreeCAD instead. Existing converted STEP projects keep
rebuilding through Remus. The geometry corpus retains the previous Remus
baselines and analytic expectations without a second kernel dependency.

PR #1154: local lint, typecheck, production build, 92 corpus tests, 25 focused
policy/asset/CI-selection checks, 56 import-menu tests and two Chromium import
regressions pass. All 22 STEP and seven import-modeling Remus baseline records
are unchanged. Full local suites retain main's reproduced assertion failures
and encounter local worker errors; exact-head hosted checks remain required.

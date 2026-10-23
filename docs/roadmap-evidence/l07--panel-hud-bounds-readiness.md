---
row: L07
---
2026-10-22 CI reliability: floating-panel browser tests poll for non-null
rendered bounds within the existing assertion budget. A handle re-arm can hide
its value-chip HUD for one frame immediately after a visibility assertion;
the measurement now waits for that rendered state without changing test
timeouts, retries, geometry, overlap or pointer-reachability assertions.
The unchanged live-handle case failed 4 of 10 local attempts before the fix;
it passed 20 of 20 afterward with retries disabled, and all eight floating-panel
cases passed. This repairs the readiness race without closing the separate
flaky-test-budget work.

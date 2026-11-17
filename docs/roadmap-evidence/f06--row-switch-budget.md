---
row: F06
---

Row switches within the W01 budgets ([record](docs/performance/2026-11-17-f06-row-switch.md)): Switch → frame for a configuration row, measured beside W01's Apply → frame in the same session on W01's fixtures, each switch to a width no build had used. Three quiet-host rounds of 30 on the W01 host: a simple box switches in 42 ms median, 48 ms p95 (budget 60/100); the 100-feature history with its isolated part in 87 ms median, 116 ms p95 (budget 150/170). Evidence: `test/e2e/perf-configuration-switch.spec.ts` (the probe, `OZ_PERF=1`), the `f06-switch-box` and `f06-switch-history` probes of `scripts/measure-active1-baselines.mjs --check`, and `test/perf-host.test.ts` (the quiet-host check no longer counts jobs queued behind the heavy-job lock; `--heavy-lock` takes that lock per round).

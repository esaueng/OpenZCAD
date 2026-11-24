---
row: W01
---

Project-card opens can restore a device-local exact session across application
releases when the emitted geometry worker, its dependencies, the bundled fonts
and the Remus build still match. The opt-in
`test/e2e/perf-project-open.spec.ts` compares cold replay with exact restore
on the same project in a fresh browser context. A local two-build Chromium
run on a 100-feature project took 38.57 s for cold replay and 2.92 s for
the subsequent release's exact restore, with equal mesh bytes, bounds,
topology hashes and warnings. First imports still replay the feature history.

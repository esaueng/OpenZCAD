---
row: W01
---

Local same-WASM production-build comparisons on RTX 3090 reduce the 500-history
setting's input-to-render median from 514.4 to 253.9 ms across three matched
30-edit pairs, a 2.03× speedup. The probe measures 501 features after setup.
The 100-history setting improves from 112.5 to 66.9 ms, and simple-box medians
are similar at 36.4 and 35.9 ms. Retained row details, mesh-copy ownership,
immutable-geometry cache sizing and bounded lossless topology transport preserve
keyboard, accessibility and exact-edit contracts. The
[baseline report](docs/performance/2026-11-16-beta-edit-baseline.md),
[samples](docs/performance/2026-11-16-beta-edit-baseline.samples.csv) and
[provenance](docs/performance/2026-11-16-beta-edit-baseline.provenance.json)
record the workload and local hardware scope. Full local lint, typecheck,
19,872 root/web tests, 97 parity tests, production build and 16 focused browser
cases pass. Integrated-GPU and deployed-beta
qualification remain open.

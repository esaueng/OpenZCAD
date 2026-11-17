---
row: W01
---

A current-main Remus 2026.1.145 refresh on RTX 3090 reduces the 500-history
setting's input-to-render median from 517.8 to 258.8 ms, a 2.00× speedup in one
clean matched 30-edit pair. The probe measures 501 features after setup. The
100-history setting improves from 114.0 to 65.5 ms (1.74×), and simple-box
medians are similar at 36.1 ms. An initial same-WASM 2026.1.141 study measured
2.03× across three large-history pairs. Retained row details, mesh-copy
ownership, immutable-geometry cache sizing and bounded lossless topology
transport preserve keyboard, accessibility and exact-edit contracts. The
[baseline report](docs/performance/2026-11-16-beta-edit-baseline.md),
[samples](docs/performance/2026-11-16-beta-edit-baseline.samples.csv) and
[provenance](docs/performance/2026-11-16-beta-edit-baseline.provenance.json)
record source identities, package versions, rejected timing attempts and local
hardware scope. Full integrated lint, typecheck, 20,196 root/web tests, 97 parity
tests, production build and 16 focused browser cases pass. Integrated-GPU and
deployed-beta qualification remain open.

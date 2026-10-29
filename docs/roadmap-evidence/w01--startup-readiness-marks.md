---
row: W01
---

Startup readiness signals (production QA F021–F023): `oz:model-visible` and `oz:input-ready` User Timing marks mark the first exact model frame and the first fully analysed frame per opened project (`startupReadiness.test.ts`). `scripts/measure-startup.mjs` reports them with long tasks, LCP and network over N production-build runs, warm or cold, with optional throttling and per-task trace attribution. The warm Heat Sink reload's long tasks are the viewer's PMREM environment and first-frame shader links, not main-thread WASM. They do not delay readiness on the measured laptop. LCP is documented as no workspace readiness metric ([performance baseline](docs/performance-baseline.md#readiness-marks)). The lazy-chunk prefetch skips chunks the page already requested and waits for the model (`lazyChunkPrefetch.test.ts`). Target-GPU budgets remain open.

Deployment tooling qualification: the root declares the same Wrangler 4.147.0
already installed for the web package, so Workers Builds' default root-level
`npx wrangler versions upload` resolves the lockfile CLI rather than downloading
a different version. The deploy-safety smoke regression runs that root command
offline with an empty npm cache. Readiness and prefetch tests also run in unit
smoke CI. Provider asset-upload success is verified separately from a passing
build and dry run.

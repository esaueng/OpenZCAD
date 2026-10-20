# MLS library spike (ADR-024, L11)

Throwaway code for [`docs/plans/mls-spike-2026-10.md`](../../docs/plans/mls-spike-2026-10.md).
Nothing in `apps/` or `packages/` imports it. It is not a pnpm workspace
package and is outside the repo's lint, typecheck and Vitest globs.

| Path                              | What                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `mls-rs-wasm/`                    | mls-rs 0.56 scenario. Feature `webcrypto` (default) or `rustcrypto` selects the provider   |
| (both crates)                     | Export `run_scenario` (the main scenario) and `run_rejoin_scenario` (ADR-024 rejoin rules) |
| `openmls-wasm/`                   | OpenMLS 0.9.1 scenario with the RustCrypto provider                                        |
| `build.sh`                        | Builds all three WASM packages into `pkg/` (git-ignored)                                   |
| `harness/hooks.mjs`               | Host hooks: clock, plus IndexedDB persistence sealed under a non-extractable AES-GCM key   |
| `harness/node-webcrypto-shim.mjs` | Node-only fix for mls-rs's WebCrypto provider (see the report)                             |
| `harness/scenario.test.mjs`       | Vitest run of every package in Node                                                        |
| `web/`                            | Vite page that runs each package lazily in a module Worker; Playwright runner              |
| `results/`                        | Raw JSON from the runs the report quotes                                                   |

Both crates are standalone Cargo projects with their own `Cargo.lock`, so
the builds are reproducible with `--locked`.

## Run

From the repository root, after `pnpm install`:

```bash
spikes/mls/build.sh
```

```bash
pnpm exec vitest run --config spikes/mls/harness/vitest.config.mjs
```

```bash
pnpm --filter @openzcad/web exec vite build --config "$PWD/spikes/mls/web/vite.config.mjs"
```

```bash
node spikes/mls/web/run-browsers.mjs --safari
```

`--safari-only` skips Chrome and WebKit.
`--chromium-only` uses the Playwright Chromium installation and skips both
Google Chrome and WebKit. Set `MLS_SPIKE_RESULTS_DIR` to a directory relative
to the repository root (or an absolute path) for both runners to preserve a
new qualification separately from the historical results, for example:

```bash
MLS_SPIKE_RESULTS_DIR=spikes/mls/results/review-2026-10-19 pnpm exec vitest run --config spikes/mls/harness/vitest.config.mjs
MLS_SPIKE_RESULTS_DIR=spikes/mls/results/review-2026-10-19 node spikes/mls/web/run-browsers.mjs --chromium-only
```

`build.sh` needs Rust ≥ 1.88 with the `wasm32-unknown-unknown` target and the
`wasm-bindgen` CLI 0.2.126. The browser runner uses installed Google Chrome
(`channel: 'chrome'`) and Playwright WebKit (`pnpm exec playwright install
webkit`). `--safari` opens the page in the real Safari with `?auto=1`, and
the page posts its results back. No Safari automation setting is needed.

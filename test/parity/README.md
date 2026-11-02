# Kernel parity harness

Two suites, run separately.

## 1. Scenario harness (`parity.test.ts`) — part of the root vitest run

The acceptance benchmark for the Remus kernel: real modeling sessions
(the workspace demos plus stress scenarios) replayed headless through the
exact kernel adapter, held to a per-body acceptance bar — zero sync warnings,
watertight/manifold meshes (edge-use census on body meshes and exported STL),
baseline-pinned volume and exact face count (the mesh-fallback tell), and
deterministic command-log replay.

```bash
# Run (part of the normal root vitest suite / CI)
pnpm exec vitest run test/parity

# Rerecord baselines after an intentional geometry change
OPENZCAD_WRITE_PARITY_BASELINES=1 pnpm exec vitest run test/parity

# Run against a local remus build without touching the lockfile
REMUS_WASM_PKG=/abs/path/to/remus/crates/wasm/pkg pnpm exec vitest run test/parity
```

Known kernel defects are **pinned**, not skipped: `expectedBuildFailure` /
`expectedWarnings` entries in `scenarios.ts` assert the exact current failure,
so a kernel fix flips the harness red until the pin is removed and baselines
are rerecorded. Per-scenario wall-clock lands in `last-run-timings.json`
(untracked) — vitest's forks pool swallows stdout.

## 2. STEP + geometry parity corpus (`corpus.spec.ts`) — its own CI job

Categorized STEP files and imported-body modeling scenarios are measured through
Remus against recorded baselines and independent construction arithmetic.

```bash
pnpm test:parity-corpus
```

This serial Vitest project keeps slow import/export/reimport geometry separate
from the fast suites. Corpus suites use `*.spec.ts`; the root suite collects
`*.test.ts`. See [`corpus/README.md`](./corpus/README.md).

[`corpus-pins.ts`](./corpus-pins.ts) records remaining deviations from analytic
expectations. The reference kernel and its measurements have been removed;
the existing Remus baseline values and tolerances are unchanged.

## Shared

`scenarios.ts` holds both `PARITY_SCENARIOS` (suite 1) and
`IMPORT_MODELING_SCENARIOS` (suite 2). `mesh-probe.ts` is the watertightness
oracle used by suite 1. `baselines.json` belongs to suite 1; `baselines/`
belongs to suite 2.

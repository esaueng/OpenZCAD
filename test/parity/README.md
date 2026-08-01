# Kernel parity harness

Two suites, run separately.

## 1. Scenario harness (`parity.test.ts`) — part of the root vitest run

The acceptance benchmark for the BrepKit kernel: real modeling sessions
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

# Run against a local brepkit build without touching the lockfile
BREPKIT_WASM_PKG=/abs/path/to/brepkit/crates/wasm/pkg pnpm exec vitest run test/parity
```

Known kernel defects are **pinned**, not skipped: `expectedBuildFailure` /
`expectedWarnings` entries in `scenarios.ts` assert the exact current failure,
so a kernel fix flips the harness red until the pin is removed and baselines
are rerecorded. Per-scenario wall-clock lands in `last-run-timings.json`
(untracked) — vitest's forks pool swallows stdout.

## 2. STEP + geometry parity corpus (`corpus.spec.ts`) — its own CI job

Categorized STEP files measured through **both** kernels (BrepKit and
OpenCascade) so the deltas between them are recorded rather than argued about.
This is the Z1.3 gate that blocks the STEP routing flip (Z3) and the OCCT
deletion (Z5).

```bash
pnpm test:parity-corpus
```

It is a separate vitest project because it runs seconds of WASM geometry per
file through two kernels. The mechanism is the file suffix — corpus suites are
`*.spec.ts` and the root config only includes `*.test.ts`, so
`pnpm exec vitest run test/parity` does not pick them up. Full documentation,
including how to add a file and how to re-record, is in
[`corpus/README.md`](./corpus/README.md).

The corpus's most valuable output is [`corpus-pins.ts`](./corpus-pins.ts): every
recorded BrepKit-vs-OCCT delta and every kernel-vs-arithmetic deviation, each
naming the file, the metric, both literal values, and the plan item
(K0.1 / K0.2 / K0.4 / K0.5 / K0.6) that owns closing it. Start there.

## Shared

`scenarios.ts` holds both `PARITY_SCENARIOS` (suite 1) and
`IMPORT_MODELING_SCENARIOS` (suite 2). `mesh-probe.ts` is the watertightness
oracle used by suite 1. `baselines.json` belongs to suite 1; `baselines/`
belongs to suite 2.

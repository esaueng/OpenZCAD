# Kernel parity harness

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

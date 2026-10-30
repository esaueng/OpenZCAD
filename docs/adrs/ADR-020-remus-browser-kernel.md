# ADR-020: Remus is the production browser kernel

## Status

Accepted. Supersedes ADR-009 without changing the browser-worker, document, or
topology contracts established there.

## Decision

OpenZCAD consumes the committed WASM package from `esaueng/remus` and installs
it locally as `remus-wasm`. The manifest follows Remus `main`; the lockfile is
the reproducibility boundary and resolves exactly one immutable source commit.
The geometry worker remains the only production kernel host.

The installed Remus package still carries some legacy internal package and
generated-asset names. OpenZCAD isolates those details behind
`remus-runtime.ts`; application code, worker state, build metadata, diagnostics,
automation, and current documentation use the Remus identity. Compatibility
code may recognize both generated asset names until Remus publishes a fully
renamed package from its current main line.

`ExactKernelAdapter.kind` is `remus`. Build metadata format version 2 records a
`remus` source identity, and project diagnostic format version 2 records
`kernel.adapter: "remus"`. Neither format change alters a canonical project
document. Existing topology hashes and lineage references remain readable;
references described as BrepKit-era are historical compatibility data and are
not renamed in persisted documents or historical ADR context.

OpenCascade remains a development-only reference under `test/parity`. It is
not imported by the production adapter or emitted into the application bundle.

## Consequences

- Kernel updates resolve from `esaueng/remus`, use a Remus-named updater, and
  still require the full geometry, parity, browser, bundle, and desktop gates.
- The exact API seam remains intentionally narrow. Remus exports the kernel as
  the `RemusKernel` JavaScript class (renamed from `BrepKernel` in
  `remus-wasm` 2026.1.87, esaueng/remus#1358), and OpenZCAD re-exports it under
  that name. The deprecated `BrepKernel` alias is not used, and lint rejects
  importing it.
- Two upstream behavior changes are pinned explicitly: flattened curved-text
  booleans now meet their closed-form volume checks, while a shallow circular
  union now returns a watertight faceted result instead of refusing. The latter
  remains visibly labeled as approximate and warns that STEP export preserves
  the planar facets.
- README, runtime status, diagnostics, performance reports, and current design
  documents identify Remus. Historical BrepKit issue links, fixtures, hashes,
  and decision context remain unchanged where renaming would falsify evidence.
- The dependency notice records the Apache-2.0 license declared by the pinned
  Remus artifact. This engineering record is not an independent determination
  of copyright ownership or relicensing authority.

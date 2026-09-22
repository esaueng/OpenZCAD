# Exact blend reconstruction QA

Status: Partial. This note records the bounded application adoption evidence
for the current exact blend reconstruction work; it is not a claim of general
blend support.

The adapter uses Remus construction evolution for the qualified cylindrical
planar-pair `resize-blend` path, including resize-to-zero. Generated blend
bands receive distinct semantic references only when the evolution identifies
unambiguous verified construction sources. A unique construction result keeps
selection even when changing radius moves its cylinder axis; multiple candidates
require a unique carrier match. One-to-one changed support faces retain their
producing feature and lineage name with a refreshed witness. Split, merge, duplicate,
stale, or deleted references remain unresolved and fail closed. The document
was also exercised through JSON serialization and a fresh adapter replay.

Application checks currently cover the direct-edit lineage and R0 path in
`test/direct-edit-lineage-pins.test.ts`, the synthetic evolution and duplicate
identity cases in `packages/kernel-adapter/src/remus-lineage.test.ts`, and the
existing imported/direct-edit feature suites. The recorded local checks are:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm test:parity-corpus
pnpm build
```

The application pins generated Remus packages 2.130.44 at immutable commit
`adcf3e988fc70f5bb6e5f54b26bdf4d4591fba8e`, from
[Remus PR #602](https://github.com/esaueng/remus/pull/602).

Kernel qualification covers ordered split contacts, an atomic connected-group
API, isolated spherical ends, bounded affine-NURBS caps, and additional analytic
intersection sections. Original 3D carriers remain authoritative; derived
spherical UV curves require whole-interval certification at the existing
tolerance. Arbitrary NURBS reconstruction and group selection in the application
remain outside this bounded delivery.

A private acceptance model passed all six orders for removing its three
remaining R1 bands through actual document edits, with consistent final volume
and face census, STEP export, and JSON replay in a fresh adapter. Private model
data is not included in the repository.

Focused browser checks cover creating, re-editing and removing a history fillet,
imported analytic re-editing twice without reselection, oversize-radius refusal,
and section-view geometry. The full local browser run exposed three unrelated
macOS failures (arc-sketch picking and two Ctrl+K palette locators) reproduced
on the unchanged application baseline; these are separate from the imported
blend selection regression corrected here.

# Exact blend reconstruction QA

Status: Partial. This note records the bounded application adoption evidence
for the current exact blend reconstruction work; it is not a claim of general
blend support.

The adapter uses Remus construction evolution for the qualified cylindrical
planar-pair `resize-blend` path, including resize-to-zero. A generated blend
band receives a semantic reference only when the evolution identifies one
unambiguous band. One-to-one changed support faces retain their producing
feature and lineage name with a refreshed witness. Split, merge, duplicate,
stale, or deleted references remain unresolved and fail closed. The document
was also exercised through JSON serialization and a fresh adapter replay.

Application checks currently cover the direct-edit lineage and R0 path in
`test/direct-edit-lineage-pins.test.ts`, the synthetic evolution and duplicate
identity cases in `packages/kernel-adapter/src/remus-lineage.test.ts`, and the
existing imported/direct-edit feature suites. The recorded local checks are:

```text
pnpm lint
pnpm typecheck
pnpm exec vitest run packages/kernel-adapter/src/remus-lineage.test.ts
pnpm exec vitest run test/direct-edit-lineage-pins.test.ts
pnpm --filter @openzcad/web test
```

The application pins generated Remus packages 2.130.43 at immutable commit
`04b50762c1d147c89e4ff1eb414857840266c079`, from
[Remus PR #602](https://github.com/esaueng/remus/pull/602). The later kernel
module-map documentation commit does not change those package contents.

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

# ADR-010: Imported STEP Direct Editing

> **Historical amendment (2026-08-15):** ADR-020 replaces the production
> BrepKit dependency with Remus. BrepKit references below describe the state
> when this decision was recorded.

## Status

Accepted.

## Decision

Treat an imported STEP file as an immutable exact B-Rep source followed by normal replayable `direct-edit` features in the browser document history. The geometry Web Worker measures selected OCCT faces and applies edits; the Cloudflare Worker never receives kernel handles or performs geometry work.

The first dimension edit is a complete cylindrical through hole. Recognition requires an exact cylindrical surface, a full revolution, inward face orientation, a void axis, and both axial ends opening outside the solid. Resizing closes the recorded cylindrical span and cuts a new exact cylinder on the same axis. This supports both larger and smaller diameters without mesh reconstruction.

All exact imported faces expose their surface class, area, and center. **Remove selected feature** uses the dedicated through-hole closure when applicable and OCCT defeaturing otherwise. The UI preflights every edit against the exact kernel and commits it only when the result contains a valid solid.

Persist deterministic face ordinals together with geometric fingerprints: surface class, area and center for removal; diameter and axis endpoints for through-hole resizing. Rebuilds fail closed when the ordinal resolves to different geometry. Schema v3 records this new feature-data variant; v1 and v2 documents normalize forward unchanged.

## Consequences

- Original STEP bytes remain available for deterministic replay, Undo/Redo, collaboration, and later edits.
- Successful direct edits remain exact and exportable as STEP; viewport meshes are still disposable projections.
- STEP does not contain the originating CAD system's sketch/constraint/feature history. OpenZCAD therefore exposes only operations proven from current B-Rep topology and labels unsupported combinations instead of inventing parameters.
- Complete through-hole diameter editing and validated single-face defeaturing are implemented. Blind holes, counterbores/countersinks, bosses, pockets, ribs, tapers, and coordinated multi-face recognition remain explicit future direct-edit operations.

## Amendment (Z5, 2026-08-01) — the kernel named above is no longer the one doing this

This ADR was written against OpenCascade and still names it twice. Both readings are now historical, and neither describes a behaviour change:

- "measures selected OCCT faces" — the geometry worker measures selected faces through BrepKit. Z3 made BrepKit build every document including imported STEP; Z5 deleted the OpenCascade adapter from `packages/kernel-adapter`.
- "OCCT defeaturing otherwise" — **Remove selected feature** still uses the dedicated through-hole closure when applicable and the kernel's defeaturing pass otherwise; that pass is now BrepKit's `defeature`.

Everything the decision actually turns on is unchanged: an imported STEP file is still an immutable exact B-Rep source, edits are still replayable `direct-edit` features, recognition still requires the same proofs, and rebuilds still fail closed when a persisted reference resolves to different geometry. The identity scheme those rebuilds resolve against is content-addressed rather than kernel-specific (ADR-011), which is why the kernel could be swapped underneath this ADR and then removed without changing it.

One capability changed with the flip, and it changed in the user's favour: solid offset on an imported body used to be refused outright in the UI, because OpenCascade's sharp offset was limited to proven convex planar bodies. BrepKit has no such limit, so the refusal, its `kernel`/`offsetTopology` capability fields, and its message were deleted rather than reworded.

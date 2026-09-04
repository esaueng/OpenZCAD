# ADR-023: Remus file-format translators load as a separate module

## Status

Accepted.

## Context

The Remus kernel package used to carry every file-format translator (STEP,
IGES, STL, 3MF, OBJ, PLY, glTF) inside the one WASM asset the geometry worker
loads for any non-empty geometry. That asset sat at 88% of the 9 MiB review
line in `docs/kernel-wasm-size-policy.md` while growing by roughly half a
megabyte a week, and the translators were about 1.4 MB of it that most
sessions never execute: a document built from sketches and primitives reads
no file.

Remus now ships two packages from the same commit: `remus-wasm` (the kernel,
built without translators) and `remus-wasm-io` (the translators, exporting
`RemusIo`). The kernel keeps its exact arena document codec; bodies cross
between the two modules as those documents, which are byte-exact for `f64`
geometry.

## Decision

`packages/kernel-adapter` pins both packages to one Remus commit and loads
`remus-wasm-io` through a dynamic import in `remus-runtime.ts`, so Vite emits
it as its own lazy chunk. Nothing fetches it until an adapter entry point
that can reach a translator awaits `loadRemusTranslators()`: `exportStep`,
`exportStl`, `exportMesh`, `inspectStep`, and `syncDocument` for a document
holding an `imported-step` or `imported-mesh` feature. The synchronous feature
builders and export callbacks then read the resident instance through
`remusTranslators()`.

Exports serialize the built solids with `kernel.serializeSolids` and hand the
bytes to the translator; imports hand the translator's bytes to
`kernel.deserializeSolids` / `deserializeSolid`. The imported-STEP rebuild
cache is unchanged: it already restores arena documents.

The translator asset (`assets/remus_wasm_io_bg-*.wasm`) is an approved lazy
asset in `scripts/report-bundle-sizes.mjs` with its own 4 MiB raw budget and
stays outside the kernel size policy by construction. The Remus updater pins
both packages together and refuses a lockfile that resolves them to different
commits; `apps/web/vite.config.ts` enforces the same when it records the
build identity.

## Consequences

- The kernel asset drops by about 1.1 MB and the translators can grow without
  consuming kernel headroom.
- A document that never imports or exports never downloads the translators.
  The first export or file-backed rebuild pays one extra lazy fetch.
- Each import or export adds one exact serialization round trip. It is small
  next to STEP parsing and adds no approximation.
- Both pins must advance together. A Remus commit that carries only one of
  the packages cannot be installed.
- `REMUS_WASM_IO_PKG` joins `REMUS_WASM_PKG` as a test-time overlay for a
  local Remus build.

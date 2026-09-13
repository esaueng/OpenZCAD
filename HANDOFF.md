# Mesh import for 3MF, OBJ, glTF binary and PLY

## What shipped

ZCAD imported STL only. It now also imports `.3mf`, `.obj`, `.glb` and `.ply`,
through the translators the pinned kernel already ships.

Every one of them lands in the **existing** `imported-mesh` feature: the file is
read into triangles, the triangles go into the document exactly as an STL
import's do, and nothing downstream can tell the formats apart. A body imported
from a 3MF autosaves, reopens, replays, sews into a shell, mirrors, shells,
offsets, exports and refuses booleans identically to one imported from an STL,
because it is the same feature and the same rebuild.

Where the work happens:

- `packages/kernel-adapter/src/mesh-import-formats.ts` — the format table: which
  extensions are offered, how a refusal names each format, and the explicit
  `maxInputBytes` / `maxEntities` budgets each translator is called with.
- `packages/kernel-adapter/src/mesh-file-import.ts` — `importMeshFile(format,
  bytes)`: size check, translator call, arena document → solids →
  `tessellateSolid` → one merged triangle list, then the document's own
  200,000-triangle ceiling.
- `apps/web/src/worker/meshImportWorker.ts` + `apps/web/src/lib/
  meshImportWorkerClient.ts` — one disposable worker per file, terminated on
  success, failure or cancel, so a hostile file cannot pin the workspace kernel
  (the translator and kernel are synchronous WASM; termination is the only
  cancellation primitive).
- `apps/web/src/App.tsx` — `handleImportFile` dispatches the new extensions to
  that client, and the STL and mesh paths now share one `commitImportedMesh`
  (unit scale, best-effort archive of the original upload, the
  `commandFactories.importMesh` commit, the project-changed guard).
- Accept lists (`App.tsx`, `TopBar.tsx`), the File-menu hint, the drop-target
  copy and `inferContentType` cover the new extensions.
- `ArtifactKind` gains `'mesh-import'` (`packages/shared`, `apps/web/worker/
  validation.ts`) so an archived 3MF/OBJ/GLB/PLY upload is not filed as an STL.
  `artifacts.kind` is an unconstrained TEXT column, so no migration.

`.gltf` is **not** offered. Verified on the pin: `importGlb` refuses a JSON
glTF with `parse error: not a GLB file (invalid magic)`, and a JSON glTF's mesh
usually lives in a sibling `.bin` a file picker never hands over. Advertising
the extension would be advertising a refusal.

## Kernel calls adopted

| Call | Replacing |
| --- | --- |
| `RemusIo.import3mf(bytes, maxInputBytes, maxEntities)` | nothing — the format had no import path |
| `RemusIo.importObj(...)` | as above |
| `RemusIo.importGlb(...)` | as above |
| `RemusIo.importPly(...)` | as above |
| `BrepKernel.deserializeSolids` + `tessellateSolid` | how the arena document those importers return becomes the triangle list the document stores |

`importStl` and the STL path are untouched: STL still parses in JS
(`@openzcad/io-stl`) on the main thread, with its own limits and messages.

### What was probed against the pinned kernel (4bbcd5c7 / 2.131.0)

Throwaway Node probes against `remus_wasm_io_node.cjs` and
`remus_wasm_node.cjs`; the scripts are deleted, the findings are these:

- All four importers accept a hand-written box and return an arena document of
  one mesh-backed solid per object: 12 faces, volume 24 mm³, bbox exact.
- `tessellateSolid` on such a solid returns **the file's own triangles** — 12
  in, 12 out, over 8 welded vertices, volume unchanged. Nothing is refined or
  decimated on the way in.
- Round trip holds: those triangles → ASCII STL → `importStl` → `sewFaces`
  gives volume 24 again, which is the rebuild path the document takes.
- `maxInputBytes` is checked before parsing and throws
  `import limit exceeded for input bytes: <n> > <limit>`.
- `maxEntities` counters differ per format, which is why the table is
  per-format: OBJ/3MF/PLY charge **vertices** and **triangles** separately
  against it; STL charges vertices against `maxEntities * 3`; glTF charges the
  **sum of every accessor's element count** (positions + indices), about 4× the
  same mesh — hence `glb`'s budget is 4× the others'.
- The `unit` attribute of a 3MF model is **ignored** by the pinned importer: a
  box marked `meter` imports with the same numbers as one marked `millimeter`.
  So all mesh formats are adopted unscaled, the STL convention (millimetres),
  and the app applies `1 / UNIT_TO_MM[doc.units]` exactly as it does for STL.
- A 3MF holding two build items imports as two solids; they are merged into one
  mesh feature, the same merge the mesh exports do in the other direction.
- Garbage input refuses by name: `parse error: PLY header missing end_header`,
  `invalid topology for export: mesh has no triangles`,
  `invalid Zip archive: Could not find EOCD`.

## Check results

Run from the worktree root on this branch:

- `pnpm lint` → `✖ 19 problems (0 errors, 19 warnings)`, exit 0 — the 19
  pre-existing `react-hooks/exhaustive-deps` warnings, unchanged.
- `pnpm typecheck` → clean, no output, exit 0.
- `pnpm test` → root `Test Files 242 passed | 2 skipped (244)`,
  `Tests 2503 passed | 4 skipped (2507)`; web `Test Files 157 passed (157)`,
  `Tests 1186 passed (1186)`; exit 0. (Web was 156 files / 1182 tests on
  `origin/main`: +1 file, +4 tests from `meshImportWorkerClient.test.ts`. Root
  gains `test/mesh-import.test.ts`, 14 tests.)
- `pnpm test:parity-corpus` → `Test Files 7 passed (7)`,
  `Tests 174 passed | 1 skipped (175)`, exit 0.

`pnpm test:e2e` and `pnpm build` were not run (per the briefing).

## Coverage added

- `test/mesh-import.test.ts` (root, real kernel): for each of the four formats —
  the fixture imports to 12 triangles enclosing 24 mm³; the resulting
  `imported-mesh` document goes through JSON, `InMemoryPersistenceService`
  `saveRevision` and `loadProject`, and the **reloaded** document rebuilds on
  the exact adapter to the same volume and bbox with no warnings; an input one
  byte over that format's ceiling is refused by a message naming the limit,
  rather than being parsed or crashing. Plus: a mis-typed file refuses with the
  format named, and `.gltf`/`.stl`/`.step` are not claimed by the mesh dispatch.
- `test/support/mesh-import-fixtures.ts`: the same box written as OBJ, ASCII
  PLY, a 3MF package (a hand-built stored Zip — the repo has no Zip writer
  outside `io-shapr`'s dependency) and a GLB. Generated, not committed binaries;
  each is a few hundred bytes.
- `apps/web/src/lib/meshImportWorkerClient.test.ts` (web): the oversized refusal
  happens **before** a worker is constructed; a mismatched request id is
  ignored; the transferred typed arrays are unpacked to plain arrays; abort and
  worker refusals both terminate the worker.

## Deliberate limits

- **STL was left alone.** It keeps its JS parser, its 128 MB ceiling and its
  messages. Routing it through the kernel importer too would have been a
  behaviour change with no user-visible gain, and it is the one mesh path with
  e2e coverage.
- **One mesh feature per file.** Multi-object files (a 3MF with several build
  items) merge into one mesh body rather than becoming several features. That
  matches how the mesh exports merge, and how an STL import behaves; splitting
  them is a product decision, not a wiring one.
- **No pre-import preview.** STEP has `inspectStep` and an import card with
  progress and cancel; mesh imports show a status line, as STL does. The client
  accepts an `AbortSignal` already, so wiring the card later is small.
- **Byte ceilings are per format but not tuned per machine**: 128 MB for OBJ,
  GLB and PLY (the ceiling STL and STEP already use), 32 MB for 3MF because it
  is a Zip package whose bytes are compressed — the entity budget is what
  actually bounds a 3MF's expansion.

## Risks for the reviewer

- **The entity budgets are a fence, not a product limit.** They sit at 3× the
  document's 200,000-triangle ceiling (4× that for glTF's different counter), so
  the user-facing refusal for a too-big mesh is still the triangle limit. A file
  between those two numbers is parsed and then refused; it is bounded, but it is
  not refused as early as an oversized *file* is.
- **`'mesh-import'` is a new `ArtifactKind`.** A deployed Cloudflare Worker
  older than this change would reject that kind. The archive is best-effort —
  the import continues and the status line says the original was not archived —
  so the failure mode is cosmetic, but it does mean the client and worker want
  to ship together.
- **Bundle budget.** `App.tsx` gained no new static import: the format table and
  the client are behind `await import('./lib/meshImportWorkerClient')`, and the
  worker is its own chunk. Entry growth should be only the longer `accept`
  strings and the new branch. `pnpm build` (and its
  `report-bundle-sizes.mjs --check`) was not run here — worth one run before
  merge, given how little headroom the entry chunk has.
- **A large import still blocks its own worker, not the UI.** There is no
  progress reporting inside the parse; a 150,000-triangle OBJ shows nothing
  until it finishes or refuses.

## Follow-ups

- Wire the mesh import into the import card (progress + cancel) — the client
  already takes an `AbortSignal`.
- An e2e case that drops a `.3mf` on the viewport, mirroring the existing STL
  e2e, would cover the DOM half this branch tests only in unit form.
- `importIges` and `importIndexedMesh` exist on the same translator and are
  still unused; IGES in particular is a small follow-on to this wiring.
- If multi-object files should become multiple bodies, that is a document-level
  change (several `imported-mesh` features from one file) and belongs with the
  assembly work in I-3.

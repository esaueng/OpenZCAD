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

**One file becomes one body.** A file that holds several objects is refused by
name, with the count, before a feature exists — see *A multi-object file is
refused* below.

**A 3MF's declared unit is honoured.** The other three formats declare none and
are adopted as written, the STL convention.

Where the work happens:

- `packages/kernel-adapter/src/mesh-import-formats.ts` — the format table: which
  extensions are offered, how a refusal names each format, and the explicit
  `maxInputBytes` / `maxEntities` budgets each translator is called with. It is
  reached as `@openzcad/kernel-adapter/mesh-import-formats`, its own package
  entry point, **not** through the adapter's index barrel — see *Bundle budget*.
- `packages/kernel-adapter/src/mesh-file-import.ts` — `importMeshFile(format,
  bytes)`: size check, unit read (3MF), translator call, arena document →
  solids → single-object check → `tessellateSolid` → one triangle list → unit
  conversion, then the document's own 200,000-triangle ceiling.
- `packages/kernel-adapter/src/three-mf-unit.ts` — reads the `unit` attribute a
  3MF's `<model>` element declares, out of the Zip package, and refuses rather
  than guessing when it cannot.
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

## A multi-object file is refused

A 3MF with two disjoint boxes — two `<object>` resources, two `<item>` build
entries — used to import as 24 triangles and then rebuild to **no body at
all**, behind the status line "Imported 24 triangles from plate.3mf". Measured
on the pin: `bodyPresent false`, and the feature warning `This mesh could not
be sewn into a shell the kernel can model with: configured healing result
refused`.

The merge itself was real; the rebuild is what cannot work. An `imported-mesh`
feature rebuilds by re-serializing its triangles to one ASCII STL solid and
sewing them, and separate shells do not sew into one. Multi-object is the
normal shape of a 3MF, so the common case shipped a false success.

`importMeshFile` now refuses a file whose arena document holds more than one
solid:

> This 3MF file holds 2 separate objects, and a mesh import becomes one body.
> Export it as a single object, or import each object from its own file.

That is the fail-closed answer, and it is a real functional limit, not a fix
for the underlying rebuild. Turning one file into several bodies is a
document-level change (several `imported-mesh` features from one import, with
one undo step) and is listed under Follow-ups.

A multi-shell **STL** still behaves the old way: the JS parser produces no
solid count, so that path has no equivalent check and such a file still imports
and then warns at rebuild. That is pre-existing on `main`, was not introduced
here, and was left alone deliberately — the STL path is the one with e2e
coverage and this branch does not otherwise touch it.

## A 3MF's declared unit is honoured

The same 2x3x4 box declared `unit="millimeter"`, `unit="inch"` and
`unit="meter"` all used to import at volume 24: the pinned translator ignores
the attribute, so an inch-authored file landed 25.4x too small and a
metre-authored one 1000x too small, with nothing on screen to say so.

`readThreeMfUnit` now reads the declaration out of the package and the import
converts to millimetres. Measured after the change: millimeter 1x, centimeter
10x, inch 25.4x, foot 304.8x, meter 1000x, micron 0.001x; an absent attribute
is the format's own default of millimetres; and an inch-authored box rebuilds
through `syncDocument` to 24 x 25.4³ mm³ with no warnings. The status line says
what it converted from.

Reading it means opening the Zip: `three-mf-unit.ts` walks the central
directory, then decompresses **only** `_rels/.rels` and the first 64 KB of the
3D model part, both capped, cancelling the decompression stream as soon as it
has enough — so a hostile package cannot expand into memory through this path.
Stored and deflated entries are both read (`DecompressionStream('deflate-raw')`,
which is what every real exporter's output needs). Zip64, encryption and any
other compression method are refused by name, as is a unit the 3MF core format
does not define. Nothing is guessed.

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

Throwaway Node and Vitest probes against `remus_wasm_io_node.cjs` and
`remus_wasm_node.cjs`; the probes are deleted, the findings are these:

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
  ZCAD reads it instead; see above.
- A 3MF holding two build items imports as two solids, and those two solids
  merged into one triangle soup **cannot be sewn** — the resulting feature has
  no body. Hence the refusal above.
- Garbage input refuses by name: `parse error: PLY header missing end_header`,
  `invalid topology for export: mesh has no triangles`. (A 3MF that is not a
  Zip is now refused by the unit reader, before the translator sees it: `This
  3MF package could not be read: it is not a Zip package.`)

## Check results

Run from the worktree root on this branch, at the final commit:

- `pnpm lint` → `✖ 19 problems (0 errors, 19 warnings)`, exit 0 — the 19
  pre-existing `react-hooks/exhaustive-deps` warnings, unchanged.
- `pnpm typecheck` → clean, no output, exit 0.
- `pnpm test` → root `Test Files 242 passed | 2 skipped (244)`,
  `Tests 2524 passed | 4 skipped (2528)`; web `Test Files 157 passed (157)`,
  `Tests 1187 passed (1187)`; exit 0. (`origin/main` baseline: root 241 files /
  2489 tests + 2 skipped, web 156 files / 1182 tests.)
- `pnpm test:parity-corpus` → `Test Files 7 passed (7)`,
  `Tests 174 passed | 1 skipped (175)`, exit 0 — the baseline exactly.
- `pnpm build` → exit 0, `"warnings": []`, `"failures": []`. Entry chunk
  `assets/index-*.js` 508,054 bytes against the 512,000-byte budget, and no
  `assets/src-*.js` among `initialAssets`.

`pnpm test:e2e` was not run (per the briefing).

## Coverage added

- `test/mesh-import.test.ts` (root, real kernel): for each of the four formats —
  the fixture imports to 12 triangles enclosing 24 mm³; the resulting
  `imported-mesh` document goes through JSON, `InMemoryPersistenceService`
  `saveRevision` and `loadProject`, and the **reloaded** document rebuilds on
  the exact adapter to the same volume and bbox with no warnings; an input one
  byte over that format's ceiling is refused by a message naming the limit.
  Plus: every 3MF unit converted and asserted by volume and bbox; an absent
  unit attribute; a **deflate-compressed** package (what real exporters write —
  the other fixtures store their parts); an undefined unit and an unopenable
  package refused by name; an inch-authored box through `syncDocument` at its
  real size; the two-object refusal naming the count; a barely oversized file
  distinguished from its limit; a mis-typed file refused with the format named;
  and `.gltf`/`.stl`/`.step` not claimed by the mesh dispatch.
- `test/mesh-import.test.ts` also pins the **lazy boundary**: the format table
  stays out of the adapter index barrel, the client and worker reach its own
  entry point, and that entry point is declared in the package exports, the Vite
  alias and the tsconfig paths together. The build failure this branch shipped
  was a source shape, so the guard is one too.
- `test/bundle-size-policy.test.ts`: `LAZY_ENTRY_PATTERNS` covers both
  disposable import workers and an anonymous `src-*` chunk, and does not cover
  the launcher entry or its named shared chunks.
- `test/support/mesh-import-fixtures.ts`: the same box written as OBJ, ASCII
  PLY, a 3MF package (a hand-built Zip — the repo has no Zip writer outside
  `io-shapr`'s dependency) and a GLB, plus 3MF variants for a declared unit,
  several objects, and deflated parts. Generated, not committed binaries.
- `apps/web/src/lib/meshImportWorkerClient.test.ts` (web): the oversized refusal
  happens **before** a worker is constructed; a mismatched request id is
  ignored; the transferred typed arrays are unpacked to plain arrays; a declared
  source unit is carried back to the caller; abort and worker refusals both
  terminate the worker.

## Deliberate limits

- **STL was left alone.** It keeps its JS parser, its 128 MB ceiling, its
  messages — and its multi-shell behaviour, which is the pre-existing false
  success described above. Routing it through the kernel importer would have
  been a behaviour change with no user-visible gain, and it is the one mesh path
  with e2e coverage.
- **One body per file, enforced.** A multi-object file is refused rather than
  imported, which is a real limit on a format where multi-object is common.
  Making it several bodies is document-level work; see Follow-ups.
- **The 3MF unit reader is not a general Zip reader.** Zip64 packages and
  compression methods other than stored and deflate are refused by name rather
  than read. No 3MF under the 32 MB ceiling needs Zip64, and no exporter in
  circulation writes a 3MF with Deflate64, but a file that did would be refused
  rather than mis-scaled.
- **`<item transform>` is the translator's business.** ZCAD reads the unit; any
  per-item placement matrix is applied (or not) by the pinned importer, and this
  branch does not second-guess it. With multi-object files refused, a transform
  on the single remaining item is the only case, and it was not probed.
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
- **Bundle budget: measured, not assumed.** An earlier revision of this branch
  claimed the entry chunk would gain "only the longer accept lists and the new
  branch", and did not run `pnpm build`. That claim was wrong and the build
  failed: the format table exported from the index barrel put 96.69 kB of
  kernel-adapter source into a shared chunk the launcher preloaded. It is fixed
  and measured — entry 508,054 bytes, 3,946 under the 512,000 budget and 2,250
  **below** the merge base's 510,304 — but the headroom is small enough that the
  next thing reachable from `App.tsx` should be checked with a real build.
- **The Zip reader is new code on an import path.** It is small, capped and
  tested against stored and deflated packages, but it has not met a corpus of
  real-world 3MF files from many exporters. Its failure mode is a refusal with a
  named reason, not wrong geometry.
- **A large import still blocks its own worker, not the UI.** There is no
  progress reporting inside the parse; a 150,000-triangle OBJ shows nothing
  until it finishes or refuses.
- **The branch is behind `main`.** Base `6ada3b3c`; `origin/main` is `989e62c7`
  (three commits ahead: #328, #327, #329). `main` requires an up-to-date branch,
  so `gh pr update-branch` and a fresh CI run are needed before merging.
  `git merge-tree --write-tree HEAD origin/main` succeeds, so the update merges
  cleanly, but the checks above were run before it.

## Follow-ups

- **Several bodies from one file.** The multi-object refusal is a stopgap. The
  real answer is either several `imported-mesh` features from one import under a
  single undo step, or a rebuild that sews each connected shell and carries them
  as several solids in one body's shape (`shape.solids` is already a list). Both
  are document-level and belong with the assembly work in I-3; the second would
  also close the multi-shell STL hole.
- Wire the mesh import into the import card (progress + cancel) — the client
  already takes an `AbortSignal`.
- An e2e case that drops a `.3mf` on the viewport, mirroring the existing STL
  e2e, would cover the DOM half this branch tests only in unit form.
- `importIges` and `importIndexedMesh` exist on the same translator and are
  still unused; IGES in particular is a small follow-on to this wiring.

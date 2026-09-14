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

**One file becomes one body, several shells included.** A file holding several
objects imports as one body carrying all of them. A file whose triangles the
rebuild cannot take is refused at import, by name, with the kernel's own
reason — see *One body per file, decided by trying*.

**A 3MF's declared unit and its `<build>` section are honoured.** Per-item
transforms are applied, an object placed twice imports twice, and an object the
build never places is left out. The other three formats declare no unit and
have no build section; their numbers are adopted as written, the STL
convention.

Where the work happens:

- `packages/kernel-adapter/src/mesh-import-formats.ts` — the format table: which
  extensions are offered, how a refusal names each format, and the explicit
  `maxInputBytes` / `maxEntities` budgets each translator is called with. It is
  reached as `@openzcad/kernel-adapter/mesh-import-formats`, its own package
  entry point, **not** through the adapter's index barrel — see *Bundle budget*.
- `packages/kernel-adapter/src/mesh-file-import.ts` — `importMeshFile(format,
  bytes)`: size check, package read (3MF), translator call, arena document →
  solids → placements → `tessellateSolid` → one triangle list → unit
  conversion, the document's own 200,000-triangle ceiling, then the rebuild
  check.
- `packages/kernel-adapter/src/three-mf-package.ts` — opens the Zip package and
  reports what the 3MF states: its `unit`, its mesh objects in `<resources>`
  order, and its `<build>` items with their matrices. Refuses rather than
  guessing when it cannot read one of them.
- `packages/kernel-adapter/src/exact-shape-utils.ts` — `importMeshSolid` and
  its `unifySewnMesh`: a refused face merge now keeps the sewn shell instead of
  throwing it away. See *One body per file*.
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

## One body per file, decided by trying

**Round 1 shipped a multi-object 3MF that imported behind "Imported 24
triangles" and then rebuilt to no body. Round 2 answered it by counting arena
solids, which was the wrong thing to count, and the round-2 review was right
on all three counts.** What the count did:

- **It never fired for OBJ, GLB or PLY.** Those translators return *one* solid
  holding several shells. Reproduced here: a two-box OBJ returned
  `triangleCount 24`, the status line said "Imported 24 triangles", and
  `syncDocument` gave no body and the warning "This mesh could not be sewn into
  a shell the kernel can model with: configured healing result refused". The
  original defect, surviving on a format this same branch introduces.
- **It refused files that import perfectly well.** A 3MF whose `<resources>`
  carry a spare object but whose `<build>` places one got a dead end plus
  advice it had already followed.
- **Its premise was false.** "Separate shells cannot be sewn" is not true, and
  the review's GLB counter-example was real.

The real cause was one branch in `unifySewnMesh`. The rebuild sews the
triangles and then asks the heal pipeline to merge same-domain faces. Measured
on the pin for the same two-box soup:

| | sewn solid | `validateSolidDetailed(sewn)` | `unify_same_domain` |
| --- | --- | --- | --- |
| OBJ, two boxes | volume 48, bbox 0..12 | `errorCount 0` | **refused** |
| GLB, two boxes | volume 48, bbox 0..12 | `errorCount 1` — "8 shared edges have inconsistent face orientations" | **refused** |
| OBJ, one box | volume 24 | `errorCount 0` | ok, 6 faces merged |

`unifySewnMesh` kept the sewn shell when it was *invalid* (the open-shell
escape hatch) and rethrew when it was *valid*. So the GLB case published — the
review's clean import was the escape hatch firing — and the OBJ case, whose
sewn shell the kernel validates with zero errors, was destroyed. The heal
pipeline is transactional and its refusal is about the *merge*, not about the
shell, so the shell now stands either way and the existing volume/bounds oracle
in `importMeshSolid` still decides whether it may be published. That also
closes the multi-shell **STL** hole the previous handoff called pre-existing.

With that fixed, all four formats import a two-box file and rebuild to volume
48 with zero warnings, so there is nothing to refuse by counting.

What replaces the count is the honest question: `importMeshFile` runs the
rebuild itself — `writeAsciiStl` → `importMeshSolid` — on the triangles it is
about to return, and refuses only if that refuses:

> This 3MF file could not be imported as a body: invalid topology for export:
> non-manifold mesh edge between welded vertices 0 and 1 has 4 incident faces
> (maximum is 2). Its triangles form 2 groups that share no vertex, and a mesh
> import becomes one body — export it as a single closed mesh, or import each
> part from its own file.

(that is a real refusal, from a 3MF whose build places one object twice at the
same spot). No path can now report success and then rebuild to nothing: the
import runs the rebuild.

## A 3MF's `<build>` section is honoured

The pinned translator reads `<resources>` and ignores `<build>` completely.
Measured on the pin, before the fix:

| the file says | what imported |
| --- | --- |
| `<item objectid="1" transform="2 0 0 0 2 0 0 0 2 0 0 0"/>` | the box at 1x — volume 24, not 192 |
| `<item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 0 0"/>` | the box at x 0..2, not 100..102 |
| `<item objectid="1"/><item objectid="1"/>` | one copy of two |
| two objects, `<item objectid="2"/>` only | both objects |

All four silently, behind a success message. `three-mf-package.ts` now reports
the build, and `mesh-file-import.ts` places it: each item's solid is
tessellated once and emitted once per placement, through the item's matrix.
Measured after the fix: the doubled box rebuilds to volume 192 / bbox 4x6x8;
the translated one to x 100..102; the two-up plate to 24 triangles and volume
48 across both copies; the spare-resource file to the one built object.

The matrix is the format's twelve numbers applied to a **row** vector
(`x' = x·m00 + y·m10 + z·m20 + m30`), verified against the review's two
measurements. A mirroring matrix (negative determinant) turns every triangle
inside out, so the winding is swapped back for those placements; measured, a
`-1 0 0 …` placement rebuilds to +24 mm³ at x −2..0.

Mapping a build item to a solid is positional — the translator returns one
solid per `<object>` in document order, verified by reversing two objects and
watching the two solids reverse — so the mapping is checked before it is used:
if the package's mesh objects and the translator's solids do not correspond one
for one, the import refuses instead of placing whichever solid sits at that
index.

Refused by name, rather than dropped or guessed:

- an object built out of `<components>` (the translator refuses this package
  too, but as "invalid topology for export: mesh has no triangles", which names
  the wrong cause — measured both built and unbuilt);
- a build item naming an object the resources do not define as a mesh;
- a build item with a `path` into another model part (the production
  extension), which neither this reader nor the translator follows;
- a transform that is not twelve finite numbers, or whose 3x3 determinant is
  zero;
- a build that places nothing, and a model with no `<build>` element.

## A 3MF's declared unit is honoured

The same 2x3x4 box declared `unit="millimeter"`, `unit="inch"` and
`unit="meter"` all used to import at volume 24: the pinned translator ignores
the attribute, so an inch-authored file landed 25.4x too small and a
metre-authored one 1000x too small, with nothing on screen to say so.

The package reader now reads the declaration and the import converts to
millimetres. Measured: millimeter 1x, centimeter 10x, inch 25.4x, foot 304.8x,
meter 1000x, micron 0.001x; an absent attribute is the format's own default of
millimetres; and an inch-authored box rebuilds through `syncDocument` to
24 x 25.4³ mm³ with no warnings. The status line says what it converted from.

Reading it means opening the Zip. `three-mf-package.ts` walks the central
directory, decompresses `_rels/.rels` in its first 64 KB, and **streams** the
3D model part: `<build>` is the last element, after every vertex and triangle,
so the whole part has to go past — but only one chunk at a time, and the scan
keeps nothing but the few hundred bytes of structure it finds. The stream is
capped at 256 MB inflated and refuses by name past it; the document's own
200,000-triangle ceiling puts a legitimate model part two orders of magnitude
below that. Stored and deflated entries are both read
(`DecompressionStream('deflate-raw')`, which is what every real exporter's
output needs). Zip64, encryption and any other compression method are refused
by name, as is a unit the 3MF core format does not define. Nothing is guessed.

## Kernel calls adopted

| Call | Replacing |
| --- | --- |
| `RemusIo.import3mf(bytes, maxInputBytes, maxEntities)` | nothing — the format had no import path |
| `RemusIo.importObj(...)` | as above |
| `RemusIo.importGlb(...)` | as above |
| `RemusIo.importPly(...)` | as above |
| `BrepKernel.deserializeSolids` + `tessellateSolid` | how the arena document those importers return becomes the triangle list the document stores |
| `BrepKernel.sewFaces` + `runHealPipeline(['unify_same_domain'])`, through the existing `importMeshSolid` | nothing new — it is the rebuild, run once at import time so a file that cannot become a body is refused as a file |

`importStl` and the STL path are untouched: STL still parses in JS
(`@openzcad/io-stl`) on the main thread, with its own limits and messages. The
`unifySewnMesh` change does reach STL, and fixes a multi-shell STL there.

### What was probed against the pinned kernel (4bbcd5c7 / 2.131.0)

Throwaway Vitest probes against the installed pin; the probes are deleted, the
findings are these. Round-2 findings first:

- **A multi-shell soup sews.** Two disjoint 2x3x4 boxes: `sewFaces` returns one
  solid of volume 48 and bbox 0..12 in every format. `validateSolidDetailed` on
  it reports 0 errors for the OBJ, PLY and 3MF orderings and 1 error —
  "8 shared edges have inconsistent face orientations" — for the GLB ordering
  of the same geometry. Whether the shells sew is not predictable from any
  count; the same two boxes differ only in vertex and triangle order.
- **`unify_same_domain` is refused for every multi-shell soup measured**, with
  "configured healing result refused: operations validator found N error(s),
  check validator found M error(s)". It succeeds for a single box (6 faces
  merged). The refusal is transactional — the sewn solid is untouched.
- **The 3MF translator returns one solid per `<object>` resource, in document
  order**, and ignores `<build>` entirely: reversing two `<object>` elements
  reverses the solids; a build naming only object 2 still returns both; a
  duplicated item returns one solid; a transform changes nothing; an empty
  build still returns the resource.
- **A `<components>` object breaks the whole 3MF import** at the translator,
  built or unbuilt: "invalid topology for export: mesh has no triangles".
- **`type="other"` objects still come back as solids**, in resource order, so
  the positional mapping counts every object that carries a mesh.
- A build that places one object twice **at the same spot** parses, tessellates
  and then fails the rebuild's sew as non-manifold — the fixture behind the
  rebuild-check regression test.

Carried over from round 1, still true:

- All four importers accept a hand-written box and return an arena document of
  one mesh-backed solid per object: 12 faces, volume 24 mm³, bbox exact.
- `tessellateSolid` on such a solid returns **the file's own triangles** — 12
  in, 12 out, over 8 welded vertices, volume unchanged.
- `maxInputBytes` is checked before parsing and throws
  `import limit exceeded for input bytes: <n> > <limit>`.
- `maxEntities` counters differ per format: OBJ/3MF/PLY charge **vertices** and
  **triangles** separately against it; glTF charges the **sum of every
  accessor's element count**, about 4x the same mesh — hence `glb`'s budget.
- The `unit` attribute of a 3MF model is **ignored** by the pinned importer.
- Garbage input refuses by name: `parse error: PLY header missing end_header`,
  `parse error: not a GLB file`.

## Check results

Run from the worktree root on this branch, at the final commit:

- `pnpm lint` → `✖ 19 problems (0 errors, 19 warnings)`, exit 0 — the 19
  pre-existing `react-hooks/exhaustive-deps` warnings, unchanged.
- `pnpm typecheck` → clean, no output, exit 0.
- `pnpm test` → root `Test Files 242 passed | 2 skipped (244)`,
  `Tests 2541 passed | 4 skipped (2545)`; web `Test Files 157 passed (157)`,
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
  the one-box fixture imports to 12 triangles enclosing 24 mm³; the resulting
  `imported-mesh` document goes through JSON, `InMemoryPersistenceService`
  `saveRevision` and `loadProject`, and the **reloaded** document rebuilds on
  the exact adapter to the same volume and bbox with no warnings; **a two-object
  file of the same format imports and rebuilds to one body of both boxes**
  (the case round 1 refused and round 2 half-refused); an input one byte over
  that format's ceiling is refused by a message naming the limit.
- The rebuild check: a 3MF that places one object twice at the same spot is
  refused with the kernel's non-manifold reason *and* the disjoint-group count;
  a one-triangle OBJ is refused with "needs at least two triangles".
- The whole 3MF build section: a scaling transform (volume x8, bbox x2), a
  translating transform (x 100..102), a mirroring transform (positive volume,
  bbox −2..0), an object placed twice (24 triangles, volume 48), a spare
  unbuilt resource (the built object only), the build read out of a **deflated**
  package, and the six refusals — `<components>`, an undefined object id, no
  build, an empty build, a malformed and a degenerate transform, and an item
  with a `path` into another model part.
- Every 3MF unit converted and asserted by volume and bbox; an absent unit
  attribute; an undefined unit and an unopenable package refused by name; an
  inch-authored box through `syncDocument` at its real size.
- `test/imported-mesh.test.ts`: a two-shell triangle soup rebuilds to one body
  of the summed volume and the union bbox — the regression for the
  `unifySewnMesh` change, on the STL-shaped path that predates this branch.
- `test/mesh-import.test.ts` also pins the **lazy boundary**: the format table
  stays out of the adapter index barrel, the client and worker reach its own
  entry point, and that entry point is declared in the package exports, the Vite
  alias and the tsconfig paths together.
- `test/bundle-size-policy.test.ts`: `LAZY_ENTRY_PATTERNS` covers both
  disposable import workers and an anonymous `src-*` chunk.
- `test/support/mesh-import-fixtures.ts`: the same box written as OBJ, ASCII
  PLY, a 3MF package (a hand-built Zip) and a GLB, each buildable `count` times
  over with the copies clear of each other, plus 3MF variants for a declared
  unit, build items with transforms and repeats, a `<components>` object, an
  absent build, and deflated parts. Generated, not committed binaries.
- `apps/web/src/lib/meshImportWorkerClient.test.ts` (web): the oversized refusal
  happens **before** a worker is constructed; a mismatched request id is
  ignored; the transferred typed arrays are unpacked to plain arrays; a declared
  source unit is carried back to the caller; abort and worker refusals both
  terminate the worker.

## Deliberate limits

- **One import is still one *body*.** Several shells now live in one body
  rather than being refused, but turning one file into several selectable
  bodies is document-level work (several `imported-mesh` features under one
  undo step, or several solids in one body's shape) and is in Follow-ups.
- **STL keeps its own parser.** It still parses in JS on the main thread, with
  its own 128 MB ceiling and messages, and it does **not** get the import-time
  rebuild check — a multi-shell STL now rebuilds correctly, but an STL whose
  triangles the sew refuses still reports success and then warns at rebuild.
  Routing STL through this path is a behaviour change on the one mesh path with
  e2e coverage; it is a follow-up, and it is the only remaining
  success-then-warn case.
- **The 3MF reader is not a general Zip or 3MF reader.** Zip64 packages and
  compression methods other than stored and deflate are refused by name.
  `<components>` composition, the production extension's multi-part models, and
  any object resource whose mesh the translator will not read are refused
  rather than resolved. The model-part scan matches tags with a regex, so an
  attribute value containing a literal `>` — legal XML, written by nothing in
  circulation — would confuse it; the failure mode is a refusal, since the
  mapping check and the rebuild check both sit behind it.
- **No pre-import preview.** STEP has `inspectStep` and an import card with
  progress and cancel; mesh imports show a status line, as STL does. The client
  accepts an `AbortSignal` already, so wiring the card later is small.
- **Byte ceilings are per format**: 128 MB for OBJ, GLB and PLY (the ceiling
  STL and STEP already use), 32 MB for 3MF because it is a Zip package whose
  bytes are compressed — the entity budget is what actually bounds a 3MF's
  expansion.

## Risks for the reviewer

- **The import now does the rebuild's work twice.** `importMeshFile` serializes
  the triangles to ASCII STL and sews them, and `syncDocument` does it again
  when the feature is committed. For a 200,000-triangle mesh that is a second
  large string and a second sew, inside the disposable worker rather than the
  UI thread. It is the price of never reporting a success that cannot come
  back; if it proves too slow, the cheaper version is to hand the verified
  solid forward rather than re-deriving it, which is a bigger change.
- **The check runs on millimetres, the document may store other units.**
  `commitImportedMesh` scales by `1/UNIT_TO_MM` after the check. The sew
  tolerance is relative to the mesh's own extent (`max(1, extent) * 1e-6`), so
  a uniform scale is nearly invariant — but the `max(1, …)` floor means a
  document in metres verifies a 12 mm part and then stores a 0.012 m one. This
  is pre-existing for STL and was not changed here; it is the one way the
  check's answer could differ from the rebuild's.
- **`unifySewnMesh` no longer rethrows.** Any failure of the heal pipeline now
  falls back to the sewn shell, including one that is not a validator refusal
  (a kernel fault, say). The volume and bounds oracle immediately after it is
  what still has to pass, and a faulted kernel would throw there, but the
  distinction between "refused the merge" and "the kernel broke" is no longer
  drawn — `runHealPipeline` is not typed, and drawing it would mean parsing
  English.
- **A GLB two-box import publishes a shell the kernel validates with one
  error** ("8 shared edges have inconsistent face orientations"). It measures
  the right volume and bounds and it shipped that way before this branch — the
  open-shell fallback published it — but it is worth knowing that "zero
  warnings" in the app does not mean "zero validator errors" for a mesh body.
  Surfacing `validateSolidDetailed` on an imported mesh as a warning is a
  follow-up.
- **`'mesh-import'` is a new `ArtifactKind`.** A deployed Cloudflare Worker
  older than this change would reject that kind. The archive is best-effort, so
  the failure mode is cosmetic, but the client and worker want to ship together.
- **Bundle budget: measured, not assumed.** Entry chunk 508,054 bytes, 3,946
  under the 512,000 budget and 2,250 **below** the merge base's 510,304, with
  `failures: []`. The headroom is small enough that the next thing reachable
  from `App.tsx` should be checked with a real build.
- **The branch is behind `main`.** `main` requires an up-to-date branch, so
  `gh pr update-branch` and a fresh CI run are needed before merging.

## Follow-ups

- **Several bodies from one file.** A multi-object file is now one body holding
  every shell, which is right for a plate of parts but not for an assembly the
  user wants to select part by part. Several `imported-mesh` features under one
  undo step, or several solids in one body's shape (`shape.solids` is already a
  list), belongs with the assembly work in I-3.
- **Route STL through `importMeshFile`'s rebuild check**, closing the last
  success-then-warn path.
- **Surface `validateSolidDetailed` on an imported mesh body** as a warning, so
  a shell with inconsistent face orientations says so instead of looking clean.
- Wire the mesh import into the import card (progress + cancel) — the client
  already takes an `AbortSignal`.
- An e2e case that drops a `.3mf` on the viewport, mirroring the existing STL
  e2e, would cover the DOM half this branch tests only in unit form.
- `importIges` and `importIndexedMesh` exist on the same translator and are
  still unused; IGES in particular is a small follow-on to this wiring.

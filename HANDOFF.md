# Exact section curves behind the section view

Branch `claude/remus-exact-sections`. Thirteen commits on top of `origin/main`,
no push, no PR. Commits 7–9 answer an independent verifier's first report on
the first six; commits 10–13 answer its second, including a defect the first
round introduced. Both rounds are recorded under "Verifier rounds" below.

## What shipped

The section view used to be one thing: three.js clipping plus the display
caps `sectionCaps` triangulates from the clipped tessellation. It is now two,
and the user is told which one is on screen.

- **While the plane moves** nothing changes. The clipped preview is what keeps
  the slider at pointer rate, and no kernel work is started during a drag.
- **When the plane comes to rest** — the slider is released, a key repeat
  ends, or the section view is switched on or cycled — the app asks the kernel
  for the real cross-section of **the document the viewport is drawing, and
  the bodies of it that are on screen** (a form preview or an assistant
  proposal replaces the live document in the viewport, and the section
  follows it) and draws that instead: the cut surface in a cool slate against the warm body
  colour, with its boundary curves showing. The rail reads "Exact section" and
  the cut's measured area.
- **Only that geometry can be exported.** A DXF button sits next to the
  slider and writes the section curves as DXF R12 in millimetres. It is live
  only when the export can write **every** body the plane cuts: the exporter
  refuses a body it cannot section exactly rather than leaving that body's
  material out of the drawing, so a section with one such body is still shown
  and still measured, but is not a drawing.
- **When there is no exact answer** the rail says so in the kernel's own
  words, the export stays shut, and the body keeps its approximate cap rather
  than rendering as an open shell.

The two are never shown together on the same body, and an exact section never
outlives the plane position, the model version, the set of visible bodies, or
the drag that produced it. Each of those bumps a request token in `App`, and
an answer that arrives under an old token is dropped rather than drawn.

### The witness, and why it is not optional

The pinned kernel's `section` is candidate evidence, not proof. Probed on
2.131.0, three of its answers look like ordinary geometry and are not:

| case | what the kernel does |
| --- | --- |
| plane misses the body | returns an EMPTY handle array, no error |
| plane flush with a planar face | returns that whole face — a full outline of an uncut body |
| plane down a through-bore axis | returns the **undrilled** rectangle: 120 mm² where the truth is 96 |
| cross-section in disjoint regions | raises `invalid input: no closed cross-section could be assembled` |
| plane parallel to a cylinder wall | same refusal, even where a rectangle is the obvious answer |

So every exact section is graded against an independent witness computed from
the solid's own tessellation: the signed cross-section area obtained by
walking each plane-crossing triangle's segment, directed
`planeNormal × triangleNormal` so material stays on its left. Summing the
shoelace term of those directed segments gives the enclosed area with holes
subtracting themselves — no contour assembly, no welding tolerance, and no
dependence on the kernel's own topology. Displacing a contour by at most the
tessellation deflection moves its area by at most `deflection × perimeter`,
which is exactly the tolerance allowed. Anything further apart is refused by
name and never drawn or exported.

Refusal reasons are typed: `plane-misses-body`, `kernel-refused`,
`empty-section`, `non-planar-section`, `area-mismatch`,
`wire-order-unverified`, `unknown-body`. The last is the only one that is
not the kernel's: it is the document-level section declining a body id the
build has no geometry for, and it exists so that one stale id cannot take
the whole section down with it.

## Kernel calls adopted

| call | used for | replacing |
| --- | --- | --- |
| `section(solid, px,py,pz, nx,ny,nz)` | exact cross-section face handles | nothing — never called before |
| `getFaceWires` / `getWireEdges` / `sampleEdge` | section boundary loops, and the DXF entities | the display caps' welded contour walk, for export only |
| `tessellateFace` | the cut surface drawn in the viewport | the caps' `ShapeUtils.triangulateShape` fill, for exact bodies only |
| `tessellateSolid` | the independent area witness | new |
| `faceArea(face, deflection)` | the kernel's own cut area, shown in the rail | new |
| `getSurfaceType` / `boundingBox` | planarity check and the graze tolerance | new |

The display-cap path (`packages/viewport/src/scene/sectionCaps.ts`) is
untouched and still owns every drag.

No new kernel call was adopted in either verifier round. The second round
used the kernel only to reproduce and to pin: `exportStep` + `importStepBody`
to author a genuine two-solid body, and `section` through the adapter to
confirm it answers per solid.

## Verified kernel behaviour (probe notes)

Probed directly against `remus_wasm_node.cjs` at the pin; throwaway scripts
deleted.

- `section` does not mutate the solid: volume and face count are unchanged,
  and the returned faces are new arena handles outside the solid.
- The returned face normal is the (normalized) plane normal; a non-unit normal
  is accepted, a zero normal raises `cannot normalize zero vector`.
- `getFaceWires` returned the outer boundary first in every case observed —
  the adapter verifies it per section rather than trusting it.
- `makeCylinder`'s wall comes through a `cut` as 64 straight segments, so a
  bore sections to a 64-gon (12.546 mm² at r=2) rather than a circle. The DXF
  is written from those LINE edges, exactly as the kernel has them.
- A body can hold several solids, and `section` answers per solid. Two boxes
  exported to STEP through the adapter and re-imported as one body give one
  body with two disjoint solids; a plane through one of them returns that
  solid's region **and** a `plane-misses-body` refusal carrying the same body
  id. Anything that counts refusals as bodies is wrong about such a model.
- An L-shaped fuse of two boxes sections correctly (3200 mm² low, 640 mm²
  high). The demo Mounting Bracket, which adds a boss, a bore and fillets,
  returns **720.8013 mm² at every offset tried** while the witness moves with
  the plane — the defect the area check exists for, seen live in the app.

## Verifier rounds

### Round one

An independent verifier read the diff and ran the kernel against it. Four
defects; all four fixed, none disputed.

1. **[major] The section ignored local visibility.** `sectionOutline` was
   called with no body list, so the adapter fell back to the document's own
   visibility — and hide/isolate never reach the document (they are
   `useProjectView` state, and `getParameterHiddenBodyIds` is explicitly
   independent of them). A hidden body still had its cut surface and curves
   drawn, floating in an empty region, and its area still counted into the
   rail's total. The viewport's visible list is now passed to both
   `sectionOutline` and the section DXF export; changing what is visible
   drops the exact section back to the clipped preview, exactly as a rebuild
   already did. The adapter comment that called `sectionableBodyIds` "what
   the viewport is showing" — the origin of the mistake — now says what it
   computes. Covered by `test/exact-section-document.test.ts`
   ("sections only the bodies it is given", "draws only the bodies it is
   given"), the worker test, and `apps/web/src/lib/sectionOutline.test.ts`.
2. **[major] The DXF button was live when the export would throw.** It was
   gated on `kind === 'exact'`, which holds as soon as one body sections
   exactly; `exportSectionDxf` fails closed on any refusal but
   `plane-misses-body`. The documented multi-body state (a box exact, the
   demo bracket refused as `area-mismatch`) therefore offered an export that
   always failed and put the kernel's witness diagnostic on the status line.
   The state now separates `missed` (the plane passed a body by — ordinary,
   still exportable) from `unsectioned` (the plane cuts a body the kernel
   could not section — no drawing), and only the second shuts the button.
   The rail gives the reason in the same line as the area. Covered by
   `ViewerToolbar.test.tsx` and `sectionOutline.test.ts`.
3. **[minor] Wireframe hid the section curves as well as the fill**, and the
   test asserting otherwise checked `curve.visible`, an `Object3D` flag
   nothing writes, so it passed either way. Only the fill follows the display
   mode now; the assertion reads `curve.material.visible`. Re-running the new
   test against the old code fails, which is how the fix was confirmed.
4. **[minor] The e2e snapshot's per-region `curves` count was the group
   total.** Each section child now carries the index of the region it was
   built for, and the count moved into `exactSectionSnapshot` in the viewport
   package — where a unit test holds a one-loop body beside a bored one and
   asserts `[1, 2]` rather than `[3, 3]`.

The verifier's own summary of the rest — the tessellated witness, the typed
refusals, the DXF unit header — is unchanged by this round.

### Round two

The verifier confirmed all four round-one fixes independently and found that
**fix 1 above introduced a major defect of its own**, plus two minors. All
three are fixed; none disputed. The round-one write-up of fix 1 was accurate
about what it did and wrong about it being contained — that is corrected here
rather than defended.

1. **[major] The body list and the document came from different models.**
   Passing the viewport's visible list was right; taking the document from
   the workspace beside it was not. `previewDoc` replaces the live document
   in the viewport wholesale — `viewerBodies` is then ITS bodies — so with
   section view on, opening the Extrude form (`edgeFormPreview.publish`) or
   previewing an assistant proposal named bodies the live build never made.
   The adapter threw `Body <id> has no exact geometry.`, the catch turned it
   into a refusal, and the rail showed that internal string with **no section
   drawn at all**, not even for the bodies that sectioned perfectly.
   Reproduced against the real kernel before the fix
   (`sectionOutline(live, XY_AT_3, [realBar, 'body_preview_only'])` threw);
   the same call now returns the bar's region plus one `unknown-body`
   refusal, pinned by `test/exact-section-document.test.ts`.

   Fixed at the root, in two places that each remove a way to get it wrong:

   - **One source.** `SectionSource` carries the document *and* the bodies of
     it that are on screen. `App` builds it in a single memo whose document
     is `previewDoc ?? doc` — the same branch `viewerBodies` takes — and both
     `resolveSectionOutline` and `writeSectionDxf` take that one value
     instead of a document and a list as two arguments. There is no call site
     left that can pair them wrongly. An exact section of a preview is
     therefore a section of the preview, which is what the viewport shows.
   - **A typed refusal, not a throw.** `sectionOutline` refuses an unknown
     body by name and sections the rest, so no future mismatch can destroy a
     whole section again. It is deliberately NOT a `try/catch` around the
     call: the refusal is per body, carries a reason, counts as unsectioned,
     and therefore shuts the export. `exportSectionDxf` still throws for the
     same body, because a drawing may not quietly lose one.

2. **[minor] A section arriving while Wireframe was on drew its shaded fill.**
   `applyExactSection` built the cut surface's material on arrival with
   `visible` defaulting to true, and the display-mode effect depends on the
   mode alone, so it never re-ran for the new geometry. The regions now
   travel with the mode they are to be drawn for (`ExactSectionDisplay`),
   which makes the mode unskippable in the type exactly when there is a fill
   to build. The new test fails against the old code.

3. **[minor] `missed` and `unsectioned` counted solids and said "bodies".**
   The kernel answers per solid and one body can hold several. Reproduced
   with a real two-solid body (two boxes exported to STEP through the
   adapter and re-imported as one body): a plane through one solid returns a
   region **and** a `plane-misses-body` refusal carrying the same body id, so
   the rail read "…, 1 body is not cut here" while drawing that very body's
   cross-section. Both counts are now over distinct bodies, a body with a
   region is never "missed", and a body with both kinds of refusal counts
   once, as unsectioned — which keeps the export gate exactly equal to
   `exportSectionDxf`'s own fail-closed condition.

One thing moved while fixing these: `writeSectionDxf` now applies
`sectionOutlineExportable` itself instead of trusting the caller, so the gate
lives with the export rather than only on the button.

The invalidation effect also changed. It was keyed on `sectionSource`'s
identity for one iteration, which was wrong: committing derived state after a
geometry sync hands the workspace a **new document object at the same
version**, and an exact section requested moments earlier would have had its
answer dropped and never re-requested. It is keyed on what the source says —
the live version, the preview's identity, and body membership.

## Check results

Re-run from the worktree root after the verifier round:

```
pnpm lint               ✖ 19 problems (0 errors, 19 warnings)   [the pre-existing 19]
pnpm typecheck          clean, no output
pnpm test (root)        Test Files 245 passed | 2 skipped (247)
                        Tests 2524 passed | 4 skipped (2528)
pnpm test (web)         Test Files 158 passed (158)
                        Tests 1200 passed (1200)
pnpm test:parity-corpus Test Files 7 passed (7)
                        Tests 174 passed | 1 skipped (175)
pnpm build              passes; entry chunk 511,960 B against the 512,000 B budget
```

`node scripts/check-css-classes.mjs` passes (277 files, 816 classes), and
`pnpm build` (which CI's `validate` also runs) passes its bundle budget.
E2E and the desktop workflow were not run, per the briefing — see the risks
below, because one e2e spec was rewritten and could not be executed here.

## Driven in the real app

Run from this worktree (`vite` on 5210 — note that `preview_start` opens the
session's launch directory, which is a different worktree, and served stale
code until the server was started here):

- Demo Mounting Bracket, section on: "No exact section", the kernel's area
  disagreeing with the witness, DXF button disabled, the body keeping its
  approximate cap.
- A box added to the same document: the box's cut drawn in slate with its
  outline while the bracket kept its orange cap. The rail read "Exact
  section — 540.00 mm² of material, 1 body has no exact section" and the DXF
  button was **live**, which was the second defect: clicking it would have
  failed. That state now reads "…, 1 body has no exact section, so there is
  no drawing to export" with the button shut.
- Adding a feature (a rebuild) dropped straight back to "Clipping preview".

The DXF button was deliberately not clicked in the browser: it opens a file
save. That is why the always-failing button was not caught here, and the
export path is covered by adapter, worker and rail tests instead — including
the exact refusal/enablement combinations. **The verifier-round fixes were
not re-driven in a browser**: they are held by unit tests, and the two that
changed rendering (the wireframe pass, the snapshot count) were each shown
to fail against the old code first.

## Deliberate limits

- **The panel opens above its button** rather than beside it: at 800 px the
  status line reached across the viewport and under the model tree.
- **Canonical planes only.** The adapter takes an arbitrary origin and normal
  and is tested on an oblique one; the UI still offers only the XY/XZ/YZ
  section planes it offered before. Nothing here adds a section-plane picker.
- **No section view state is persisted.** The exact section is runtime-only,
  like the cutaway it belongs to. No document schema change, no new field.
- **One drawing per plane, no view layout.** The DXF carries the section
  curves of every cut body in one shared plane frame (drawing up is world +Z
  where the plane allows it, else +Y, so a plan keeps world X running right).
  It has no border, no title block, no hatching and no dimension — those
  belong to the drawings milestone proper, not to its first slice.
- **Bodies are sectioned separately, never fused first.** A union would change
  the geometry being measured, and the kernel refuses a disjoint cross-section
  anyway.
- **An exact section of a preview is a section of the preview.** With a form
  preview or an assistant proposal on screen the kernel rebuilds that
  document to section it, which is a full exact rebuild at the moment the
  plane comes to rest. It is not cached across previews, and each preview
  publish drops the section back to the clipped one. Cheaper would be to
  section only the changed body; correct came first.
- **Areas are the kernel's `faceArea` at the display deflection.** Good enough
  to grade a section and to show; not published as a measurement.

## Risks for the reviewer

- **`test/e2e/viewport.spec.ts`'s section spec was rewritten and NOT run.**
  It could not be: the old one asserted a display cap follows the slider, and
  that is no longer what a resting plane shows. It now asserts the new
  contract — cap while the plane moves, kernel curves once it rests, never
  both — reading a new `exactSections` field on the viewport's e2e
  render-policy snapshot. Reasoned through carefully, typechecked, but the
  first real run of it will be in CI. That snapshot's shape is unchanged by
  the verifier round; its `curves` field is simply correct now (per region
  rather than the group's total) and nothing in the spec asserts on it yet.
- **The entry chunk finishes at 511,960 bytes against a 512,000 budget:
  forty bytes.** The feature lives in `apps/web/src/lib/sectionOutline.ts`
  (lazy) and the launcher keeps only the state, the effect and two thin
  handlers. The first verifier round had to fit the visible-body plumbing
  into ten bytes of headroom and paid for it by deriving the viewport's
  section geometry inside `ViewerShell` (already lazy) instead of passing it
  from `App`, and by replacing the plane/version comparison with one request
  token. The second paid for the document half by folding one handler into
  the JSX callback that was its only caller and by moving the export gate
  into `writeSectionDxf`. Two forms that look equivalent are not: writing
  `await (await import('./lib/sectionOutline')).writeSectionDxf(…)` instead
  of binding the namespace to a const cost **62 bytes** here and pushed the
  chunk over the budget. Measure this file; do not reason about it. It is
  still the case that the next line of eager code in `App.tsx`
  — from this branch or any other — trips the gate. The budget's own comment
  asks for a real split rather than another raise; that split is now overdue,
  and this branch is not the place for it.
- **How often the kernel refuses.** On the demo Mounting Bracket every offset
  tried was refused as `area-mismatch` — correctly, but it means a user of a
  blended, unioned part may see "No exact section" more often than not. That
  is the pinned kernel's section being wrong, not the check being strict: the
  same body's area check passes on a plain box, a bored bar and a hollow
  block. If reviewers would rather show something, the honest lever is fixing
  `section` in Remus, not loosening the tolerance.
- **The tolerance is `deflection × perimeter` plus 1 µm².** It is a real bound
  on tessellation displacement, but it is generous for a long, thin section
  and tight for a coarse one. Worth a second opinion.
- **The graze test uses tessellation vertices** (min/max signed distance), so
  a plane within 1e-9 of the body's extent reads as "does not cut". That is
  the case the kernel answers with a whole face, so failing closed there is
  deliberate.
- **`sectionCaps.exact.test.ts` lives in the viewport package and imports the
  kernel adapter's source by relative path.** No production dependency is
  added — `three` only resolves from inside that package, and holding the two
  pipelines against each other is the point of the test — but it is a
  test-only reach across a package boundary and a reviewer may want it moved.
- **`writeDxf` now emits `$INSUNITS 4` and `$MEASUREMENT 1`.** That changes
  the existing single-face DXF export's header too (its test was updated
  deliberately). Both variables are post-R12 additions that R12 readers
  ignore; the alternative was shipping millimetre files that say nothing
  about their unit.
- **The `App` pairing itself has no unit test.** `SectionSource` is the type
  that holds the document and the bodies together, and the lazy module's
  tests hold the contract (including "asks about the document those bodies
  came from, never another one"), but nothing executes `App`'s own
  `previewDoc ?? doc` line — there is no App test harness in this repo. What
  IS pinned is that a mismatch can no longer be catastrophic: the adapter
  refuses the unknown body by name and sections the rest, proved against the
  real kernel. A reviewer who wants the pairing itself held should ask for
  the section controller to be extracted into a hook, which the entry-chunk
  budget currently makes expensive.
- **The verifier-round-two fixes were not driven in a browser either.** Each
  is held by a test that was shown to fail against the code before it.
- The exact section is attached to the viewport's body group in document
  coordinates. Bodies are drawn at identity there today; a future per-body
  transform in the viewport would need the same matrix applied here.

## Follow-ups

- A section that refuses could say which body refused and offer to nudge the
  plane; today it reports the first refusal's message, and a partial section
  reports only how many bodies were refused, not which.
- **Hiding or isolating a body drops the exact section back to the clipped
  preview** rather than re-cutting straight away. It is the fail-safe
  behaviour and matches what a rebuild does, but a re-request would be
  friendlier; it was kept out of this round because it changes the
  "a rebuild always shows the preview" rule the e2e spec was written to.
- **A body the plane cuts that the kernel cannot section blocks the whole
  DXF.** The alternative — exporting the rest and naming what was left out —
  is a real option, and a reviewer may prefer it. Fail-closed was chosen
  because a drawing silently missing a part's material is the worse failure.
- Hatching the cut surface, and a real drawing frame (border, title block,
  scale) — the rest of D03.
- Remus: `section` dropping a through-bore when the plane runs down its axis,
  and refusing any cross-section that falls into disjoint regions, are both
  worth issues upstream. Both are reproduced by the tests in
  `test/exact-section.test.ts`; if either is fixed, those tests fail loudly
  and should be updated rather than deleted.
- The exact section is computed for every body the viewport is showing, at
  once. A large assembly would benefit from sectioning only what the plane's
  bounding box can reach.
- **A preview could be re-sectioned as it settles** rather than only on the
  next slider release. The rule "anything that changes the model drops back
  to the clipped preview" is the fail-safe one and the e2e spec is written to
  it, so changing it is its own piece of work.
- Splitting the launcher chunk properly, so the next feature has room. The
  section work is already lazy; the remaining weight is not.

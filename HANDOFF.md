# Exact section curves behind the section view

Branch `claude/remus-exact-sections`. Four commits, no push, no PR.

## What shipped

The section view used to be one thing: three.js clipping plus the display
caps `sectionCaps` triangulates from the clipped tessellation. It is now two,
and the user is told which one is on screen.

- **While the plane moves** nothing changes. The clipped preview is what keeps
  the slider at pointer rate, and no kernel work is started during a drag.
- **When the plane comes to rest** — the slider is released, a key repeat
  ends, or the section view is switched on or cycled — the app asks the kernel
  for the real cross-section and draws that instead: the cut surface in a cool
  slate against the warm body colour, with its boundary curves showing. The
  rail reads "Exact section" and the cut's measured area.
- **Only that geometry can be exported.** A DXF button sits next to the
  slider, live only while an exact section is on screen, and writes the
  section curves as DXF R12 in millimetres.
- **When there is no exact answer** the rail says so in the kernel's own
  words, the export stays shut, and the body keeps its approximate cap rather
  than rendering as an open shell.

The two are never shown together on the same body, and an exact section never
outlives the plane position, the model version, or the drag that produced it.

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
`wire-order-unverified`.

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
- An L-shaped fuse of two boxes sections correctly (3200 mm² low, 640 mm²
  high). The demo Mounting Bracket, which adds a boss, a bore and fillets,
  returns **720.8013 mm² at every offset tried** while the witness moves with
  the plane — the defect the area check exists for, seen live in the app.

## Check results

```
pnpm lint               ✖ 19 problems (0 errors, 19 warnings)   [the pre-existing 19]
pnpm typecheck          clean, no output
pnpm test (root)        Test Files 245 passed | 2 skipped (247)
                        Tests 2520 passed | 4 skipped (2524)
pnpm test (web)         Test Files 157 passed (157)
                        Tests 1189 passed (1189)
pnpm test:parity-corpus Test Files 7 passed (7)
                        Tests 174 passed | 1 skipped (175)
```

`node scripts/check-css-classes.mjs` also passes (276 files, 816 classes).
E2E and the desktop workflow were not run, per the briefing.

## Deliberate limits

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
- **Areas are the kernel's `faceArea` at the display deflection.** Good enough
  to grade a section and to show; not published as a measurement.

## Risks for the reviewer

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
- The exact section is attached to the viewport's body group in document
  coordinates. Bodies are drawn at identity there today; a future per-body
  transform in the viewport would need the same matrix applied here.

## Follow-ups

- A section that refuses could say which body refused and offer to nudge the
  plane; today it reports the first refusal's message.
- Hatching the cut surface, and a real drawing frame (border, title block,
  scale) — the rest of D03.
- Remus: `section` dropping a through-bore when the plane runs down its axis,
  and refusing any cross-section that falls into disjoint regions, are both
  worth issues upstream. Both are reproduced by the tests in
  `test/exact-section.test.ts`; if either is fixed, those tests fail loudly
  and should be updated rather than deleted.
- The exact section is computed for every visible body at once. A large
  assembly would benefit from sectioning only what the plane's bounding box
  can reach.

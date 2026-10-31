# D06 auto-dimensioning: a complete, non-redundant dimension set

Status: design (2026-10-31). Owns [D06](../../ROADMAP.md#d06). Builds on the
D02 annotation contract in
[the drawing MVP design](drawing-mvp-design.md#implementation-decisions-d02-annotations-schema-v31);
nothing here is implemented yet.

## Goal

One request — the **Auto-dimension** button in Draw, or "dimension this" to
the assistant — places every dimension a machinist needs to make the part,
and no more. "Enough" and "not too much" are both checked by code, never left
to judgement:

- **Complete.** Every size and every location of every feature is stated.
- **Non-redundant.** No value is stated twice, and no value follows from
  others already stated (a closed chain, or a fillet tangent height that the
  radius already fixes).
- **True size only.** Each dimension sits in a view that sees it true size.
  D02 already refuses foreshortened and edge-on measurements; the generator
  never proposes one.

A language model cannot guarantee either property by looking at a sheet, so
the guarantee comes from a deterministic generator and checker. The
assistant sits on top: it chooses style and scope from the user's words and
explains the result, and its proposal is shown only once the checker passes.

## Worked example: a turned walking-stick foot

A user's part, exported from another CAD tool as STEP (11 faces, all
analytic, axis +Z, millimetres):

| Surface             | Geometry                                                 |
| ------------------- | -------------------------------------------------------- |
| Body                | cylinder Ø40, between its blends                         |
| Neck                | cylinder Ø33 up to the top face at z = 50                |
| Bore                | cylinder Ø25 from z = 50 down to a flat floor at z = 9   |
| Bottom and shoulder | 45° cones (4 × 45° chamfers of a Ø40 × 29 body)          |
| Blends              | three R4 tori: both chamfer–body edges, and chamfer–neck |
| Contact face        | flat circle Ø32 at z = 0                                 |

Its blend tangent heights are z = 5.657, 23.343 and 30.157 — exactly the
kind of value a purely geometric dimensioner picks up. A hand-placed drawing
of an earlier revision showed the same failure: about 17 dimensions, among
them 26.73, 6.29 and 2.07 (blend tangent heights fixed by the radii), 50 =
41 + 9 (a closed chain), Ø33 stated again as 25 + 2 × 4 in the section, the
same radius called three times, and a side view that repeated the front view
of an axisymmetric part only to carry those radii.

The complete, non-redundant set is eight dimensions, all round numbers:

1. Ø40 body
2. Ø33 neck
3. Ø25 bore
4. 50 overall height
5. 29 body height (to the virtual sharp of the shoulder chamfer)
6. 41 bore depth (or 9 floor thickness — one of them, never both)
7. 2× 4 × 45° chamfer
8. 3× R4

Ø32 is not dimensioned: it follows from Ø40 and the chamfer. This part is
the first acceptance fixture. The repository gets an equivalent part built
from in-app features plus the same body as a generated STEP, not the user's
file.

## Decisions taken

Defaults chosen 2026-10-31 from the planning discussion; each can be revisited
before its slice lands.

1. **The generator is deterministic and works without the assistant.** The
   Auto-dimension button runs offline with no assistant consent. The
   assistant adds intent on top of the same engine.
2. **Design intent first, geometry as fallback.** A part with history is
   dimensioned from its driving values: sketch dimensions, extrude and
   revolve extents, hole parameters, fillet and chamfer sizes. A history-less
   import is dimensioned from recognized features (the exact recognizer's
   holes, bosses and pockets, and the kernel-recognized fillet bands in
   `remus-feature-recognition.ts`), with chamfer–blend pairs dimensioned to
   their **virtual sharp**. Raw edge-to-edge geometry is the last resort and
   is labelled so.
3. **Baseline dimensioning from one datum per direction** by default (the
   lower-left of the front view, the bottom face for height). Chain
   dimensioning stacks error. Ordinate style comes later, as an assistant
   style request.
4. **Repeated features take one dimension with a count**: "4× Ø6", "3× R4".
5. **Each dimension goes in the view where its feature is clearest**: true
   size, visible rather than hidden, and the view with the most of that
   feature's other dimensions. The isometric view stays clean. An
   axisymmetric part is dimensioned on its profile — diameters marked Ø on
   the side or section view — and its end views get no repeated circles.
6. **Existing dimensions are kept** and count towards completeness. The
   generator adds only what is missing; a redundant user dimension is
   reported, never deleted.
7. **Nothing lands silently.** The result is a preview with Apply, and one
   undo step afterwards.
8. **The checker ships first**, as a "Check drawing" report, so every later
   slice is measured by it.

## Architecture

```
model + history ──► intent extraction ──► dimension scheme ──► view choice ──► placement
                                              │                                   │
                                              └──────────── checker ◄─────────────┘
assistant ──► style and scope ──► (same pipeline) ──► proposal only if checker passes
```

- **Intent extraction** yields a list of _requirements_: each feature's size
  parameters and its location relative to a datum, per model axis. A
  requirement knows which values it derives (a blend's tangent heights from
  its radius; a contact diameter from a chamfer).
- **Dimension scheme** chooses datums and turns each requirement into one
  candidate dimension, merging repeats into counted dimensions.
- **View choice** picks one view per dimension (decision 5) and the edges
  the D02 annotation will reference there.
- **Placement** stacks dimensions outside the view outline, shortest nearest
  the part, without crossing or overlapping text, inside the paper.
- **Checker** is the oracle: given a sheet and the model, it maps every
  annotation back to requirements and reports `missing` (a requirement with
  no dimension), `redundant` (a requirement dimensioned twice, a closed
  chain, or a derived value), and `unmeasurable` (needs a view the sheet
  lacks, such as a section for an internal feature).

All of it runs on the drawing worker beside projection, reads exact edges
and published circle data as D02 does, and stores nothing new beyond the
annotations themselves: values are still read from the model each time.

## Schema additions

Each needs its own schema bump, claimed from open PRs at the time
(`PROJECT_DOCUMENT_SCHEMA_VERSION`; main is v43 at the time of writing).

- **Count prefix** on radius, diameter and chamfer dimensions (`4×`).
- **Diameter on a linear dimension**: a Ø prefix for a span across a
  cylinder seen side-on.
- **Silhouette and virtual-sharp anchors.** A cylinder's sides in a side
  view are silhouettes, not model edges, and its rim circles are closed
  edges that a D02 linear dimension refuses (`closed-edge`). Today a turned
  part's height and side-view diameter cannot be dimensioned. Add an anchor
  for a circular edge's extreme along the measuring direction, and a
  virtual-sharp anchor at the intersection of two faces' underlying
  surfaces.
- **Chamfer dimension**: `size × angle`.
- **Reference dimensions** (shown in brackets), for a value a user wants
  visible although it is derived.
- **Provenance**: whether an annotation was generated, and from which
  requirement, so a rerun can update its own dimensions and leave the
  user's alone.

## Assistant integration

- New patch operations in `ai-contracts`: `add_drawing_annotations` and
  `remove_drawing_annotations`, scoped to one sheet. The current patch
  contract has model operations only.
- Context: the sheet's views and existing annotations, the requirement list,
  and the generator's candidate set. The assistant chooses among candidates
  and styles ("dimension from the bore centre", "skip the radii", "only the
  front view", "ordinate from the bottom face"); it does not invent edge
  references.
- Before the proposal is shown, every annotation must resolve and the
  checker must pass for the requested scope. A scoped request ("only the
  front view") reports what it leaves out rather than passing silently.
- The assistant must be reachable from Draw; confirm the panel's mount
  conditions there before this slice.

## Slice A decisions (dimension check, 2026-10-31)

- **Positions.** Along each model axis: planar faces square to it, and the
  axes of holes, bosses and turned surfaces across it. A cylinder tangent to
  an adjacent planar face is a blend, positioned by its radius alone; a span
  ending at its tangent or axis is reported as derived.
- **Bolt circles.** Three or more holes of one size equidistant from another
  turned axis are one bolt circle. Live testing on the Pipe Flange demo
  showed the alternative: per-hole X/Y positions doubled the requirement
  count (12 against 6). Its pitch diameter is reported as not dimensionable
  until slice B; the holes' clocking angle is not yet checked.
- **Not counted, never guessed.** Revolved blend radii, chamfers and tapers,
  sloped faces, angles, cross-body spans and circles that bound no hole or
  blend (a chamfer's edge) are listed as "can't dimension yet" or "not
  checked", never as satisfied.

## Slices

| Slice | Delivers                                                                                          | Acceptance                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A     | Checker and a "Check drawing" report listing missing, redundant and unmeasurable requirements     | Foot fixture: the earlier hand drawing's redundancies all reported; a hand-built eight-dimension sheet passes |
| B     | Schema: counts, Ø on linear, silhouette and virtual-sharp anchors, chamfer, reference, provenance | Turned-part height and side-view diameter dimensionable; reload byte-stable; older clients fenced             |
| C     | Deterministic Auto-dimension button with view choice and placement (in-app history parts)         | Corpus: zero missing, zero redundant; no overlaps; undo is one step                                           |
| D     | Recognized-feature intent for history-less imports, virtual sharps                                | Foot STEP yields the eight dimensions above                                                                   |
| E     | Assistant operations and style requests                                                           | Proposal shown only when the checker passes; fake-provider e2e                                                |
| F     | Section-aware placement once D03 lands                                                            | Bore depth and floor dimensioned on the section rather than on hidden lines                                   |

Until D03, an internal feature with no visible view is dimensioned on hidden
lines and the report says so.

## Evaluation corpus

Each fixture has a hand-written expected requirement set; CI asserts zero
missing and zero redundant, and that every placed dimension resolves:

- a plain box (three dimensions)
- the turned foot (eight)
- a plate with a 2 × 2 hole pattern (counted diameter, two baseline pairs)
- a bracket with fillets and a slot
- one history-less STEP import

## Out of scope

Tolerances and GD&T, thread and hole-depth callouts, surface finish,
ordinate style before slice E, and assemblies.

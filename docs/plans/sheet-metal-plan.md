# Sheet metal: flat blank, bends and flat pattern (M16)

Status: specification for [ROADMAP M16](../../ROADMAP.md#m16). Written
2026-11-15. Delivery status lives in the roadmap row and its evidence
fragments, not here.

## Goal

Help a user make a bent sheet-metal part for a laser/punch and a press brake:

1. Draw the 2D blank in a sketch.
2. Turn it into a sheet of a material and thickness.
3. Pick bend lines and set each bend's specification (angle, up/down,
   inside radius, K-factor, where the bend sits on the line, relief).
4. See the folded part, and export the flat pattern (DXF with bend lines on
   their own layers) and a bend table for the brake operator.

This is the _flat-first_ workflow (SOLIDWORKS Sketched Bend, Inventor Fold,
Fusion Bend). The drawn blank is the source of truth, so the flat pattern is
exact by construction and no general unfold algorithm is needed. The
_3D-first_ workflow (base flange, edge flanges, unfold of an arbitrary body),
hems with a zero radius, jogs, bend sequencing and press-brake collision
checks are out of scope for M16's first delivery and are listed under
[Later](#later).

## Terms and maths

Symbols: `T` thickness, `R` inside bend radius, `K` K-factor (neutral-axis
position as a fraction of `T` from the inside surface), `θ` bend angle in
radians (the angle the flange turns through: 90° makes an L).

| Quantity                                               | Formula                                |
| ------------------------------------------------------ | -------------------------------------- |
| Bend allowance (neutral-fibre arc length)              | `BA = θ · (R + K·T)`                   |
| Outside setback                                        | `OSSB = tan(θ/2) · (R + T)` (θ < 180°) |
| Inside setback                                         | `ISSB = tan(θ/2) · R`                  |
| Bend deduction                                         | `BD = 2·OSSB − BA`                     |
| Flat length of a part with outside flange lengths `Lᵢ` | `Σ Lᵢ − Σ BDⱼ`                         |

K-factor sources:

- **Value** (default 0.44, a common air-bending value at `R ≈ T`).
- **DIN 6935**: `K = ½ · (0.65 + ½·log₁₀(R/T))` for `R/T < 5`, else `0.5`,
  clamped to `[0.25, 0.5]`. This is an approximation; a shop's measured
  value always wins, which is why the value is editable per bend.

Every value here is a nominal shop rule of thumb. The UI labels them as
such; none are certifications.

## Document model

One new feature kind, `sheet-metal`, owning one new body. All bends live in
the feature as a table, in the blank's flat coordinates, so every bend line
is defined on the flat sheet and later bends never have to reference folded
geometry. (Separate per-bend features would need sketches on folded faces and
would break the flat pattern as the source of truth.)

```ts
featureKind: 'sheet-metal';
sketchId: SketchId;                 // the blank's sketch
profiles: SketchProfileReference[]; // cells fused into one connected blank
thickness: ParamValue;
thicknessSide?: 'positive' | 'negative'; // along the sketch normal; absent = positive
bendRadius: ParamValue;             // default inside radius, > 0
kFactor: ParamValue;                // default K, in (0, 1); used when method is 'value'
kFactorMethod?: 'value' | 'din-6935'; // absent = 'value'
relief?: SheetMetalRelief;          // default relief for every bend
materialPresetId?: string;          // advisory thresholds only
gaugeId?: string;                   // display only; thickness stays authoritative
fixedPoint?: [number, number];      // sketch-local point inside the fixed region
bends: SheetMetalBend[];            // may be empty: a flat sheet

interface SheetMetalBend {
  id: string;                       // stable; names the bend's faces
  line: { sketchId: SketchId; objectId: SketchObjectId }; // a line, coplanar with the blank
  angleDeg: ParamValue;             // (0, 180]
  direction: 'up' | 'down';         // up = toward +sketch normal
  position?: 'centerline' | 'fixed-side' | 'moving-side' | 'outside-mold-line';
  radius?: ParamValue;              // override of bendRadius
  kFactor?: ParamValue;             // override; forces method 'value' for this bend
  relief?: SheetMetalRelief;        // override
}

interface SheetMetalRelief {
  shape: 'rectangular' | 'obround' | 'none';
  width?: ParamValue;               // absent = T
  extension?: ParamValue;           // past the bend zone into the fixed side; absent = T
}
```

- A bend line may be a construction line or an ordinary line of the blank's
  sketch (an ordinary line splits the blank into cells, which `profiles`
  fuses back), or a line in another sketch on the same plane.
- `fixedPoint` absent means the region with the largest area stays fixed.
- Every `ParamValue` takes expressions, as on other features.
- Schema: the next free `PROJECT_DOCUMENT_SCHEMA_VERSION` (58 at the time of
  writing). Older clients must refuse: they have no builder for the kind and
  would drop the body.

## Flat layout of one bend

In the sketch frame, take the bend line's unit direction `d̂` and the in-plane
unit normal `n̂` pointing from the fixed side to the moving side (decided by
the region tree below). Let `n = 0` on the line. The bend zone is the strip
`n ∈ [s₀, s₀ + BA]`, limited along `d̂` to the line's segment, where:

| `position`             | `s₀`    | Meaning                                                                                       |
| ---------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `centerline` (default) | `−BA/2` | The line is the bend's centre line in the flat (what a shop marks).                           |
| `fixed-side`           | `−BA`   | The bend ends at the line; it sits on the fixed side.                                         |
| `moving-side`          | `0`     | The bend starts at the line; it sits on the moving side.                                      |
| `outside-mold-line`    | `−OSSB` | The outside corner (virtual sharp) of the fixed flange lies on the line. Refused at θ ≥ 179°. |

## Fold kinematics

The plate occupies `z ∈ [z₀, z₁]` in the sketch frame (`[0, T]` or `[−T, 0]`).

- **Up** (toward +z): the top surface `z₁` is the inside of the bend. Axis
  through `(n = s₀, z = z₁ + R)`, direction `â = n̂ × ẑ`, rotation `+θ`.
- **Down**: the bottom surface `z₀` is the inside. Axis through
  `(n = s₀, z = z₀ − R)`, the same `â`, rotation `−θ`.

A point of the zone at `n = s₀ + u` (`0 ≤ u ≤ BA`), depth `z`, along-line `t`
maps to angle `φ = θ·u/BA` at radius `r` from the axis (`r = z_axis − z` up,
`z − z_axis` down), so the neutral fibre (`r = R + K·T`) keeps its length.
Every point beyond the zone moves rigidly by
`M = Rot(axis, ±θ) · Translate(−BA·n̂)`, continuous with the zone at `u = BA`.

With several bends the regions form a tree rooted at the fixed region. Each
region's transform is its parent's transform times the bend's `M`, all bends
being defined in the flat frame. `up`/`down` refer to the blank's +z side
whichever region is fixed, so choosing another fixed region only moves the
whole part. `fixed-side`/`moving-side` follow the fixed region, as in other
CAD programs.

Fold preview (view only, never stored): at fold fraction `f ∈ (0, 1]`, keep
the flat zone width `BA` and turn by `f·θ`, which implies an effective radius
`R' = BA/(f·θ) − K·T`; `f = 0` shows the flat sheet.

## Exact build (kernel adapter)

Composed from existing Remus operations; no kernel change is required for
the first delivery.

1. `P = extrude(blank face, T)` in the sketch frame.
2. For each bend, the zone box `Zᵢ` (its strip × the plate's depth) and its
   relief boxes (below).
3. Flat sheet `F = P − ∪ reliefs`. This is the flat pattern.
4. Regions: the solids of `F − ∪ Zᵢ`. Zone pieces: the solids of `F ∩ Zᵢ`
   (read from `F`'s edge faces rather than intersected; see
   [As built](#as-built-slice-2)).
5. Checks, each a named refusal (`sheet-metal:<reason>`):
   - every zone piece is a full rectangular prism across the zone (no hole,
     notch or angled edge inside a bend zone): `bend-zone-not-clear`;
   - zones of different bends do not overlap: `bends-overlap`;
   - each zone piece touches exactly one region on each side, and nothing
     past the ends of its line: `bend-not-separating` (the flange is still
     attached beside the bend; extend the line or add relief). A zone with
     nothing beyond it on one side is `bend-line-outside`;
   - the bend graph is a tree (no closed loop of bends): `bend-loop`. One
     bend line may meet the same two regions more than once (a line across a
     window); that is one bend in several pieces, not a loop;
   - one connected blank, `R > 0`, `T > 0`, `0 < K < 1`, `0 < θ ≤ 180°`,
     a bend line that is a straight line coplanar with the blank and crosses
     it: `invalid-parameter`, `bend-line-missing`, `bend-line-not-coplanar`,
     `bend-line-outside`.
6. Each region is transformed by its region transform. Each zone piece's face
   on its parent side is revolved about the bend axis through `θ` (the axis
   lies in that face's plane, `R` away from it), then transformed by the
   parent's transform.
7. Refuse `folded-overlap` when transformed pieces that are not neighbours
   in the region tree intersect (flanges folded through each other, e.g. two
   outward 135° up bends on a 20 mm base with 30 mm flanges); the message
   names the two bends or regions. Neighbours share only their joining face.
8. Fuse the pieces pairwise in tree order, parent first (not `fuseAll`; see
   [As built](#as-built-slice-2)), check the result against the analytic
   volume, then place it from the sketch frame into the world.
9. Name every face: `sheet.face.top|bottom|edge…` for plate faces and
   `sheet.bend[<bendId>].inner|outer|side…` for bend faces, by role, never by
   output order (follow ADR-013 and the gear naming pattern). Name edges
   from their two faces as gears do. The names are listed under
   [Names](#names).

Reliefs: at each end `E` of a bend line, when the relief shape is not `none`,
cut a slot `d ∈ [E, E + width]` outward from the bend, `n` from `s₀ −
extension` to `s₀ + BA` (rectangular; obround rounds its fixed-side end with
a semicircle of diameter `width`, centred `extension − width/2` behind the
zone so the slot still reaches `extension`; with a shorter extension the
semicircle is centred on the zone's fixed edge). A slot outside the blank
changes nothing. With `none`, a zone that still touches material beside it
refuses as `bend-not-separating`.

Fallback: if the composed build is not robust on the pinned kernel (the
coincident-face fuses), add a native Remus `foldSheet` that builds the B-rep
directly (planar regions mapped rigidly, exact cylinders in the zones, no
booleans) with face roles, and switch the adapter to it behind the same
feature data.

### As built (slice 2)

`packages/kernel-adapter/src/exact-sheet-metal.ts` follows the steps above on
the pinned kernel (spiked on Remus 907ee07, suite re-run on 66dbbf1) with
these differences, each forced by what the exact kernel qualifies:

- **Pairwise fuse, not `fuseAll`.** Spiked on 58 folds (bend lines at 0°,
  17°, 31°, 90° and 213° in the sketch, angles 15° to 180°, up and down, U
  and Z channels, holes in regions, a tab with relief). `fuseAll` returned a
  valid-looking solid with an unmerged internal contact in 4 of them (a
  sketch-aligned line at 45° and 90°, up and down); `fuse` taken pairwise in
  tree order merged all 58 to one face-connected solid with the analytic
  volume to 1e-11. No native `foldSheet` was needed.
- **A checked result.** After the fuse the body must validate, be one
  face-connected component, and have the volume `Σ regions + Σ θ·T·(R +
T/2)·w`; otherwise it refuses `sheet-metal:fold-failed` (an added code, for
  a kernel operation that failed or a result that did not check; never for
  a user error).
- **Zone pieces without an intersection.** The exact `F ∩ Zᵢ` is declined
  whenever the zone meets a window or a hole. The pieces are read from `F`
  instead: every edge face of `F` that enters the zone's strip must be a
  plane square to the bend line that crosses the whole strip (a clean cross
  edge); the pieces are the stretches between cross edges that hold
  material. Because that scan samples curved faces, the rule is then proved
  by volume: `vol(F) = Σ vol(regions) + Σ BA·T·w` must hold, which fails for
  any hole, notch or angled edge in a zone.
- **Regions.** `booleanRegions('cut')` separates the regions; where it
  declines (a zone crossing a window) the plain cut is used and each
  face-connected lump is rebuilt from copies of its faces, with the lumps'
  volumes required to add up.
- **Zone boxes** reach 1 % of `T` past each end of the bend line (and past
  the plate in `z`), so a line that ends on the blank's edge never leaves a
  coplanar or sliver cut. Material found in that margin is what
  `bend-not-separating` reports.
- **Which side moves** is found first on centre-line zones without reliefs,
  because a zone's place (`fixed-side`, `moving-side`, `outside-mold-line`)
  and its relief depend on it; the build then lays the zones out for that
  answer, reads the sides again from the real layout, and retries once with
  them if they differ. The first pass refuses nothing: a fixed point that
  falls in a provisional zone takes the region on its own side of the bend
  line, and only the real layout decides whether the point is on a flat
  region.
- **Reliefs are cut by the exact kernel, each as one tool.** No slot is
  skipped by a guess: a slot off the sheet, or only touching it, comes back
  from the cut unchanged. An obround slot is one profile (three lines and
  two quarter arcs), because the exact boolean declines a cylinder cut after
  the box beside it. Where the tool that passes through the plate is
  declined (a slot that swallows a whole lug standing off the blank's edge),
  the same slot is cut flush with the plate's faces. A slot neither cuts
  refuses `sheet-metal:relief-failed` (an added code); a relief is never
  left out or replaced by another shape.
- **Sketch state.** The feature refuses, like an extrude, when its blank's
  sketch or a bend line's sketch has linked projections that failed to
  solve; the flat-pattern and fold-preview entry points apply the same guard
  and read the sketches as the build did (re-projected linked geometry).
- A bend line that crosses the sheet in two places folding opposite ways is
  refused (`invalid-parameter`): one line has one moving side.
- Lengths compare within `1e-8` of the blank's diagonal, volumes within
  `1e-7`.

### Names

`<region>` is `fixed` for the fixed region, otherwise the id of the bend that
carries it. A bend whose line crosses the sheet more than once counts its
pieces along the line from the line's first end: `<bendId>.<n>`.

| Name                                               | Face                                                                                                                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sheet.face.top[<region>]`, `sheet.face.bottom[…]` | A region's faces on the blank's `+normal` and `−normal` sides.                                                                                                                                           |
| `sheet.bend[<bend>].inner`, `.outer`               | The bend's two cylinders.                                                                                                                                                                                |
| `sheet.face.edge[<region>].<source>`               | A thickness face. `<source>` is the sketch curve it was drawn by (`<objectId>.<segment>`, as an extrude names its sides) or a relief wall (`relief[<bendId>].start\|end.near\|far\|front\|back\|round`). |
| `sheet.bend[<bend>].side.start`, `.side.end`       | A bend's end face at the line's first or second end, where no region's edge runs on through it.                                                                                                          |
| `sheet.edge.between.<face>\|<face>`                | An edge, from the two faces it lies between, as on gears. Several edges between one pair stay unnamed.                                                                                                   |

A blank edge square to a bend line stays one face through the fold (the
flange's edge, the bend's end and the next flange's edge are coplanar), named
for the region nearest the fixed one. A name two faces would share is given
to neither; a face on a spline edge has no name. Names depend only on the
sketch curves, the bend ids and which region is fixed, so they survive a
change of thickness, radius, angle or K-factor.

## Advisories (never refusals)

Shown like gear advisories; thresholds are rules of thumb and say so.

- Inside radius below the material's minimum (`minInsideRadiusOverT · T`).
- Flange shorter than the brake can hold: a region's extent perpendicular to
  a bend, measured from the outside mold line, below `0.7 · V` with
  `V = 8·T` (die opening).
- Hole or cut-out edge closer than `2·T` to a bend zone (slice 2 checks
  round holes and arcs; straight-sided cut-outs are not measured yet).
- Relief narrower than `T`.
- Material from a later feature that cuts or adds to the folded body is not
  in the flat pattern. This one is carried by the flat-pattern API
  (`changedBy`) rather than raised at rebuild: a feature's build may not
  depend on the features after it, which the history cache restores it
  without reading.

## Outputs

- **Flat pattern view**: an SVG of `F`'s top face with bend centre lines
  (dashed; up and down distinguished) and the bend table, from the body's
  context menu, the Inspector and Export.
- **DXF**: R12 as today, with layers: `0` the cut outline (unchanged for
  existing CAM setups), `BEND_UP`, `BEND_DOWN` (bend centre lines across the
  zone pieces' extent), `BEND_NOTES` (TEXT such as `UP 90° R1.5`).
- **Bend table**: number, direction, angle, inside radius, K, BA, BD, line
  length, as a table in the flat-pattern view, copyable as CSV, and on
  drawings when the drawing package can place a table.

### Adapter API (slice 2)

Both are methods of the exact kernel adapter, rebuilt from the document on
demand; neither stores anything.

`sheetMetalFlatPattern(document, featureId)` returns, in document units:

```ts
interface SheetMetalFlatPattern {
  featureId: FeatureId;
  thickness: number;
  // The blank's sketch frame: a 2D point (x, y) is origin + x·u + y·v.
  frame: { origin: Vec3; u: Vec3; v: Vec3; normal: Vec3 };
  // Closed loops of F's outline in sketch-local 2D, outer boundary first,
  // as the io-dxf entities the face-outline export writes (line, arc,
  // circle, polyline, ellipse, spline).
  loops: { outer: boolean; entities: DxfEntity[] }[];
  // One row per zone piece.
  bends: {
    bendId: string;
    piece: number; // index along the bend line
    segment: [[number, number], [number, number]]; // centre line, 2D
    direction: 'up' | 'down';
    angleDeg: number;
    insideRadius: number;
    kFactor: number;
    bendAllowance: number;
    bendDeduction: number | null; // null at 180°
    lineLength: number;
  }[];
  // Later features that cut or added to the folded body.
  changedBy: { featureId: FeatureId; name: string }[];
}
```

`sheetMetalFoldPreview(document, featureId, fraction)` builds the body at fold
fraction `f ∈ [0, 1]` with `sheetMetalFold`'s `fraction` (`0` is the flat
sheet `F`) and returns a world-space triangle mesh (`positions`, `normals`,
`indices`), its `volume` and `boundingBox`. It folds the feature alone: later
features are not applied, and folded-overlap is not checked while previewing.

## Interaction

- **Sheet metal** (Create group): pick one or more sketch cells (as Extrude),
  then thickness (drag handle and value), side, material and gauge presets,
  inside radius and K-factor under Options. Creates the feature with no bends.
- **Bend** (on a sheet-metal body; also reopens the feature from History):
  shows the sheet flat with candidate lines highlighted; a click adds a bend
  row with defaults (90°, up, centre line); the bend table panel edits each
  row (angle, up/down, position, radius and K overrides, relief, delete); a
  click on a region makes it the fixed one; a fold slider previews the fold;
  Apply commits one transaction.
- Feature summary: "1.5 mm, 3 bends"; with a material preset, its name
  follows the thickness ("1.5 mm mild steel, 3 bends").

## Presets

`packages/shared/src/sheet-metal.ts` ships:

- materials: mild steel (CRS), stainless 304, aluminium 5052-H32,
  aluminium 6061-T6, copper, brass, each with a nominal minimum inside radius
  ratio and a density preset link;
- gauges: US Manufacturers' Standard Gauge (steel), stainless and
  aluminium (Brown & Sharpe) tables, plus common metric thicknesses.

## Delivery slices

1. Spec, roadmap row, pure maths and presets (`sheet-metal.ts`), unit tests.
2. Schema, feature kind, validation, commands, expressions, replay, the
   exact build, flat-pattern extraction, names, refusals and advisories;
   headless tests against analytic values (an L bracket from a 96.5239 mm
   blank, `T = 2`, `R = 2`, `K = 0.44`, centre-line bend at 48.262 mm builds
   50 × 50 outside; the folded volume is `F`'s volume with each zone's flat
   volume `BA·T·w` replaced by its bent volume `θ·T·(R + T/2)·w`, which
   differ unless `K = 0.5`).
3. UI: the two tools, bend table, fold preview, History edit, summary, e2e.
4. Flat-pattern view, layered DXF, bend table (CSV and drawings).

## Later

- 3D-first sheet metal: base flange, edge flange, contour flange, and unfold
  of an arbitrary constant-thickness body (needs a kernel unfold).
- Bends across angled edges or holes in a zone (warped zone faces).
- Hems with zero radius, jogs, louvres, forming tools, corner closure.
- Bend sequencing and press-brake collision checks; tonnage estimate.
- Bend tables (K or BD by angle, radius and thickness) imported from a shop.

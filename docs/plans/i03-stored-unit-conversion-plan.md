# I03 stored-unit conversion plan

Status: design only (2026-11-22); owner decisions recorded in §9. No code, schema or command lands with this
document. Built on `main` at `6a93cc064` (schema v148).

Roadmap: [I03](../../ROADMAP.md#i03), product note I-4 in
[cad-feature-roadmap.md](../cad-feature-roadmap.md) ("explicit,
whole-document, once"; "no implicit reinterpretation of existing
dimensions"). Display units (#1915, schema v148,
[evidence](../roadmap-evidence/i03--display-units.md)) delivered the
non-destructive half. This plan covers the remaining half: one explicit
operation that rewrites the stored document from `units = A` to `units = B`.

## Recommendation (summary)

1. **Keep display units as the default answer.** Most "switch to inches"
   requests are already served by `displayUnits.set` with no risk to
   geometry or references. Present stored conversion as a separate,
   rarer action: "Convert stored units…", with a review step.
2. **Model the conversion as a pure document transform plus a kernel-verified
   reference map.** A replayable `units.convert` command takes
   `{ from, to, references }`. `references` is the old→new topology reference
   map, computed once at authoring time by rebuilding the converted document.
   This follows the ADR-021 "resolved once at creation" precedent, so replay
   stays pure.
3. **Run it the way ADR-022 runs a restore.** First write a safety checkpoint
   ("Before converting to inches"). Then apply the command through the
   command manager as one undoable step. Do not create a branch or copy by
   default; offer "Convert a copy" as a second button that reuses the
   duplicate endpoint.
4. **Expressions:** never reinterpret meaning. Leave unit-suffixed and
   dimension-bearing expressions as text. Rewrite each dimensionless
   expression that sits in a length field to `(E) * k`, written with an exact
   factor (§2). Scale plain numbers and round them to 15 significant digits.
5. **Fail closed.** Refuse the whole conversion, naming the offending
   features, when any of these holds:
   - a persisted reference cannot be re-captured one to one;
   - a length-class field cannot be classified;
   - the converted rebuild disagrees with the scaled original beyond
     tolerance.
6. **Prerequisite:** a machine-checked quantity registry (§1.4). The
   conversion is only as correct as the classification, so the registry
   ships first, on its own, and pays off immediately: it closes the
   display-units read-out gaps and finds registry bugs such as gear
   `outsideDiameter` (§1.3).

## 0. What the code already guarantees

- `ProjectDocument.units: UnitSystem` (`packages/shared/src/index.ts:5010`,
  `'mm' | 'cm' | 'm' | 'inch'` at :589). `UNIT_TO_MM` (:7295) and
  `millimetresPerUnit` (:7307) give 1 / 10 / 1000 / 25.4.
- `units` is already a `HISTORY_FIELDS` member
  (`packages/shared/src/document-history.ts`), and `save-state-diff.ts:269`
  already reports a `units` change between save states. Undo/redo and the
  save-state diff therefore understand a units change today. Nothing writes
  one yet.
- Exports scale from the document unit (`kernel-adapter/src/export-units.ts`
  `exportLengthScale`), so exports never need migrating.
- Imported STEP is re-read every rebuild. Remus normalizes it to mm, the
  checksum cache stays in mm, and the solids are scaled by
  `1 / millimetresPerUnit(document.units)` before lineage derivation
  (`kernel-adapter/src/exact-feature-builders.ts:634-646`). The comment there
  says outright that this "keeps a cached import correct across a document
  units change".
- `displayUnits` (v148) is display only. `setDisplayUnits` clears it when it
  equals `units` (`packages/document-core/src/display-units.ts`).

## 1. Inventory

Tags: **L** length, **A** area, **V** volume, **ANG** angle (degrees unless
noted), **CNT** count, **R** ratio/unitless, **POS** vector of lengths,
**DIR** unit vector, **HASH** geometry-derived hash or witness, **PAPER** fixed
paper-space mm, **AMB** ambiguous. Line numbers refer to `shared/src/index.ts`
unless another file is named.

Every scalar authored field is a `ParamValue = number | string` (:823). A
number holds a value in document units. A string holds an expression (§2).

### 1.1 Top level and parameters

| Field | Class | Conversion |
| --- | --- | --- |
| `units` (:5010), `ProjectNode.units` (:1264) | tag | set both to B |
| `displayUnits?` (:5085) | tag | see §5.4 |
| `printClearance?: ParamValue` (:5066) | L | scale / rewrite |
| `ParameterNode.expression` (:1290) | `quantity` (:1300): `length` → L, `angle` → ANG, `number` → R, **absent → AMB** | §2 |
| `ParameterNode.value` (:1291) | cache | recompute |
| `ConfigurationRow.parameters` (`configurations.ts`) | per parameter's `quantity` | rewrite every row, not only the active one |
| `ConfigurationRow.material` density | SI kg/m³ (`mass-density.ts`) | none |
| `derived: DerivedState` (:4936) | session cache | discard; rebuild |
| `shaprImports[].units`, `numericCandidates` | provenance; raw source numbers | none (record only) |

### 1.2 Features (`FeatureData`, :2539)

Length fields, which scale:

- **extrude:** `distance`, `backDistance`, `toFaceOffset`, `startOffset`.
- **sweep:** `cornerRadius`.
- **helical-sweep:** `radius`, `pitch`.
- **hole:** `diameter`, `depth`, `counterbore*`, `countersinkDiameter`,
  `position.u/v`, `tapped.length/clearance`.
- **gear:** `pitch` when sizing is module or circular-pitch; `faceWidth`,
  `offset`, `backlash`, `boreDiameter`, `rimDiameter`, `backDepth`,
  `wormLength`.
- **thread:** `majorDiameter`, `pitch`, `depth`, `crestWidth`, `clearance`,
  `length`, `offset`.
- **standard-part:** `length`.
- **sheet-metal:** `thickness`, `bendRadius`, relief `width`/`extension`,
  `bends[].radius` (`sheet-metal.ts:42-92`).
- **shell, solid-offset, thicken, rib:** thickness or distance.
- **wrap:** `depth`, `axialOffset`.
- **fillet:** `radius`, `endRadius`.
- **chamfer:** `distance`, `distance2`.
- **pattern:** `spacing`, `spacing2`.
- **primitive:** every `dimensions` key. All legal keys are lengths
  (`kernel-adapter/src/exact-carry-edit-gate.ts:95`).
- **datum plane:** `offset`; canonical `offset`.
- **transform:** `translation`, `pivot`.

Position vectors, which scale per component:

- `ParametricVector3` origins: gear, standard-part, helical axis.
- `datum-point.offset.offset`, `draft.neutralPoint`, `loft.endPoint`.
- mirror, split and pattern plane `origin`.
- datum point sources.

Unchanged:

- **ANG:** every `*Deg` field. Direct-edit `angleRadians` is radians.
- **CNT:** `teeth`, `count`, `starts`, `turns`, `sides`, `degree`, indices.
- **R:** `kFactor`, `endScale`, `transform.scale`, `profileShift`,
  `diameterFactor`, `addendum`, `dedendum`, `rootFillet`, `fraction`,
  `activeWhen`.
- **DIR:** `axis`, `normal`, `xDirection`, `direction`, `pullDirection`.
- Gear `pitch` with diametral-pitch sizing: teeth per inch in every unit
  system, already tagged `'number'` in `parameter-expressions.ts:228`.

Plain-number geometric fingerprints scale exactly. The rebuild compares them
and fails closed on a mismatch, so they must be scaled, never recomputed
loosely. They include direct-edit `source*` and `recorded*` lengths (L), the
centers and axis ends (POS), `sourceArea` (**A**, scale by k²), datum and face
sources (`sourceArea` A, `sourceCenter`/`sourceCentroid` POS, `frame.origin`
POS; :1362-1383), and sketch-region profiles (`samplePoint` POS, `sourceArea`
A; :2441). `regionFingerprint` and `profileId` are HASH (§3).

Imports:

- **imported-step:** `stepText`/`stepSourceRef` need nothing. The planar
  emboss `selection.depth` is L, `bounds` and `sourcePlacement.translation` are
  POS, and its hashes are HASH.
- **imported-mesh:** `vertices` (:3549) are POS already baked into document
  units. `meshPayloadRef` (:3561) is a content-addressed blob in document
  units with no unit field (`imported-mesh-payload.ts:50`). `assumedUnits`
  (:3570) is provenance. See §3.4.

### 1.3 Sketches, drawings, PMI, assembly, images

- **Sketch objects** (:2235-2342): every `x`/`y`/`center*`/`radius*`/`width`/
  `height` field, spline points and text `size` are L. Arc and ellipse angles
  are ANG. `sides` and `degree` are CNT.
- **Sketch node:** `planeRef` canonical `offset` and the legacy `offset` are
  L, frame origin is POS, `dimensionLabelPositions` are POS (:1952; document
  units, inferred).
- **Constraints** (:2000-2093): `distance.value`, `radius.value` and
  `lock.x`/`lock.y` are L. `angle.valueDeg` is ANG. Pattern `layout.spacing`
  is L and `layout.stepDeg` is ANG. `lock-entity.at: number[]` is **AMB by
  position**: L for every slot except the arc's two trailing angles.
- **Reference dimensions, composites, boundary provenance:** identity and
  counts only. Nothing to convert.
- **`SketchPromotion.sourceData`:** an inert legacy shape with L fields.
  Scale it for consistency.
- **Drawings:**
  - Paper space never changes: `centerMm`, `placementMm`, `widthMm`,
    `lineWidthsMm`, the paper sizes.
  - `DrawingScale` is a physical paper:model ratio. `drawingPaperPerModelUnit`
    multiplies by `millimetresPerUnit(units)`, so the ratio is unchanged and
    the printed sheet stays identical.
  - Model space scales: `DrawingDetail.center`/`radius` and section `depth`/
    `steps` (`drawings.ts:465-511`).
  - Tolerance values (`drawings.ts:228-232`, `:335`, `:713`) are **AMB**.
    They are fixed when the sheet sets `format.units`; otherwise they are
    document units. Recommended: pin `format.units = A` on every sheet that
    has none, so printed tolerances keep their meaning with zero arithmetic.
    That is one visible change, recorded in the review screen.
- **PMI** (`model-pmi.ts`): `anchor` is POS and the feature-control-frame
  `amount` is L.
- **Assembly** (`assembly.ts`): **AMB.**
  - The header says "lengths in millimetres" and `AssemblyDofUnit` is
    `'deg' | 'mm'`, but the UI reads slide values in `document.units`
    (`AssemblyDetails.tsx:165`, `assemblyUi.ts:94`; reported by the
    inventory pass, not re-verified).
  - Treat them as document units, which matches the kernel placement path
    (inferred). Then scale `placement.translation`, frame `origin`, the
    `'mm'`-DOF joint values, limits and positions, and the exploded
    `offsets`. Rotations, quaternions and times stay as they are.
  - `AssemblyCoupling.ratio` changes only across mixed DOFs: L→ANG
    multiplies by k and ANG→L by 1/k. `offset` follows the driven DOF.
  - **Decided (§9 Q3):** document units are authoritative; scale them.
- **Reference images** (`reference-images.ts:59-79`): plane `offset`,
  `center`, `width` L; the rest are ANG, R or CNT.
- **Outside `ProjectDocument`:** `ProjectComment.anchor.point` (POS),
  `WorkspaceResumeState.camera` (POS and `orthographicHalfHeight` L) and the
  per-user `AppSettings.linearSnap` (inferred to be in document units).
  Comments must be migrated by the same operation (server records). Camera
  state may be reset instead.

**Registry defect found while inventorying.** Gear `outsideDiameter` is
documented as a diameter (:3145, "the outside diameter beside the throat").
The kernel reads it as a length (`exact-gear.ts:535`), yet
`parameter-expressions.ts:256` tags it `'number'`. Display units and typed
parameter checks treat it wrong today. A small fix PR, independent of the
conversion.

### 1.4 Making classification machine-checked

`packages/document-core/src/parameter-expressions.ts` (`rewriteNodeExpressions`)
is already a per-kind field registry with an exhaustive `satisfies never`
over kinds. Its limits:

- it visits only `string` values;
- nothing forces every numeric key of a kind to appear;
- it does not cover top level, drawings, PMI, assembly or images.

Proposal: a **quantity registry** (`packages/shared/src/quantity-registry.ts`)
with three checks.

1. **Type level.** Per feature kind, declare
   `QuantityMap<FeatureDataOf<K>>`, a mapped type that requires an entry for
   every key whose type contains `number` or `ParamValue`, recursively
   through plain objects and arrays. Its values are `'length' | 'area' |
   'angle' | 'angle-rad' | 'number' | 'position' | 'direction' | 'hash' |
   'paper-mm' | Dynamic<fn>`. `Dynamic` covers the cases decided per
   instance: gear `pitch` by sizing, `lock-entity.at` by slot,
   `custom-feature.inputs` by the script's `ScriptInputQuantity`
   (`scripting/src/script.ts:50`), assembly DOF by `ASSEMBLY_JOINT_DOFS`, and
   drawing tolerances by `format.units`. Adding a numeric field without a
   classification then fails `pnpm typecheck`.
2. **Runtime coverage test.** Walk every numeric leaf of every fixture and
   parity document (`test/parity/scenarios.ts`, e2e fixtures) and assert
   that the registry classifies its JSON path. This catches `Record<string,
   …>` maps and unions that the mapped type cannot see.
3. **Single source.** Re-derive `rewriteNodeExpressions` from the registry,
   so rename, F05 suggestions, display units and conversion cannot drift
   apart. The CSS-class coverage test is the house precedent for "an entry
   that stops matching fails as stale".

## 2. Expressions

### 2.1 What the evaluator already does

`parseExpressionQuantity` (`document-core/src/index.ts:8519`) tracks
`{ value, length, angle }` exponents.

- Unit-suffixed literals (`5 mm`, `2 cm`, `3 in`, `1' 2"`) convert *into*
  `documentUnits` at evaluation (`applyUnitSuffix`, :8540).
- Typed parameters carry their dimension. Unitless parameters and bare
  literals are dimension 0.
- `+` and `-` require identical dimensions, `*` and `/` add exponents, and
  `^` needs a dimensionless exponent.
- `sqrt` halves even length powers.
- `floor`, `ceil` and `round` keep dimension.
- `sin`, `cos` and `tan` take degrees.

`evaluateFieldExpression` (:8880) then accepts a result that either matches
the field's dimension or is **dimension 0**. A bare number or unitless
parameter in a length field "is a document-unit value by definition".

**Kernel gap.** `resolveParamValue` (:6480) refuses a length suffix when
`documentUnits` is not passed. About 153 calls in `packages/kernel-adapter`
use it, and only about 29 pass units. `resolveParametricPoint`
(`exact-shape-utils.ts:74`) passes none, so a suffix in a vector field fails
to build today. That rules out any conversion strategy that *adds* unit
suffixes.

### 2.2 Options

| Option | Exact | Works on all resolvers | Readable | Verdict |
| --- | --- | --- | --- | --- |
| A. Append the source suffix to literals (`5` → `5 mm`) | yes | **no** (§2.1 gap) | good | rejected until every resolver gets units |
| B. Infer which literals are lengths and scale them | no (`width/2`: is the 2 a length?) | yes | good | rejected: guesses |
| C. Scale the parameter values and leave the text alone | no: `w + 5` keeps its `5` in the wrong unit | yes | best | rejected: reinterprets |
| **D. Wrap dimension-0 expressions in length fields** | yes | yes | acceptable | **recommended** |

**Option D rule.** For every expression field, evaluate it in the source
document, then:

1. **Dimension matches the field** (a length result from `5 mm`,
   `width + 2 mm`, or a typed-length parameter): leave the text unchanged.
   Suffixes convert by themselves, and typed parameters are converted at
   their own definition.
2. **Dimension 0 in a length field** (`10`, `20/2`, `w*2` with `w` unitless,
   `a*b`): write `(E) * N / D`. N/D is `millimetresPerUnit(A) /
   millimetresPerUnit(B)` written as two short decimals: mm→in is
   `(E) / 25.4`, in→mm `(E) * 25.4`, m→mm `(E) * 1000`. Unitless parameters
   are **not** touched, so they keep every count, ratio and angle use.
   `a*b` keeps its old meaning ("a number of millimetres") exactly.
3. **Pure numerals** (`"10"`) and numeric `ParamValue`s: replace with the
   scaled number, `Number((x * N / D).toPrecision(15))`. This is an
   approximation at about 1e-15 relative, below every kernel tolerance;
   property-test it (§6).
4. **Angle, number and null fields** (directions, `fraction`, `activeWhen`):
   unchanged.
5. **Round trip.** Converting back recognizes the exact wrapper it wrote,
   `(E) / 25.4` followed by `* 25.4`, and unwraps it to `E`. mm→in→mm
   therefore restores the expression text byte for byte, and wrappers never
   stack.

**Edge cases.**

- **Scale-variant functions.** `round(w)`, `floor(w)`, `ceil(w)` and `mod`
  over a dimension-0 length do not commute with scaling. D keeps them
  exact, because it evaluates the old expression and scales the result. B
  and C would silently change `round(10.4)` = 10 mm into `round(0.409)` = 0
  in.
- **Typed-length parameters inside them:** `round(width)` with a typed
  `width` (dimension 1). The parameter's *value* scales, so `round` now
  rounds in inches: 10.4 mm rounds to 10 mm, but 0.4094 in rounds to 0 in.
  This is a real reinterpretation. **Detect it** by comparing each field's
  converted evaluation with its scaled original (§6, step 1), and refuse
  conversion by default, listing the field. The owner can rewrite it as
  `round(width / 1 mm) * 1 mm` before converting. Same for `mod`,
  `require_one_of` and `^` with a non-integer result.
- **Area and volume.** No stored field has area dimension except the plain
  fingerprints (`sourceArea`, k²). An expression such as `a*b/c` that
  evaluates to length¹ is case 1. `sqrt(area)` is fine.
- **Trigonometry.** `w * sin(30)` is a length times a number: case 1 or 2 by
  the dimension of `w`. Angles never scale.
- **Guards** (`require_min(x, 3 mm)`): refused when `x` is a length. The
  floating-point comparison of `k·x` with `k·3 mm` need not decide as the
  original, so the guard can pass in one unit and throw in the other after
  a later edit. `require_min(x, 3)` with a dimension-0 `x` sits inside a
  wrapped expression, so it is unchanged and exact.
- **Discontinuities refuse structurally** (implementation, #1965 re-check).
  The value comparison only sees today's values. Any operation
  discontinuous in a length (rounding, `mod`, guards, `sign`, `atan2`'s
  branch cut) is refused whenever a length reaches it, and so is any field
  that does not scale (a count, angle, ratio, fraction or condition) whose
  value depends on a length, because the kernel rounds or compares it.
  Continuous equivariant operations (`+ - * /`, `abs`, `sqrt`, `min`,
  `max`, `avg`, `^` with an integer exponent) convert.
- **Typed-length parameter expressions** convert by the same rule, with the
  parameter as the "field". Their `value` is recomputed by re-evaluation.
- **Custom-feature scripts** (`script.source`): literals inside a script
  cannot be rewritten. Inputs are rewritten by their declared
  `ScriptInputQuantity`. Refuse conversion when a script is present until
  the scripting API exposes document units to scripts (decided, §9 Q5).

## 3. Persisted references

### 3.1 What breaks

ADR-013 witnesses (`EdgeWitnessV1`, `FaceWitnessV1`, :842-879) store
coordinates and lengths as integers on a "frozen `1e-6` document-unit
quantum" (ADR-013 §witness), and `currentHash` derives from them. The same
holds for:

- legacy `faceHash` / `edgeHashes` / `oppositeFaceHash`;
- `regionFingerprint` / `profileId` (`geometry/src/regions.ts:1812,1940`);
- drawing edge/face refs (`drawings.ts:83-97`) and `DrawingSheetSource.fingerprint`;
- PMI face refs.

### 3.2 Options

- **Migrate arithmetically** (multiply the integers by k and re-hash):
  rejected. The quantized values differ by ±1 quantum at cell boundaries,
  and the ADR comparisons are exact integers, so a fraction of references
  would break nondeterministically.
- **Invalidate** (drop witnesses and rely on lineage names): rejected. v5
  resolution rejects weak witnesses, so features would fail on the next
  rebuild. That is data loss presented as a migration.
- **Recompute by rebuild — recommended.**
  1. Build the source document (cold, no cache) and resolve every
     reference to a concrete entity.
  2. Build the converted document with references still pointing at the old
     identities, with resolution disabled so the converted rebuild only
     publishes lineage.
  3. Map each old entity to a new one by `lineageName` plus the old witness
     scaled by k, matched within 2 quanta, and require a unique match.
  4. Re-capture the witness and hash from the new build.
  5. Write the map into the command payload (§5.1).
  6. On any non-unique or missing match, refuse and name the feature.

  Legacy hash-only references (pre-v5) use the same path. Where no lineage
  name exists, match on the scaled fingerprint alone and require
  uniqueness.

### 3.3 Caches

- `derived` and the exact history cache (ADR-015) are keyed by content,
  which changes, so they miss naturally. Drop them explicitly anyway.
- The imported-STEP checksum cache is in mm and survives (§0).
- Display-mesh and sketch-geometry caches live in `derived`: rebuild them.
- `DrawingSheetSource.fingerprint` is recomputed by the next sheet refresh.

### 3.4 Imported meshes

The payload triangles are in document units and content-addressed.
Rewriting the bytes would mean a new blob, a new SHA and, for E2EE
projects, a re-encryption. **Recommended:** add an optional
`payloadUnits?: UnitSystem` to the imported-mesh feature (absent means
`units`, so the change is backward compatible). The kernel then scales on
load, as it already does for STEP. Conversion writes `payloadUnits = A` and
leaves the blob alone. `vertices` (inline, small) are scaled directly.

### 3.5 Kernel tolerances (§4 risk) also affect references

Witness quantization is 1e-6 *document units*: 1 nm in mm, 25.4 nm in
inches, 1 µm in metres. A metre document has coarser identity, so two faces
1 µm apart collapse. The scaled-witness match in §3.2 will report that as
non-unique and refuse, which is the correct outcome.

## 4. Kernel tolerances

Absolute tolerances in `packages/kernel-adapter` are plain numbers in model
(document) units:

- `GEOMETRY_EPSILON` 1e-9, `ANALYTIC_MATCH_EPSILON` 1e-7 and
  `DIRECT_EDIT_TOLERANCE` 1e-6 (`exact-math.ts:23-25`);
- `BLEND_TANGENCY_TOLERANCE` and `EDGE_CIRCLE_MISFIT_TOLERANCE` 1e-6
  (`exact-brep.ts`);
- `TOUCH_TOLERANCE`, `OFFSET_DISTANCE_TOLERANCE`, `planar-emboss` 1e-6;
- `KERNEL_EXTRUDE_RECOGNITION_TOLERANCE` 1e-5;
- extrude inference 1e-9 (`extrude-inference.ts:44-46`).

Some paths are already unit-aware:

- display tessellation is relative (`display-tessellation.ts`
  `DISPLAY_LINEAR_DEFLECTION_RATIO`);
- opening recognition scales its mm margins by the unit
  (`opening-recognition.ts:46`);
- mesh sewing is relative, with a ceiling (`exact-shape-utils.ts:436`).

The Remus kernel's own internal tolerances are not visible from this repo
(not verified).

Risks by target:

- **mm ↔ cm ↔ inch** (k between 0.039 and 25.4): absolute tolerances move by
  at most 25.4×, inside the bands H01 already exercises.
  - H01 originally pinned an inch-document bridge-union refusal at K07.
  - Its later evidence says the inch recipe is now qualified (2-inch growth,
    mm STEP replay), and `test/growing-holder-units.test.ts` holds no
    expected-refusal pin. I did not confirm whether any other inch pin
    remains in `test/parity/scenarios.ts`.
  - Treat inch as supported but verify per document (§6).
- **→ m** (k = 0.001 from mm): a 5 mm fillet becomes 0.005. `DIRECT_EDIT_TOLERANCE`
  1e-6 then means 1 µm and `GEOMETRY_EPSILON` 1e-9 means 1 nm. Small-feature
  parts (threads with 0.1 mm clearance, which becomes 1e-4) approach the
  boolean and tangency bands. **Decided (§9 Q1):** no conversion to or from
  `m` in I03. When relative tolerances land, revisit with §6 verification
  and a warning when the smallest authored length falls below 1e-3 in the
  target unit.
- **m → mm** (k = 1000): large models get large coordinates. That is fine
  for a double, but `MAX_REFERENCE_IMAGE_EXTENT` and the other caps "in
  document units" may refuse. Gather the caps into the registry and
  re-check them.

The longer-term fix (kernel tolerances relative to the model, or expressed
in mm) is K-row work outside I03.

## 5. History, revisions and schema

### 5.1 One command, recorded and replayable

- **Kind:** `units.convert`. Payload:
  `{ from, to, factor: [N, D], references: Record<path, TopologyReferenceV5 | number> }`.
  `factor` is redundant with the units but pins the arithmetic for future
  replays. `references` is the §3.2 map, keyed by registry path.
- **Replay:** `replayCommands` (`command-system/src/index.ts:6782`) applies
  a pure `convertDocumentUnits(document, payload)` in `document-core`. It
  needs no kernel, because the references are precomputed.
- **Authoring:** a worker task runs §3.2 and §6, then submits the command.
  On refusal no command is created.
- **Old commands in `commandLog`** keep their payloads in the units of their
  time. Replay is ordered, so a pre-conversion command applies to a
  pre-conversion document. Nothing is rewritten.
- **Payload size:** proportional to the reference count, not the document.
  This avoids ADR-022's objection to "a command carrying a whole document".

### 5.2 Undo (`editHistory`)

The command is one `DocumentHistoryEntry` holding value diffs of `units`,
`nodes`, `drawings`, `assembly`, `pmi`, `referenceImages`, `printClearance`,
`configurations` and `displayUnits`. A large document can exceed
`MAX_UNDO_BYTES` (8 MB). `bounded()` (`document-core/src/document-history.ts:180`)
then drops the oldest entries first, and conversion could make all earlier
undo unreachable. Mitigation: the safety checkpoint (§5.3) is the real
escape hatch. Undo of the conversion itself is still kept: it is the newest
entry and dropped last. Say so in the confirm dialog when the entry exceeds
the bound (measurable before applying).

### 5.3 Checkpoints, revisions and branches (ADR-022)

- Write the safety checkpoint "Before unit conversion (mm → in)" and persist
  it *before* applying, exactly as restore does.
- Then append a revision. `version` stays monotonic.
- Older checkpoints and revisions are snapshots in their own units, so
  restoring one restores its units, which is correct. The save-state diff
  already shows `units` changing (`save-state-diff.ts:269`).
- The diff should not list every scaled value as a geometry edit. Add one
  summary row instead: "Converted stored units mm → in (n values)".
- "Convert a copy" uses the existing duplicate endpoint, then runs the
  conversion on the copy. `branchedFrom` records the source.

### 5.4 Interaction with `displayUnits`

After `units := B`:

- if `displayUnits === B`, clear it (the normal form `setDisplayUnits`
  already enforces);
- otherwise keep it, so a document shown in cm keeps showing cm;
- a document that showed lengths in A without the field now gets
  `displayUnits = A`? **No.** The I-4 intent is "the document is now in B".
  Show B and let the owner switch display back (decided, §9 Q2).

`assertDisplayUnitsSchema` and the v148 guards stay as they are.

### 5.5 Schema version

Data changes that need a schema bump:

- `units.convert` command kind (content-schema gate as in
  `document-content-schema.ts:1030`);
- `imported-mesh.payloadUnits?`;
- optionally `format.units` pinning, which already exists, so no change.

Claim the next unclaimed number at implementation time, per CLAUDE.md
"Pull request lifecycle": check open PRs for `PROJECT_DOCUMENT_SCHEMA_VERSION`
bumps; main is at 148 today. Older schemas refuse the command (mirror
`assertDisplayUnitsSchema`). New tests read the constant.

Collaboration and cloud sync see one large edit. Conversion should require
the editor lock and refuse while other live editors are present (inferred
requirement; ADR-016/ADR-019 not re-read for this plan).

## 6. Verification

Inside the operation (blocking; it runs before the command exists):

1. **Field-level oracle.** For every registry-classified field, assert:
   - `eval_B(converted) ≈ eval_A(original) * k` for L;
   - `≈ * k²` for A;
   - `=` for ANG, R and CNT.
   Use relative 1e-12. This catches the `round(width)` class (§2.2).
2. **Geometry oracle.** Do a cold rebuild of both and compare per body:
   - bounding box scaled by k, within kernel tolerance;
   - volume scaled by k³ and area by k², relative 1e-6;
   - identical face, edge and solid counts;
   - identical exportable body set and warnings.
3. **References.** Every reference maps one to one (§3.2) and the converted
   rebuild resolves every one with zero repairs.

Tests:

- **Unit tests** (`test/units-convert.test.ts`): every row of the registry,
  each §2.2 edge case, numeral canonicalization, wrapper unwrap and refusals.
- **Round trip:** mm→in→mm and mm→cm→mm restore the expression text and
  numbers byte for byte. Witness hashes match the original after rebuild.
- **Property test over `test/parity/scenarios.ts`:** every scenario,
  converted to each of cm, m and inch, passes oracles 1–3. Add this as a
  parity-corpus spec (`test/parity/unit-conversion.spec.ts`; the `.spec.ts`
  suffix keeps it in the serial corpus job). Known kernel pins in a target
  unit are pinned per scenario, not skipped.
- **STEP corpus** (`test/parity/corpus/b-unit-*`): import, convert, then
  export. The exported STEP has unchanged physical size, and so do STL and
  3MF.
- **Registry coverage test** (§1.4) over all fixtures.
- **Browser:** one `@ci-smoke` e2e: convert, check the read-outs, undo,
  redo, reload, restore the safety checkpoint.

## 7. Delivery plan

Each phase is one small PR and independently useful.

| # | PR | Schema | Notes |
| --- | --- | --- | --- |
| 0 | Fix gear `outsideDiameter` registry tag (`'number'` → `'length'`) + regression test | no | done in #1935 |
| 1 | Quantity registry (§1.4): typed map, runtime coverage test, `rewriteNodeExpressions` derived from it | no | prerequisite; also lets display units cover the Inspector grids, drawings and the parameter table (open I03 read-out gaps) |
| 2 | `convertDocumentUnits` pure function + expression rule D + numeral canonicalization + field oracle; tests only, not wired | no | the heart; reviewable in isolation |
| 3 | `imported-mesh.payloadUnits` + kernel scale on load | **yes** (claim) | backward compatible; independent of 2 |
| 4 | Reference re-capture worker task (§3.2) + geometry oracle; parity property spec | no | kernel work; longest PR; may split edges/faces |
| 5 | `units.convert` command, content-schema gate, replay, safety checkpoint, save-state summary row, refusal messages | **yes** (claim) | wires 2 and 4 together |
| 6 | UI: File › Units › "Convert stored units…" review dialog (counts, wrapped expressions, refusals, undo-size warning, "Convert a copy"); e2e | no | UX copy needs owner review |
| 7 | Evidence fragment `docs/roadmap-evidence/i03--stored-conversion.md` | no | per ROADMAP rules |

Order: 0, then 1, then 2 ∥ 3, then 4, then 5, then 6. Phases 0–2 carry no
user-visible risk.

## 8. Risks

- **Misclassified field:** silent 25.4× error. Mitigated by the type-level
  registry plus the field and geometry oracles. This is the main risk;
  phase 1 exists for it.
- **Kernel non-determinism across scales** (topology ordering, boolean
  splits differing in inches): the reference mapping refuses rather than
  guesses. Expect some real documents to be refused. Measure the refusal
  rate on the parity corpus in phase 4 before committing to the UI.
- **m targets:** out of scope (§9 Q1); revisit after relative tolerances.
- **Wrapped expressions look odd** (`(w*2) / 25.4`). This is the honest
  form of "this used to mean millimetres". The review dialog lists them.
  A later "simplify" action may offer `w*2 * 1 mm` once all resolvers take
  units (option A).
- **Undo window loss on huge documents** (§5.2): mitigated by the
  checkpoint.
- **Comments and camera:** server-side comment anchors need the same
  scaling. A missed anchor only floats a pin; it is not data loss.

## 9. Owner decisions (2026-11-22)

1. **Targets:** mm, cm and inch only. Conversion to or from `m` is out of
   scope until the kernel tolerances are relative to the model (K-row
   work, §4); display units already cover reading in metres.
2. **Display after conversion:** show the new stored unit. A document whose
   `displayUnits` names a third unit keeps it; one equal to the new stored
   unit is cleared (§5.4).
3. **Assembly units:** document units are authoritative, as the UI and the
   kernel placement path already treat them. Assembly values scale with the
   rest of the document, and the `assembly.ts` header and the `'mm'` DOF
   name are corrected. Before phase 2, confirm that no older saved file
   stored assembly values in millimetres independently of `units`; if one
   did, stop and bring it back to the owner.
4. **`round(width)` and similar:** refuse the conversion and name the
   feature, so the owner edits the expression first (§2.2). No
   convert-with-warning path.
5. **Custom-feature scripts:** refuse conversion when a script is present.
   Exposing document units to scripts is a separate L15 change, not part
   of I03.
6. **Default action:** convert in place after a safety checkpoint, as one
   undoable step; "Convert a copy" stays as the second button.
7. **Drawing tolerances without `format.units`:** pin the sheet to the old
   unit so printed sheets stay identical; the review screen lists each
   pinned sheet.

## Not verified in code

- Remus-internal tolerances.
- Whether `parity/scenarios.ts` still pins any inch-only kernel refusal.
- Assembly unit semantics beyond the cited UI lines.
- Whether collaboration needs an explicit editor lock.
- Comment and camera storage paths beyond their shared types.
- The exact count of `resolveParamValue` call sites is from a grep
  (153 calls, 29 passing units). It is not an audit.

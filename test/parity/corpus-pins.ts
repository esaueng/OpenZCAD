/**
 * The pin list: every place BrepKit and OpenCascade currently disagree on the
 * parity corpus, and every place a kernel disagrees with a corpus file's own
 * arithmetic.
 *
 * This list is the most valuable thing the Z1.3 lane produces. It is the
 * working checklist the kernel lanes (K0.1 / K0.4 / K0.5 / K0.6) are measured
 * against, so every entry states four things and nothing vaguer:
 *
 *   1. WHICH file or scenario,
 *   2. WHICH metric,
 *   3. WHAT each side produces, as a literal value,
 *   4. WHICH plan item owns closing it.
 *
 * Pins are asserted in BOTH directions, exactly like `EXPECTED_MESH_DEFECTS`
 * in `scenarios.ts`:
 *
 *   - an unpinned divergence fails the corpus, so a new gap cannot appear
 *     quietly;
 *   - a pinned divergence that has been REPAIRED also fails the corpus, so a
 *     pin cannot outlive the defect it describes. Retire it and rerecord.
 *
 * A pin is not a suppression. There are no "known broken" labels here: a pin
 * that does not state the numbers is worse than no pin, because it converts a
 * measurement into a shrug.
 *
 * Scope note. A divergence in a GOVERNING metric (`status`, `roundTripStatus`)
 * subsumes its dependants, so `c-void-single-cavity` gets one `status` pin
 * rather than fourteen restatements of the same refusal. The suite enforces
 * that in both directions — a redundant pin fails too. Full per-metric detail
 * for every file and kernel lives in `baselines/corpus.json`.
 *
 * ---------------------------------------------------------------------------
 * Reading the list, as of the recording this file was written against
 * ---------------------------------------------------------------------------
 *
 * Four things stand between BrepKit and the STEP route flip (Z3), in rough
 * order of how much they cost:
 *
 *   1. SURFACE_CURVE. BrepKit cannot import ANY OpenCascade-authored STEP
 *      file — the smallest one in the corpus is a plain box
 *      (`f-hostile-occt-authored-box`, 6 planar faces) and it fails outright.
 *      OCCT writes SURFACE_CURVE + PCURVE pairs for every edge, and real-world
 *      STEP overwhelmingly comes from OCCT-based tools. K0.1's entity-widening
 *      step names TRIMMED_CURVE and POLYLINE but not SURFACE_CURVE; on this
 *      corpus SURFACE_CURVE is the single highest-value entity to add.
 *      It also breaks OpenZCAD's own multi-solid round trip today
 *      (`d-multi-two-boxes`), because the multi-solid export path routes
 *      through OCCT's writer.
 *   2. Units. `b-unit-inch-cube` reads 1 mm³ instead of 16387.064 mm³ — a
 *      factor of 25.4³. Not a tolerance question; the file states its own
 *      conversion factor.
 *   3. Voids. `BREP_WITH_VOIDS` is unreadable, and in a multi-solid file the
 *      voided solid is dropped SILENTLY rather than refused
 *      (`d-multi-solid-and-void`: 216 mm³ where the file says 7216 mm³).
 *   4. Validity. `f-hostile-open-shell` is a five-faced box that BrepKit
 *      imports as a solid of 666.67 mm³. Accepting a non-solid is worse than
 *      refusing a solid, and it is the one place in the corpus where BrepKit
 *      loses a validity check OCCT passes.
 *
 * Two findings cut the other way and are worth keeping visible, because the
 * plan's framing assumes OCCT is the oracle:
 *
 *   - BrepKit's REFUSALS are consistently better than OCCT's. On three hostile
 *     files OCCT either throws an opaque `[object WebAssembly.Exception]` or
 *     reports a generic "contains no solids", where BrepKit names the entity
 *     and the reason. K0.6 asks BrepKit's warning taxonomy to match OCCT's;
 *     on this corpus that would be a downgrade.
 *   - OCCT gets `boolean-on-nurbs-import` wrong by +1.38% while BrepKit is
 *     within 0.1% of the closed-form answer. The plan predicts BrepKit
 *     mesh-fallback for this class (K0.5); no mesh fallback occurs, and the
 *     kernel that misses is OpenCascade.
 *
 * Neither kernel publishes schema-v5 topology witnesses on imported bodies:
 * `witnessedFaces` and `lineageNames` are empty in every record on both sides.
 * K0.6's premise that OCCT already provides imported-body witnesses does not
 * hold at the import boundary — there is no OCCT behaviour to port, and the
 * feature has to be built. Face and edge HASHES exist on both, and they agree
 * for hand-authored planar bodies but NOT for the tessellated bracket sample
 * or for curved primitives, so stored picks on those bodies would not survive
 * the flip.
 */

/** Plan item that owns closing the gap; see `docs/kernel-execution-plan.md`. */
export type PinOwner =
  /** STEP import/export fidelity: units, voids, entity widening, AP214. */
  | 'K0.1'
  /** Multi-solid STEP export. */
  | 'K0.2'
  /** Blend phases: holed-cap corners, vertex blends, hole-rim fillets. */
  | 'K0.4'
  /** Boolean: analytic x NURBS SSI + torus pairs. */
  | 'K0.5'
  /** Import validation + lineage/witness parity. */
  | 'K0.6'
  /**
   * BrepKit's `volume()` integrates a tessellation at
   * `MEASUREMENT_DEFLECTION` (0.08); OCCT's `getVolume` is exact BRepGProp.
   * Shows up as a ~1e-5 relative gap on bodies with curved walls. Not owned by
   * a listed plan item: closing it needs an exact volume integrator in the
   * kernel, and until then no volume assertion on a curved body can be
   * tightened past ~1e-4.
   */
  | 'brepkit-measurement'
  /** An OpenCascade defect. Recorded, but nothing in the plan will fix it. */
  | 'OCCT-defect';

export interface KernelDeltaPin {
  /** Corpus file id, or import-modeling scenario key. */
  subject: string;
  /** Metric name from `comparableMetrics` in `corpus.spec.ts`. */
  metric: string;
  /** Literal value BrepKit produces today. */
  brepkit: string | number;
  /** Literal value OpenCascade produces today. */
  occt: string | number;
  owner: PinOwner;
  /** Why it diverges, and what closing it looks like. */
  note: string;
}

export interface ReferenceDeviationPin {
  /** Corpus file id, or import-modeling scenario key. */
  subject: string;
  kernel: 'brepkit' | 'occt';
  /**
   * Closed-form truth from the file's own construction, in mm³. Zero means
   * the file declares no importable solid at all.
   */
  referenceMm3: number;
  /** What the kernel reports instead — a volume, or how it failed. */
  reported: number | 'refused' | 'threw';
  owner: PinOwner;
  note: string;
}

const SURFACE_CURVE_NOTE =
  'BrepKit refuses every OpenCascade-authored STEP file: OCCT writes an edge ' +
  'as SURFACE_CURVE carrying PCURVE pairs on both adjacent faces, and ' +
  "BrepKit's reader has no case for it. This is not an exotic entity — it is " +
  'what the dominant STEP writer emits for every single edge. K0.1 step 3 ' +
  '(entity widening) must add SURFACE_CURVE; the step currently names only ' +
  'TRIMMED_CURVE and POLYLINE.';

const VOID_NOTE =
  'BREP_WITH_VOIDS is unreadable. reader.rs passes Vec::new() for inner ' +
  'shells, so a solid with a cavity resolves to nothing and the whole file ' +
  'reports "contains no solids". K0.1 step 2: accept BREP_WITH_VOIDS / ' +
  'ORIENTED_CLOSED_SHELL and build Solid::new(outer, inner_shells).';

const SEAM_NOTE =
  'Seam-edge representation differs on periodic surfaces. Both kernels close ' +
  'the UV parameterization, but they publish a different number of seam ' +
  'edges for the same body, so the edge hash set differs and a stored edge ' +
  'pick on a curved face would not resolve after the flip. K0.6 has to ' +
  'settle which representation the app sees before Z3, because feature ' +
  'references are stored against it.';

const MEASUREMENT_NOTE =
  "BrepKit's volume() integrates a tessellation at MEASUREMENT_DEFLECTION " +
  '(0.08) while OCCT uses exact BRepGProp, so any body with a curved wall ' +
  'reads slightly high. The closed-form answer is on OCCT\'s side here. This ' +
  'is a measurement gap, not a geometry gap: the B-rep is correct and the ' +
  'meshes agree.';

// ---------------------------------------------------------------------------
// BrepKit vs OpenCascade
// ---------------------------------------------------------------------------

export const KERNEL_DELTAS: KernelDeltaPin[] = [
  // --- (a) exports ---------------------------------------------------------
  {
    subject: 'a-sample-parametric-bracket',
    metric: 'faceHashDigest',
    brepkit: '61b71132',
    occt: '0482617b',
    owner: 'K0.6',
    note:
      'Same 821 faces, same 1722 edges, volumes agreeing to 1.5e-9 — and a ' +
      'different face hash set. ADR-011 makes fingerprints cross-kernel ' +
      'stable for analytic faces; this body is fully tessellated, so every ' +
      'face is a small plane and the fingerprints still diverge. Any feature ' +
      'referencing a face of an imported tessellated body breaks at the Z3 ' +
      'flip. Diagnose alongside edgeHashDigest below.'
  },
  {
    subject: 'a-sample-parametric-bracket',
    metric: 'edgeHashDigest',
    brepkit: 'fbf7718e',
    occt: '7262ee46',
    owner: 'K0.6',
    note:
      'Edge-hash counterpart of the face divergence above, same body and the ' +
      'same consequence: stored edge picks on an imported tessellated body ' +
      'do not survive the kernel flip. The counts match exactly (1722), so ' +
      'this is a hashing/ordering difference rather than a topology one.'
  },
  {
    subject: 'a-sample-simple-assembly',
    metric: 'warnings',
    brepkit: '["Feature \\"Imported\\": STEP file contains no solids."]',
    occt: '["Feature \\"Imported\\": importStep: [object WebAssembly.Exception]"]',
    owner: 'OCCT-defect',
    note:
      'BrepKit is BETTER here and the pin exists to keep that visible. The ' +
      'shipped sample is product metadata with no shape representation; ' +
      'BrepKit says so, OCCT lets a WASM exception escape and the user sees ' +
      '"[object WebAssembly.Exception]". K0.6 asks BrepKit to match OCCT\'s ' +
      'warning taxonomy — on this file that would be a downgrade, so match ' +
      'the intent, not the string.'
  },
  {
    subject: 'a-sample-simple-assembly',
    metric: 'inspect',
    brepkit: 'solid=false valid=false',
    occt: 'error: importStep: [object WebAssembly.Exception]',
    owner: 'OCCT-defect',
    note:
      'inspectStep is the pre-import probe the app shows before a user ' +
      'commits to an import. BrepKit answers it (not a solid, not valid); ' +
      'OCCT throws. Z1.1 flips inspectStep to BrepKit, which resolves this ' +
      'in OpenZCAD; the pin records that the flip is an improvement rather ' +
      'than a risk.'
  },
  {
    subject: 'a-export-cone',
    metric: 'edgeCount',
    brepkit: 2,
    occt: 3,
    owner: 'K0.6',
    note: SEAM_NOTE + ' On the cone the difference is one edge out of three.'
  },
  {
    subject: 'a-export-cone',
    metric: 'seamEdgeCount',
    brepkit: 1,
    occt: 2,
    owner: 'K0.6',
    note:
      SEAM_NOTE +
      ' Both of the cone\'s extra edges are seams, so the FEATURE edge count ' +
      'agrees (1 each) and only the seam bookkeeping differs — the cheapest ' +
      'instance of this class to debug.'
  },
  {
    subject: 'a-export-cone',
    metric: 'edgeHashDigest',
    brepkit: 'd02fc837',
    occt: '60672a43',
    owner: 'K0.6',
    note:
      'Follows from the seam-count difference above: a different edge set ' +
      'hashes differently. Recorded separately because a fix that unified ' +
      'the counts without unifying the hashes would still break stored picks.'
  },
  {
    subject: 'a-export-sphere',
    metric: 'edgeCount',
    brepkit: 32,
    occt: 36,
    owner: 'K0.6',
    note:
      SEAM_NOTE +
      ' The sphere is the extreme case: 32 edges vs 36 on a two-patch body ' +
      'with degenerate poles.'
  },
  {
    subject: 'a-export-sphere',
    metric: 'seamEdgeCount',
    brepkit: 32,
    occt: 4,
    owner: 'K0.6',
    note:
      'BrepKit classifies ALL 32 of the sphere\'s edges as seams; OCCT ' +
      'classifies 4 of its 36. displayRole drives what the viewport draws, so ' +
      'this is user-visible as well as reference-breaking: on BrepKit the ' +
      'sphere shows no feature edges at all. The largest single-metric ' +
      'divergence in the corpus.'
  },
  {
    subject: 'a-export-sphere',
    metric: 'faceHashDigest',
    brepkit: 'e0d01c9d',
    occt: '26977392',
    owner: 'K0.6',
    note:
      'Two SPHERICAL_SURFACE patches on both sides, same count, different ' +
      'fingerprints — so ADR-011 analytic-face parity does not currently ' +
      'extend to spheres. Worth checking whether the centre-of-mass ' +
      'fingerprint degenerates on a patch whose centroid sits off-surface.'
  },
  {
    subject: 'a-export-sphere',
    metric: 'edgeHashDigest',
    brepkit: 'ef3ea079',
    occt: 'a527c73e',
    owner: 'K0.6',
    note:
      'Edge-set counterpart of the sphere face divergence; follows from the ' +
      '32-vs-36 edge count. Retire together with the seam pins above.'
  },
  {
    subject: 'a-export-bored-plate',
    metric: 'volume',
    brepkit: 8814.767373332443,
    occt: 8814.601836602551,
    owner: 'brepkit-measurement',
    note:
      MEASUREMENT_NOTE +
      ' The file\'s closed-form volume is 8814.6018366 mm3 (40x24x10 minus a ' +
      'r5 bore); OCCT hits it to 1e-12, BrepKit reads 1.88e-5 relative high. ' +
      'One cylindrical wall is enough to produce it.'
  },

  // --- (b) units -----------------------------------------------------------
  {
    subject: 'b-unit-inch-cube',
    metric: 'volume',
    brepkit: 1,
    occt: 16387.064,
    owner: 'K0.1',
    note:
      'THE unit bug, in its smallest form. The file declares ' +
      "CONVERSION_BASED_UNIT('INCH') with an explicit 25.4 mm factor and a " +
      'GLOBAL_UNIT_ASSIGNED_CONTEXT binding it, then a 1x1x1 cube. BrepKit ' +
      'reads the coordinates as millimetres and reports 1 mm3 instead of ' +
      '16387.064 — a factor of 25.4^3. b-unit-mm-cube is the same physical ' +
      'cube written in millimetres and both kernels read IT correctly, so ' +
      'the difference isolates unit handling exactly. K0.1 step 1.'
  },
  {
    subject: 'b-unit-inch-cube',
    metric: 'faceHashDigest',
    brepkit: '36b44e76',
    occt: 'a08888a9',
    owner: 'K0.1',
    note:
      'Consequence of the unit bug rather than an independent defect: the ' +
      'two kernels build the cube at different scales, so their face ' +
      'fingerprints differ. Expected to retire in the same change as the ' +
      'volume pin above; if it does not, the fingerprint is scale-sensitive ' +
      'in a way that matters for K0.6.'
  },
  {
    subject: 'b-unit-inch-cube',
    metric: 'edgeHashDigest',
    brepkit: 'ddcce681',
    occt: 'fa5f4241',
    owner: 'K0.1',
    note:
      'Edge counterpart of the scale-driven fingerprint divergence above. ' +
      'Same cause, same expected retirement.'
  },
  {
    subject: 'b-unit-degree-cone',
    metric: 'edgeCount',
    brepkit: 2,
    occt: 3,
    owner: 'K0.6',
    note:
      SEAM_NOTE +
      ' Identical to a-export-cone: the degree rewrite does not affect ' +
      'topology, which is the point of carrying both files.'
  },
  {
    subject: 'b-unit-degree-cone',
    metric: 'seamEdgeCount',
    brepkit: 1,
    occt: 2,
    owner: 'K0.6',
    note:
      SEAM_NOTE +
      ' Same value as a-export-cone, confirming the seam divergence is a ' +
      'property of the cone and not of the unit declaration.'
  },
  {
    subject: 'b-unit-degree-cone',
    metric: 'edgeHashDigest',
    brepkit: 'd02fc837',
    occt: '60672a43',
    owner: 'K0.6',
    note:
      'Byte-identical digests to a-export-cone on both kernels, which proves ' +
      'the adapter\'s degree rewriter reproduces the radian file exactly. ' +
      'That is the evidence Z3 needs before deleting the rewriter: the ' +
      'kernel must reach these same two digests from the degree file on its ' +
      'own.'
  },
  {
    subject: 'b-unit-degree-cone-unassigned',
    metric: 'warnings',
    brepkit:
      '["Feature \\"Imported\\": parse error: CONICAL_SURFACE #37: parameter 45 out of range [0.0000000000000002220446049250313, 1.5707963267948966]"]',
    occt: '["Feature \\"Imported\\": STEP file contains no solids."]',
    owner: 'K0.1',
    note:
      'The one file that shows the RAW kernel behaviour with the adapter ' +
      'workaround provably inert: normalizeStepPlaneAnglesForKernel needs an ' +
      'assigned context to prove a scale, and this file has none, so BrepKit ' +
      'sees the literal 45. Its message is exactly right about what it saw. ' +
      'When K0.1 step 1 lands, BrepKit should IMPORT this file at ' +
      '1047.1975512 mm3 rather than improve the error — an unassigned ' +
      'CONVERSION_BASED_UNIT is still a declared unit. OCCT reads it as ' +
      'radians and produces a degenerate solid, then reports nothing usable.'
  },
  {
    subject: 'b-unit-degree-cone-unassigned',
    metric: 'inspect',
    brepkit:
      'error: parse error: CONICAL_SURFACE #37: parameter 45 out of range [0.0000000000000002220446049250313, 1.5707963267948966]',
    occt: 'solid=false valid=false',
    owner: 'K0.1',
    note:
      'inspectStep counterpart of the warning divergence above. BrepKit ' +
      'raises rather than answering, which is a worse SHAPE of answer even ' +
      'though the text is better — the app calls inspectStep to decide ' +
      'whether to offer the import at all. Give it a typed refusal, not a ' +
      'throw.'
  },

  // --- (c) voids -----------------------------------------------------------
  {
    subject: 'c-void-single-cavity',
    metric: 'status',
    brepkit: 'refused',
    occt: 'imported',
    owner: 'K0.1',
    note:
      VOID_NOTE +
      ' A 20 mm cube with one 10 mm cavity: OCCT reads 7000 mm3, round-trips ' +
      'it, and re-emits BREP_WITH_VOIDS. BrepKit refuses the file entirely.'
  },
  {
    subject: 'c-void-two-cavities',
    metric: 'status',
    brepkit: 'refused',
    occt: 'imported',
    owner: 'K0.1',
    note:
      VOID_NOTE +
      ' Two cavities rather than one, so a fix that only handles a single ' +
      'optional inner shell still fails here. OCCT reads 11272 mm3.'
  },

  // --- (d) multi-solid -----------------------------------------------------
  {
    subject: 'd-multi-two-boxes',
    metric: 'roundTripStatus',
    brepkit: 'reimport-refused',
    occt: 'ok',
    owner: 'K0.2',
    note:
      "OpenZCAD's own multi-solid round trip is broken on BrepKit TODAY. " +
      'BrepKit imports the two-solid file correctly (1216 mm3, 12 faces), ' +
      'but exporting it routes through combineStepSolids — an OCCT writer, ' +
      'because BrepKit has no multi-solid export binding — and the resulting ' +
      'file comes back "unsupported STEP entity: SURFACE_CURVE (curve #48)". ' +
      'So the two open items compound: K0.2 removes the OCCT writer from the ' +
      'path, K0.1 step 3 makes the file readable even if it stays. Either ' +
      'one alone fixes this pin, which makes it a useful early signal.'
  },
  {
    subject: 'd-multi-solid-and-void',
    metric: 'volume',
    brepkit: 216,
    occt: 7215.999999999999,
    owner: 'K0.1',
    note:
      'The worst failure mode in the corpus: SILENT DATA LOSS. The file has ' +
      'two solids — a 20 mm cube with a 10 mm cavity (7000 mm3) and a plain ' +
      '6 mm box (216 mm3). BrepKit cannot read the voided one, drops it, and ' +
      'imports the remaining box with NO WARNING. The user gets a body that ' +
      'is 3% of what they opened and nothing says so. Whatever else K0.1 ' +
      'step 2 does, an unreadable solid inside a multi-solid file must be ' +
      'reported, not skipped.'
  },
  {
    subject: 'd-multi-solid-and-void',
    metric: 'faceCount',
    brepkit: 6,
    occt: 18,
    owner: 'K0.1',
    note:
      'Twelve missing faces are the dropped voided solid (6 outer + 6 ' +
      'cavity). Recorded separately from volume so a partial fix — reading ' +
      'the outer shell but still dropping the cavity, which would give 12 — ' +
      'is distinguishable from a complete one.'
  },
  {
    subject: 'd-multi-solid-and-void',
    metric: 'edgeCount',
    brepkit: 12,
    occt: 36,
    owner: 'K0.1',
    note:
      'Edge counterpart of the dropped solid: 24 missing edges, 12 outer and ' +
      '12 cavity. Same partial-fix discrimination as the face count.'
  },
  {
    subject: 'd-multi-solid-and-void',
    metric: 'surfaceTypes',
    brepkit: 'plane x6',
    occt: 'plane x18',
    owner: 'K0.1',
    note:
      'All-planar on both sides, so the divergence is purely "how much of ' +
      'the file survived". Kept because a surface-type histogram is the ' +
      'cheapest way to see a mesh fallback appear, and this subject is where ' +
      'one would show up first if reading voids went via tessellation.'
  },
  {
    subject: 'd-multi-solid-and-void',
    metric: 'faceHashDigest',
    brepkit: '67b522bf',
    occt: '84534438',
    owner: 'K0.1',
    note:
      'Follows from the dropped solid — BrepKit hashes 6 faces where OCCT ' +
      'hashes 18. Should retire with the volume pin; if it survives a void ' +
      'fix, the fingerprints genuinely differ and it becomes a K0.6 item.'
  },
  {
    subject: 'd-multi-solid-and-void',
    metric: 'edgeHashDigest',
    brepkit: '0c0d856a',
    occt: '871da9f2',
    owner: 'K0.1',
    note:
      'Edge counterpart of the face-digest divergence above; same cause and ' +
      'same expected retirement.'
  },
  {
    subject: 'd-multi-solid-and-void',
    metric: 'roundTripSolidCount',
    brepkit: 1,
    occt: 2,
    owner: 'K0.1',
    note:
      'The data loss is durable: BrepKit re-exports one MANIFOLD_SOLID_BREP ' +
      'where the source file had two. Anyone who imports this file and saves ' +
      'has permanently lost the cavity solid.'
  },
  {
    subject: 'd-multi-solid-and-void',
    metric: 'roundTripVoids',
    brepkit: 'false',
    occt: 'true',
    owner: 'K0.1',
    note:
      "The writer half of K0.1 step 2. BrepKit's write_solid drops inner " +
      'shells even when it has them, so a cavity cannot survive an export ' +
      'either. OCCT re-emits BREP_WITH_VOIDS. This pin stays red until the ' +
      'WRITER is fixed, independently of the reader.'
  },

  // --- (e) NURBS -----------------------------------------------------------
  {
    subject: 'e-nurbs-fillet-plate',
    metric: 'volume',
    brepkit: 9534.97678436453,
    occt: 9499.999999999998,
    owner: 'K0.1',
    note:
      'Both kernels read the same B_SPLINE_SURFACE_WITH_KNOTS file and ' +
      'disagree by 0.37%, straddling the closed-form answer 9522.7433388: ' +
      'BrepKit is +0.13%, OCCT is -0.24%. Neither is a tessellation ' +
      'artefact at that magnitude. Something in NURBS surface evaluation or ' +
      'trimming differs, and since a-export-box / a-export-cylinder / ' +
      'a-export-cone all agree exactly, this file isolates it to the spline ' +
      'path. Both REFERENCE_DEVIATIONS entries below record the two sides ' +
      'against the arithmetic.'
  },
  {
    subject: 'e-analytic-fillet-plate',
    metric: 'status',
    brepkit: 'refused',
    occt: 'imported',
    owner: 'K0.1',
    note:
      SURFACE_CURVE_NOTE +
      ' Paired with e-nurbs-fillet-plate, which is the SAME nominal shape ' +
      'written by BrepKit: the geometry is importable, the encoding is not.'
  },

  // --- (f) hostile ---------------------------------------------------------
  {
    subject: 'f-hostile-occt-authored-box',
    metric: 'status',
    brepkit: 'refused',
    occt: 'imported',
    owner: 'K0.1',
    note:
      SURFACE_CURVE_NOTE +
      ' This is the smallest reproduction in the corpus — a 10x20x30 box, ' +
      'six planar faces, no curves anywhere — so it is the file to fix ' +
      'against. OCCT reads it as 6000 mm3.'
  },
  {
    subject: 'f-hostile-open-shell',
    metric: 'status',
    brepkit: 'imported',
    occt: 'refused',
    owner: 'K0.6',
    note:
      'BrepKit ACCEPTS a file that is not a solid. The shell is a 10 mm box ' +
      'with its z-max face removed from the CLOSED_SHELL member list — five ' +
      'faces, four edges used once — and BrepKit imports it as a body of ' +
      '666.67 mm3 (the divergence-theorem integral over the five faces it ' +
      'has) with NO warning. OCCT refuses. Accepting a non-solid is worse ' +
      'than refusing a solid: every downstream boolean, fillet and export ' +
      'then operates on an open shell. K0.6 must run a closed-shell check on ' +
      'import before Z3.'
  },
  {
    subject: 'f-hostile-dangling-reference',
    metric: 'warnings',
    brepkit: '["Feature \\"Imported\\": parse error: entity #999999 not found"]',
    occt: '["Feature \\"Imported\\": STEP file contains no solids."]',
    owner: 'OCCT-defect',
    note:
      'BrepKit is better again: it names the missing entity, OCCT reports ' +
      'the generic "contains no solids" and leaves the user to find a ' +
      'dangling reference by hand. Keep BrepKit\'s message when K0.6 aligns ' +
      'the taxonomy.'
  },
  {
    subject: 'f-hostile-dangling-reference',
    metric: 'inspect',
    brepkit: 'error: parse error: entity #999999 not found',
    occt: 'solid=false valid=false',
    owner: 'K0.6',
    note:
      'Same split as b-unit-degree-cone-unassigned: BrepKit has the better ' +
      'text but throws out of inspectStep instead of answering it. The app ' +
      'needs a value here, so K0.6 should return {solid:false, valid:false} ' +
      'and surface the parse error through the warning channel.'
  },
  {
    subject: 'f-hostile-no-shape-representation',
    metric: 'warnings',
    brepkit: '["Feature \\"Imported\\": STEP file contains no solids."]',
    occt: '["Feature \\"Imported\\": importStep: [object WebAssembly.Exception]"]',
    owner: 'OCCT-defect',
    note:
      'Minimal self-describing version of the a-sample-simple-assembly case: ' +
      'product structure and nothing else. OCCT lets a WASM exception ' +
      'escape; BrepKit answers. Recorded on both files because the sample is ' +
      'shipped and the minimal file is diagnosable.'
  },
  {
    subject: 'f-hostile-no-shape-representation',
    metric: 'inspect',
    brepkit: 'solid=false valid=false',
    occt: 'error: importStep: [object WebAssembly.Exception]',
    owner: 'OCCT-defect',
    note:
      'inspectStep counterpart. Z1.1 routes inspectStep to BrepKit, which ' +
      'removes this failure mode from the product; the pin keeps the ' +
      'evidence for that decision attached to a runnable file.'
  },

  // --- import-modeling scenarios ------------------------------------------
  {
    subject: 'fillet-on-import',
    metric: 'surfaceTypes',
    brepkit: 'bspline x4, plane x6',
    occt: 'cylinder x4, plane x6',
    owner: 'K0.4',
    note:
      'The headline blend delta, and NOT the one the plan predicts. K0.5 ' +
      'expects fillet-on-import to show mesh fallback; it does not — BrepKit ' +
      'produces an exact 10-face body with no warnings. What it does instead ' +
      'is fit the four corner bands as B-splines where the exact answer is a ' +
      'quarter cylinder. Face count and topology are right; the surface type ' +
      'is not, which costs 4.4 mm3 of volume (see the volume pin) and makes ' +
      'the result unrecognisable to any downstream analytic fast path. K0.4 ' +
      'phase 2 (walking-builder vertex blends) is the owner.'
  },
  {
    subject: 'fillet-on-import',
    metric: 'volume',
    brepkit: 9518.33214341142,
    occt: 9522.74333882308,
    owner: 'K0.4',
    note:
      'Quantifies the B-spline-vs-cylinder pin above: 4.63e-4 relative, and ' +
      'the closed-form answer 9522.7433388 is exactly what OCCT reports. The ' +
      'B-spline bands are slightly UNDER the true quarter cylinder. Retire ' +
      'together with the surfaceTypes pin; if the surface type is fixed and ' +
      'this stays, the residue is brepkit-measurement rather than K0.4.'
  },
  {
    subject: 'fillet-on-import',
    metric: 'faceHashDigest',
    brepkit: '35d76d2e',
    occt: 'b563a24b',
    owner: 'K0.4',
    note:
      'Different surface types produce different face fingerprints. Note ' +
      "that OCCT's digest here (b563a24b) is byte-identical to its digest " +
      'for e-analytic-fillet-plate — the imported OCCT-authored file of the ' +
      'same shape — which is a good sign for fingerprint stability once the ' +
      'surface types agree.'
  },
  {
    subject: 'fillet-on-import',
    metric: 'edgeHashDigest',
    brepkit: '9389207a',
    occt: '26f53b2e',
    owner: 'K0.4',
    note:
      'Edge counterpart of the fingerprint divergence; same cause. OCCT ' +
      'again matches its own e-analytic-fillet-plate digest (26f53b2e).'
  },
  {
    subject: 'fillet-on-import',
    metric: 'roundTripVolumeDelta',
    brepkit: 0.001748693017046106,
    occt: 7.831626128295643e-15,
    owner: 'K0.1',
    note:
      'A separate defect from the blend itself: BrepKit exports the filleted ' +
      'body and reads its own file back 0.175% heavier. OCCT round-trips to ' +
      '8e-15. So the B-spline WRITER and READER disagree with each other, ' +
      'not only with OCCT — which is why e-nurbs-fillet-plate reads high ' +
      'too. Fix the spline round trip before trusting any NURBS volume.'
  },
  {
    subject: 'boolean-with-import',
    metric: 'volume',
    brepkit: 8814.767373332443,
    occt: 8814.601836602551,
    owner: 'brepkit-measurement',
    note:
      MEASUREMENT_NOTE +
      ' Same body and same 1.88e-5 gap as a-export-bored-plate, reached by a ' +
      'boolean against an imported body rather than by importing the result. ' +
      'Both kernels produce 7 faces with one cylinder — no mesh fallback, ' +
      'contrary to what K0.5 predicts for this scenario.'
  },
  {
    subject: 'pattern-boolean-with-import',
    metric: 'volume',
    brepkit: 9011.200497119044,
    occt: 9010.951377451911,
    owner: 'brepkit-measurement',
    note:
      MEASUREMENT_NOTE +
      ' Three r2.5 bores cut in one multi-tool boolean; 2.76e-5 relative, ' +
      'scaling with the number of cylindrical walls exactly as a ' +
      'deflection-driven error should. Topology agrees completely.'
  },
  {
    subject: 'boolean-on-nurbs-import',
    metric: 'volume',
    brepkit: 9425.614677425621,
    occt: 9546.002960523074,
    owner: 'OCCT-defect',
    note:
      'The K0.5 scenario, and OpenCascade is the kernel that gets it wrong. ' +
      'An r4 bore is cut through a corner whose band arrived as a B-spline. ' +
      'The closed-form answer is 9416.3938 mm3; BrepKit reads +0.098%, OCCT ' +
      'reads +1.38%. OCCT returns MORE volume after a SUBTRACT than its own ' +
      'import of the same body (9500.0), which is not a tolerance question. ' +
      'Both produce 10 exact faces with no mesh fallback, so the K0.5 ' +
      'acceptance criterion "flip from mesh-fallback to exact" is already ' +
      'met for this class — the remaining work is accuracy, and the baseline ' +
      'to beat is BrepKit, not OCCT.'
  },
  {
    subject: 'boolean-on-nurbs-import',
    metric: 'faceHashDigest',
    brepkit: '3c489854',
    occt: 'c1cead63',
    owner: 'K0.5',
    note:
      'The two kernels reach 10 faces with the same surface-type histogram ' +
      'but different fingerprints, consistent with the 1.4% geometric ' +
      'divergence above. Expected to retire when the volume pin does; if it ' +
      'outlives the volume fix, the fingerprints are unstable across ' +
      'analytic-vs-NURBS boolean paths and it becomes K0.6.'
  },
  {
    subject: 'boolean-on-nurbs-import',
    metric: 'edgeHashDigest',
    brepkit: 'e140444b',
    occt: 'fea0548c',
    owner: 'K0.5',
    note:
      'Edge counterpart of the fingerprint divergence above; same cause and ' +
      'same expected retirement.'
  }
];

// ---------------------------------------------------------------------------
// Kernel vs the file's own arithmetic
//
// These say something the cross-kernel list cannot: which side is WRONG. Every
// referenceMm3 below is computed from the file's construction, not read from a
// kernel, so neither implementation gets a vote.
// ---------------------------------------------------------------------------

export const REFERENCE_DEVIATIONS: ReferenceDeviationPin[] = [
  {
    subject: 'a-export-bored-plate',
    kernel: 'brepkit',
    referenceMm3: 8814.601836602551,
    reported: 8814.767373332443,
    owner: 'brepkit-measurement',
    note:
      MEASUREMENT_NOTE +
      ' 1.88e-5 relative high on a body with one cylindrical bore wall. OCCT ' +
      'matches the arithmetic to 1e-12.'
  },
  {
    subject: 'b-unit-inch-cube',
    kernel: 'brepkit',
    referenceMm3: 16387.064,
    reported: 1,
    owner: 'K0.1',
    note:
      'The file states its own conversion factor (25.4 mm per INCH) and ' +
      'binds it through GLOBAL_UNIT_ASSIGNED_CONTEXT. Reading 1 mm3 is not a ' +
      'difference of opinion with OCCT, it is wrong by 25.4^3. K0.1 step 1.'
  },
  {
    subject: 'c-void-single-cavity',
    kernel: 'brepkit',
    referenceMm3: 7000,
    reported: 'refused',
    owner: 'K0.1',
    note:
      VOID_NOTE +
      ' The file is 20^3 minus 10^3 by construction; BrepKit reads no solid ' +
      'at all rather than reading 8000 and losing the cavity, so the reader ' +
      'fails closed. That is the right failure direction.'
  },
  {
    subject: 'c-void-two-cavities',
    kernel: 'brepkit',
    referenceMm3: 30 * 20 * 20 - 6 ** 3 - 8 ** 3,
    reported: 'refused',
    owner: 'K0.1',
    note:
      VOID_NOTE +
      ' Two cavities, so a single-inner-shell fix does not close this one. ' +
      'Fails closed like the single-cavity file.'
  },
  {
    subject: 'd-multi-solid-and-void',
    kernel: 'brepkit',
    referenceMm3: 20 ** 3 - 10 ** 3 + 6 ** 3,
    reported: 216,
    owner: 'K0.1',
    note:
      'Where the void reader fails OPEN instead of closed, and the ' +
      'difference matters. In a multi-solid file the unreadable solid is ' +
      'skipped silently and the import "succeeds" with 216 of 7216 mm3 and ' +
      'no warning. Whatever K0.1 step 2 does about reading voids, an ' +
      'unreadable solid must be reported.'
  },
  {
    subject: 'e-nurbs-fillet-plate',
    kernel: 'brepkit',
    referenceMm3: 40 * 24 * 10 - 4 * (1 - Math.PI / 4) * 9 * 10,
    reported: 9534.97678436453,
    owner: 'K0.1',
    note:
      'Reads its OWN B-spline export 0.13% heavy. Recorded against the ' +
      'arithmetic rather than against OCCT because both kernels miss here, ' +
      'in opposite directions — so a fix that merely agreed with OCCT would ' +
      'be aiming at the wrong number.'
  },
  {
    subject: 'e-nurbs-fillet-plate',
    kernel: 'occt',
    referenceMm3: 40 * 24 * 10 - 4 * (1 - Math.PI / 4) * 9 * 10,
    reported: 9499.999999999998,
    owner: 'OCCT-defect',
    note:
      'OCCT reads the same B-spline file 0.24% LIGHT, and lands on exactly ' +
      '9500.0, which is suspiciously round for a body whose exact volume is ' +
      '9522.7433. Recorded so nobody calibrates BrepKit against OCCT on this ' +
      'file: the arithmetic is the target, and OCCT misses it by twice as ' +
      'much as BrepKit does.'
  },
  {
    subject: 'e-analytic-fillet-plate',
    kernel: 'brepkit',
    referenceMm3: 40 * 24 * 10 - 4 * (1 - Math.PI / 4) * 9 * 10,
    reported: 'refused',
    owner: 'K0.1',
    note:
      SURFACE_CURVE_NOTE +
      ' Fails closed, which is correct behaviour for an entity it cannot ' +
      'read. OCCT reads the file to 9522.7433388, matching the arithmetic.'
  },
  {
    subject: 'f-hostile-occt-authored-box',
    kernel: 'brepkit',
    referenceMm3: 6000,
    reported: 'refused',
    owner: 'K0.1',
    note:
      SURFACE_CURVE_NOTE +
      ' A plain 10x20x30 box. Until this reads 6000 mm3, BrepKit cannot open ' +
      'files from the CAD tools most OpenZCAD users will export from, and Z3 ' +
      'cannot ship.'
  },
  {
    subject: 'f-hostile-open-shell',
    kernel: 'brepkit',
    referenceMm3: 0,
    reported: 666.6666666666666,
    owner: 'K0.6',
    note:
      'The file declares no closed solid — its z-max face is not a member of ' +
      'any CLOSED_SHELL. BrepKit reports a volume anyway: 666.67 mm3, the ' +
      'divergence integral over the five faces present. There is no reading ' +
      'of this file under which a volume exists, so this is a validity ' +
      'check missing on import, not a tolerance. K0.6.'
  },
  {
    subject: 'fillet-on-import',
    kernel: 'brepkit',
    referenceMm3: 40 * 24 * 10 - 4 * (1 - Math.PI / 4) * 9 * 10,
    reported: 9518.33214341142,
    owner: 'K0.4',
    note:
      'B-spline corner bands sit inside the true quarter cylinder, costing ' +
      '4.4 mm3 (4.63e-4 relative). OCCT reaches the arithmetic exactly, so ' +
      'this pin measures the blend, not the measurement.'
  },
  {
    subject: 'boolean-with-import',
    kernel: 'brepkit',
    referenceMm3: 40 * 24 * 10 - Math.PI * 25 * 10,
    reported: 8814.767373332443,
    owner: 'brepkit-measurement',
    note:
      MEASUREMENT_NOTE +
      ' Identical body and identical 1.88e-5 gap to a-export-bored-plate, ' +
      'confirming the residue is measurement rather than anything the ' +
      'boolean did.'
  },
  {
    subject: 'pattern-boolean-with-import',
    kernel: 'brepkit',
    referenceMm3: 40 * 24 * 10 - 3 * Math.PI * 2.5 * 2.5 * 10,
    reported: 9011.200497119044,
    owner: 'brepkit-measurement',
    note:
      MEASUREMENT_NOTE +
      ' Three bores rather than one, and the relative error grows from ' +
      '1.88e-5 to 2.76e-5 — proportional to cylindrical wall area, as a ' +
      'deflection-driven measurement error should be.'
  },
  {
    subject: 'boolean-on-nurbs-import',
    kernel: 'occt',
    referenceMm3:
      40 * 24 * 10 -
      4 * (1 - Math.PI / 4) * 9 * 10 -
      ((Math.PI * 16) / 4) * 10 +
      (1 - Math.PI / 4) * 9 * 10,
    reported: 9546.002960523074,
    owner: 'OCCT-defect',
    note:
      'OCCT misses the closed-form answer by +1.38% on a subtract that ' +
      'crosses a B-spline face — and returns more volume than it imported. ' +
      'BrepKit is inside 0.1% on the same scenario. The pin exists so this ' +
      'lane is not read as "OCCT is the reference": on the hardest boolean ' +
      'in the corpus it is the one that is wrong.'
  }
];

export function findKernelDelta(
  subject: string,
  metric: string
): KernelDeltaPin | undefined {
  return KERNEL_DELTAS.find(
    (pin) => pin.subject === subject && pin.metric === metric
  );
}

export function findReferenceDeviation(
  subject: string,
  kernel: 'brepkit' | 'occt'
): ReferenceDeviationPin | undefined {
  return REFERENCE_DEVIATIONS.find(
    (pin) => pin.subject === subject && pin.kernel === kernel
  );
}

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
 * subsumes its dependants, so `b-unit-no-global-context` gets one `status` pin
 * rather than nineteen restatements of the same refusal. The suite enforces
 * that in both directions — a redundant pin fails too. Full per-metric detail
 * for every file and kernel lives in `baselines/corpus.json`.
 *
 * ---------------------------------------------------------------------------
 * Reading the list, as of the recording this file was written against
 * ---------------------------------------------------------------------------
 *
 * The first recording of this corpus found four things standing between
 * BrepKit and the STEP route flip (Z3). **Three of them are now closed**, which
 * is what the list is for — this section is the record of what moved, not a
 * static description.
 *
 *   1. SURFACE_CURVE. CLOSED (K0.1). BrepKit could not read ANY
 *      OpenCascade-authored STEP file; `f-hostile-occt-authored-box`, a plain
 *      six-faced box, failed outright. It now reads 6000 mm3, and
 *      `e-analytic-fillet-plate` — the same nominal shape as
 *      `e-nurbs-fillet-plate`, written by OCCT — imports too. What is left on
 *      those two files is accuracy and edge identity, pinned below.
 *   2. Units. CLOSED (K0.1). `b-unit-inch-cube` read 1 mm3 instead of
 *      16387.064; it now reads the file's own declared conversion. The same
 *      change made BrepKit REFUSE `b-unit-no-global-context`, a file that
 *      declares units and never binds them — see that pin, which is the one
 *      new divergence the unit work introduced.
 *   3. Voids. CLOSED (K0.1/K0.2). `BREP_WITH_VOIDS` reads and round-trips, and
 *      `d-multi-solid-and-void` no longer drops its voided solid silently:
 *      7216 mm3 on both kernels, re-exported as two solids with the cavity
 *      intact.
 *   4. Validity. CLOSED (K0.6). `f-hostile-open-shell` — a five-faced box that
 *      BrepKit imported as a solid of 666.67 mm3 — is now refused, and refused
 *      with a message that names the defect and counts the boundary edges.
 *      Both kernels refuse it; only the wording differs, which is the one pin
 *      left on that file and BrepKit is the better side of it.
 *   5. Blend surfaces. CLOSED (K0.4). `fillet-on-import` fitted its four
 *      corner bands as B-splines just inside the true quarter cylinder. They
 *      are exact cylinders now, so THREE pins retire together: `surfaceTypes`
 *      (both kernels read `cylinder x4, plane x6`), `faceHashDigest` (both
 *      reach b563a24b, which is also what OCCT reads for the same shape
 *      imported as `e-analytic-fillet-plate` — the fingerprint stability that
 *      pin predicted), and `roundTripVolumeDelta` (BrepKit read its own
 *      filleted export back 0.175% heavy; it now round-trips to 0, because an
 *      analytic cylinder survives the writer where a spline did not). The
 *      volume and edge-hash pins survive with new values and new owners; see
 *      their notes. K0.4 no longer owns anything in this list.
 *
 *      Not everything the blend work landed is right, and the corpus does not
 *      cover the part that is not: a fillet over a subset of the edges meeting
 *      at a corner builds a B-spline vertex patch that removes far more
 *      material than a rolling ball can (+147% on one corner chain, +259% over
 *      a four-edge perimeter) and tessellates with inconsistent winding. Both
 *      are held failing in `test/exact-kernel-adapter.test.ts`. Fillets where
 *      EVERY edge at a vertex is selected come back as exact spheres and hit
 *      the closed form, which is why this corpus — whose blend scenario
 *      selects four parallel vertical edges — sees none of it.
 *
 * What remains, in rough order of how much it costs:
 *
 *   1. **Seam representation.** The largest surviving class. The two kernels
 *      publish a different number of seam edges for the same periodic body
 *      (cone: 1 vs 2 of 2-vs-3 edges; sphere: 32 of 32 vs 4 of 36), so the
 *      edge hash set differs and a stored edge pick on a curved face would not
 *      resolve after the flip. Now visible in three metrics rather than one:
 *      the edge counts, the edge hash digest, and the imported-body lineage
 *      names those hashes generate.
 *
 *      **Z3 landed without settling this**, deliberately, because measuring
 *      it changed what it was. BrepKit's edge set is a strict SUBSET of
 *      OCCT's on both bodies, so a stored pick either resolves unchanged or
 *      has no counterpart at all — it can never land on a different edge.
 *      The no-counterpart case fails closed by name ('A selected edge no
 *      longer exists.'), the imported body still builds at its correct size,
 *      and `test/kernel-seam.test.ts` pins that. The cost is therefore a
 *      re-select on seam picks, not a silently wrong body, which is a cost
 *      the flip could carry. K0.6 still owns closing it.
 *   2. **Sphere face identity.** BrepKit's two spherical patches share one
 *      exact witness, so neither can be named one-to-one and the body publishes
 *      NO face references at all (`witnessedFaces` 0 vs OCCT's 2). This is the
 *      identity scheme failing closed exactly as designed — but it means a face
 *      pick on an imported sphere cannot be stored on BrepKit, which is a
 *      product limit, not a formality. Since Z3 it is a LIVE product limit
 *      rather than a corpus observation: BrepKit is the only kernel building
 *      these documents, so face picks on imported spheres are unavailable in
 *      the app today. Highest-value K0.6 item for that reason.
 *   3. **Tessellated-body identity.** `a-sample-parametric-bracket` has 821
 *      faces and 1722 edges agreeing exactly in count and to 1.5e-9 in volume,
 *      and a different hash DIGEST on each kernel. Measured element-wise
 *      during Z3 the overlap is large: 739 of 821 faces and 1646 of 1722 edges
 *      carry the same hash on both kernels. So a stored pick on an imported
 *      tessellated body usually survives the flip, and where it does not it
 *      fails closed by name — see `test/kernel-seam.test.ts`, "keeps most
 *      identities on an imported tessellated body across kernels" and "fails
 *      closed on a pick stored against the other kernel's topology". The
 *      digest still differs and the pin stands; what changed is the claim
 *      about consequence.
 *   4. **Volume measurement.** BrepKit's `volume()` integrates a tessellation;
 *      OCCT's is exact. Shows up as ~1e-5 relative on every body with a curved
 *      wall, now including `e-analytic-fillet-plate`, which BrepKit could not
 *      read at all before.
 *
 * Three findings cut the other way and are worth keeping visible, because the
 * plan's framing assumes OCCT is the oracle:
 *
 *   - BrepKit's REFUSALS are consistently better than OCCT's. On the hostile
 *     files OCCT either throws an opaque `[object WebAssembly.Exception]` or
 *     reports a generic "contains no solids", where BrepKit names the entity,
 *     the missing unit, or the open shell and its boundary-edge count. K0.6
 *     asks BrepKit's warning taxonomy to match OCCT's; on this corpus that
 *     would be a downgrade, so it matched the intent and kept the text.
 *   - BrepKit publishes MORE imported-body face references than OCCT on
 *     `e-nurbs-fillet-plate` (10 vs 6), because ADR-013 conservatively treats
 *     every OCCT B-spline face as closed — the OCCT bridge cannot report
 *     periodicity, and BrepKit's can. The guard is identical; only the
 *     evidence available to it differs.
 *   - OCCT gets `boolean-on-nurbs-import` wrong by +1.38% while BrepKit is
 *     within 0.1% of the closed-form answer. The plan predicts BrepKit
 *     mesh-fallback for this class (K0.5); no mesh fallback occurs, and the
 *     kernel that misses is OpenCascade.
 *
 * The original recording also found that NEITHER kernel published schema-v5
 * topology witnesses on imported bodies, so K0.6's premise that OCCT already
 * provided them did not hold and the feature had to be built. It now exists on
 * both adapters under one shared rule, which is why `witnessedFaces`,
 * `witnessedEdges` and `lineageNames` carry pins at all: they went from
 * uniformly zero — where nothing could diverge — to a live measurement of
 * whether a stored pick survives the kernel flip.
 */

/** Plan item that owns closing the gap; see `docs/kernel-execution-plan.md`. */
export type PinOwner =
  /** STEP import/export fidelity: units, voids, entity widening, AP214. */
  | 'K0.1'
  /** Multi-solid STEP export. */
  | 'K0.2'
  /**
   * Blend phases: holed-cap corners, vertex blends, hole-rim fillets. Landed,
   * and no pin is owned by it any more — kept because the notes on the pins it
   * used to own refer to it, and deleting the name would make them unreadable.
   */
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

const SEAM_NOTE =
  'Seam-edge representation differs on periodic surfaces. Both kernels close ' +
  'the UV parameterization, but they publish a different number of seam ' +
  'edges for the same body, so the edge hash set differs and a stored edge ' +
  'pick on a curved face would not resolve after the flip. K0.6 has to ' +
  'settle which representation the app sees before Z3, because feature ' +
  'references are stored against it.';

const IMPORT_NAME_NOTE =
  'An imported body names every face and edge by its own exact ADR-011 ' +
  'fingerprint (K0.6, see the ADR-013 amendment), because an import has no ' +
  'feature contract to name its topology from. So a divergence here is the ' +
  'name-set restatement of a hash divergence on the same body: it carries no ' +
  'independent diagnosis, and it retires when the hashes agree. It is pinned ' +
  'separately because it is the metric that says what BREAKS — these are the ' +
  'identities a saved selection is stored against.';

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
      'different face hash DIGEST. ADR-011 makes fingerprints cross-kernel ' +
      'stable for analytic faces; this body is fully tessellated, so every ' +
      'face is a small plane, and 82 of the 821 still fingerprint ' +
      'differently. The other 739 agree, so a stored face pick on an ' +
      'imported tessellated body survives the Z3 flip about 90% of the time ' +
      'and fails closed the rest. Diagnose alongside edgeHashDigest below.'
  },
  {
    subject: 'a-sample-parametric-bracket',
    metric: 'edgeHashDigest',
    brepkit: 'fbf7718e',
    occt: '7262ee46',
    owner: 'K0.6',
    note:
      'Edge-hash counterpart of the face divergence above, same body and the ' +
      'same cause. 1646 of the 1722 edges carry the same hash on both ' +
      'kernels; 76 do not. The counts match exactly, so this is a hashing ' +
      'difference on particular edges rather than a topology one.'
  },
  {
    subject: 'a-sample-parametric-bracket',
    metric: 'lineageNames',
    brepkit: '2543 names · 0e069cb2',
    occt: '2543 names · 2126c818',
    owner: 'K0.6',
    note:
      IMPORT_NAME_NOTE +
      ' Both kernels publish a reference for every one of the 2543 faces and ' +
      'edges and the counts agree exactly. The DIGESTS differ, but the name ' +
      'sets largely coincide — a name is the hash, and 2385 of the 2543 ' +
      'hashes match. The bracket divergence is 158 sub-shapes out of 2543, ' +
      'not the whole body.'
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
    subject: 'a-export-cone',
    metric: 'witnessedEdges',
    brepkit: 2,
    occt: 3,
    owner: 'K0.6',
    note:
      'The seam difference reaching the identity scheme: both kernels publish ' +
      'a schema-v5 reference for every edge they have, so the reference count ' +
      'inherits the 2-vs-3 edge count. Useful as the control for the sphere ' +
      'pins below, where the counts diverge for a DIFFERENT reason (a witness ' +
      'collision) and the distinction matters.'
  },
  {
    subject: 'a-export-cone',
    metric: 'lineageNames',
    brepkit:
      'import.step.edge.264da6b3,import.step.edge.d267f64f,import.step.face.642b7626,import.step.face.7bafc908',
    occt: 'import.step.edge.264da6b3,import.step.edge.a5507066,import.step.edge.d267f64f,import.step.face.642b7626,import.step.face.7bafc908',
    owner: 'K0.6',
    note:
      IMPORT_NAME_NOTE +
      ' The most legible instance in the corpus, because the sets are small ' +
      'enough to print: four of the five names are IDENTICAL across kernels — ' +
      'both faces and two of the edges — and OCCT has one extra seam edge ' +
      '(a5507066) that BrepKit does not publish. So the cross-kernel identity ' +
      'scheme works; the seam representation is the whole of the gap.'
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
    subject: 'a-export-sphere',
    metric: 'witnessedFaces',
    brepkit: 0,
    occt: 2,
    owner: 'K0.6',
    note:
      'The identity scheme failing closed, correctly, on a real defect. ' +
      "BrepKit's two hemispherical patches produce the SAME exact ADR-011 " +
      'witness, so neither can be named one-to-one and the body publishes no ' +
      'face reference at all; OCCT\'s two patches differ and both publish. ' +
      'Nothing here should be loosened — an ambiguous name is worse than ' +
      'none — but the consequence is a product limit worth stating plainly: ' +
      'a face pick on an imported sphere cannot be stored on BrepKit. It ' +
      'retires with the faceHashDigest pin above, since a fingerprint that ' +
      'distinguishes the two patches also names them.'
  },
  {
    subject: 'a-export-sphere',
    metric: 'witnessedEdges',
    brepkit: 32,
    occt: 36,
    owner: 'K0.6',
    note:
      'Unlike the faces, every edge on both kernels has a distinct witness ' +
      'and publishes, so this count is just the 32-vs-36 edge count again. ' +
      'Kept because reading it beside witnessedFaces (0 vs 2) is what shows ' +
      'the face divergence is a collision rather than a count.'
  },
  {
    subject: 'a-export-sphere',
    metric: 'lineageNames',
    brepkit: '32 names · 9b2eec30',
    occt: '38 names · 15e3c5cb',
    owner: 'K0.6',
    note:
      IMPORT_NAME_NOTE +
      ' 32 edge names on BrepKit and no face names; 36 edge plus 2 face names ' +
      'on OCCT. Retires with the sphere hash pins.'
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
    subject: 'b-unit-degree-cone',
    metric: 'witnessedEdges',
    brepkit: 2,
    occt: 3,
    owner: 'K0.6',
    note:
      'Seam counterpart in the identity scheme, identical to a-export-cone. ' +
      'Retires with the cone seam pins.'
  },
  {
    subject: 'b-unit-degree-cone',
    metric: 'lineageNames',
    brepkit:
      'import.step.edge.264da6b3,import.step.edge.d267f64f,import.step.face.642b7626,import.step.face.7bafc908',
    occt: 'import.step.edge.264da6b3,import.step.edge.a5507066,import.step.edge.d267f64f,import.step.face.642b7626,import.step.face.7bafc908',
    owner: 'K0.6',
    note:
      'Character-for-character identical to the a-export-cone name sets on ' +
      'both kernels, which is a stronger statement than the digest equality ' +
      'those files already had: the degree file and the radian file produce ' +
      'the same stored identities, so a selection survives the rewrite.'
  },
  {
    subject: 'b-unit-degree-cone-unassigned',
    metric: 'warnings',
    brepkit:
      '["Feature \\"Imported\\": parse error: STEP file declares no LENGTH_UNIT in a GLOBAL_UNIT_ASSIGNED_CONTEXT; the model\'s length unit is unknown"]',
    occt: '["Feature \\"Imported\\": STEP file contains no solids."]',
    owner: 'K0.1',
    note:
      'The file with no GLOBAL_UNIT_ASSIGNED_CONTEXT, so the adapter ' +
      'workaround is provably inert. Before K0.1 landed units, BrepKit read ' +
      'the literal 45 as radians and complained about the CONICAL_SURFACE ' +
      'half-angle; it now refuses one step earlier, on the missing length ' +
      'unit, which is the more fundamental of the two objections and the ' +
      'right one to raise first. It should eventually IMPORT this file at ' +
      '1047.1975512 mm3 — an unassigned CONVERSION_BASED_UNIT is still a ' +
      'declared unit — rather than improve the error further. OCCT reads it ' +
      'as radians, produces a degenerate solid, and reports nothing usable.'
  },
  {
    subject: 'b-unit-no-global-context',
    metric: 'status',
    brepkit: 'refused',
    occt: 'imported',
    owner: 'K0.1',
    note:
      'The one divergence the unit work INTRODUCED, and the corpus file was ' +
      'carried specifically to catch it — its manifest entry says "a kernel ' +
      'change in flight may turn this into a hard refusal; the corpus exists ' +
      'to make that audible instead of silent". A 20 mm cube whose units are ' +
      'declared but never bound: BrepKit now refuses with "STEP file declares ' +
      'no LENGTH_UNIT in a GLOBAL_UNIT_ASSIGNED_CONTEXT", OCCT still assumes ' +
      'millimetres and reads 8000 mm3. Failing closed on an unknown scale is ' +
      'defensible — guessing millimetres is how a part arrives 25.4x wrong — ' +
      'but it is a REGRESSION in what OpenZCAD can open, and it is K0.1\'s to ' +
      'settle deliberately before Z3: either import with a stated assumption ' +
      'the user can see, or keep the refusal and say so in the file picker.'
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
    subject: 'e-nurbs-fillet-plate',
    metric: 'witnessedFaces',
    brepkit: 10,
    occt: 6,
    owner: 'OCCT-defect',
    note:
      'BrepKit is BETTER here, by exactly the margin ADR-013 predicts. Both ' +
      'kernels apply the same closed-B-spline guard — a free-form face whose ' +
      'closure is closed OR UNKNOWN publishes no persistent reference — but ' +
      'the OCCT bridge cannot report surface periodicity at all, so all four ' +
      'of its spline bands are conservatively unknown and unnamed, while ' +
      "BrepKit's bridge proves them open and names them. Nothing to fix on " +
      'the BrepKit side; it retires when OCCT is deleted (Z5), or earlier if ' +
      'the OCCT bridge ever exposes periodic-U/periodic-V.'
  },
  {
    subject: 'e-nurbs-fillet-plate',
    metric: 'lineageNames',
    brepkit: '34 names · ae180b36',
    occt: '30 names · 58c3a755',
    owner: 'OCCT-defect',
    note:
      'Name-set counterpart of the witnessedFaces pin above: the same four ' +
      'B-spline band faces, named on BrepKit and withheld on OCCT. The ' +
      'digests differ rather than one being a subset of the other because ' +
      'the two kernels also disagree on this file\'s spline geometry (see ' +
      'the volume pin), which moves every fingerprint on the body.'
  },
  {
    subject: 'e-analytic-fillet-plate',
    metric: 'volume',
    brepkit: 9522.606928409188,
    occt: 9522.743338823155,
    owner: 'brepkit-measurement',
    note:
      MEASUREMENT_NOTE +
      ' New measurement, only possible because K0.1 taught BrepKit to read ' +
      'SURFACE_CURVE: this OCCT-authored file used to be refused outright. ' +
      'BrepKit now reads it 1.43e-5 relative LOW against the closed-form ' +
      '9522.7433388, which OCCT hits to 1e-12. Four quarter-cylinder bands, ' +
      'the same deflection-driven residue as a-export-bored-plate.'
  },
  {
    subject: 'e-analytic-fillet-plate',
    metric: 'edgeHashDigest',
    brepkit: '2cf1303e',
    occt: '26f53b2e',
    owner: 'K0.6',
    note:
      'Same 34 edges, same face hash digest — the faces agree exactly — and ' +
      'a different edge hash set. So this is NOT the spline or measurement ' +
      'gap: it is the seam class again, on the four cylindrical bands, and it ' +
      'is the cleanest analytic instance of it in the corpus because every ' +
      'other metric on the file lines up. Diagnose it alongside a-export-cone.'
  },
  {
    subject: 'e-analytic-fillet-plate',
    metric: 'lineageNames',
    brepkit: '34 names · 1de5dda1',
    occt: '34 names · fa33bc13',
    owner: 'K0.6',
    note:
      IMPORT_NAME_NOTE +
      ' Both kernels name all 34 faces and edges — the counts agree — and the ' +
      'sets differ because of the edge hashes above. Retires with the ' +
      'edgeHashDigest pin.'
  },

  // --- (f) hostile ---------------------------------------------------------
  {
    subject: 'f-hostile-open-shell',
    metric: 'warnings',
    brepkit:
      '["Feature \\"Imported\\": STEP file contains no closed solids: solid 1 (5 faces): it is an open shell — 4 of its 12 edges are used by a single face, so it encloses no volume."]',
    occt: '["Feature \\"Imported\\": STEP file contains no solids."]',
    owner: 'OCCT-defect',
    note:
      'All that is left of the corpus\'s headline validity gap, and BrepKit ' +
      'is now the better side of it. This file used to import on BrepKit as a ' +
      'body of 666.67 mm3 with no warning; K0.6 refuses it, and refuses it ' +
      'by naming the defect and counting the boundary edges, where OCCT ' +
      'reports the generic "contains no solids" and leaves the user to work ' +
      'out which face is missing. Keep BrepKit\'s message.'
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
    metric: 'volume',
    brepkit: 9522.60692840917,
    occt: 9522.74333882308,
    owner: 'brepkit-measurement',
    note:
      MEASUREMENT_NOTE +
      ' This pin used to read 9518.3321434 and belong to K0.4: BrepKit fitted ' +
      "the four corner bands as B-splines just inside the true quarter " +
      'cylinder and lost 4.4 mm3 (4.63e-4 relative). The bands are now exact ' +
      'cylinders — the surfaceTypes and faceHashDigest pins that recorded ' +
      'that gap are retired — and what is left is 1.43e-5, the same ' +
      'deflection residue every other curved body in this corpus carries. ' +
      'The reassignment is corroborated rather than assumed: BrepKit now ' +
      'reads this scenario within 2e-15 relative of its own import of ' +
      'e-analytic-fillet-plate (9522.6069284092), the OCCT-authored file of ' +
      'the same nominal shape, so the blend and the import agree on the ' +
      'geometry and only the integrator is short.'
  },
  {
    subject: 'fillet-on-import',
    metric: 'edgeHashDigest',
    brepkit: '4de1dc1b',
    occt: '26f53b2e',
    owner: 'K0.6',
    note:
      'Was 9389207a under K0.4, when the divergence was that BrepKit bounded ' +
      'B-spline bands and OCCT bounded cylinders. The bands agree now — the ' +
      'faces do too, both kernels reaching b563a24b — so what is left is the ' +
      'seam class, and this becomes the third instance of it alongside ' +
      'a-export-cone and e-analytic-fillet-plate. Measured element-wise the ' +
      'two kernels publish 24 edges each and 16 of the 24 carry the SAME ' +
      'hash, so a stored edge pick on this body usually survives and fails ' +
      'closed when it does not. Note BrepKit does not reach its own ' +
      'e-analytic-fillet-plate digest (2cf1303e) either, so the remaining ' +
      'difference is in how a blended edge is represented, not in importing.'
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
    subject: 'b-unit-no-global-context',
    kernel: 'brepkit',
    referenceMm3: 20 * 20 * 20,
    reported: 'refused',
    owner: 'K0.1',
    note:
      'A 20 mm cube whose units are declared and never bound to a ' +
      'GLOBAL_UNIT_ASSIGNED_CONTEXT. K0.1\'s unit work made BrepKit refuse ' +
      'it rather than assume millimetres. Fails closed, which is the safe ' +
      'direction — a wrong scale is silent and expensive — but the file is ' +
      'plainly readable and OCCT reads it to 8000, so this is a capability ' +
      'the flip loses unless K0.1 either imports it with a stated assumption ' +
      'or surfaces the refusal before the user commits.'
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
    reported: 9522.606928409188,
    owner: 'brepkit-measurement',
    note:
      MEASUREMENT_NOTE +
      ' This pin used to read "refused": BrepKit could not open an ' +
      'OpenCascade-authored file at all. It now reads the file 1.43e-5 ' +
      'relative low, which is the deflection residue on four ' +
      'quarter-cylinder bands and nothing more — OCCT hits the arithmetic ' +
      'to 1e-12 on the same file.'
  },
  {
    subject: 'fillet-on-import',
    kernel: 'brepkit',
    referenceMm3: 40 * 24 * 10 - 4 * (1 - Math.PI / 4) * 9 * 10,
    reported: 9522.60692840917,
    owner: 'brepkit-measurement',
    note:
      MEASUREMENT_NOTE +
      ' Was 9518.3321434 under K0.4 — B-spline corner bands sitting inside ' +
      'the true quarter cylinder, 4.63e-4 relative low. The bands are exact ' +
      'cylinders now and the deviation from the arithmetic fell 32x, to ' +
      '1.43e-5, which is the same residue a-export-bored-plate and ' +
      'e-analytic-fillet-plate carry. This entry is the one that says the ' +
      'move is an improvement rather than a different answer: it is measured ' +
      "against the scenario's own construction, not against OCCT."
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

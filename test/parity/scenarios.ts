/**
 * Kernel parity scenarios: real modeling sessions replayed headless through
 * the exact kernel adapter.
 *
 * The three workspace demos are the primary corpus — multi-stage feature
 * histories (booleans, revolve, patterns, fillets, chamfers) that resolve
 * exact edge hashes through a live kernel sync, exactly like interactive
 * edge picks. `boreGrid` adds a boolean-heavy stress case: a patterned bore
 * tool subtracted from a plate in one multi-tool subtract.
 */

import {
  CommandManager,
  commandFactories
} from '@openzcad/command-system';
import {
  createBodyFeatureIds,
  createParameterIds,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';

import {
  DEMO_DEFINITIONS,
  buildDemoDocument,
  type ExactSyncFn
} from '../../apps/web/src/lib/demos';

/** Edge-use census a mesh is pinned to, from `meshEdgeUse`. */
export interface MeshDefectPin {
  /** Edges used by exactly one triangle (holes). Watertight ⇒ 0. */
  boundaryEdges: number;
  /** Edges used by three or more triangles (branching). Manifold ⇒ 0. */
  nonManifoldEdges: number;
}

export interface ParityScenario {
  key: string;
  /** Build the full document, syncing through the injected kernel. */
  build: (syncExact: ExactSyncFn) => Promise<ProjectDocument>;
  /**
   * A pinned, known kernel defect: the build is EXPECTED to fail with this
   * message. The harness asserts the exact failure so the defect cannot
   * drift silently — and once the kernel is fixed, the scenario fails the
   * harness until this pin is removed, forcing the baseline to be recorded.
   */
  expectedBuildFailure?: RegExp;
  /**
   * Pinned known feature failures: the build completes but sync is EXPECTED
   * to produce exactly these warnings (one pattern per warning, in order).
   * Same discipline as `expectedBuildFailure`: a kernel fix flips the
   * harness red until the pin is removed and baselines re-recorded.
   */
  expectedWarnings?: RegExp[];
  /**
   * Pinned known mesh defects: `bodies` is keyed by body name, `stl` covers
   * the exported STL (which welds every exportable body into one mesh). Any
   * body or STL left unlisted must be perfectly watertight and manifold.
   *
   * This pins a count, it does not suppress an assertion — the harness
   * asserts the number EXACTLY, so the scenario flips red both when the
   * defect worsens and when it is fixed. A repaired mesh keeps failing until
   * the pin is retired, the same discipline as `expectedBuildFailure`.
   */
  expectedMeshDefects?: {
    bodies?: Record<string, MeshDefectPin>;
    stl?: MeshDefectPin;
  };
}

const HARNESS_USER = toUserId('user_parity_harness');

function buildBoreGrid(): ProjectDocument {
  const manager = new CommandManager(
    createProjectDocument('Parity · Bore Grid', HARNESS_USER, 'mm')
  );

  manager.runTransaction(
    'Parameters',
    Object.entries({
      plate_w: 90,
      plate_d: 50,
      plate_t: 8,
      bore_r: 3.25,
      bore_count: 5,
      bore_pitch: 16
    }).map(([name, value]) =>
      commandFactories.setParameter({
        name,
        expression: String(value),
        ids: createParameterIds()
      })
    )
  );

  const plate = createBodyFeatureIds();
  const bore = createBodyFeatureIds();
  const boreRow = createBodyFeatureIds();
  const drilled = createBodyFeatureIds();
  manager.runTransaction('Drill bore row', [
    commandFactories.addPrimitive({
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 'plate_w', height: 'plate_d', depth: 'plate_t' },
      ids: plate
    }),
    commandFactories.addPrimitive({
      name: 'Bore tool',
      primitiveKind: 'cylinder',
      dimensions: { radius: 'bore_r', height: 'plate_t + 4' },
      ids: bore
    }),
    commandFactories.transformBody({
      name: 'Seat first bore',
      targetBodyId: bore.bodyId,
      translation: { x: 'bore_pitch', y: 'plate_d / 2', z: -2 }
    }),
    commandFactories.patternBody({
      name: 'Bore row',
      targetBodyId: bore.bodyId,
      patternKind: 'linear',
      count: 'bore_count',
      axis: 'x',
      spacing: 'bore_pitch',
      ids: boreRow
    }),
    commandFactories.booleanBodies({
      name: 'Drill row',
      operation: 'subtract',
      targetBodyIds: [plate.bodyId, boreRow.bodyId],
      ids: drilled
    })
  ]);

  return manager.document;
}

/**
 * Known kernel defects pinned as build failures — currently none. Every
 * scenario builds.
 *
 * HISTORY, because the flange's analytic path took three kernel fixes to
 * recover and the trail is worth keeping. The rim u hub FUSE was the origin:
 * the two revolved annuli share the r24 cylinder, the same-domain key hashed
 * the two instances of that closed circle apart, the coincident pair was never
 * detected, and the blank collapsed to ~1031 planar faces. Everything
 * downstream inherited the mesh. Trace this class of thing with arena
 * snapshots, not STEP — a STEP round-trip normalises it away and the fuse
 * comes out analytic.
 *
 *   1. `fix(algo): canonical same-domain key for closed edges` (brepkit #21,
 *      1dc4541) — closed edges key on the centroid over the whole period
 *      instead of a midpoint sampled in stored order. Makes the blank analytic.
 *   2. `fix(algo): split plane faces carrying several closed section loops`
 *      (brepkit #24, 9ce6cce) — with the blank analytic the bolt-circle cut
 *      then failed with NonManifoldResult. `split_face_2d` routed a plane face
 *      to its internal-loops path only for exactly ONE closed section, so the
 *      six patterned bolts (fused into one tool, cut in one operation) left the
 *      cap and bottom unsplit and their bore walls stranded.
 *   3. `fix(algo): respect face holes in the EF containment test` (brepkit #25,
 *      d108788) — the drilled body was then analytic but still meshed OPEN.
 *      Phase EF built its planar containment polygon from the outer wire alone,
 *      so the rim's z=10 cap (an annulus r24..45) accepted a crossing at
 *      (12, 0, 10) — 12mm inside its own hole — and paved a vertex there,
 *      splitting the bore seam. Every B-Rep gate passed; only the mesh leaked.
 *
 * All three are on brepkit main and this lock now carries them. The flange
 * drilled body measures 12 faces, nine cylindrical walls, and is watertight.
 *
 * One prediction in the previous version of this note turned out wrong and is
 * corrected here: an analytic blank was expected to stop the Rev C chamfer
 * SEEDING ("found no exact edges for rim + hub lip"), because the picker
 * selects by position and was tuned against the tessellated body. It does not.
 * The picker finds its edges on the analytic body — the chamfer OPERATION is
 * what fails. See EXPECTED_WARNINGS below.
 */
const EXPECTED_BUILD_FAILURES: Record<string, RegExp> = {};

/**
 * No mesh defects are pinned. The flange's 873 boundary edges — the
 * mesh-fallback signature — are gone as of brepkit #25; the body and its STL
 * both read 0.
 *
 * The reasoning that put that pin here still stands for the next one: pin an
 * EXACT count rather than skipping the assertion, so it fails in both
 * directions. A worse mesh fails, and so does a repaired one, which is what
 * forces the pin to be retired instead of outliving the defect. What a pin
 * buys over a standing red is that a new watertightness break anywhere in the
 * corpus turns the suite red on its own, instead of hiding inside a failure
 * count everyone has learned to expect.
 */
const EXPECTED_MESH_DEFECTS: Record<
  string,
  ParityScenario['expectedMeshDefects']
> = {};

/**
 * flange: the Rev C rim chamfer (3 edges, d=1.5) fails in the kernel's chamfer
 * path and is swallowed into a warning — the demo renders undrilled at the rim
 * lip, and the final body is `Drill bolt circle Body` rather than
 * `Pipe Flange`. This became visible only once fixes #21/#24/#25 let the demo
 * reach Rev C at all; it is not a regression from them.
 *
 * Three edges, not the four this pin used to name: the picker had also been
 * matching the r=45 cylinder's vertical seam, which shares the rim's radius
 * but is not a design edge. Fixed in `demos.ts` by constraining the pick to
 * edges flat in Z — see the note there. The chamfer fails either way, so this
 * changes the pinned count and nothing else.
 *
 * Tracked in brepkit as a chamfer defect on closed circular edges: any
 * cylinder rim errors "cannot normalize zero vector". Long-standing, exposed
 * once the booleans went analytic and started handing the chamfer real
 * circles. When it lands, drop this entry and rerecord — the body name,
 * faceCount and volume all change.
 *
 * bracket's 4-corner fillet pin was retired here: brepkit #23 (638d141,
 * G1 ridgeline spine propagation) fixed it, the warning no longer fires, and
 * its baseline is rerecorded in this change (13 -> 17 faces).
 */
const EXPECTED_WARNINGS: Record<string, RegExp[]> = {
  flange: [/Rim chamfer.*Chamfer could not be created on 3 selected edges/]
};

export const PARITY_SCENARIOS: ParityScenario[] = [
  ...DEMO_DEFINITIONS.map((definition) => ({
    key: definition.key,
    build: (syncExact: ExactSyncFn) =>
      buildDemoDocument(definition, HARNESS_USER, syncExact),
    expectedBuildFailure: EXPECTED_BUILD_FAILURES[definition.key],
    expectedWarnings: EXPECTED_WARNINGS[definition.key],
    expectedMeshDefects: EXPECTED_MESH_DEFECTS[definition.key]
  })),
  {
    key: 'boreGrid',
    build: () => Promise.resolve(buildBoreGrid())
  }
];

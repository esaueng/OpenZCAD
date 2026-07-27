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
 * Known kernel defects, keyed by scenario (currently none pinned as build
 * failures). The flange bolt-circle pin was removed when the kernel bump
 * made the scenario build — but note its baseline faceCount (~2789) is the
 * mesh-fallback signature: the analytic cut still fails and the mesh-boolean
 * fallback carries the demo. The underlying unify-then-cut defect remains
 * tracked in brepkit; when it is fixed the flange faceCount should collapse
 * to tens of faces and the baseline must be rerecorded.
 */
const EXPECTED_BUILD_FAILURES: Record<string, RegExp> = {};

/**
 * flange: the mesh-boolean fallback described above is not watertight. The
 * body reports exactly 873 boundary edges, unchanged from kernel 2.128.5
 * through 2.129.0, and the exported STL carries the same 873 through (the
 * scenario has one exportable body, so the two meshes agree).
 *
 * This was left unpinned for a while on the reasoning that suppressing a
 * watertightness assertion is the green-looking blindfold the harness exists
 * to prevent. That reasoning holds against suppression — which is why this is
 * an exact count rather than a skip. 873 is asserted in both directions: a
 * worse mesh fails, and so does a repaired one, which is what forces the pin
 * to be retired when the analytic cut lands. What the pin buys is the thing a
 * standing red does not: a new watertightness break anywhere in the corpus
 * now turns the suite red on its own, instead of hiding inside a failure
 * count everyone has learned to expect.
 */
const EXPECTED_MESH_DEFECTS: Record<
  string,
  ParityScenario['expectedMeshDefects']
> = {
  flange: {
    bodies: { 'Pipe Flange': { boundaryEdges: 873, nonManifoldEdges: 0 } },
    stl: { boundaryEdges: 873, nonManifoldEdges: 0 }
  }
};

/**
 * bracket: the Rev C base-corner fillet (4 vertical edges, r=3) fails in the
 * kernel's fillet path and is swallowed into a warning — the demo currently
 * renders without its fillet. Tracked as a brepkit fillet defect.
 */
const EXPECTED_WARNINGS: Record<string, RegExp[]> = {
  bracket: [/Base corner fillets.*Fillet could not be created on 4 selected edges/]
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

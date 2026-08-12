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

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CommandManager,
  commandFactories
} from '@openzcad/command-system';
import {
  createBodyFeatureIds,
  createParameterIds,
  createProjectDocument
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type EdgeTopology,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';

import {
  DEMO_DEFINITIONS,
  buildDemoDocument,
  type ExactSyncFn
} from '../../apps/web/src/lib/demos';

import { MODELING_BASE, REPO_ROOT } from './corpus/manifest';

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
 * All four are on brepkit main and this lock now carries them. The flange
 * builds through Rev C: `Pipe Flange`, 15 faces (nine cylindrical bore/body
 * walls plus three conical chamfer bands), watertight, no warnings.
 *
 *   4. `feat(blend): chamfer closed circular rims` (brepkit #27, 3d0c11c) and
 *      `fix(blend): rim chamfer on a cap that carries holes` (#28, 9117219) —
 *      with the body finally analytic and watertight, Rev C's rim chamfer was
 *      the last thing failing. No engine could chamfer a closed circular edge:
 *      the v2 builder refused them outright and the v1 flat-bevel engine, being
 *      planar-only, reported "cannot normalize zero vector". #27 ported the
 *      annular rim rebuild the FILLET builder already had; #28 let it keep a
 *      cap's holes, which the flange rim cap needs.
 *
 * One prediction in an earlier version of this note turned out wrong and is
 * corrected here: an analytic blank was expected to stop the Rev C chamfer
 * SEEDING ("found no exact edges for rim + hub lip"), because the picker
 * selects by position and was tuned against the tessellated body. It does not.
 * The picker found its edges on the analytic body; the chamfer OPERATION was
 * what failed.
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
 * No warnings are pinned. Every demo now rebuilds clean.
 *
 * Both entries that lived here have been retired by kernel fixes:
 *
 *   - bracket's 4-corner fillet, by brepkit #23 (638d141, G1 ridgeline spine
 *     propagation).
 *   - flange's Rev C rim chamfer, by brepkit #27 (3d0c11c) and #28 (9117219).
 *     #27 taught the chamfer builder the annular rim rebuild the fillet
 *     builder already had — a cone band with a straight ruled seam, rather
 *     than a torus with a minor arc — replacing a guard that had refused every
 *     closed edge outright. #28 then let that rebuild keep a cap's HOLES: the
 *     flange rim cap is an annulus with a central opening and six bolt holes,
 *     and the first cut of the fix only handled a bare disc, so all three
 *     picked rims still failed with "trimming failure".
 *
 * Keep the pinning discipline for the next defect: pin an EXACT value rather
 * than skipping the assertion, so it fails in both directions and cannot
 * outlive the defect it describes. Both of these were retired precisely
 * because their pins started failing once the kernel was fixed.
 */
const EXPECTED_WARNINGS: Record<string, RegExp[]> = {};

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

// ---------------------------------------------------------------------------
// Import-modeling scenarios — the Z1.3 working checklist
// ---------------------------------------------------------------------------

/**
 * Modeling operations layered on top of an IMPORTED body.
 *
 * These are separate from `PARITY_SCENARIOS` on purpose. They are measured on
 * BrepKit and OCCT *directly*, side by side, which is the only way the delta
 * they exist to record is visible at all — and running two WASM kernels per
 * scenario does not belong in the fast pool. Before Z3 an `imported-step`
 * feature rerouted the whole production adapter to OpenCascade; that is no
 * longer true, so these scenarios are now the measurement of what the app
 * actually does, against the kernel it no longer uses.
 *
 * Every scenario carries a `nominalVolumeMm3` computed from the design intent
 * by hand, not read from a kernel. That is deliberate: when the two kernels
 * disagree, "which one is wrong" is otherwise unanswerable, and a corpus that
 * can only say "they differ" is much less useful to the lane it feeds.
 */
export interface ImportModelingScenario {
  key: string;
  /** One line: what this scenario is measuring and why it is in the corpus. */
  purpose: string;
  /**
   * Closed-form volume of the intended shape, in mm³, derived from the
   * construction rather than from either kernel.
   */
  nominalVolumeMm3: number;
  /**
   * Relative tolerance against `nominalVolumeMm3`. Loose values are always
   * explained on the scenario — an unexplained loose tolerance is how a real
   * defect hides.
   */
  nominalRtol: number;
  build: (sync: ExactSyncFn) => Promise<ProjectDocument>;
}

const IMPORT_USER = toUserId('user_parity_import_modeling');

function corpusStep(id: string): string {
  return readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      'corpus',
      `${id}.step`
    ),
    'utf8'
  );
}

/** The manifest owns the base plate's path; assert the two agree. */
const BASE_PLATE_PATH = join(REPO_ROOT, MODELING_BASE.path);

function importedPlateManager(
  name: string,
  stepId: string
): { manager: CommandManager; imported: ReturnType<typeof createBodyFeatureIds> } {
  const manager = new CommandManager(
    createProjectDocument(name, IMPORT_USER, 'mm')
  );
  const imported = createBodyFeatureIds();
  manager.execute(
    commandFactories.importStep({
      name: 'Imported plate',
      artifactId: `artifact_parity_${stepId}`,
      sourceName: `${stepId}.step`,
      stepText: corpusStep(stepId),
      ids: imported
    })
  );
  return { manager, imported };
}

function bounds(points: number[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < points.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = points[index + axis]!;
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }
  return { min, max };
}

function topologyOf(
  derived: DerivedState,
  bodyId: BodyId,
  what: string
): { faces: FaceTopology[]; edges: EdgeTopology[] } {
  const topology = derived.bodyRepresentations[bodyId]?.topology;
  if (!topology) {
    throw new Error(
      `${what}: the imported body published no topology, so no pick can be resolved`
    );
  }
  return { faces: topology.faces, edges: topology.edges };
}

/**
 * The four vertical corner edges of the base plate, resolved by position the
 * way an interactive edge pick resolves them. Tall in Z, narrow in XY — the
 * same discipline `demos.ts` uses to keep long perimeter edges out of a corner
 * pick.
 */
function verticalCornerEdges(edges: EdgeTopology[], what: string): number[] {
  const hashes = edges
    .filter((edge) => {
      const { min, max } = bounds(edge.points);
      return (
        max[2]! - min[2]! >= MODELING_BASE.height - 1 &&
        max[0]! - min[0]! < 1 &&
        max[1]! - min[1]! < 1
      );
    })
    .map((edge) => edge.hash);
  if (hashes.length !== 4) {
    throw new Error(
      `${what}: expected 4 vertical corner edges on the imported plate, found ${hashes.length}`
    );
  }
  return hashes;
}

function topFaceHash(faces: FaceTopology[], what: string): number {
  const top = faces.filter(
    (face) =>
      face.geometry?.normal !== undefined &&
      Math.abs(face.geometry.normal.z - 1) < 1e-6 &&
      Math.abs(face.geometry.center.z - MODELING_BASE.height) < 1e-6
  );
  if (top.length !== 1) {
    throw new Error(
      `${what}: expected exactly one +Z face at z=${MODELING_BASE.height}, found ${top.length}`
    );
  }
  return top[0]!.hash;
}

const PLATE_VOLUME =
  MODELING_BASE.width * MODELING_BASE.depth * MODELING_BASE.height;

/** A quarter-disc corner replaced by a fillet arc removes this much area. */
const CORNER_FILLET_AREA = (radius: number) =>
  (1 - Math.PI / 4) * radius * radius;

export const IMPORT_MODELING_SCENARIOS: ImportModelingScenario[] = [
  {
    key: 'fillet-on-import',
    purpose:
      'Blend an imported body: r3 fillets on the four vertical corners of the ' +
      'imported plate. The corner band is where the two kernels choose ' +
      'different surface types for the same nominal geometry.',
    nominalVolumeMm3:
      PLATE_VOLUME - 4 * CORNER_FILLET_AREA(3) * MODELING_BASE.height,
    // 1e-6: both kernels report analytic volumes for this class, so anything
    // above float noise is a real geometric difference and must be pinned.
    nominalRtol: 1e-6,
    build: async (sync) => {
      const { manager, imported } = importedPlateManager(
        'Parity · fillet on import',
        'modeling-base-plate'
      );
      const derived = await sync(manager.document);
      const { edges } = topologyOf(derived, imported.bodyId, 'fillet-on-import');
      manager.runTransaction('Break the imported corners', [
        commandFactories.filletEdges({
          name: 'Corner break',
          targetBodyId: imported.bodyId,
          edgeHashes: verticalCornerEdges(edges, 'fillet-on-import'),
          size: 3,
          ids: createBodyFeatureIds()
        })
      ]);
      return manager.document;
    }
  },
  {
    key: 'chamfer-on-import',
    purpose:
      'The other blend engine on the same picks: 3 mm chamfers on the four ' +
      'vertical corners. Purely planar output, so a divergence here is a ' +
      'topology problem, not a surface-fitting one.',
    nominalVolumeMm3: PLATE_VOLUME - 4 * 0.5 * 3 * 3 * MODELING_BASE.height,
    nominalRtol: 1e-6,
    build: async (sync) => {
      const { manager, imported } = importedPlateManager(
        'Parity · chamfer on import',
        'modeling-base-plate'
      );
      const derived = await sync(manager.document);
      const { edges } = topologyOf(derived, imported.bodyId, 'chamfer-on-import');
      manager.runTransaction('Chamfer the imported corners', [
        commandFactories.chamferEdges({
          name: 'Corner chamfer',
          targetBodyId: imported.bodyId,
          edgeHashes: verticalCornerEdges(edges, 'chamfer-on-import'),
          size: 3,
          ids: createBodyFeatureIds()
        })
      ]);
      return manager.document;
    }
  },
  {
    key: 'boolean-with-import',
    purpose:
      'Subtract a natively built r5 cylinder from the imported plate: an ' +
      'exact primitive meeting imported topology in one boolean. The plain ' +
      'analytic case, and the control for boolean-on-nurbs-import.',
    nominalVolumeMm3: PLATE_VOLUME - Math.PI * 25 * MODELING_BASE.height,
    nominalRtol: 1e-6,
    build: async () => {
      const { manager, imported } = importedPlateManager(
        'Parity · boolean with import',
        'modeling-base-plate'
      );
      const bore = createBodyFeatureIds();
      manager.runTransaction('Bore the imported plate', [
        commandFactories.addPrimitive({
          name: 'Bore tool',
          primitiveKind: 'cylinder',
          dimensions: { radius: 5, height: MODELING_BASE.height + 20 },
          ids: bore
        }),
        commandFactories.transformBody({
          name: 'Seat the bore',
          targetBodyId: bore.bodyId,
          translation: {
            x: MODELING_BASE.width / 2,
            y: MODELING_BASE.depth / 2,
            z: -10
          }
        }),
        commandFactories.booleanBodies({
          name: 'Bored import',
          operation: 'subtract',
          targetBodyIds: [imported.bodyId, bore.bodyId],
          ids: createBodyFeatureIds()
        })
      ]);
      return manager.document;
    }
  },
  {
    key: 'boss-crossing-a-wall',
    purpose:
      'Fuse a cylindrical boss that CROSSES a planar wall of the plate — the ' +
      'boss is seated 3 mm outside the x=0 face, so it overhangs the edge. ' +
      'This is the non-planar coincident-contact case, and it is here because ' +
      'the census the hardening work relies on cannot see the worst of it: a ' +
      'dropped operand and an ignored cut produce no approximation at all, ' +
      'just less geometry, so only a volume check catches them. Seated fully ' +
      'inside the wall the same fuse is exact, which is what makes this worth ' +
      'pinning rather than filing.',
    // Plate, plus the whole boss above it, less the part of the boss that
    // sits inside the plate. The boss disc (centre x=3, r=6) is cut by the
    // x=0 wall, leaving a circular segment outside the footprint:
    //   segment = r^2 acos(d/r) - d sqrt(r^2 - d^2)  with d = 3
    nominalVolumeMm3:
      PLATE_VOLUME +
      Math.PI * 36 * 20 -
      (Math.PI * 36 - (36 * Math.acos(0.5) - 3 * Math.sqrt(27))) *
        MODELING_BASE.height,
    nominalRtol: 1e-6,
    build: async () => {
      const { manager, imported } = importedPlateManager(
        'Parity · boss crossing a wall',
        'modeling-base-plate'
      );
      const boss = createBodyFeatureIds();
      manager.runTransaction('Fuse a boss across the plate edge', [
        commandFactories.addPrimitive({
          name: 'Boss',
          primitiveKind: 'cylinder',
          dimensions: { radius: 6, height: 20 },
          ids: boss
        }),
        commandFactories.transformBody({
          name: 'Seat the boss across the x=0 wall',
          targetBodyId: boss.bodyId,
          // centre x=3 with r=6 puts 3 mm of the boss outside the wall
          translation: { x: 3, y: MODELING_BASE.depth / 2, z: 0 }
        }),
        commandFactories.booleanBodies({
          name: 'Boss fused across the edge',
          operation: 'union',
          targetBodyIds: [imported.bodyId, boss.bodyId],
          ids: createBodyFeatureIds()
        })
      ]);
      return manager.document;
    }
  },
  {
    key: 'pattern-boolean-with-import',
    purpose:
      'A patterned tool subtracted from the import in ONE multi-tool boolean ' +
      '— three r2.5 bores in a row. Multi-tool booleans are where the ' +
      'section-loop handling on a single planar face gets stressed.',
    nominalVolumeMm3: PLATE_VOLUME - 3 * Math.PI * 2.5 * 2.5 * MODELING_BASE.height,
    nominalRtol: 1e-6,
    build: async () => {
      const { manager, imported } = importedPlateManager(
        'Parity · pattern boolean with import',
        'modeling-base-plate'
      );
      const bore = createBodyFeatureIds();
      const row = createBodyFeatureIds();
      manager.runTransaction('Drill a bore row into the import', [
        commandFactories.addPrimitive({
          name: 'Bore tool',
          primitiveKind: 'cylinder',
          dimensions: { radius: 2.5, height: MODELING_BASE.height + 20 },
          ids: bore
        }),
        commandFactories.transformBody({
          name: 'Seat the first bore',
          targetBodyId: bore.bodyId,
          translation: { x: 10, y: MODELING_BASE.depth / 2, z: -10 }
        }),
        commandFactories.patternBody({
          name: 'Bore row',
          targetBodyId: bore.bodyId,
          patternKind: 'linear',
          count: 3,
          axis: 'x',
          spacing: 10,
          ids: row
        }),
        commandFactories.booleanBodies({
          name: 'Drilled import',
          operation: 'subtract',
          targetBodyIds: [imported.bodyId, row.bodyId],
          ids: createBodyFeatureIds()
        })
      ]);
      return manager.document;
    }
  },
  {
    key: 'shell-on-import',
    purpose:
      'Hollow the imported plate to a 2 mm wall with its +Z face open. The ' +
      'operation resolves a FACE pick on imported topology, which is the ' +
      'other half of the K0.6 witness story.',
    nominalVolumeMm3:
      PLATE_VOLUME -
      (MODELING_BASE.width - 4) *
        (MODELING_BASE.depth - 4) *
        (MODELING_BASE.height - 2),
    nominalRtol: 1e-6,
    build: async (sync) => {
      const { manager, imported } = importedPlateManager(
        'Parity · shell on import',
        'modeling-base-plate'
      );
      const derived = await sync(manager.document);
      const { faces } = topologyOf(derived, imported.bodyId, 'shell-on-import');
      manager.runTransaction('Hollow the imported plate', [
        commandFactories.shellBody({
          name: 'Hollow import',
          targetBodyId: imported.bodyId,
          openingFaceHashes: [topFaceHash(faces, 'shell-on-import')],
          thickness: 2,
          ids: createBodyFeatureIds()
        })
      ]);
      return manager.document;
    }
  },
  {
    key: 'boolean-on-nurbs-import',
    purpose:
      'The K0.5 case: subtract an analytic cylinder from a body whose corner ' +
      'bands arrived as B-splines (e-nurbs-fillet-plate). The r4 bore is ' +
      'seated ON the filleted corner, so the cut surface must intersect a ' +
      'NURBS face rather than a plane.',
    // Filleted plate, minus the first-quadrant material inside r=4 of the
    // origin that the r3 corner fillet had not already removed.
    nominalVolumeMm3:
      PLATE_VOLUME -
      4 * CORNER_FILLET_AREA(3) * MODELING_BASE.height -
      (Math.PI * 16) / 4 * MODELING_BASE.height +
      CORNER_FILLET_AREA(3) * MODELING_BASE.height,
    // 5e-3: the input body is a B-spline APPROXIMATION of the analytic
    // filleted plate, so the nominal figure is the design intent rather than
    // the file's exact content. Both kernels land inside 0.5% when the
    // boolean is correct; a wrong boolean misses by far more, which is
    // exactly what this scenario caught.
    nominalRtol: 5e-3,
    build: async () => {
      const { manager, imported } = importedPlateManager(
        'Parity · boolean on NURBS import',
        'e-nurbs-fillet-plate'
      );
      const bore = createBodyFeatureIds();
      manager.runTransaction('Cut the blended corner', [
        commandFactories.addPrimitive({
          name: 'Corner bore',
          primitiveKind: 'cylinder',
          dimensions: { radius: 4, height: MODELING_BASE.height + 20 },
          ids: bore
        }),
        commandFactories.transformBody({
          name: 'Seat on the corner',
          targetBodyId: bore.bodyId,
          translation: { x: 0, y: 0, z: -10 }
        }),
        commandFactories.booleanBodies({
          name: 'Cut blended corner',
          operation: 'subtract',
          targetBodyIds: [imported.bodyId, bore.bodyId],
          ids: createBodyFeatureIds()
        })
      ]);
      return manager.document;
    }
  }
];

export { BASE_PLATE_PATH };

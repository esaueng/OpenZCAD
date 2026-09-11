import {
  createProjectDocument,
  importStepBody,
  setParameter,
  withoutDerivedProjection
} from '../packages/document-core/src/index';
import {
  CommandManager,
  growingHolderCommand,
  growingHolderHistories,
  replayCommands,
  type GrowingHolderRecipe,
  type OpeningAxis
} from '../packages/command-system/src/index';
import {
  toUserId,
  type SketchObjectData,
  type Vector3
} from '../packages/shared/src/index';
import { inspectTriangleMeshClosure } from '../packages/kernel-adapter/src/boolean-result-validation';
import { buildDocumentHistory } from '../packages/kernel-adapter/src/exact-build-loop';
import {
  RemusKernel,
  loadRemusTranslators,
  remusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { parseProjectBackup } from '../apps/web/src/lib/projectBackup';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { syntheticHolderSolid } from './support/synthetic-holder';

beforeAll(async () => {
  await loadRemusTranslators();
});

const rect = (
  u0: number,
  v0: number,
  u1: number,
  v1: number
): SketchObjectData[] => [
  { objectKind: 'line', x1: u0, y1: v0, x2: u1, y2: v0 },
  { objectKind: 'line', x1: u1, y1: v0, x2: u1, y2: v1 },
  { objectKind: 'line', x1: u1, y1: v1, x2: u0, y2: v1 },
  { objectKind: 'line', x1: u0, y1: v1, x2: u0, y2: v0 }
];

/**
 * The synthetic U-bracket in three placements. Its floor is the straight
 * section (8 × 20 mm), the arms with their holes and the boss are the rigid
 * ends. Cuts at 12 and 48 along the opening axis leave 4 mm of plain floor
 * on each end, clear of the countersinks and the boss.
 */
const placements: {
  axis: OpeningAxis;
  /** Row-major 4×4 applied to the canonical bracket. */
  matrix: Float64Array;
  section: SketchObjectData[];
  /** Measured source bounds in this placement. */
  envelope: { min: Vector3; max: Vector3 };
  /** Fixed extents of the two axes the opening does not change. */
  fixed: [[number, number], [number, number]];
}[] = [
  {
    axis: 'x',
    matrix: Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1),
    // YZ plane: u = y, v = z.
    section: rect(0, 0, 8, 20),
    envelope: { min: { x: -0.5, y: 0, z: 0 }, max: { x: 60.5, y: 32, z: 20 } },
    fixed: [
      [0, 32],
      [0, 20]
    ]
  },
  {
    axis: 'y',
    // Rotate +90° about z: (x, y, z) → (−y, x, z).
    matrix: Float64Array.of(0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1),
    // XZ plane: u = x, v = −z.
    section: rect(-8, -20, 0, 0),
    envelope: { min: { x: -32, y: -0.5, z: 0 }, max: { x: 0, y: 60.5, z: 20 } },
    fixed: [
      [-32, 0],
      [0, 20]
    ]
  },
  {
    axis: 'z',
    // Rotate −90° about y: (x, y, z) → (−z, y, x).
    matrix: Float64Array.of(0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1),
    // XY plane: u = x, v = y.
    section: rect(-20, 0, 0, 8),
    envelope: { min: { x: -20, y: 0, z: -0.5 }, max: { x: 0, y: 32, z: 60.5 } },
    fixed: [
      [-20, 0],
      [0, 32]
    ]
  }
];

const OPENING = 44;
const SECTION_LENGTH = 36;
const FLOOR_AREA = 8 * 20;

function recipeFor(
  placement: (typeof placements)[number],
  targetBodyId: GrowingHolderRecipe['targetBodyId']
): GrowingHolderRecipe {
  return {
    version: 1,
    name: 'Bracket opening',
    targetBodyId,
    axis: placement.axis,
    envelope: placement.envelope,
    cuts: [12, 48],
    center: 30,
    sourceOpening: OPENING,
    parameter: 'opening_width',
    minimumOpening: 10,
    section: placement.section
  };
}

describe('growing holder recipe on a synthetic bracket', () => {
  let kernel: RemusKernel;
  beforeEach(() => {
    kernel = new RemusKernel();
  });
  afterEach(() => {
    kernel.free();
  });

  for (const placement of placements) {
    it(`grows the opening along ${placement.axis} and moves the holes with the arms`, async () => {
      const axisIndex = { x: 0, y: 1, z: 2 }[placement.axis];
      const others = [0, 1, 2].filter((i) => i !== axisIndex);
      const placed = kernel.copyAndTransformSolid(
        syntheticHolderSolid(kernel),
        placement.matrix
      );
      const stepText = new TextDecoder().decode(
        remusTranslators().exportStep(
          kernel.serializeSolids(Uint32Array.of(placed))
        )
      );
      // Volumes are tessellated: a Boolean repartitions the hole and
      // countersink faces, so the result at the source opening is the
      // baseline, not the import itself. From there only the planar floor
      // changes and the delta is the exact section growth.
      let baselineVolume: number | null = null;
      const imported = importStepBody(
        createProjectDocument('Bracket', toUserId('local_bracket')),
        {
          name: 'Bracket',
          artifactId: 'bracket',
          sourceName: 'bracket.step',
          stepText
        }
      );
      const recipe = recipeFor(placement, imported.bodyId);
      const manager = new CommandManager(imported.document);
      const compiled = growingHolderCommand(manager.document, recipe);
      manager.execute(compiled.command);
      const history = growingHolderHistories(manager.document);
      expect(history).toHaveLength(1);
      expect(history[0]!.resultBodyId).toBe(compiled.bodyId);

      for (const width of [OPENING, 60, 30, 10]) {
        const document = setParameter(manager.document, {
          name: 'opening_width',
          expression: String(width)
        });
        const built = buildDocumentHistory(kernel, document);
        expect(
          built.warnings.map((w) => JSON.stringify(w)),
          `width ${width}`
        ).toEqual([]);
        expect(built.consumed.has(recipe.targetBodyId)).toBe(true);
        expect(built.consumed.has(compiled.negativeEndBodyId)).toBe(true);
        expect(built.consumed.has(compiled.positiveEndBodyId)).toBe(true);
        const solids = built.shapes.get(compiled.bodyId)!.solids;
        expect(solids).toHaveLength(1);
        const solid = solids[0]!;
        expect(kernel.validateSolid(solid), `width ${width}`).toBe(0);
        const bounds = Array.from(kernel.boundingBox(solid));
        // Each 8 mm arm carries its countersink, which breaks 0.5 mm out of
        // the outer face; the arms move rigidly, so that overhang moves too.
        const half = (width + 16) / 2 + 0.5;
        expect(bounds[axisIndex]).toBeCloseTo(30 - half, 6);
        expect(bounds[axisIndex + 3]).toBeCloseTo(30 + half, 6);
        for (const [slot, index] of others.entries()) {
          expect(bounds[index]).toBeCloseTo(placement.fixed[slot]![0], 6);
          expect(bounds[index + 3]).toBeCloseTo(placement.fixed[slot]![1], 6);
        }
        const holes = Array.from(kernel.getSolidFaces(solid))
          .map(
            (face) =>
              JSON.parse(kernel.getAnalyticSurfaceParams(face)) as {
                type: string;
                radius?: number;
                origin?: number[];
              }
          )
          .filter(
            (s) =>
              s.type === 'cylinder' && Math.abs((s.radius ?? 0) - 2.5) < 1e-7
          )
          .map((s) => s.origin![axisIndex]!)
          .sort((a, b) => a - b);
        expect(holes, `holes at width ${width}`).toHaveLength(2);
        expect(holes[0]).toBeCloseTo(30 - width / 2 - 4, 6);
        expect(holes[1]).toBeCloseTo(30 + width / 2 + 4, 6);
        // At the coarse 0.01 deflection the union's re-tessellated hole and
        // countersink faces wander by ~0.3 mm³ between widths; at 0.001 the
        // delta is the section growth to four decimals.
        const volume = kernel.volume(solid, 0.001);
        baselineVolume ??= volume;
        expect(volume - baselineVolume).toBeCloseTo(
          (width - OPENING) * FLOOR_AREA,
          3
        );
        const mesh = kernel.tessellateSolid(solid, 0.05);
        try {
          expect(
            inspectTriangleMeshClosure(mesh.positions, mesh.indices)
          ).toMatchObject({
            boundaryEdges: 0,
            nonManifoldEdges: 0,
            inconsistentWindingEdges: 0
          });
        } finally {
          mesh.free();
        }
        const restored = kernel.deserializeSolids(
          remusTranslators().importStep(
            remusTranslators().exportStep(
              kernel.serializeSolids(Uint32Array.of(solid))
            )
          )
        );
        expect(restored).toHaveLength(1);
        expect(kernel.validateSolid(restored[0]!)).toBe(0);
      }

      // The bridge is exactly the replaced section at the source opening.
      const source = buildDocumentHistory(kernel, manager.document);
      const bridge = source.shapes.get(compiled.bridgeBodyId)!.solids[0]!;
      const bridgeBounds = Array.from(kernel.boundingBox(bridge));
      expect(bridgeBounds[axisIndex]).toBeCloseTo(12, 6);
      expect(bridgeBounds[axisIndex + 3]).toBeCloseTo(48, 6);
      expect(kernel.volume(bridge, 0.01)).toBeCloseTo(
        SECTION_LENGTH * FLOOR_AREA,
        6
      );

      const text = JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document: withoutDerivedProjection(manager.document),
        files: [],
        sources: [],
        saveStates: []
      });
      const reopened = (await parseProjectBackup(text)).document;
      expect(reopened.featureOrder).toEqual(manager.document.featureOrder);
      expect(growingHolderHistories(reopened)).toHaveLength(1);
      expect(
        replayCommands(imported.document, manager.document.commandLog)
          .featureOrder
      ).toEqual(manager.document.featureOrder);
    });
  }

  it('rejects a cut plane outside the measured source', () => {
    const imported = importStepBody(
      createProjectDocument('Bracket', toUserId('local_bracket')),
      {
        name: 'Bracket',
        artifactId: 'bracket',
        sourceName: 'bracket.step',
        stepText: 'ISO-10303-21;'
      }
    );
    const recipe = recipeFor(placements[0]!, imported.bodyId);
    expect(() =>
      growingHolderCommand(imported.document, { ...recipe, cuts: [12, 61] })
    ).toThrow(/inside the source along x/);
    expect(() => growingHolderCommand(imported.document, recipe)).not.toThrow();
  });
});

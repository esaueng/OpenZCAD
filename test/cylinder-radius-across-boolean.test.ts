import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  transformBody
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type BooleanOperation,
  type ProjectDocument
} from '@openzcad/shared';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import {
  primitiveCylinderRadiusAncestor,
  primitiveCylinderScale
} from '../apps/web/src/lib/interaction/cylinderPrimitiveAncestry';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../packages/kernel-adapter/src/boolean-result-validation';
import { sphereCylinderUnionInputs } from './support/sphere-cylinder-union';

/**
 * 2026-11-05 report, M1: a diameter drag on a boss grown out of a sphere
 * resizes the source Cylinder instead of the boolean's face. The kernel
 * refuses the local wall resize on a sphere neighbour, while the source edit
 * rebuilds the boolean, which the K10 matrix qualifies for union and
 * subtract. A planar cap offset recorded after the boolean replays on the
 * resized operand through its lineage.
 */
const CASES: ReadonlyArray<[BooleanOperation, boolean]> = [
  ['union', false],
  ['union', true],
  ['subtract', false]
];

describe('a cylinder radius drag across a boolean', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => {
    adapter.dispose();
  });

  async function wallOf(document: ProjectDocument, bodyId: BodyId) {
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[bodyId]!;
    return {
      body,
      wall: body.topology?.faces.find(
        (face) => face.geometry?.surfaceType === 'cylinder'
      )
    };
  }

  it.each(CASES)(
    'resizes the source cylinder after a %s (cap offset: %s)',
    async (operation, capOffset) => {
      const { document, sphere, cylinder } = sphereCylinderUnionInputs();
      const manager = new CommandManager(document);
      manager.execute(
        commandFactories.booleanBodies({
          name: 'Combine',
          operation,
          targetBodyIds: [sphere, cylinder]
        })
      );
      const bodyId = manager.document.bodyOrder.at(-1)!;
      if (capOffset) {
        const derived = await adapter.syncDocument(manager.document);
        const cap = derived.bodyRepresentations[bodyId]!.topology!.faces.find(
          (face) => face.geometry?.surfaceType === 'plane'
        )!;
        const plan = planFaceOffset({
          document: { ...manager.document, derived },
          bodyId,
          face: cap,
          faceHash: cap.hash,
          offset: 5
        });
        expect(plan?.kind).toBe('direct-edit');
        manager.execute(plan!.command);
      }
      const { body: before, wall } = await wallOf(manager.document, bodyId);
      expect(wall?.geometry?.radius).toBeCloseTo(6, 9);

      const primitive = primitiveCylinderRadiusAncestor(
        manager.document,
        bodyId,
        wall!.reference,
        wall!.hash
      );
      expect(primitive?.name).toBe('Cylinder');
      expect(
        primitiveCylinderScale(
          manager.document,
          bodyId,
          wall!.reference,
          wall!.hash
        )
      ).toBe(1);
      if (primitive?.data.featureKind !== 'primitive') return;
      manager.execute(
        commandFactories.updateFeature(
          {
            featureId: primitive.featureId,
            data: {
              dimensions: { ...primitive.data.dimensions, radius: 7 }
            }
          },
          'Resize Cylinder'
        )
      );

      const { body: after, wall: resized } = await wallOf(
        manager.document,
        bodyId
      );
      expect(resized?.geometry?.radius).toBeCloseTo(7, 9);
      expect(resized?.reference?.lineageName).toBe(
        wall!.reference?.lineageName
      );
      expect(after.exportableStep).toBe(true);
      expect(
        isClosedConsistentlyOrientedMesh(
          inspectTriangleMeshClosure(after.mesh.vertices, after.mesh.indices)
        )
      ).toBe(true);
      // A wider boss adds material outside the sphere; a wider bore removes it.
      if (operation === 'union') {
        expect(after.volume).toBeGreaterThan(before.volume);
      } else {
        expect(after.volume).toBeLessThan(before.volume);
      }
      if (capOffset) {
        // The cap pushed 5 after the union still sits 5 above the source top.
        expect(after.bbox.max.z).toBeCloseTo(before.bbox.max.z, 6);
      }
    },
    120_000
  );

  it('keeps a hash-only seam fillet on the local wall resize, which removes, resizes and re-blends it', async () => {
    // Box ∪ boss with its seam filleted. The kernel's evolution declines to
    // trace the seam, so the fillet holds a hash. A source radius edit would
    // make a new seam and lose that pick, so the drag must not cross the
    // union here. The kernel's own local resize leaves the fillet band at
    // r 6 capped by a new annulus — a 46.9 mm³ groove (K10) — so the adapter
    // takes the WS6 ladder instead: remove the band, resize the sharp wall,
    // rebuild the band at r 2. The body must match the closed form (Pappus)
    // in both directions.
    let document = addPrimitiveFeature(
      createProjectDocument('Boss on a plate', toUserId('user_boss_plate')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 60, height: 60, depth: 20 }
      }
    );
    const box = document.bodyOrder[0]!;
    document = addPrimitiveFeature(document, {
      name: 'Cylinder',
      primitiveKind: 'cylinder',
      dimensions: { radius: 6, height: 30 }
    });
    const cylinder = document.bodyOrder[1]!;
    document = transformBody(document, {
      name: 'Move',
      targetBodyId: cylinder,
      translation: { x: 30, y: 30, z: 10 }
    }).document;
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Union',
        operation: 'union',
        targetBodyIds: [box, cylinder]
      })
    );
    const unionId = manager.document.bodyOrder.at(-1)!;
    const joined = await adapter.syncDocument(
      manager.document,
      undefined,
      undefined,
      undefined,
      {
        lineageDemand: [unionId]
      }
    );
    const topology = joined.bodyRepresentations[unionId]!.topology!;
    const surface = new Map(
      topology.faces.map((face) => [face.hash, face.geometry?.surfaceType])
    );
    const seams = topology.edges.filter((edge) => {
      const types = (edge.adjacentFaceHashes ?? []).map((hash) =>
        surface.get(hash)
      );
      return (
        edge.displayRole !== 'seam' &&
        types.includes('cylinder') &&
        types.includes('plane') &&
        edge.reference === undefined
      );
    });
    expect(seams).toHaveLength(1);
    const rounded = filletEdges(manager.document, {
      name: 'Fillet edges',
      targetBodyId: unionId,
      edgeHashes: seams.map((edge) => edge.hash),
      size: 2
    });
    const { wall } = await wallOf(rounded.document, rounded.bodyId);
    expect(
      primitiveCylinderRadiusAncestor(
        rounded.document,
        rounded.bodyId,
        wall!.reference,
        wall!.hash
      )
    ).toBeNull();
    for (const radius of [7, 5]) {
      const local = new CommandManager(rounded.document).runTransaction(
        'Resize',
        [
          commandFactories.directEditBody({
            name: 'Resize Cylinder',
            targetBodyId: rounded.bodyId,
            operation: {
              kind: 'resize-cylindrical-face',
              faceHash: wall!.hash,
              ...(wall!.reference ? { faceReference: wall!.reference } : {}),
              sourceRadius: 6,
              sourceAxisStart: wall!.geometry!.axisStart!,
              sourceAxisEnd: wall!.geometry!.axisEnd!,
              concavity: 'boss',
              radius
            }
          })
        ]
      );
      const bodyId = local.bodyOrder.at(-1)!;
      const derived = await adapter.syncDocument(local);
      expect(derived.featureWarnings ?? []).toEqual([]);
      const body = derived.bodyRepresentations[bodyId]!;
      // Block, the boss above it, and the seam ring: the fillet spandrel
      // ρ²(1 − π/4) swept round the axis at r + ρ(10 − 3π)/(12 − 3π).
      const rho = 2;
      const ring =
        2 *
        Math.PI *
        (radius + (rho * (10 - 3 * Math.PI)) / (12 - 3 * Math.PI)) *
        rho *
        rho *
        (1 - Math.PI / 4);
      expect(body.volume).toBeCloseTo(
        60 * 60 * 20 + Math.PI * radius * radius * 20 + ring,
        3
      );
      const faces = body.topology!.faces;
      expect(
        faces.filter(
          (face) =>
            face.geometry?.surfaceType === 'cylinder' &&
            Math.abs((face.geometry.radius ?? 0) - radius) < 1e-9
        )
      ).toHaveLength(1);
      expect(
        faces.filter((face) => face.geometry?.surfaceType === 'torus')
      ).toHaveLength(1);
      expect(
        isClosedConsistentlyOrientedMesh(
          inspectTriangleMeshClosure(body.mesh.vertices, body.mesh.indices)
        )
      ).toBe(true);
    }
  }, 120_000);
});

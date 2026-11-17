import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { listFeaturesInOrder } from '@openzcad/document-core';
import type { BooleanOperation } from '@openzcad/shared';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../packages/kernel-adapter/src/boolean-result-validation';
import {
  RemusKernel,
  type SolidOperationDetailedResult
} from '../packages/kernel-adapter/src/remus-runtime';
import { filletedSphereBoss } from './support/sphere-boss-seam-fillet';
import { sphereCylinderUnionInputs } from './support/sphere-cylinder-union';

/**
 * 2026-11-05 report: dragging the diameter of a boss that grows out of a
 * sphere refused. Remus #1558 re-limits a resized wall against a sphere
 * neighbour, so the boss (union) and the blind bore cut from the same sphere
 * (subtract) now resize as local direct edits. The result must be the body
 * the source route builds: the same sphere ∪/− a Cylinder of the new radius.
 * A wall meeting the seam fillet's freeform band re-fillets at its
 * approximate quality, disclosed (see `sphere-boss-seam-fillet-resize.test.ts`),
 * in one kernel call: a small change must not run the old waypoint ladder.
 */
const CASES: ReadonlyArray<[BooleanOperation, 'boss' | 'hole']> = [
  ['union', 'boss'],
  ['subtract', 'hole']
];

describe('resizing a cylinder wall that meets a sphere', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => {
    adapter.dispose();
  });

  function combined(operation: BooleanOperation) {
    const { document, sphere, cylinder } = sphereCylinderUnionInputs();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Combine',
        operation,
        targetBodyIds: [sphere, cylinder]
      })
    );
    return { manager, bodyId: manager.document.bodyOrder.at(-1)! };
  }

  it.each(CASES)(
    'resizes the wall after a %s exactly, matching the source route',
    async (operation, concavity) => {
      for (const radius of [7, 5, 6.3]) {
        const { manager, bodyId } = combined(operation);
        const base = await adapter.syncDocument(manager.document);
        expect(base.warnings).toEqual([]);
        const wall = base.bodyRepresentations[bodyId]!.topology!.faces.find(
          (face) =>
            face.geometry?.surfaceType === 'cylinder' &&
            Math.abs((face.geometry.radius ?? 0) - 6) < 1e-6
        )!;
        const direct = await adapter.syncDocument(
          manager.runTransaction('Resize', [
            commandFactories.directEditBody({
              name: 'Resize Cylinder',
              targetBodyId: bodyId,
              operation: {
                kind: 'resize-cylindrical-face',
                faceHash: wall.hash,
                ...(wall.reference ? { faceReference: wall.reference } : {}),
                sourceRadius: 6,
                sourceAxisStart: wall.geometry!.axisStart!,
                sourceAxisEnd: wall.geometry!.axisEnd!,
                concavity,
                radius
              }
            })
          ])
        );
        expect(direct.warnings, `${operation} r ${radius}`).toEqual([]);
        const body = direct.bodyRepresentations[bodyId]!;
        expect(body.exportableStep).toBe(true);
        expect(
          isClosedConsistentlyOrientedMesh(
            inspectTriangleMeshClosure(body.mesh.vertices, body.mesh.indices)
          )
        ).toBe(true);
        expect(
          body.topology!.faces.some(
            (face) =>
              face.geometry?.surfaceType === 'cylinder' &&
              Math.abs((face.geometry.radius ?? 0) - radius) < 1e-6
          )
        ).toBe(true);

        // The source route: the same history with the Cylinder at `radius`.
        const source = combined(operation);
        const cylinderFeature = listFeaturesInOrder(
          source.manager.document
        ).find((feature) => feature.name === 'Cylinder')!;
        if (cylinderFeature.data.featureKind !== 'primitive') return;
        source.manager.execute(
          commandFactories.updateFeature({
            featureId: cylinderFeature.featureId,
            data: {
              dimensions: { ...cylinderFeature.data.dimensions, radius }
            }
          })
        );
        const rebuilt = await adapter.syncDocument(source.manager.document);
        expect(rebuilt.warnings).toEqual([]);
        const reference = rebuilt.bodyRepresentations[source.bodyId]!.volume;
        expect(Math.abs(body.volume - reference)).toBeLessThan(
          Math.max(0.05, 1e-6 * reference)
        );
      }
    },
    300_000
  );

  it('re-fillets a seam-filleted wall in one call, without the waypoint ladder', async () => {
    const { manager, bodyId, wall } = await filletedSphereBoss(adapter);
    const typed = vi.spyOn(
      RemusKernel.prototype,
      'resizeCylindricalFaceDetailed'
    );
    const legacy = vi.spyOn(RemusKernel.prototype, 'resizeCylindricalFace');
    try {
      // 6 -> 6.3 is a 5% change, inside the 15% band that used to detour.
      const derived = await adapter.syncDocument(
        manager.runTransaction('Resize', [
          commandFactories.directEditBody({
            name: 'Resize Cylinder',
            targetBodyId: bodyId,
            operation: {
              kind: 'resize-cylindrical-face',
              faceHash: wall.hash,
              ...(wall.reference ? { faceReference: wall.reference } : {}),
              sourceRadius: 6,
              sourceAxisStart: wall.geometry!.axisStart!,
              sourceAxisEnd: wall.geometry!.axisEnd!,
              concavity: 'boss',
              radius: 6.3
            }
          })
        ])
      );
      const warnings = (derived.featureWarnings ?? []).filter(
        (entry) => entry.featureName === 'Resize Cylinder'
      );
      expect(warnings.map((entry) => entry.kind)).toEqual(['advisory']);
      expect(
        derived.bodyRepresentations[bodyId]!.topology!.faces.some(
          (face) =>
            face.geometry?.surfaceType === 'cylinder' &&
            Math.abs((face.geometry.radius ?? 0) - 6.3) < 1e-6
        )
      ).toBe(true);
      expect(typed).toHaveBeenCalledTimes(1);
      expect(legacy).not.toHaveBeenCalled();
    } finally {
      typed.mockRestore();
      legacy.mockRestore();
    }
  }, 300_000);

  it('keeps a blend-cluster "diameter unbuildable" verdict without the waypoint ladder', async () => {
    // A boss whose joint fillet meets other fillets at a vertex the kernel
    // cannot re-blend is refused at every diameter (2026-11-14 recording:
    // Ø12.4, 14.26, 16.12, 10.2 and 8.4 all failed on the same vertex). The
    // blend-cluster route has already tried every re-fillet order, so each
    // waypoint only repeats that multi-second search. One typed call, and
    // the verdict survives unchanged.
    const { manager, bodyId, wall } = await filletedSphereBoss(adapter);
    const unbuildable = (radius: number): SolidOperationDetailedResult => ({
      status: 'error',
      code: 'cylinder-diameter-unbuildable',
      category: 'internal',
      details: {
        kernelCode: 'cylinder-diameter-unbuildable',
        message: `blend cluster: diameter ${radius * 2} mm cannot be built with the existing supports and blends`,
        operation: 'resizeCylindricalFace',
        requestedDiameter: radius * 2
      },
      value: null
    });
    const typed = vi
      .spyOn(RemusKernel.prototype, 'resizeCylindricalFaceDetailed')
      .mockImplementation((_solid, _face, radius) => unbuildable(radius));
    const journaled = vi
      .spyOn(RemusKernel.prototype, 'resizeCylindricalFaceJournaled')
      .mockImplementation(() => {
        throw new Error('blend cluster: diameter cannot be built');
      });
    try {
      // 6 -> 6.2 is a 3% change, inside the 15% band that detours.
      const derived = await adapter.syncDocument(
        manager.runTransaction('Resize', [
          commandFactories.directEditBody({
            name: 'Resize Cylinder',
            targetBodyId: bodyId,
            operation: {
              kind: 'resize-cylindrical-face',
              faceHash: wall.hash,
              ...(wall.reference ? { faceReference: wall.reference } : {}),
              sourceRadius: 6,
              sourceAxisStart: wall.geometry!.axisStart!,
              sourceAxisEnd: wall.geometry!.axisEnd!,
              concavity: 'boss',
              radius: 6.2
            }
          })
        ])
      );
      const refusals = (derived.featureWarnings ?? []).filter(
        (entry) => entry.featureName === 'Resize Cylinder'
      );
      expect(refusals.map((entry) => entry.kernelRefusal?.code)).toEqual([
        'cylinder-diameter-unbuildable'
      ]);
      expect(typed.mock.calls.map((call) => call[2])).toEqual([6.2]);
    } finally {
      typed.mockRestore();
      journaled.mockRestore();
    }
  }, 300_000);
});

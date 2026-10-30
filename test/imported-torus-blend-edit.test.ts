import { afterEach, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId, type FaceTopology } from '@openzcad/shared';
import { selectionCapabilities } from '../apps/web/src/lib/interaction/capabilities';
import {
  importedBlendCarriers,
  importedBlendSnapshot
} from '../apps/web/src/lib/interaction/filletFaceEdit';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';

const adapters: Awaited<ReturnType<typeof createExactKernelAdapter>>[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
});

/** Rotation about X by `degrees`, as the kernel's row-major 4×4. */
function tilt(degrees: number): Float64Array {
  const c = Math.cos((degrees * Math.PI) / 180);
  const s = Math.sin((degrees * Math.PI) / 180);
  return Float64Array.from([1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]);
}

/**
 * A Ø40 × 30 base under a Ø24 × 30 neck: R5 on the base's foot, R4 on its
 * shoulder rim and R3 in the neck's root — every round a torus band.
 */
async function importedBottle(tiltDegrees: number) {
  const kernel = new RemusKernel();
  const io = await loadRemusTranslators();
  const neck = kernel.makeCylinder(12, 30);
  kernel.transformSolid(
    neck,
    Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 30, 0, 0, 0, 1])
  );
  let solid = kernel.fuse(kernel.makeCylinder(20, 30), neck);
  const rim = (radius: number, z: number) =>
    Uint32Array.from(
      [...kernel.getSolidEdges(solid)].filter((edge) => {
        if (kernel.getEdgeCurveType(edge) !== 'CIRCLE') return false;
        const [x, y, at] = kernel.getEdgeVertices(edge);
        return (
          Math.abs(at! - z) < 1e-6 &&
          Math.abs(Math.hypot(x!, y!) - radius) < 1e-6
        );
      })
    );
  solid = kernel.fillet(solid, rim(20, 30), 4);
  solid = kernel.fillet(solid, rim(12, 30), 3);
  solid = kernel.fillet(solid, rim(20, 0), 5);
  kernel.transformSolid(solid, tilt(tiltDegrees));
  const stepText = new TextDecoder().decode(
    io.exportStep(kernel.serializeSolid(solid))
  );
  kernel.free();
  const adapter = await createExactKernelAdapter();
  adapters.push(adapter);
  const imported = importStepBody(
    createProjectDocument('Bottle', toUserId('user_test')),
    {
      name: 'root',
      sourceName: 'bottle.step',
      artifactId: 'artifact_bottle',
      stepText
    }
  );
  const derived = await adapter.syncDocument(imported.document);
  expect(derived.warnings).toEqual([]);
  imported.document.derived = derived;
  return {
    adapter,
    document: imported.document,
    bodyId: imported.bodyId,
    body: derived.bodyRepresentations[imported.bodyId]!
  };
}

/** Material a convex quarter-round of radius r takes off a rim of radius R. */
function convexRoundVolume(rimRadius: number, r: number): number {
  const area = r * r * (1 - Math.PI / 4);
  const centroidInset = (r * (10 - 3 * Math.PI)) / (3 * (4 - Math.PI));
  return 2 * Math.PI * (rimRadius - centroidInset) * area;
}

/** Material a concave quarter-round of radius r adds at a root of radius R. */
function concaveRoundVolume(rootRadius: number, r: number): number {
  const area = r * r * (1 - Math.PI / 4);
  const centroidInset = (r * (10 - 3 * Math.PI)) / (3 * (4 - Math.PI));
  return 2 * Math.PI * (rootRadius + centroidInset) * area;
}

function blend(faces: readonly FaceTopology[], radius: number): FaceTopology {
  return faces.find(
    (face) =>
      face.geometry?.surfaceType === 'torus' &&
      Math.abs((face.geometry.blendRadius ?? 0) - radius) < 1e-9
  )!;
}

describe('imported torus blends', () => {
  it.each([0, 30])(
    'carry their axis, so Remove Fillet is offered and exact (tilt %i°)',
    async (tiltDegrees) => {
      const { adapter, document, bodyId, body } =
        await importedBottle(tiltDegrees);
      const expectedAxis = {
        x: 0,
        y: -Math.sin((tiltDegrees * Math.PI) / 180),
        z: Math.cos((tiltDegrees * Math.PI) / 180)
      };
      const faces = body.topology!.faces;
      for (const radius of [3, 4, 5]) {
        const geometry = blend(faces, radius).geometry!;
        // Remus reports a torus's centre and radii but not its axis; the
        // adapter reads it off the surface, and up to sign it is the bottle's.
        expect(
          Math.abs(
            geometry.axis!.x * expectedAxis.x +
              geometry.axis!.y * expectedAxis.y +
              geometry.axis!.z * expectedAxis.z
          )
        ).toBeCloseTo(1, 12);
        expect(geometry.editableDimension).toBe('blendRadius');
      }

      const shoulder = blend(faces, 4);
      const snapshot = importedBlendSnapshot(shoulder);
      expect(snapshot?.surfaceClass).toBe('torus');
      expect(
        selectionCapabilities({
          kind: 'face',
          target: {
            surfaceType: 'other',
            hash: shoulder.hash,
            blendRadius: 4,
            canResizeImportedBlend: snapshot !== null,
            removableBlendCount: importedBlendCarriers(faces).length
          }
        }).map((capability) => capability.action)
      ).toEqual(['edit-fillet', 'remove-fillet', 'remove-all-fillets']);

      // Remove Fillet commits the imported resize at radius zero.
      const manager = new CommandManager(document);
      manager.execute(
        commandFactories.directEditBody({
          name: 'Remove Imported Blend',
          targetBodyId: bodyId,
          operation: {
            kind: 'resize-blend',
            faceHash: shoulder.hash,
            ...(shoulder.reference
              ? { faceReference: shoulder.reference }
              : {}),
            surfaceClass: 'torus',
            recordedRadius: 4,
            recordedCenter: snapshot!.center,
            recordedAxis: snapshot!.axis,
            newRadius: 0
          }
        })
      );
      const removed = await adapter.syncDocument(manager.document);
      expect(removed.warnings).toEqual([]);
      const sharp = removed.bodyRepresentations[bodyId]!;
      expect(sharp.faceCount).toBe(body.faceCount - 1);
      expect(
        sharp.topology!.faces.filter(
          (face) => face.geometry?.surfaceType === 'torus'
        )
      ).toHaveLength(2);
      expect(sharp.volume - body.volume).toBeCloseTo(
        convexRoundVolume(20, 4),
        6
      );
    },
    60_000
  );

  it.each([0, 30])(
    'Remove All Fillets strips every round in one edit (tilt %i°)',
    async (tiltDegrees) => {
      const { adapter, document, bodyId, body } =
        await importedBottle(tiltDegrees);
      const faces = body.topology!.faces;
      const blends = importedBlendCarriers(faces);
      expect(blends.map((carrier) => carrier.radius).sort()).toEqual([3, 4, 5]);
      const seed = blend(faces, 4);
      const removeAll = (
        name: string,
        recorded: typeof blends,
        seedFace = seed
      ) => {
        const manager = new CommandManager(document);
        manager.execute(
          commandFactories.directEditBody({
            name,
            targetBodyId: bodyId,
            operation: {
              kind: 'remove-blends',
              faceHash: seedFace.hash,
              ...(seedFace.reference
                ? { faceReference: seedFace.reference }
                : {}),
              blends: recorded
            }
          })
        );
        return adapter.syncDocument(manager.document);
      };

      const removed = await removeAll('Remove All Imported Blends', blends);
      expect(removed.warnings).toEqual([]);
      const sharp = removed.bodyRepresentations[bodyId]!;
      expect(sharp.faceCount).toBe(body.faceCount - 3);
      expect(
        sharp.topology!.faces.every(
          (face) => face.geometry?.featureType !== 'blend'
        )
      ).toBe(true);
      // The sharp bottle is two stacked cylinders: Ø40 × 30 and Ø24 × 30.
      expect(sharp.volume).toBeCloseTo(
        Math.PI * (20 ** 2 * 30 + 12 ** 2 * 30),
        6
      );
      expect(sharp.volume - body.volume).toBeCloseTo(
        convexRoundVolume(20, 4) +
          convexRoundVolume(20, 5) -
          concaveRoundVolume(12, 3),
        6
      );

      // A recorded round that is gone refuses the whole edit, unchanged.
      const missing = await removeAll('Stale rounds', [
        ...blends,
        { ...blends[0]!, radius: blends[0]!.radius + 1 }
      ]);
      expect(missing.warnings).toEqual([
        expect.stringMatching(
          /^Feature "Stale rounds": The R\d+ torus blend could not be found on the body any more\.$/
        )
      ]);
      expect(missing.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
        body.volume,
        9
      );

      // The seed must be one of the recorded rounds.
      const foreignSeed = await removeAll(
        'Foreign seed',
        blends.filter((carrier) => carrier.radius !== 4)
      );
      expect(foreignSeed.warnings).toEqual([
        'Feature "Foreign seed": The selected blend is not one of the recorded blends.'
      ]);
    },
    60_000
  );
});

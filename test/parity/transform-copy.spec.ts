import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyId } from '@openzcad/shared';
import { OcctStepKernelAdapter } from './occt-reference/occt-step';

describe('transform copies across exact kernels', () => {
  let remus: ExactKernelAdapter;
  let occt: OcctStepKernelAdapter;
  beforeAll(async () => {
    remus = await createExactKernelAdapter();
    occt = await OcctStepKernelAdapter.create();
  });
  afterAll(() => {
    remus.dispose();
    occt.dispose();
  });

  it.each([
    ['translated', 1, { x: 0, y: 0, z: 0 }, [30, 0, 0], [50, 10, 10]],
    ['turned and scaled', 2, { x: 0, y: 0, z: 90 }, [30, -15, -5], [50, 25, 15]]
  ] as const)(
    'keeps the source and publishes the %s copy',
    async (_label, scale, rotationDeg, min, max) => {
      const document = addPrimitiveFeature(
        createProjectDocument('Copy parity', toUserId('user_copy_parity')),
        {
          name: 'Block',
          primitiveKind: 'box',
          dimensions: { width: 20, height: 10, depth: 10 }
        }
      );
      const sourceId = document.bodyOrder[0] as BodyId;
      const copied = transformBody(document, {
        name: 'Copy',
        targetBodyId: sourceId,
        copy: true,
        translation: { x: 30, y: 0, z: 0 },
        rotationDeg,
        scale,
        pivot: { x: '1 cm', y: '5 mm', z: '0.5 cm' }
      });
      for (const adapter of [remus, occt]) {
        const derived = await adapter.syncDocument(copied.document);
        expect(derived.warnings).toEqual([]);
        expect(derived.exportableBodyIds).toEqual([sourceId, copied.bodyId]);
        const source = derived.bodyRepresentations[sourceId]!;
        expect(source.bbox).toEqual({
          min: { x: 0, y: 0, z: 0 },
          max: { x: 20, y: 10, z: 10 }
        });
        expect(source.volume).toBeCloseTo(2_000, 6);
        const copy = derived.bodyRepresentations[copied.bodyId]!;
        expect(copy.volume).toBeCloseTo(2_000 * scale ** 3, 6);
        for (const [index, axis] of (['x', 'y', 'z'] as const).entries()) {
          expect(copy.bbox.min[axis]).toBeCloseTo(min[index]!, 6);
          expect(copy.bbox.max[axis]).toBeCloseTo(max[index]!, 6);
        }
      }
    }
  );
});

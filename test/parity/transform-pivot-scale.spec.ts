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

/**
 * M10: a Move that scales about a pivot builds the same solid in both exact
 * kernels — the OCCT reference applies L = scale·R and p − L·p as well.
 */
describe('transform scale about a pivot across exact kernels', () => {
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
    ['scale only', { x: 0, y: 0, z: 0 }, [-10, -5, -5], [30, 15, 15]],
    ['turn and scale', { x: 0, y: 0, z: 90 }, [0, -15, -5], [20, 25, 15]]
  ] as const)(
    '%s ×2 about the body centre',
    async (_label, rotationDeg, min, max) => {
      // A 20 × 10 × 10 block from the origin: centre (10, 5, 5).
      const document = addPrimitiveFeature(
        createProjectDocument('Pivot scale parity', toUserId('user_m10')),
        {
          name: 'Block',
          primitiveKind: 'box',
          dimensions: { width: 20, height: 10, depth: 10 }
        }
      );
      const blockId = document.bodyOrder[0] as BodyId;
      const scaled = transformBody(document, {
        name: 'Grow',
        targetBodyId: blockId,
        translation: { x: 0, y: 0, z: 0 },
        rotationDeg,
        scale: 2,
        pivot: { x: 10, y: 5, z: 5 }
      }).document;
      for (const adapter of [remus, occt]) {
        const derived = await adapter.syncDocument(scaled);
        expect(derived.warnings).toEqual([]);
        const body = derived.bodyRepresentations[blockId]!;
        expect(body.volume).toBeCloseTo(16_000, 6);
        expect(body.bbox.min.x).toBeCloseTo(min[0], 6);
        expect(body.bbox.min.y).toBeCloseTo(min[1], 6);
        expect(body.bbox.min.z).toBeCloseTo(min[2], 6);
        expect(body.bbox.max.x).toBeCloseTo(max[0], 6);
        expect(body.bbox.max.y).toBeCloseTo(max[1], 6);
        expect(body.bbox.max.z).toBeCloseTo(max[2], 6);
      }
    }
  );
});

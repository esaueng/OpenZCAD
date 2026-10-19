import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  booleanBodies,
  createProjectDocument,
  extrudeSketch,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BooleanKeepOriginals,
  type BooleanOperation,
  type ProjectDocument
} from '@openzcad/shared';
import { OcctStepKernelAdapter } from './occt-step';

/**
 * Research-audit Stage 4 (schema v22) across both kernels: the extrude
 * Intersect intent (ZC-060) and Boolean keep-originals (M11). Each volume is
 * checked against its closed form on both, not one kernel against the other,
 * so a shared mistake cannot read as parity. The OCCT reference does not
 * model Split, so split keep-original is covered by the Remus suite only.
 */
const user = toUserId('user_solid_options_parity');
const CUBE = 1000;
const ORACLE: Record<BooleanOperation, number> = {
  union: 1750,
  subtract: 750,
  intersect: 250
};

function cubePair(): { document: ProjectDocument; a: BodyId; b: BodyId } {
  let document = createProjectDocument('Cube pair', user);
  for (const name of ['A', 'B']) {
    document = addPrimitiveFeature(document, {
      name,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
  }
  const [a, b] = document.bodyOrder as [BodyId, BodyId];
  document = transformBody(document, {
    name: 'Offset B',
    targetBodyId: b,
    translation: { x: 5, y: 5, z: 0 }
  }).document;
  return { document, a, b };
}

describe('Stage 4 solid options: Remus and OCCT closed forms', () => {
  let remus: ExactKernelAdapter;
  let occt: OcctStepKernelAdapter;
  beforeAll(async () => {
    remus = await createExactKernelAdapter();
    occt = await OcctStepKernelAdapter.create();
  });
  afterAll(() => {
    occt.dispose();
  });

  function near(actual: number | undefined, expected: number) {
    expect(actual).toBeDefined();
    expect(Math.abs(actual! - expected)).toBeLessThan(expected * 1e-6);
  }

  it.each([
    [undefined, [true, true]],
    ['all', [false, false]],
    ['target', [false, true]],
    ['tools', [true, false]]
  ] as [BooleanKeepOriginals | undefined, [boolean, boolean]][])(
    'keeps originals %s with the cube-pair volumes',
    async (keepOriginals, [aConsumed, bConsumed]) => {
      for (const operation of ['union', 'subtract', 'intersect'] as const) {
        const { document, a, b } = cubePair();
        const result = booleanBodies(document, {
          name: operation,
          operation,
          targetBodyIds: [a, b],
          ...(keepOriginals ? { keepOriginals } : {})
        });
        for (const kernel of [remus, occt]) {
          const derived = await kernel.syncDocument(result.document);
          expect(derived.warnings).toEqual([]);
          near(
            derived.bodyRepresentations[result.bodyId]?.volume,
            ORACLE[operation]
          );
          expect(derived.bodyRepresentations[a]?.consumed).toBe(aConsumed);
          expect(derived.bodyRepresentations[b]?.consumed).toBe(bConsumed);
          if (!aConsumed) near(derived.bodyRepresentations[a]?.volume, CUBE);
          if (!bConsumed) near(derived.bodyRepresentations[b]?.volume, CUBE);
        }
      }
    }
  );

  it('intersects an extrude with its target to the shared column', async () => {
    let document = createProjectDocument('Intersect extrude', user);
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 10 }
    });
    const blockId = document.bodyOrder[0]!;
    const sketched = addSketchFeature(document, {
      name: 'Square',
      planeRef: { type: 'canonical', plane: 'XY', offset: -5 },
      objects: [
        {
          objectKind: 'rectangle',
          width: 10,
          height: 10,
          centerX: 10,
          centerY: 10
        }
      ]
    });
    const created = extrudeSketch(sketched.document, {
      name: 'Keep column',
      sketchId: sketched.sketchId,
      distance: 20,
      operation: 'intersect',
      targetBodyId: blockId
    });
    for (const kernel of [remus, occt]) {
      const derived = await kernel.syncDocument(created.document);
      expect(derived.warnings).toEqual([]);
      near(derived.bodyRepresentations[created.bodyId]?.volume, 1000);
      expect(derived.bodyRepresentations[blockId]?.consumed).toBe(true);
    }
  });
});

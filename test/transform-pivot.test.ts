import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder,
  transformBody,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * M10 Stage 1b (schema v22): a Move stores the point it turns and scales
 * about. Round trips restore the body exactly, a rotation about the body's
 * centre turns it in place, uniform scale ×2 gives ×8 volume about the
 * pivot, and editing a rotation later keeps the stored pivot.
 */
describe('transform pivot (M10)', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  // A 20 × 10 × 10 block from the origin: centre (10, 5, 5).
  const block = () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Pivot', toUserId('user_m10')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 10, depth: 10 }
      }
    );
    return { document, blockId: document.bodyOrder[0] as BodyId };
  };
  const centre = { x: 10, y: 5, z: 5 };
  const zero = { x: 0, y: 0, z: 0 };

  async function bounds(document: ProjectDocument, bodyId: BodyId) {
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[bodyId]!;
    const r = (value: number) => Math.round(value * 1e6) / 1e6 || 0;
    return {
      min: [r(body.bbox.min.x), r(body.bbox.min.y), r(body.bbox.min.z)],
      max: [r(body.bbox.max.x), r(body.bbox.max.y), r(body.bbox.max.z)],
      volume: Math.round(body.volume * 1e3) / 1e3
    };
  }

  it('moves +10 then −10 back to exactly where it was', async () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBe(25);
    const { document, blockId } = block();
    const before = await bounds(document, blockId);
    let moved = transformBody(document, {
      name: 'Out',
      targetBodyId: blockId,
      translation: { x: 10, y: 0, z: 0 }
    }).document;
    moved = transformBody(moved, {
      name: 'Back',
      targetBodyId: blockId,
      translation: { x: -10, y: 0, z: 0 }
    }).document;
    expect(await bounds(moved, blockId)).toEqual(before);
  });

  it('turns about its pivot, and the inverse turn restores it', async () => {
    const { document, blockId } = block();
    const before = await bounds(document, blockId);
    const turned = transformBody(document, {
      name: 'Turn',
      targetBodyId: blockId,
      translation: zero,
      rotationDeg: { x: 0, y: 0, z: 90 },
      pivot: centre
    }).document;
    // About (10, 5): x' = 10 − (y − 5), y' = 5 + (x − 10).
    expect(await bounds(turned, blockId)).toMatchObject({
      min: [5, -5, 0],
      max: [15, 15, 10]
    });
    const back = transformBody(turned, {
      name: 'Unturn',
      targetBodyId: blockId,
      translation: zero,
      rotationDeg: { x: 0, y: 0, z: -90 },
      pivot: centre
    }).document;
    expect(await bounds(back, blockId)).toEqual(before);
    // The same turn about the world origin lands somewhere else entirely.
    const aboutOrigin = transformBody(document, {
      name: 'Turn at origin',
      targetBodyId: blockId,
      translation: zero,
      rotationDeg: { x: 0, y: 0, z: 90 }
    }).document;
    expect(await bounds(aboutOrigin, blockId)).toMatchObject({
      min: [-10, 0, 0],
      max: [0, 20, 10]
    });
  });

  it('scales ×2 about its pivot for ×8 the volume, centre fixed', async () => {
    const { document, blockId } = block();
    const scaled = transformBody(document, {
      name: 'Grow',
      targetBodyId: blockId,
      translation: zero,
      scale: 2,
      pivot: centre
    }).document;
    expect(await bounds(scaled, blockId)).toEqual({
      min: [-10, -5, -5],
      max: [30, 15, 15],
      volume: 16000
    });
  });

  it('keeps the stored pivot when the rotation is edited later', async () => {
    // What the gizmo writes: a turn about the body's centre. Editing the
    // angle afterwards must still turn it in place, not about the origin.
    const { document, blockId } = block();
    let next = transformBody(document, {
      name: 'Gizmo turn',
      targetBodyId: blockId,
      translation: { x: 1, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 90 },
      pivot: centre
    }).document;
    const move = listFeaturesInOrder(next).find(
      (feature) => feature.name === 'Gizmo turn'
    )!;
    if (move.data.featureKind !== 'transform') throw new Error('not a move');
    next = updateFeature(next, {
      featureId: move.featureId,
      data: {
        transform: {
          ...move.data.transform,
          rotationDeg: { x: 0, y: 0, z: 180 }
        }
      }
    });
    // Half a turn about (10, 5) maps the block onto itself, then +1 in x.
    expect(await bounds(next, blockId)).toMatchObject({
      min: [1, 0, 0],
      max: [21, 10, 10]
    });
  });
});

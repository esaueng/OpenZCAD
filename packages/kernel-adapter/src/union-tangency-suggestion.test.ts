import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from './boolean-result-validation';
import { createExactKernelAdapter } from './exact';

const user = toUserId('user_tangency');

/**
 * A new box is corner-origin and a new cylinder is axis-origin, so creating
 * one of each puts the cylinder's axis exactly on the box's corner edge.
 * Historical kernels could not resolve that contact without faceting or
 * opening the result; the current kernel preserves the exact cylinder wall.
 */
function boxAndCylinder(move: { x: number; y: number; z: number } | null): {
  document: ProjectDocument;
  boxId: BodyId;
  cylId: BodyId;
} {
  let doc = addPrimitiveFeature(createProjectDocument('Tangency', user), {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 30, height: 18, depth: 24 }
  });
  const boxId = doc.bodyOrder[0] as BodyId;
  doc = addPrimitiveFeature(doc, {
    name: 'Cylinder',
    primitiveKind: 'cylinder',
    dimensions: { radius: 6, height: 28 }
  });
  let cylId = doc.bodyOrder[1] as BodyId;
  if (move) {
    const moved = transformBody(doc, {
      name: 'Place',
      targetBodyId: cylId,
      translation: move,
      rotationDeg: { x: 0, y: 0, z: 0 }
    });
    doc = moved.document;
    cylId = moved.bodyId;
  }
  return { document: doc, boxId, cylId };
}

describe('union corner-axis tangency', { timeout: 60_000 }, () => {
  it('preserves exact topology when the corner-axis union succeeds', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const { document, boxId, cylId } = boxAndCylinder(null);
      const united = booleanBodies(document, {
        name: 'Union',
        operation: 'union',
        targetBodyIds: [boxId, cylId]
      }).document;
      const derived = await adapter.syncDocument(united);
      const resultId = united.bodyOrder.at(-1)!;
      const body = derived.bodyRepresentations[resultId]!;

      expect(derived.warnings).toEqual([]);
      expect(body.volume).toBeCloseTo(
        30 * 18 * 24 + Math.PI * 6 ** 2 * (28 - 24 / 4),
        5
      );
      expect(
        body.topology?.faces.some(
          (face) => face.geometry?.surfaceType === 'cylinder'
        )
      ).toBe(true);
      expect(
        isClosedConsistentlyOrientedMesh(
          inspectTriangleMeshClosure(body.mesh.vertices, body.mesh.indices)
        )
      ).toBe(true);

      const step = await adapter.exportStep(united, [resultId]);
      expect(step).toContain('CYLINDRICAL_SURFACE');
      await expect(adapter.inspectStep(step)).resolves.toMatchObject({
        solid: true,
        valid: true
      });
    } finally {
      adapter.dispose();
    }
  });

  it('stays quiet when the union already succeeds', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const { document, boxId, cylId } = boxAndCylinder({ x: 15, y: 9, z: 0 });
      const united = booleanBodies(document, {
        name: 'Union',
        operation: 'union',
        targetBodyIds: [boxId, cylId]
      }).document;
      const derived = await adapter.syncDocument(united);
      expect(derived.warnings).toEqual([]);
    } finally {
      adapter.dispose();
    }
  });

  it('sizes the default cylinder so the first union is reachable', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      // The shipped defaults, as PRIMITIVE_FIELDS states them. A cylinder wider
      // than the box's smallest footprint cannot union exactly at ANY position,
      // so this pairing is a property of the defaults rather than of placement:
      // measured against this box, radius 8 is the last that works and 9 is the
      // first that facets, where the diameter reaches the 18 mm depth.
      const { document, boxId, cylId } = boxAndCylinder({ x: 15, y: 9, z: 0 });
      expect((await adapter.syncDocument(document)).warnings).toEqual([]);
      const united = booleanBodies(document, {
        name: 'Union',
        operation: 'union',
        targetBodyIds: [boxId, cylId]
      }).document;
      expect((await adapter.syncDocument(united)).warnings).toEqual([]);
    } finally {
      adapter.dispose();
    }
  });
});

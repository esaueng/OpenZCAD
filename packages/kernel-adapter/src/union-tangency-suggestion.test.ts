import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import { createExactKernelAdapter } from './exact';

const user = toUserId('user_tangency');

/**
 * A new box is corner-origin and a new cylinder is axis-origin, so creating
 * one of each puts the cylinder's axis exactly on the box's corner edge —
 * the one contact the fuse cannot resolve exactly. The refusal therefore has
 * to name the move that clears it, because the repair a user reaches for
 * first (slide it along X) keeps the axis in a face plane and fails again.
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

describe('union tangency suggestion', { timeout: 60_000 }, () => {
  it('names a move that actually clears the tangency, and it works', async () => {
    const adapter = await createExactKernelAdapter();
    try {
      const { document, boxId, cylId } = boxAndCylinder(null);
      const attempted = booleanBodies(document, {
        name: 'Union',
        operation: 'union',
        targetBodyIds: [boxId, cylId]
      }).document;
      const refused = await adapter.syncDocument(attempted);
      const message = refused.warnings.join(' ');
      expect(message).toMatch(/faceted approximation|replaced every curved/);

      // The suggestion is concrete: a body, a signed amount, an axis.
      const suggestion = /Moving (.+?) ([+-]?[\d.]+) mm in ([XYZ]) clears it\./.exec(
        message
      );
      expect(suggestion, `no offset suggested in: ${message}`).not.toBeNull();
      const [, movedName, amountText, axis] = suggestion!;
      expect(movedName).toBe('Cylinder Body');
      const amount = Number(amountText);

      // Apply exactly what it said and the same union must now succeed. A
      // suggestion that does not work is worse than the general advice it
      // replaces, so this is the assertion that matters.
      const applied = boxAndCylinder({
        x: axis === 'X' ? amount : 0,
        y: axis === 'Y' ? amount : 0,
        z: axis === 'Z' ? amount : 0
      });
      const united = booleanBodies(applied.document, {
        name: 'Union',
        operation: 'union',
        targetBodyIds: [applied.boxId, applied.cylId]
      }).document;
      const derived = await adapter.syncDocument(united);
      expect(derived.warnings).toEqual([]);
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

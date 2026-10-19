import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type BodyId } from '@openzcad/shared';
import { affectedFeatureTargets } from './affectedFeatureTargets';
import { featureHistory, featureResultBodyIds } from './featureHistory';
import { primitivePlacement } from './primitivePlacement';
import { bodyFeature } from './selectionFeature';

/**
 * M10: a transform copy owns its own body and leaves its source live. The
 * rules that read "the transform of body X" as an in-place edit — selection,
 * the primitive's placement Move, the history graph — must not mistake it
 * for one.
 */
describe('transform copy in the history rules (M10)', () => {
  const setup = () => {
    let document = addPrimitiveFeature(
      createProjectDocument('Copy rules', toUserId('user_m10_rules')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      }
    );
    const boxId = document.bodyOrder[0] as BodyId;
    const copied = transformBody(document, {
      name: 'Copy',
      targetBodyId: boxId,
      translation: { x: 20, y: 0, z: 0 },
      copy: true
    });
    document = copied.document;
    const [primitive, copy] = listFeaturesInOrder(document);
    return { document, boxId, copyId: copied.bodyId, primitive, copy };
  };

  it('gives the copy its own body and leaves the source with its producer', () => {
    const { document, boxId, copyId, primitive, copy } = setup();
    expect(copyId).not.toBe(boxId);
    expect(featureResultBodyIds(copy!)).toEqual([copyId]);
    expect(bodyFeature(document, boxId)?.featureId).toBe(primitive!.featureId);
    expect(bodyFeature(document, copyId)?.featureId).toBe(copy!.featureId);
  });

  it('is not the primitive placement Move', () => {
    const { document, primitive } = setup();
    expect(primitivePlacement(document, primitive!).feature).toBeNull();
  });

  it('depends on its source, and a source edit reaches the copy', () => {
    const { document, boxId, copyId, primitive, copy } = setup();
    const { parents, downstream } = featureHistory(document);
    expect([...parents.get(copy!.featureId)!]).toEqual([primitive!.featureId]);
    expect(downstream(primitive!.featureId).map((f) => f.featureId)).toEqual([
      copy!.featureId
    ]);
    expect(
      affectedFeatureTargets(document, primitive!.featureId).map(
        (target) => target.resultBodyId
      )
    ).toEqual([boxId, copyId]);
    // Editing the copy reaches its own body, never the source.
    expect(
      affectedFeatureTargets(document, copy!.featureId).map(
        (target) => target.resultBodyId
      )
    ).toEqual([copyId]);
  });
});

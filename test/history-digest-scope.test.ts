import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSplitFeature,
  booleanBodies,
  createBodyFeatureIds,
  createProjectDocument,
  importStepBody,
  listFeaturesInOrder,
  setParameter,
  transformBody
} from '../packages/document-core/src/index';
import { toUserId } from '../packages/shared/src/index';
import { historyFeatureDigest } from '../packages/kernel-adapter/src/exact-history-cache';

function fixture(planeOffset: number | string) {
  const imported = importStepBody(
    setParameter(createProjectDocument('Digest', toUserId('user_digest')), {
      name: 'opening_width',
      expression: '46'
    }),
    {
      name: 'Source',
      artifactId: 'source',
      sourceName: 'source.step',
      stepText: 'ISO-10303-21;'
    }
  );
  const split = addSplitFeature(imported.document, {
    name: 'Cut',
    targetBodyId: imported.bodyId,
    plane: { origin: { x: planeOffset, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
  });
  const moved = transformBody(split.document, {
    name: 'Move',
    targetBodyId: split.bodyId,
    translation: { x: 'opening_width / 2', y: 0, z: 0 }
  });
  return moved.document;
}

const digests = (document: ReturnType<typeof fixture>) =>
  listFeaturesInOrder(document).map((feature, index) =>
    historyFeatureDigest(document, feature, index)
  );

describe('history feature digests and the parameter scope', () => {
  it('keeps a literal-plane split checkpoint across a parameter edit', () => {
    const before = fixture(-4);
    const after = setParameter(before, {
      name: 'opening_width',
      expression: '55'
    });
    const [importBefore, splitBefore, moveBefore] = digests(before);
    const [importAfter, splitAfter, moveAfter] = digests(after);
    expect(importAfter).toBe(importBefore);
    expect(splitAfter).toBe(splitBefore);
    // A feature that reads a parameter still sees the edit.
    expect(moveAfter).not.toBe(moveBefore);
  });

  it('keeps literal masks, placements and Booleans across a parameter edit', () => {
    const imported = importStepBody(
      setParameter(createProjectDocument('Digest', toUserId('user_digest')), {
        name: 'opening_width',
        expression: '46'
      }),
      {
        name: 'Source',
        artifactId: 'source',
        sourceName: 'source.step',
        stepText: 'ISO-10303-21;'
      }
    );
    const maskIds = createBodyFeatureIds();
    const masked = addPrimitiveFeature(imported.document, {
      name: 'Mask',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 },
      ids: maskIds
    });
    const placed = transformBody(masked, {
      name: 'Place',
      targetBodyId: maskIds.bodyId,
      translation: { x: -5, y: -5, z: -5 }
    });
    const carved = booleanBodies(placed.document, {
      name: 'Carve',
      operation: 'intersect',
      targetBodyIds: [imported.bodyId, maskIds.bodyId]
    });
    const parametric = transformBody(carved.document, {
      name: 'Move',
      targetBodyId: carved.bodyId,
      translation: { x: '(46 - opening_width) / 2', y: 0, z: 0 }
    });
    const before = parametric.document;
    const after = setParameter(before, {
      name: 'opening_width',
      expression: '55'
    });
    const stable = digests(before);
    const changed = digests(after);
    expect(changed.slice(0, 4)).toEqual(stable.slice(0, 4));
    expect(changed[4]).not.toBe(stable[4]);
  });

  it('still invalidates a split whose plane reads a parameter', () => {
    const before = fixture('opening_width / 2');
    const after = setParameter(before, {
      name: 'opening_width',
      expression: '55'
    });
    expect(digests(after)[1]).not.toBe(digests(before)[1]);
  });

  it('still sees a changed literal plane', () => {
    expect(digests(fixture(-4))[1]).not.toBe(digests(fixture(-5))[1]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  filletBody,
  getLatestBodyId,
  resizeBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

describe('document-core', () => {
  it('creates a stable project scaffold', () => {
    const document = createProjectDocument('Test', toUserId('user_test'));
    expect(document.name).toBe('Test');
    expect(
      Object.values(document.nodes).some((node) => node.kind === 'project')
    ).toBe(true);
    expect(document.revisions).toHaveLength(1);
  });

  it('adds primitives and extrudes sketches into bodies', () => {
    let document = createProjectDocument('Test', toUserId('user_test'));
    document = addPrimitiveFeature(document, {
      name: 'Box 1',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 20, depth: 30 }
    });

    const sketchResult = addSketchFeature(document, {
      name: 'Sketch 1',
      plane: 'XY',
      objectKind: 'rectangle',
      rectangle: { width: 20, height: 10 }
    });
    document = extrudeSketch(sketchResult.document, {
      name: 'Extrude',
      sketchId: sketchResult.sketchId,
      distance: 15
    }).document;

    expect(document.bodyOrder).toHaveLength(2);
    expect(getLatestBodyId(document)).toBeTruthy();
  });

  it('commits direct primitive edits and fillet intent to the document model', () => {
    let document = createProjectDocument('Direct Edit', toUserId('user_test'));
    document = addPrimitiveFeature(document, {
      name: 'Editable box',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 20, depth: 30 }
    });
    const bodyId = getLatestBodyId(document);
    expect(bodyId).toBeTruthy();
    if (!bodyId) {
      return;
    }

    document = resizeBody(document, {
      targetBodyId: bodyId,
      dimension: 'width',
      value: 42
    });
    document = filletBody(document, {
      targetBodyId: bodyId,
      edgeIds: [`${bodyId}:m0:e2`],
      radius: 3
    });

    const feature = Object.values(document.nodes).find(
      (node) => node.kind === 'feature' && node.bodyId === bodyId
    );
    expect(feature?.kind).toBe('feature');
    if (
      feature?.kind === 'feature' &&
      feature.data.featureKind === 'primitive'
    ) {
      expect(feature.data.dimensions.width).toBe(42);
      expect(feature.data.fillet).toEqual({
        radius: 3,
        edgeIds: [`${bodyId}:m0:e2`]
      });
    }
  });
});

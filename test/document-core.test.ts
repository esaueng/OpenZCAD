import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  getLatestBodyId
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

describe('document-core', () => {
  it('creates a stable project scaffold', () => {
    const document = createProjectDocument('Test', toUserId('user_test'));
    expect(document.name).toBe('Test');
    expect(Object.values(document.nodes).some((node) => node.kind === 'project')).toBe(true);
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
});


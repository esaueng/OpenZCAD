import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  evaluateExpression,
  extrudeSketch,
  getLatestBodyId
} from '@openzcad/document-core';
import { sanitizeFileName, toUserId } from '@openzcad/shared';

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

  it('does not mutate the input document', () => {
    const original = createProjectDocument('Test', toUserId('user_test'));
    const nodeCount = Object.keys(original.nodes).length;
    addPrimitiveFeature(original, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    expect(Object.keys(original.nodes)).toHaveLength(nodeCount);
    expect(original.featureOrder).toHaveLength(0);
    expect(original.version).toBe(1);
  });
});

describe('evaluateExpression', () => {
  const scope = { width: 10, height: 4 };

  it('evaluates arithmetic with precedence and parentheses', () => {
    expect(evaluateExpression('1 + 2 * 3', {})).toBe(7);
    expect(evaluateExpression('(1 + 2) * 3', {})).toBe(9);
    expect(evaluateExpression('10 / 4', {})).toBe(2.5);
    expect(evaluateExpression('-3 + 5', {})).toBe(2);
    expect(evaluateExpression('2 * -4', {})).toBe(-8);
    expect(evaluateExpression('.5 + 1.25', {})).toBe(1.75);
  });

  it('resolves identifiers from the provided scope', () => {
    expect(evaluateExpression('width * height / 2', scope)).toBe(20);
    expect(evaluateExpression('width - (height + 1)', scope)).toBe(5);
  });

  it('rejects unknown identifiers instead of touching globals', () => {
    expect(() => evaluateExpression('globalThis', scope)).toThrow(/Unknown identifier/);
    expect(() => evaluateExpression('alert(1)', scope)).toThrow();
  });

  it('rejects malformed expressions', () => {
    expect(() => evaluateExpression('1 +', {})).toThrow();
    expect(() => evaluateExpression('(1 + 2', {})).toThrow();
    expect(() => evaluateExpression('1 ; 2', {})).toThrow(/Unexpected character/);
    expect(() => evaluateExpression('1 / 0', {})).toThrow(/finite/);
  });
});

describe('sanitizeFileName', () => {
  it('strips path segments and hostile characters', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\temp\\part one.step')).toBe('part-one.step');
    expect(sanitizeFileName('weird\u0001name.stl')).toBe('weirdname.stl');
    expect(sanitizeFileName('....///')).toBe('upload');
    expect(sanitizeFileName('model (v2).stl')).toBe('model-v2-.stl');
  });

  it('caps the length', () => {
    expect(sanitizeFileName(`${'a'.repeat(300)}.stl`).length).toBeLessThanOrEqual(128);
  });
});


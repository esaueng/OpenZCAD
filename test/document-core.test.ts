import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  deleteFeature,
  deleteParameter,
  evaluateExpression,
  extrudeSketch,
  getLatestBodyId,
  getParameterScope,
  listFeaturesInOrder,
  listParameters,
  resolveParamValue,
  setParameter,
  updateFeature,
  updateSketch
} from '@openzcad/document-core';
import { sanitizeFileName, toUserId } from '@openzcad/shared';

const user = () => toUserId('user_test');

describe('document-core', () => {
  it('creates a stable project scaffold', () => {
    const document = createProjectDocument('Test', user());
    expect(document.name).toBe('Test');
    expect(Object.values(document.nodes).some((node) => node.kind === 'project')).toBe(true);
    expect(document.revisions).toHaveLength(1);
    expect(document.parameterOrder).toEqual([]);
  });

  it('adds primitives and extrudes sketches into bodies', () => {
    let document = createProjectDocument('Test', user());
    document = addPrimitiveFeature(document, {
      name: 'Box 1',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 20, depth: 30 }
    });

    const sketchResult = addSketchFeature(document, {
      name: 'Sketch 1',
      plane: 'XY',
      offset: 0,
      object: { objectKind: 'rectangle', width: 20, height: 10, centerX: 0, centerY: 0 }
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
    const original = createProjectDocument('Test', user());
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

describe('parameters', () => {
  it('upserts parameters and evaluates dependent expressions in any order', () => {
    let document = createProjectDocument('Params', user());
    document = setParameter(document, { name: 'total', expression: 'width * 2' });
    document = setParameter(document, { name: 'width', expression: '21' });

    const { scope, errors } = getParameterScope(document);
    expect(errors).toEqual([]);
    expect(scope.width).toBe(21);
    expect(scope.total).toBe(42);

    document = setParameter(document, { name: 'width', expression: '10' });
    expect(getParameterScope(document).scope.total).toBe(20);
    expect(listParameters(document)).toHaveLength(2);
  });

  it('reports cycles and unknown references as per-parameter errors', () => {
    let document = createProjectDocument('Params', user());
    document = setParameter(document, { name: 'a', expression: 'b + 1' });
    document = setParameter(document, { name: 'b', expression: 'a + 1' });
    const { scope, errors } = getParameterScope(document);
    expect(Object.keys(scope)).toHaveLength(0);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/Parameter "a"/);
  });

  it('rejects invalid names and deletes by name', () => {
    let document = createProjectDocument('Params', user());
    expect(() => setParameter(document, { name: '2bad', expression: '1' })).toThrow(
      /not a valid parameter name/
    );
    expect(() => setParameter(document, { name: 'sin', expression: '1' })).toThrow(
      /not a valid parameter name/
    );
    document = setParameter(document, { name: 'keep', expression: '5' });
    document = deleteParameter(document, { name: 'keep' });
    expect(listParameters(document)).toHaveLength(0);
    expect(() => deleteParameter(document, { name: 'keep' })).toThrow(/not found/);
  });

  it('resolves literal and expression ParamValues', () => {
    expect(resolveParamValue(4, {})).toBe(4);
    expect(resolveParamValue('w / 2', { w: 9 })).toBe(4.5);
    expect(() => resolveParamValue('missing', {}, 'width')).toThrow(/^width:/);
  });
});

describe('feature editing', () => {
  it('merges primitive dimension patches and renames', () => {
    let document = createProjectDocument('Edit', user());
    document = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 20, depth: 30 }
    });
    const feature = listFeaturesInOrder(document)[0]!;
    document = updateFeature(document, {
      featureId: feature.featureId,
      name: 'Base Block',
      data: { dimensions: { width: 'w * 2' } }
    });
    const updated = listFeaturesInOrder(document)[0]!;
    expect(updated.name).toBe('Base Block');
    expect(updated.data.featureKind).toBe('primitive');
    if (updated.data.featureKind === 'primitive') {
      expect(updated.data.dimensions).toEqual({ width: 'w * 2', height: 20, depth: 30 });
    }
  });

  it('refuses to change a feature kind', () => {
    let document = createProjectDocument('Edit', user());
    document = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const feature = listFeaturesInOrder(document)[0]!;
    expect(() =>
      updateFeature(document, {
        featureId: feature.featureId,
        data: { featureKind: 'extrude' } as never
      })
    ).toThrow(/cannot change kind/);
  });

  it('updates sketch plane, offset, and profile', () => {
    let document = createProjectDocument('Edit', user());
    const { document: withSketch, sketchId } = addSketchFeature(document, {
      name: 'Profile',
      plane: 'XY',
      offset: 0,
      object: { objectKind: 'rectangle', width: 10, height: 10, centerX: 0, centerY: 0 }
    });
    document = updateSketch(withSketch, {
      sketchId,
      plane: 'XZ',
      offset: 'lift',
      object: { objectKind: 'circle', radius: 7, centerX: 1, centerY: 2 }
    });
    const sketch = Object.values(document.nodes).find((node) => node.kind === 'sketch');
    expect(sketch?.kind).toBe('sketch');
    if (sketch?.kind === 'sketch') {
      expect(sketch.plane).toBe('XZ');
      expect(sketch.offset).toBe('lift');
      const objectNode = document.nodes[sketch.objectIds[0]!];
      expect(objectNode?.kind).toBe('sketch-object');
      if (objectNode?.kind === 'sketch-object') {
        expect(objectNode.data).toEqual({
          objectKind: 'circle',
          radius: 7,
          centerX: 1,
          centerY: 2
        });
      }
    }
  });

  it('deletes a feature with its body, and sketch features with their sketches', () => {
    let document = createProjectDocument('Delete', user());
    document = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    const { document: withSketch, sketchId } = addSketchFeature(document, {
      name: 'Profile',
      plane: 'XY',
      offset: 0,
      object: { objectKind: 'circle', radius: 5, centerX: 0, centerY: 0 }
    });
    document = withSketch;

    const [boxFeature, sketchFeature] = listFeaturesInOrder(document);
    document = deleteFeature(document, { featureId: boxFeature!.featureId });
    expect(document.bodyOrder).toHaveLength(0);
    expect(document.featureOrder).toHaveLength(1);

    document = deleteFeature(document, { featureId: sketchFeature!.featureId });
    expect(document.sketchOrder).not.toContain(sketchId);
    expect(Object.values(document.nodes).some((node) => node.kind === 'sketch')).toBe(false);
    expect(
      Object.values(document.nodes).some((node) => node.kind === 'sketch-object')
    ).toBe(false);

    const part = document.nodes[document.activePartId];
    expect(part?.kind).toBe('part');
    if (part?.kind === 'part') {
      expect(part.childIds).toHaveLength(0);
    }
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

  it('supports power, functions, and the pi constant', () => {
    expect(evaluateExpression('2 ^ 10', {})).toBe(1024);
    expect(evaluateExpression('2 ^ 3 ^ 2', {})).toBe(512);
    expect(evaluateExpression('sqrt(81)', {})).toBe(9);
    expect(evaluateExpression('min(3, 8, -2)', {})).toBe(-2);
    expect(evaluateExpression('max(width, height)', scope)).toBe(10);
    expect(evaluateExpression('sin(30)', {})).toBeCloseTo(0.5, 10);
    expect(evaluateExpression('cos(60)', {})).toBeCloseTo(0.5, 10);
    expect(evaluateExpression('round(2.6)', {})).toBe(3);
    expect(evaluateExpression('pi', {})).toBeCloseTo(Math.PI, 12);
    expect(evaluateExpression('2 * pi * 10', {})).toBeCloseTo(62.8318, 3);
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
    expect(() => evaluateExpression('sqrt(4, 9)', {})).toThrow(/one argument/);
    expect(() => evaluateExpression('nope(1)', {})).toThrow(/Unknown function/);
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

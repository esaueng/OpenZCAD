import { describe, expect, it } from 'vitest';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  evaluateExpression,
  evaluateFieldExpression,
  getParameterScope,
  listParameters,
  newTypedParameterMisuse,
  normalizeDocument,
  renameNode,
  renameParameter,
  parameterKindsOf,
  parameterQuantityRefusal,
  setParameter,
  suggestParameterQuantities,
  suggestParameterQuantity
} from './index';
import { rewriteNodeExpressions } from './parameter-expressions';

/**
 * F05 Stage 1a (schema v21): a parameter may say what it measures. A typed
 * parameter carries its dimension into expressions, so `width + 5 mm`
 * evaluates; a quantity is refused where it would break a use; an untyped
 * parameter behaves exactly as before.
 */

const blank = () =>
  createProjectDocument('Typed parameters', toUserId('user_f05_typed'));

const quantityOf = (document: ProjectDocument, name: string) =>
  listParameters(document).find((parameter) => parameter.name === name)
    ?.quantity;

describe('typed parameters in expressions', () => {
  it('lets a length parameter add to a suffixed length', () => {
    let document = setParameter(blank(), {
      name: 'width',
      expression: '10',
      quantity: 'length'
    });
    document = setParameter(document, {
      name: 'outer',
      expression: 'width + 5 mm',
      quantity: 'length'
    });
    const { scope, errors } = getParameterScope(document);
    expect(errors).toEqual([]);
    expect(scope.outer).toBe(15);
    // Inches convert into the document's millimetres alongside it.
    expect(
      evaluateExpression('width + 1 in', scope, { documentUnits: 'mm' })
    ).toBeCloseTo(35.4, 12);
  });

  it('keeps an untyped parameter unitless, as before v21', () => {
    const document = setParameter(blank(), { name: 'width', expression: '10' });
    const { scope } = getParameterScope(document);
    expect(() =>
      evaluateExpression('width + 5 mm', scope, { documentUnits: 'mm' })
    ).toThrow(/Incompatible dimensions/);
    expect(evaluateExpression('width + 5', scope)).toBe(15);
  });

  it('refuses a typed field that receives the wrong quantity', () => {
    const document = setParameter(blank(), {
      name: 'tilt',
      expression: '30 deg',
      quantity: 'angle'
    });
    const { scope } = getParameterScope(document);
    expect(() =>
      evaluateFieldExpression('tilt', scope, {
        documentUnits: 'mm',
        dimension: 'length'
      })
    ).toThrow(/expected a length/);
    expect(
      evaluateFieldExpression('tilt', scope, {
        documentUnits: 'mm',
        dimension: 'angle'
      })
    ).toBe(30);
  });

  it('carries kinds on the scope without changing its keys', () => {
    const document = setParameter(blank(), {
      name: 'width',
      expression: '10',
      quantity: 'length'
    });
    const { scope } = getParameterScope(document);
    expect(Object.keys(scope)).toEqual(['width']);
    expect(JSON.stringify(scope)).toBe('{"width":10}');
    expect(parameterKindsOf(scope)).toEqual({ width: 'length' });
    // Deep equality ignores it, so scopes still compare as plain records.
    expect(scope).toEqual({ width: 10 });
  });
});

describe('setting a quantity', () => {
  it('refuses an expression that does not hold the quantity', () => {
    expect(() =>
      setParameter(blank(), {
        name: 'count',
        expression: '5 mm',
        quantity: 'number'
      })
    ).toThrow(/Incompatible dimensions/);
  });

  it('keeps the quantity across expression edits and clears it with null', () => {
    let document = setParameter(blank(), {
      name: 'width',
      expression: '10',
      quantity: 'length'
    });
    document = setParameter(document, { name: 'width', expression: '12' });
    expect(quantityOf(document, 'width')).toBe('length');
    document = setParameter(document, {
      name: 'width',
      expression: '12',
      quantity: null
    });
    expect(quantityOf(document, 'width')).toBeUndefined();
  });

  it('refuses a quantity that would break a field using the parameter', () => {
    let document = setParameter(blank(), { name: 'a', expression: '20' });
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 'a', height: 10, depth: 10 }
    });
    expect(parameterQuantityRefusal(document, 'a', 'angle')).toMatch(
      /uses "a": .*expected a length/
    );
    expect(() =>
      setParameter(document, { name: 'a', expression: '20', quantity: 'angle' })
    ).toThrow(/expected a length/);
    expect(parameterQuantityRefusal(document, 'a', 'length')).toBeNull();
  });

  it('refuses a length quantity that a bare number is added to', () => {
    let document = setParameter(blank(), { name: 'width', expression: '10' });
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 'width + 5', height: 10, depth: 10 }
    });
    expect(parameterQuantityRefusal(document, 'width', 'length')).toMatch(
      /uses "width \+ 5": Incompatible dimensions/
    );
  });

  it('refuses a quantity that breaks another parameter reading it', () => {
    let document = setParameter(blank(), { name: 'w', expression: '10' });
    document = setParameter(document, {
      name: 'n',
      expression: 'w',
      quantity: 'number'
    });
    expect(parameterQuantityRefusal(document, 'w', 'length')).toMatch(
      /Parameter "n": Incompatible dimensions/
    );
  });
});

describe('named cycles', () => {
  it('names a reference cycle instead of an unknown identifier', () => {
    let document = setParameter(blank(), { name: 'a', expression: '1' });
    document = setParameter(document, { name: 'b', expression: 'a + 1' });
    document = setParameter(document, { name: 'a', expression: 'b + 1' });
    const { errors } = getParameterScope(document);
    expect(errors).toContain(
      'Parameter "a": its expression refers back to itself (a → b → a).'
    );
    expect(errors).toContain(
      'Parameter "b": its expression refers back to itself (b → a → b).'
    );
  });

  it('does not read a name in call position as a self-reference', () => {
    let document = setParameter(blank(), { name: 'foo', expression: '1' });
    document = setParameter(document, { name: 'foo', expression: 'foo(1)' });
    const { errors } = getParameterScope(document);
    expect(errors.join('\n')).not.toMatch(/refers back to itself/);
    expect(errors.join('\n')).toMatch(/foo/);
  });

  it('handles a long broken chain in linear time without deep recursion', () => {
    // 20,000 parameters, each reading the next, the last an unknown name:
    // none is a cycle, and none may cost a walk of the whole chain.
    const document = setParameter(blank(), { name: 'p0', expression: 'p1' });
    const template = listParameters(document)[0]!;
    const count = 20_000;
    for (let index = 1; index < count; index += 1) {
      const id = `node_chain_${index}`;
      const parameterId =
        `parameter_chain_${index}` as typeof template.parameterId;
      document.nodes[id] = {
        ...template,
        id: id as typeof template.id,
        parameterId,
        name: `p${index}`,
        expression: index === count - 1 ? 'missing + 1' : `p${index + 1}`
      };
      document.parameterOrder.push(parameterId);
    }
    const started = performance.now();
    const { errors } = getParameterScope(document);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(errors).toHaveLength(count);
    expect(errors.some((error) => error.includes('refers back'))).toBe(false);
  });

  it('names a parameter that reads itself', () => {
    let document = setParameter(blank(), { name: 'a', expression: '1' });
    document = setParameter(document, { name: 'a', expression: 'a + 1' });
    expect(getParameterScope(document).errors).toEqual([
      'Parameter "a": its expression refers back to itself (a → a).'
    ]);
  });

  it('still reports a plain unknown identifier as one', () => {
    const document = setParameter(blank(), { name: 'a', expression: 'zz + 1' });
    expect(getParameterScope(document).errors).toEqual([
      'Parameter "a": Unknown identifier "zz" in expression.'
    ]);
  });
});

describe('suggested quantities', () => {
  it('suggests what the expression carries, then what its uses agree on', () => {
    let document = setParameter(blank(), { name: 'gap', expression: '12 mm' });
    expect(suggestParameterQuantity(document, 'gap')).toBe('length');
    document = setParameter(document, { name: 'side', expression: '20' });
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 'side', height: 'side', depth: 10 }
    });
    expect(suggestParameterQuantity(document, 'side')).toBe('length');
  });

  it('suggests nothing when uses disagree or there are none', () => {
    let document = setParameter(blank(), { name: 'x', expression: '20' });
    expect(suggestParameterQuantity(document, 'x')).toBeNull();
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 'x', height: 10, depth: 10 }
    });
    ({ document } = addSketchFeature(document, {
      name: 'Arc',
      objects: [
        {
          objectKind: 'arc',
          centerX: 0,
          centerY: 0,
          radius: 5,
          startAngleDeg: 0,
          endAngleDeg: 'x'
        }
      ]
    }));
    expect(suggestParameterQuantity(document, 'x')).toBeNull();
  });

  it('suggests for a large table in one linear pass', () => {
    // 10,000 unitless parameters, the first used as a box width.
    let document = setParameter(blank(), { name: 'p0', expression: '5' });
    const template = listParameters(document)[0]!;
    const count = 10_000;
    for (let index = 1; index < count; index += 1) {
      const id = `node_bulk_${index}`;
      const parameterId =
        `parameter_bulk_${index}` as typeof template.parameterId;
      document.nodes[id] = {
        ...template,
        id: id as typeof template.id,
        parameterId,
        name: `p${index}`,
        expression: index % 2 ? `${index} mm` : String(index)
      };
      document.parameterOrder.push(parameterId);
    }
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 'p0', height: 10, depth: 10 }
    });
    const started = performance.now();
    const suggestions = suggestParameterQuantities(document);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(suggestions.p0).toBe('length');
    expect(suggestions.p1).toBe('length');
    expect(suggestions.p2).toBeUndefined();
    expect(Object.keys(suggestions)).toHaveLength(1 + count / 2);
  });

  it('stays fast when many fields each read a wide set of unitless parameters', () => {
    // 128 names fill an expression's 256-token cap; 500 boxes hold two such
    // products each. Re-parsing every read per candidate took ~2 s here.
    const count = 128;
    let document = setParameter(blank(), { name: 'p0', expression: '1' });
    const template = listParameters(document)[0]!;
    const names = ['p0'];
    for (let index = 1; index < count; index += 1) {
      const id = `node_wide_${index}`;
      const parameterId =
        `parameter_wide_${index}` as typeof template.parameterId;
      document.nodes[id] = {
        ...template,
        id: id as typeof template.id,
        parameterId,
        name: `p${index}`
      };
      document.parameterOrder.push(parameterId);
      names.push(`p${index}`);
    }
    const product = names.join('*');
    for (let box = 0; box < 500; box += 1) {
      document = addPrimitiveFeature(document, {
        name: `Block ${box}`,
        primitiveKind: 'box',
        dimensions: { width: product, height: product, depth: 10 }
      });
    }
    const started = performance.now();
    const suggestions = suggestParameterQuantities(document);
    expect(performance.now() - started).toBeLessThan(1_000);
    // A read this wide suggests nothing rather than being re-checked per name.
    expect(suggestions).toEqual({});
  });

  it('does not suggest a quantity that would break a use', () => {
    let document = setParameter(blank(), { name: 'w', expression: '20' });
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 'w', height: 'w + 1', depth: 10 }
    });
    // Both fields are lengths, but `w + 1` would add a bare number.
    expect(suggestParameterQuantity(document, 'w')).toBeNull();
  });

  it('does not count a unit suffix as a read of a parameter named after it', () => {
    let document = setParameter(blank(), { name: 'm', expression: '20' });
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: '0.01 m', height: '0.02m', depth: 10 }
    });
    // `0.01 m` is metres, not the parameter `m`: nothing reads it.
    expect(suggestParameterQuantities(document).m).toBeUndefined();
  });
});

describe('raw-radians fields', () => {
  it('admits only a unitless value into a countersink angle', () => {
    const seen: Record<string, unknown> = {};
    rewriteNodeExpressions(
      {
        kind: 'feature',
        data: {
          featureKind: 'direct-edit',
          operation: {
            kind: 'resize-imported-countersink',
            boreDiameter: 'bore',
            sinkDiameter: 'sink',
            angleRadians: 'tilt'
          }
        }
      } as unknown as Parameters<typeof rewriteNodeExpressions>[0],
      (expression, dimension) => {
        seen[expression] = dimension;
        return expression;
      }
    );
    // A typed angle (degrees) or length would be read as radians.
    expect(seen.tilt).toBe('number');
    expect(seen.bore).toBe('length');
  });
});

describe('new typed-parameter misuse', () => {
  it('tells a second identical misuse from the one already there', () => {
    const document = setParameter(blank(), {
      name: 'tilt',
      expression: '30',
      quantity: 'angle'
    });
    const line = {
      objectKind: 'line' as const,
      x1: 'tilt',
      y1: 0,
      x2: 10,
      y2: 0
    };
    // A document from elsewhere already reads an angle as a coordinate.
    const before = addSketchFeature(document, {
      name: 'Profile',
      objects: [line]
    }).document;
    // The same sketch name and expression again: same message, new field.
    const after = addSketchFeature(before, {
      name: 'Profile',
      objects: [line]
    }).document;
    expect(newTypedParameterMisuse(document, before)).toMatch(/tilt/);
    expect(newTypedParameterMisuse(before, before)).toBeNull();
    expect(newTypedParameterMisuse(before, after)).toMatch(/tilt/);
  });

  it('does not count a renamed holder as a new misuse', () => {
    const document = setParameter(blank(), {
      name: 'tilt',
      expression: '30',
      quantity: 'angle'
    });
    const before = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 'tilt', depth: 10 }
    });
    const node = Object.values(before.nodes).find(
      (entry) => entry.kind === 'feature' && entry.name === 'Block'
    )!;
    const after = renameNode(before, { nodeId: node.id, name: 'Renamed' });
    expect(newTypedParameterMisuse(document, before)).toMatch(/tilt/);
    expect(newTypedParameterMisuse(before, after)).toBeNull();
  });

  it('does not count a renamed parameter as a new misuse, but an edit is', () => {
    const document = setParameter(blank(), {
      name: 'tilt',
      expression: '30',
      quantity: 'angle'
    });
    const before = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 'tilt', depth: 10 }
    });
    const renamed = renameParameter(before, { name: 'tilt', newName: 'lean' });
    expect(newTypedParameterMisuse(before, renamed)).toBeNull();
    // A real edit of the invalid field is still a new misuse.
    const edited = structuredClone(before);
    const box = Object.values(edited.nodes).find(
      (entry) => entry.kind === 'feature' && entry.name === 'Block'
    );
    if (box?.kind !== 'feature' || box.data.featureKind !== 'primitive') {
      throw new Error('expected the box feature');
    }
    box.data.dimensions.height = 'tilt * 2';
    expect(newTypedParameterMisuse(before, edited)).toMatch(/tilt \* 2/);
  });

  it('keeps an existing misuse its identity when an earlier field changes', () => {
    const document = setParameter(blank(), {
      name: 'tilt',
      expression: '30',
      quantity: 'angle'
    });
    const box = (width: string | number) =>
      addPrimitiveFeature(document, {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width, height: 'tilt', depth: 10 }
      });
    const before = box('10');
    const after = structuredClone(before);
    const data = Object.values(after.nodes).find(
      (node) => node.kind === 'feature' && node.data.featureKind === 'primitive'
    );
    if (data?.kind !== 'feature' || data.data.featureKind !== 'primitive') {
      throw new Error('expected the box feature');
    }
    // A string width becomes a literal; the height misuse is unchanged.
    data.data.dimensions.width = 10;
    expect(newTypedParameterMisuse(document, before)).toMatch(/tilt/);
    expect(newTypedParameterMisuse(before, after)).toBeNull();
  });
});

describe('stored quantities at load', () => {
  it('refuses a document whose parameter has an unknown type', () => {
    const document = setParameter(blank(), { name: 'w', expression: '1' });
    const node = Object.values(document.nodes).find(
      (entry) => entry.kind === 'parameter'
    )!;
    (node as unknown as { quantity: string }).quantity = 'mass';
    expect(() => normalizeDocument(document)).toThrow(
      'Parameter "w" has an unknown type "mass".'
    );
    (node as unknown as { quantity: string }).quantity = 'length';
    expect(() => normalizeDocument(document)).not.toThrow();
  });
});

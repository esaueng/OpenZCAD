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
  parameterKindsOf,
  parameterQuantityRefusal,
  setParameter,
  suggestParameterQuantity
} from './index';

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
});

import { describe, expect, it } from 'vitest';
import { toUserId, type UnitSystem } from '@openzcad/shared';
import {
  coerceParamValue,
  createProjectDocument,
  evaluateExpression as evaluateWithOptions,
  getExpressionDimensions as dimensionsWithOptions,
  getParameterScope,
  listParameters,
  setParameter
} from './index';

/**
 * F05 executable grammar audit (ROADMAP row F05).
 *
 * One case per audit item. Statuses live in
 * docs/reviews/f05-expression-audit-2026-10-02.md; this file pins them:
 * every "supported" row evaluates here, every "refused-correctly" row throws
 * through the evaluator's existing `throw new Error(...)` path (never a new
 * error channel), and every "needs schema" row asserts the schema boundary.
 *
 * Legacy contract, asserted throughout: any input that evaluated successfully
 * before this audit evaluates to the bit-identical number now. New
 * capabilities (unit suffixes, dimensions, new functions) only ever applied
 * to inputs that previously threw.
 */

// Most cases read a millimetre document; `evalIn` names any other.
const MM = { documentUnits: 'mm' } as const;
const evaluateExpression = (
  expression: string,
  scope: Record<string, number>
): number => evaluateWithOptions(expression, scope, MM);
const getExpressionDimensions = (
  expression: string,
  scope: Record<string, number>
) => dimensionsWithOptions(expression, scope, MM);

const evalIn = (expression: string, documentUnits: UnitSystem): number =>
  evaluateWithOptions(expression, {}, { documentUnits });

describe('F05 audit: units inside expressions', () => {
  it('evaluates mixed metric units into document units (5 mm + 2 cm = 25 mm)', () => {
    expect(evaluateExpression('5 mm + 2 cm', {})).toBe(25);
    expect(evalIn('5 mm + 2 cm', 'inch')).toBeCloseTo(25 / 25.4, 12);
    expect(evalIn('5 mm + 2 cm', 'cm')).toBe(2.5);
  });

  it('multiplies imperial lengths by plain numbers (3 in * 2)', () => {
    expect(evaluateExpression('3 in * 2', {})).toBeCloseTo(152.4, 9);
    expect(evaluateExpression('2 * 3 in', {})).toBeCloseTo(152.4, 9);
    expect(evalIn('3 in * 2', 'inch')).toBeCloseTo(6, 12);
  });

  it('adds feet and inches word forms (1 ft + 2 in)', () => {
    expect(evaluateExpression('1 ft + 2 in', {})).toBeCloseTo(355.6, 9);
    expect(evaluateExpression('1 foot + 2 inches', {})).toBeCloseTo(355.6, 9);
    expect(evalIn('1 ft + 2 in', 'inch')).toBeCloseTo(14, 12);
  });

  it('reads feet/inch symbol forms (1\' 2") as an implicit sum', () => {
    expect(evaluateExpression(`1' 2"`, {})).toBeCloseTo(355.6, 9);
    expect(evalIn(`1' 2"`, 'inch')).toBeCloseTo(14, 12);
    expect(evaluateExpression('5"', {})).toBeCloseTo(127, 9);
    expect(evaluateExpression(`5'`, {})).toBeCloseTo(1524, 9);
  });

  it('accepts long unit spellings and plurals', () => {
    expect(evaluateExpression('1 millimeter + 1 millimetre', {})).toBe(2);
    expect(evaluateExpression('1 centimeter + 1 centimetre', {})).toBe(20);
    expect(evaluateExpression('1 meter + 1 metre', {})).toBe(2000);
    expect(evaluateExpression('1 inch', {})).toBeCloseTo(25.4, 12);
  });

  it('still refuses quote-led or bare-unit fragments without a literal', () => {
    // No string literals, no bare-unit factors: a unit must suffix a number.
    expect(() => evaluateExpression('"', {})).toThrow();
    expect(() => evaluateExpression(`'`, {})).toThrow();
    expect(() => evaluateExpression('mm', {})).toThrow(/Unknown identifier/);
  });

  it('parameters named like units keep working bare; suffixes stay units', () => {
    // A parameter called `m` resolves bare, exactly as before.
    expect(evaluateExpression('m * 2', { m: 3 })).toBe(6);
    // But `5 m` is five metres now (it threw before), never scope-dependent.
    expect(evaluateExpression('5 m', { m: 3 })).toBe(5000);
  });
});

describe('F05 audit: dimensional rules', () => {
  it('refuses length ± angle', () => {
    expect(() => evaluateExpression('5 mm + 30deg', {})).toThrow(
      /Incompatible dimensions/
    );
    expect(() => evaluateExpression('5 mm - 30deg', {})).toThrow(
      /Incompatible dimensions/
    );
  });

  it('computes length * length = area and area / length = length', () => {
    expect(evaluateExpression('(2 mm) * (3 mm)', {})).toBe(6);
    expect(evaluateExpression('((2 mm) * (3 mm)) / (2 mm)', {})).toBe(3);
    expect(evaluateExpression('(2 in) * (3 in)', {})).toBeCloseTo(3870.96, 6);
    expect(evalIn('(2 in) * (3 in)', 'inch')).toBeCloseTo(6, 12);
    expect(evalIn('((2 in) * (3 in)) / (2 in)', 'inch')).toBeCloseTo(3, 12);
  });

  it('computes number * length = length, commutatively', () => {
    expect(evaluateExpression('2 * 3 mm', {})).toBe(6);
    expect(evaluateExpression('3 mm * 2', {})).toBe(6);
    expect(evaluateExpression('(2 mm) / 2', {})).toBe(1);
  });

  it('refuses bare-number/length mixing without a parameter unit type', () => {
    // Scope values are untyped document-unit numbers, so `width + 5 mm`
    // cannot be proved coherent. Typed parameters would need a schema
    // change (see the unit-type case below); until then this refuses.
    expect(() => evaluateExpression('5 + 3 mm', {})).toThrow(
      /Incompatible dimensions/
    );
    expect(() => evaluateExpression('width + 5 mm', { width: 10 })).toThrow(
      /Incompatible dimensions/
    );
  });

  it('trig takes angles (deg/rad) or legacy degree numbers, and returns numbers', () => {
    expect(evaluateExpression('sin(90deg)', {})).toBeCloseTo(1, 12);
    expect(evaluateExpression('cos(0deg)', {})).toBeCloseTo(1, 12);
    expect(evaluateExpression('tan(45deg)', {})).toBeCloseTo(1, 12);
    expect(evaluateExpression('sin(1.5707963267948966 rad)', {})).toBeCloseTo(
      1,
      9
    );
    // Legacy degree semantics are bit-identical.
    expect(evaluateExpression('sin(30)', {})).toBeCloseTo(0.5, 10);
    expect(evaluateExpression('cos(60)', {})).toBeCloseTo(0.5, 10);
    expect(() => evaluateExpression('sin(5 mm)', {})).toThrow(
      /expects an angle/
    );
  });

  it('inverse trig returns angles as degree numbers', () => {
    expect(evaluateExpression('asin(0.5)', {})).toBeCloseTo(30, 12);
    expect(evaluateExpression('acos(0.5)', {})).toBeCloseTo(60, 12);
    expect(evaluateExpression('atan(1)', {})).toBeCloseTo(45, 12);
    expect(evaluateExpression('atan2(1, 1)', {})).toBeCloseTo(45, 12);
    // Degree numbers compose with legacy degree trig: sin(asin(x)) == x.
    expect(evaluateExpression('sin(asin(0.5))', {})).toBeCloseTo(0.5, 12);
    expect(evaluateExpression('asin(0.5) + 30', {})).toBeCloseTo(60, 12);
    expect(() => evaluateExpression('asin(2)', {})).toThrow(/between -1 and 1/);
    expect(() => evaluateExpression('acos(2)', {})).toThrow(/between -1 and 1/);
  });
});

describe('F05 audit: function inventory', () => {
  it('keeps the previously supported set bit-identical', () => {
    expect(evaluateExpression('sqrt(81)', {})).toBe(9);
    expect(evaluateExpression('abs(0 - 4)', {})).toBe(4);
    expect(evaluateExpression('min(3, 8, -2)', {})).toBe(-2);
    expect(evaluateExpression('max(3, 8, -2)', {})).toBe(8);
    expect(evaluateExpression('round(2.6)', {})).toBe(3);
    expect(evaluateExpression('floor(2.9)', {})).toBe(2);
    expect(evaluateExpression('ceil(2.1)', {})).toBe(3);
    expect(evaluateExpression('sin(30)', {})).toBeCloseTo(0.5, 10);
    expect(evaluateExpression('cos(60)', {})).toBeCloseTo(0.5, 10);
    expect(evaluateExpression('tan(45)', {})).toBeCloseTo(1, 10);
    expect(evaluateExpression('pi', {})).toBeCloseTo(Math.PI, 12);
    expect(evaluateExpression('2 * pi * 10', {})).toBeCloseTo(62.8318, 3);
  });

  it('supports the missing inverse trig family', () => {
    expect(evaluateExpression('asin(1)', {})).toBeCloseTo(90, 12);
    expect(evaluateExpression('acos(0)', {})).toBeCloseTo(90, 12);
    expect(evaluateExpression('atan(0)', {})).toBe(0);
    expect(evaluateExpression('atan2(0, 1)', {})).toBe(0);
    expect(evaluateExpression('atan2(1, 0)', {})).toBeCloseTo(90, 12);
  });

  it('supports mod, avg and sign', () => {
    expect(evaluateExpression('mod(5, 3)', {})).toBe(2);
    expect(evaluateExpression('mod(7.5, 2)', {})).toBeCloseTo(1.5, 12);
    expect(() => evaluateExpression('mod(5, 0)', {})).toThrow(/zero/);
    expect(evaluateExpression('avg(2, 4, 6)', {})).toBe(4);
    expect(evaluateExpression('avg(5)', {})).toBe(5);
    expect(evaluateExpression('sign(0 - 5)', {})).toBe(-1);
    expect(evaluateExpression('sign(0)', {})).toBe(0);
    expect(evaluateExpression('sign(5)', {})).toBe(1);
  });

  it('applies scalar functions dimension-wise and refuses mixed dimensions', () => {
    // Note `abs(-5 mm)`, not `abs(0 - 5 mm)`: the bare subtraction itself
    // refuses (number − length), before abs ever sees it.
    expect(evaluateExpression('abs(-5 mm)', {})).toBe(5);
    expect(evaluateExpression('min(5 mm, 20 mm)', {})).toBe(5);
    expect(evaluateExpression('max(5 mm, 20 mm)', {})).toBe(20);
    expect(evaluateExpression('avg(5 mm, 15 mm)', {})).toBe(10);
    expect(evaluateExpression('mod(5 mm, 3 mm)', {})).toBe(2);
    expect(evaluateExpression('sign(-5 mm)', {})).toBe(-1);
    expect(() => evaluateExpression('min(5 mm, 30deg)', {})).toThrow(
      /Incompatible dimensions/
    );
    expect(() => evaluateExpression('avg(5 mm, 2)', {})).toThrow(
      /Incompatible dimensions/
    );
  });

  it('still refuses unknown functions and guards sqrt arity', () => {
    expect(() => evaluateExpression('nope(1)', {})).toThrow(/Unknown function/);
    expect(() => evaluateExpression('sqrt(4, 9)', {})).toThrow(/one argument/);
    expect(() => evaluateExpression('radians(180)', {})).toThrow(
      /Unknown function/
    );
  });
});

describe('F05 audit: dimension query for field owners', () => {
  it('reports dimensions with the same value the evaluator returns', () => {
    expect(getExpressionDimensions('5 mm + 2 cm', {})).toEqual({
      length: 1,
      angle: 0
    });
    expect(getExpressionDimensions('(2 mm) * (3 mm)', {})).toEqual({
      length: 2,
      angle: 0
    });
    expect(getExpressionDimensions('90deg', {})).toEqual({
      length: 0,
      angle: 1
    });
    expect(getExpressionDimensions('w / 2 + 5', { w: 30 })).toEqual({
      length: 0,
      angle: 0
    });
    expect(getExpressionDimensions('1 ft + 2 in', {})).toEqual({
      length: 1,
      angle: 0
    });
  });

  it('refuses on the same path as evaluation', () => {
    expect(() => getExpressionDimensions('5 mm + 30deg', {})).toThrow(
      /Incompatible dimensions/
    );
    expect(() => getExpressionDimensions('nope +', {})).toThrow();
    expect(() => getExpressionDimensions('1 / 0', {})).toThrow(/finite/);
  });
});

describe('F05 parity: legacy inputs are bit-identical to the old evaluator', () => {
  // Every expected value below is the exact output of the pre-change
  // evaluator (extracted from git HEAD into .scratch/ and executed), pasted
  // here so the rewrite is pinned without depending on the old code.
  // `toBe` (not `toBeCloseTo`) proves bit-identical doubles.
  const scope = { width: 10, height: 4, pi2: 6 };
  const cases: Array<[string, Record<string, number>, number]> = [
    ['2', {}, 2],
    ['3.5', {}, 3.5],
    ['.5', {}, 0.5],
    ['1 + 2 * 3', {}, 7],
    ['(1 + 2) * 3', {}, 9],
    ['10 / 4', {}, 2.5],
    ['-3 + 5', {}, 2],
    ['2 * -4', {}, -8],
    ['+5', {}, 5],
    ['2 ^ 10', {}, 1024],
    ['2 ^ 3 ^ 2', {}, 512],
    ['-2 ^ 2', {}, -4],
    ['(-2) ^ 2', {}, 4],
    ['2 ^ -2', {}, 0.25],
    ['2e3 + 5e-1', {}, 2000.5],
    ['.5 + 1.25', {}, 1.75],
    ['width * height / 2', scope, 20],
    ['width - (height + 1)', scope, 5],
    ['max(width, height)', scope, 10],
    ['sqrt(81)', {}, 9],
    ['sqrt(2)', {}, 1.4142135623730951],
    ['sqrt(2^2 + 3^2)', {}, 3.605551275463989],
    ['min(3, 8, -2)', {}, -2],
    ['max(3, 8, -2)', {}, 8],
    ['min(max(1, 2), 3)', {}, 2],
    ['round(2.6)', {}, 3],
    ['round(2.5)', {}, 3],
    ['floor(2.9)', {}, 2],
    ['floor(0 - 2.1)', {}, -3],
    ['ceil(2.1)', {}, 3],
    ['abs(0 - 4)', {}, 4],
    ['abs(7)', {}, 7],
    ['sin(30)', {}, 0.49999999999999994],
    ['cos(60)', {}, 0.5000000000000001],
    ['tan(45)', {}, 0.9999999999999999],
    ['sin(30) + cos(60)', {}, 1],
    ['round(sqrt(2) * 10)', {}, 14],
    ['pi', {}, 3.141592653589793],
    ['PI', {}, 3.141592653589793],
    ['2 * pi * 10', {}, 62.83185307179586],
    ['2 * PI', {}, 6.283185307179586],
    ['require_min(width, 16.1)', { width: 20 }, 20],
    ['require_min(width, width)', scope, 10],
    ['require_one_of(46, 46, 50)', {}, 46],
    ['require_one_of(50, 46, 50)', {}, 50],
    ['((width + height) * 2 - 1) / 3', scope, 9],
    ['pi2 * 2', scope, 12]
  ];
  it.each(cases)('%s evaluates to %s', (input, inputScope, expected) => {
    expect(evaluateExpression(input, inputScope)).toBe(expected);
  });

  const errorCases: Array<[string, string]> = [
    ['1 +', 'Unexpected end of expression.'],
    ['(1 + 2', 'Unexpected end of expression.'],
    ['1 ; 2', 'Unexpected character ";" in expression.'],
    ['1 / 0', 'Expression did not evaluate to a finite number.'],
    ['sqrt(4, 9)', 'sqrt() expects exactly one argument.'],
    ['nope(1)', 'Unknown function "nope" in expression.'],
    ['globalThis', 'Unknown identifier "globalThis" in expression.'],
    ['require_min(1, 2)', 'Parameter value 1 must be at least 2.'],
    [
      'require_one_of(1, 2, 3)',
      'Parameter value 1 is unsupported; supported values: 2, 3.'
    ]
  ];
  it.each(errorCases)('%s throws %s', (input, message) => {
    expect(() => evaluateExpression(input, scope)).toThrow(message);
  });
});

describe('F05 audit: parameter unit types', () => {
  it('needs schema: parameters carry no unit type and are created untyped', () => {
    // Any field creates a parameter the same way: the raw string is stored
    // verbatim as `expression` (numbers stay numbers). There is no
    // length/angle/number type to create — adding one is a persisted-schema
    // change, so the audit marks it "needs schema" and skips it.
    expect(coerceParamValue('4')).toBe(4);
    expect(coerceParamValue('width / 2')).toBe('width / 2');
    let document = createProjectDocument('Units', toUserId('user_f05'));
    document = setParameter(document, { name: 'len', expression: '5 mm' });
    document = setParameter(document, { name: 'ang', expression: '30' });
    document = setParameter(document, { name: 'count', expression: '2 + 3' });
    for (const parameter of listParameters(document)) {
      expect(parameter).not.toHaveProperty('unitType');
      expect(parameter).not.toHaveProperty('unit');
      expect(typeof parameter.value).toBe('number');
    }
    // ...so the length parameter evaluates in document units (mm default).
    expect(getParameterScope(document).scope.len).toBe(5);
  });
});

describe('F05 audit: cycles and refusals leave the prior model intact', () => {
  it('reports parameter cycles as scope errors while keeping cached values', () => {
    let document = createProjectDocument('Cycle', toUserId('user_f05'));
    document = setParameter(document, { name: 'a', expression: '1' });
    document = setParameter(document, { name: 'b', expression: 'a + 1' });
    expect(getParameterScope(document).errors).toEqual([]);
    // Introducing the cycle stores the expression (document-core never throws
    // on set) but neither member resolves, and `a` keeps its last good value.
    document = setParameter(document, { name: 'a', expression: 'b + 1' });
    const { scope, errors } = getParameterScope(document);
    expect(scope.a).toBeUndefined();
    expect(scope.b).toBeUndefined();
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).toMatch(/Parameter "a"/);
    const cached = listParameters(document).find((p) => p.name === 'a')!;
    expect(cached.value).toBe(1);
    expect(cached.expression).toBe('b + 1');
  });

  it('keeps the prior value when a new expression is dimensionally incompatible', () => {
    let document = createProjectDocument('Dims', toUserId('user_f05'));
    document = setParameter(document, { name: 'w', expression: '10' });
    document = setParameter(document, {
      name: 'w',
      expression: '5 mm + 30deg'
    });
    const { scope, errors } = getParameterScope(document);
    expect(scope.w).toBeUndefined();
    expect(errors.join('\n')).toMatch(/Incompatible dimensions/);
    expect(listParameters(document).find((p) => p.name === 'w')!.value).toBe(
      10
    );
  });

  it('evaluator failures stay plain thrown Errors on the existing path', () => {
    for (const bad of [
      '5 mm + 30deg',
      'width + 5 mm',
      'sin(5 mm)',
      'asin(2)',
      'mod(1, 0)',
      '5 mm +',
      '1 / 0'
    ]) {
      let caught: unknown;
      try {
        evaluateExpression(bad, { width: 10 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
    }
  });
});

describe('F05 audit: callers without document units', () => {
  it('refuse a length suffix instead of assuming millimetres', () => {
    expect(() => evaluateWithOptions('5 mm', {})).toThrow(/document's units/);
    expect(() => evaluateWithOptions(`1' 2"`, {})).toThrow(/document's units/);
    expect(() => dimensionsWithOptions('2 in', {})).toThrow(/document's units/);
  });

  it('keep unit-free and angle-suffixed inputs working', () => {
    expect(evaluateWithOptions('2 * 3 + 4', {})).toBe(10);
    expect(evaluateWithOptions('sin(90deg)', {})).toBeCloseTo(1, 12);
  });
});

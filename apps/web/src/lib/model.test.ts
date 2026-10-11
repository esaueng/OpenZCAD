import { describe, expect, it } from 'vitest';
import { previewExpression } from './model';

describe('previewExpression undefined parameters (G5)', () => {
  it('names an undefined parameter when that is all that is wrong', () => {
    const preview = previewExpression('width', {});
    expect(preview).toMatchObject({
      ok: false,
      text: 'Unknown identifier "width" in expression.',
      undefinedParameter: 'width'
    });
  });

  it('names the first of several undefined parameters', () => {
    expect(
      previewExpression('width / 2 + height', { other: 1 }).undefinedParameter
    ).toBe('width');
    expect(previewExpression('w * 2 + h', { w: 3 }).undefinedParameter).toBe(
      'h'
    );
  });

  it.each([
    // Most values of `width` fail these; whether it builds depends on the
    // value it is given, not on the expression, so the name is offered.
    'sqrt(width - 5)',
    'sqrt(width - 1000)',
    '1 / (width - 1)',
    'require_min(width, 5000)',
    'mod(10, width)',
    'asin(width)'
  ])('offers the name in %s whatever values would fail', (expression) => {
    expect(previewExpression(expression, {}).undefinedParameter).toBe('width');
  });

  it.each([
    ['width +', 'a syntax error'],
    ['require_min(width, 5000) +', 'syntax after a failed guard'],
    ['require_one_of(width, 1, 2) 80', 'tokens after a failed guard'],
    ['asin(width) +', 'syntax after a failed domain check'],
    ['width 80', 'trailing tokens'],
    ['(width', 'an unclosed parenthesis'],
    ['sqrt', 'a reserved function name'],
    ['width + 90 deg', 'incompatible dimensions'],
    ['width + 5 mm', 'a length suffix the field cannot convert'],
    ['width $', 'an unexpected character'],
    ['nope(width)', 'an unknown function'],
    ['sqrt(width) + sqrt', 'a function name read as a value'],
    ['width * 2 + 3 mm', 'a length suffix after the name'],
    ['abs(width, 2)', 'the wrong number of arguments']
  ])('offers nothing for %s (%s)', (expression) => {
    const preview = previewExpression(expression, {});
    expect(preview.ok).toBe(false);
    expect(preview.undefinedParameter).toBeUndefined();
  });

  it('offers nothing for an expression that evaluates', () => {
    expect(previewExpression('width', { width: 80 })).toEqual({
      ok: true,
      text: '= 80',
      value: 80
    });
  });

  it('does not treat a prototype member as defined', () => {
    expect(previewExpression('toString + width', {}).ok).toBe(false);
  });
});

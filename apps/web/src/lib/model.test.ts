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

  it('accepts an expression that only builds for some values', () => {
    // At 1 the square root is of a negative number; at 100 it is not.
    expect(previewExpression('sqrt(width - 5)', {}).undefinedParameter).toBe(
      'width'
    );
  });

  it.each([
    ['width +', 'a syntax error'],
    ['width 80', 'trailing tokens'],
    ['(width', 'an unclosed parenthesis'],
    ['sqrt', 'a reserved function name'],
    ['width + 90 deg', 'incompatible dimensions'],
    ['width + 5 mm', 'a length suffix the field cannot convert'],
    ['width $', 'an unexpected character'],
    ['nope(width)', 'an unknown function']
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

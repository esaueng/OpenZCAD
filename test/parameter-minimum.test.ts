import { expect, it } from 'vitest';
import { evaluateExpression } from '@openzcad/document-core';

it('enforces a finite lower bound without an upper bound', () => {
  for (const value of [16.1, 20, 46, 48, 50, 55, 1000, 1e9]) {
    expect(
      evaluateExpression('require_min(width, 16.1)', { width: value })
    ).toBe(value);
  }
  for (const expression of [
    'require_min(10,16.1)',
    'require_min(16.099,16.1)',
    'require_min(1)',
    'require_min(20,16.1,30)',
    'require_min(1/0,16.1)',
    'require_min(20,1/0)'
  ])
    expect(() => evaluateExpression(expression, {})).toThrow();
});

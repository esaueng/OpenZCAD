import { describe, expect, it } from 'vitest';
import {
  exportScope,
  exportScopeLabel,
  type ExportScopeBody
} from './exportScope';

const body = (
  bodyId: string,
  overrides: Partial<ExportScopeBody> = {}
): ExportScopeBody => ({
  bodyId,
  exportable: true,
  hidden: false,
  withheld: false,
  ...overrides
});

const model = [
  body('a'),
  body('b', { hidden: true }),
  body('c'),
  body('d', { exportable: false }),
  body('e', { hidden: true, withheld: true })
];

describe('exportScope (ZC-199)', () => {
  it('writes every exportable body, hidden ones included, and says so', () => {
    const scope = exportScope(model, null, true);
    expect(scope.bodyIds).toEqual(['a', 'b', 'c']);
    expect(scope.hiddenIncluded).toBe(1);
    expect(scope.withheldIds).toEqual(['e']);
    expect(exportScopeLabel(scope)).toBe('all bodies (3, 1 hidden)');
  });

  it('leaves hidden bodies out when asked, and counts them', () => {
    const scope = exportScope(model, null, false);
    expect(scope.bodyIds).toEqual(['a', 'c']);
    expect(scope.hiddenExcluded).toBe(1);
    expect(scope.withheldIds).toEqual([]);
    expect(exportScopeLabel(scope)).toBe(
      'visible bodies (2, 1 hidden left out)'
    );
  });

  it('exports a selected body alone, hidden or not, unless its step failed', () => {
    expect(exportScope(model, 'b', false)).toMatchObject({
      bodyIds: ['b'],
      selection: true
    });
    expect(exportScope(model, 'e', true)).toMatchObject({
      bodyIds: [],
      withheldIds: ['e']
    });
    // A selection that cannot export falls back to the whole model.
    expect(exportScope(model, 'd', true).selection).toBe(false);
  });

  it('never counts a withheld hidden body as left out', () => {
    // 'e' is hidden and withheld: including hidden bodies cannot add it.
    const scope = exportScope(model, null, false);
    expect(scope.hiddenExcluded).toBe(1);
    const onlyWithheld = exportScope(
      [body('a'), body('e', { hidden: true, withheld: true })],
      null,
      false
    );
    expect(onlyWithheld.hiddenExcluded).toBe(0);
    expect(exportScopeLabel(onlyWithheld)).toBe('all bodies (1)');
  });

  it('labels a model with nothing hidden plainly', () => {
    expect(
      exportScopeLabel(exportScope([body('a'), body('b')], null, false))
    ).toBe('all bodies (2)');
  });
});

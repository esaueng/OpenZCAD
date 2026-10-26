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
  it('exports only visible exportable bodies and counts hidden omissions', () => {
    const scope = exportScope(model, null);
    expect(scope.bodyIds).toEqual(['a', 'c']);
    expect(scope.hiddenExcluded).toBe(1);
    expect(scope.withheldIds).toEqual([]);
    expect(exportScopeLabel(scope)).toBe(
      'visible bodies (2, 1 hidden left out)'
    );
  });

  it('exports a visible selected body alone unless its step failed', () => {
    expect(exportScope(model, 'c')).toMatchObject({
      bodyIds: ['c'],
      selection: true
    });
    expect(exportScope([body('a', { withheld: true })], 'a')).toMatchObject({
      bodyIds: [],
      withheldIds: ['a']
    });
    // A selection that cannot export falls back to the whole model.
    expect(exportScope(model, 'd').selection).toBe(false);
  });

  it('ignores hidden selections and exports the visible bodies instead', () => {
    for (const selected of ['b', 'e']) {
      expect(exportScope(model, selected)).toMatchObject({
        bodyIds: ['a', 'c'],
        selection: false
      });
    }
    expect(exportScope([body('a', { hidden: true })], 'a').bodyIds).toEqual([]);
  });

  it('tracks hide, isolate and show changes without retaining old scope', () => {
    const bodies = [body('a'), body('b')];
    expect(exportScope(bodies, null).bodyIds).toEqual(['a', 'b']);
    bodies[0]!.hidden = true;
    expect(exportScope(bodies, null).bodyIds).toEqual(['b']);
    bodies[1]!.hidden = true;
    expect(exportScope(bodies, null).bodyIds).toEqual([]);
    bodies[0]!.hidden = false;
    expect(exportScope(bodies, null).bodyIds).toEqual(['a']);
  });

  it('never counts a withheld hidden body as left out', () => {
    const scope = exportScope(model, null);
    expect(scope.hiddenExcluded).toBe(1);
    const onlyWithheld = exportScope(
      [body('a'), body('e', { hidden: true, withheld: true })],
      null
    );
    expect(onlyWithheld.hiddenExcluded).toBe(0);
    expect(exportScopeLabel(onlyWithheld)).toBe('all bodies (1)');
  });

  it('labels a model with nothing hidden plainly', () => {
    expect(exportScopeLabel(exportScope([body('a'), body('b')], null))).toBe(
      'all bodies (2)'
    );
  });
});

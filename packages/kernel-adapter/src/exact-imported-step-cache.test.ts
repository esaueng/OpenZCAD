import { describe, expect, it } from 'vitest';
import { ImportedStepCache } from './exact-imported-step-cache';

const diagnostics = { declaredSolidCount: 2, rejections: [], flagged: [] };
const indices = [0, 1];

describe('imported STEP arena cache budgets', () => {
  it('refuses arenas containing rejected roots before retention', () => {
    const cache = new ImportedStepCache(4);
    expect(
      cache.store(
        'mixed',
        new Uint8Array(1),
        [0],
        {
          ...diagnostics,
          rejections: ['Solid 2 has an open shell.']
        },
        new Set()
      )
    ).toBe('rejected-roots');
    expect(cache.lookup('mixed')).toBeUndefined();
    expect(
      cache.store('valid', new Uint8Array(4), indices, diagnostics, new Set())
    ).toBe('cached');
  });
  it('refuses an oversized arena without retaining or copying it', () => {
    const cache = new ImportedStepCache(4);
    const document = new Uint8Array(5);
    expect(
      cache.store('oversized', document, indices, diagnostics, new Set())
    ).toBe('budget-exceeded');
    expect(cache.lookup('oversized')).toBeUndefined();
    expect(
      cache.store('small', new Uint8Array(4), indices, diagnostics, new Set())
    ).toBe('cached');
  });

  it('charges the whole allocation when the arena is a small view', () => {
    const cache = new ImportedStepCache(4);
    const view = new Uint8Array(new ArrayBuffer(5), 0, 1);
    expect(cache.store('view', view, indices, diagnostics, new Set())).toBe(
      'budget-exceeded'
    );
    expect(cache.lookup('view')).toBeUndefined();
  });

  it('refuses aggregate overflow without evicting protected prefetched hits', () => {
    const cache = new ImportedStepCache(4);
    const first = new Uint8Array(3);
    cache.store('first', first, indices, diagnostics, new Set());
    expect(
      cache.store(
        'second',
        new Uint8Array(2),
        indices,
        diagnostics,
        new Set(['first', 'second'])
      )
    ).toBe('budget-exceeded');
    expect(cache.lookup('first')?.document).toBe(first);
    expect(cache.lookup('second')).toBeUndefined();
    expect(
      cache.store(
        'fits',
        new Uint8Array(1),
        indices,
        diagnostics,
        new Set(['first'])
      )
    ).toBe('cached');
  });

  it('evicts inactive entries and accounts replacement once', () => {
    const cache = new ImportedStepCache(4);
    cache.store('old', new Uint8Array(3), indices, diagnostics, new Set());
    const document = new Uint8Array(3);
    expect(
      cache.store('current', document, indices, diagnostics, new Set())
    ).toBe('cached');
    expect(cache.lookup('old')).toBeUndefined();
    expect(cache.lookup('current')).toEqual({
      document,
      acceptedDeclaredIndices: indices,
      diagnostics
    });
    expect(
      cache.store(
        'current',
        new Uint8Array(2),
        indices,
        diagnostics,
        new Set(['current'])
      )
    ).toBe('cached');
    expect(
      cache.store(
        'other',
        new Uint8Array(2),
        indices,
        diagnostics,
        new Set(['current'])
      )
    ).toBe('cached');
    expect(
      cache.store(
        'overflow',
        new Uint8Array(1),
        indices,
        diagnostics,
        new Set(['current', 'other'])
      )
    ).toBe('budget-exceeded');
  });

  it('disables admission for zero and invalid budgets and releases all entries', () => {
    for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const cache = new ImportedStepCache(budget);
      expect(
        cache.store('entry', new Uint8Array(1), indices, diagnostics, new Set())
      ).toBe('budget-exceeded');
      expect(
        cache.store('empty', new Uint8Array(), indices, diagnostics, new Set())
      ).toBe('budget-exceeded');
    }
    const cache = new ImportedStepCache(1);
    cache.store('entry', new Uint8Array(1), indices, diagnostics, new Set());
    cache.clear();
    expect(cache.lookup('entry')).toBeUndefined();
    expect(
      cache.store('other', new Uint8Array(1), indices, diagnostics, new Set())
    ).toBe('cached');
  });
});

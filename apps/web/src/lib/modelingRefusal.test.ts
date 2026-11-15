import { describe, expect, it } from 'vitest';
import { modelingRefusalSummary } from './modelingRefusal';

describe('modeling refusal recovery', () => {
  it('explains an empty Intersect and how to recover', () => {
    expect(
      modelingRefusalSummary(
        'invalid input: solid has no vertices',
        'Intersect'
      )
    ).toBe(
      'Intersect would leave no solid. Move the bodies so they overlap, then try again.'
    );
  });

  it('does not diagnose an unrelated operation as disjoint', () => {
    expect(
      modelingRefusalSummary('invalid input: solid has no vertices', 'Shell')
    ).toBeNull();
    expect(
      modelingRefusalSummary('unrecognized kernel error', 'Intersect')
    ).toBeNull();
  });

  // QA 2026-11-14 finding #18: the identical-box cut read as an internal
  // failure; the kernel's two empty-cut wordings now read the same way.
  it.each([
    'empty result: Cut of identical solids',
    'empty result: Cut with target fully contained in tool'
  ])('says a cut that empties the body would remove it: %s', (reason) => {
    expect(modelingRefusalSummary(reason, 'Subtract')).toBe(
      'This cut would remove the entire target body. Reduce its size or move it.'
    );
  });
});

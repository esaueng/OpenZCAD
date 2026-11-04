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
      'Intersect would leave no solid. Move the bodies so they overlap, or use Union.'
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
});

import { expect } from 'vitest';
import type { BodyId, DerivedState } from '@openzcad/shared';

/**
 * ADR-017 (November 2026): a feature that fails hands the body it would have
 * replaced through under its own result id, unchanged — none of the geometry
 * it would have made — and consumes that input, so exactly one copy of it is
 * on screen. A failure that used to leave its result id empty now leaves
 * this.
 */
export function expectPassedThrough(
  derived: DerivedState,
  resultBodyId: BodyId,
  inputBodyId: BodyId
): void {
  const input = derived.bodyRepresentations[inputBodyId];
  const result = derived.bodyRepresentations[resultBodyId];
  expect(input, 'the failed feature input').toBeDefined();
  expect(input!.consumed, 'the failed feature consumes its input').toBe(true);
  expect(result, 'the failed feature passes its input through').toBeDefined();
  expect(result!.faceCount).toBe(input!.faceCount);
  expect(result!.volume).toBeCloseTo(input!.volume, 6);
}

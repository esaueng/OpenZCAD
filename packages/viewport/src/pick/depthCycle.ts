import { candidateKey, type PickCandidate } from './PickService';

/**
 * Reaching geometry that is hidden behind other geometry.
 *
 * Clicking the same spot again steps one layer deeper instead of reselecting
 * what is already selected — the "select other" every CAD tool has, because
 * the alternative is orbiting the model just to reach a face you can see.
 *
 * The cycle is anchored to a screen position and to the identity of the stack
 * under it. Move the pointer, or change the model, and the next click starts
 * from the front again rather than resuming somewhere arbitrary.
 */
export interface DepthCycle {
  x: number;
  y: number;
  /** Identity of the whole stack, so a changed scene restarts the cycle. */
  stack: string;
  /** Index within the stack that was returned last. */
  index: number;
}

/** Pixels the pointer may drift and still count as the same spot. */
const SAME_SPOT_PX = 3;

function stackKey(candidates: PickCandidate[]): string {
  return candidates.map(candidateKey).join('|');
}

export interface DepthCycleResult {
  candidate: PickCandidate | null;
  cycle: DepthCycle | null;
}

/**
 * Picks the next candidate for a click at (x, y), given where the last click
 * left the cycle.
 *
 * Wraps back to the front rather than stopping at the deepest layer: a user
 * who clicks past the thing they wanted should not have to move the pointer
 * to try again.
 */
export function cycleDepthPick(
  candidates: PickCandidate[],
  previous: DepthCycle | null,
  x: number,
  y: number,
  tolerancePx = SAME_SPOT_PX
): DepthCycleResult {
  if (candidates.length === 0) {
    return { candidate: null, cycle: null };
  }
  const stack = stackKey(candidates);
  const sameSpot =
    previous !== null &&
    Math.abs(previous.x - x) <= tolerancePx &&
    Math.abs(previous.y - y) <= tolerancePx &&
    previous.stack === stack;
  const index = sameSpot ? (previous.index + 1) % candidates.length : 0;
  return {
    candidate: candidates[index] ?? null,
    cycle: { x, y, stack, index }
  };
}

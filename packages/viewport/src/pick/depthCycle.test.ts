import { describe, expect, it } from 'vitest';
import { toBodyId } from '@openzcad/shared';
import type { PickCandidate } from './PickService';
import { cycleDepthPick, type DepthCycle } from './depthCycle';

/** A body pick at a given depth; only identity and order matter here. */
function pick(bodyId: string, distance: number): PickCandidate {
  return {
    kind: 'body',
    distance,
    hit: {} as PickCandidate['hit'],
    selection: { bodyId: toBodyId(bodyId), kind: 'body' }
  };
}

const stack = [pick('front', 1), pick('middle', 2), pick('back', 3)];
const bodyOf = (candidate: PickCandidate | null) =>
  candidate?.selection?.bodyId ?? null;

describe('a fresh click takes the frontmost candidate', () => {
  it('starts at the front with no previous cycle', () => {
    const { candidate } = cycleDepthPick(stack, null, 100, 100);
    expect(bodyOf(candidate)).toBe('front');
  });

  it('reports nothing when the pointer is over nothing', () => {
    const result = cycleDepthPick([], null, 100, 100);
    expect(result.candidate).toBeNull();
    expect(result.cycle).toBeNull();
  });
});

describe('clicking the same spot goes deeper', () => {
  it('steps one layer per click', () => {
    let cycle: DepthCycle | null = null;
    const seen: (string | null)[] = [];
    for (let click = 0; click < 3; click += 1) {
      const result = cycleDepthPick(stack, cycle, 100, 100);
      cycle = result.cycle;
      seen.push(bodyOf(result.candidate));
    }
    expect(seen).toEqual(['front', 'middle', 'back']);
  });

  it('wraps to the front rather than sticking at the back', () => {
    // Clicking past what you wanted should not require moving the pointer.
    let cycle: DepthCycle | null = null;
    let last: string | null = null;
    for (let click = 0; click < 4; click += 1) {
      const result = cycleDepthPick(stack, cycle, 100, 100);
      cycle = result.cycle;
      last = bodyOf(result.candidate);
    }
    expect(last).toBe('front');
  });

  it('tolerates the small drift of a hand holding still', () => {
    const first = cycleDepthPick(stack, null, 100, 100);
    const second = cycleDepthPick(stack, first.cycle, 102, 99);
    expect(bodyOf(second.candidate)).toBe('middle');
  });
});

describe('the cycle resets when the context changes', () => {
  it('starts over when the pointer moves somewhere else', () => {
    const first = cycleDepthPick(stack, null, 100, 100);
    const elsewhere = cycleDepthPick(stack, first.cycle, 300, 220);
    expect(bodyOf(elsewhere.candidate)).toBe('front');
  });

  it('starts over when the stack underneath has changed', () => {
    // A rebuilt model can put something different under the same pixel;
    // resuming at index 1 there would select an unrelated body.
    const first = cycleDepthPick(stack, null, 100, 100);
    const changed = [pick('other', 1), pick('middle', 2)];
    const next = cycleDepthPick(changed, first.cycle, 100, 100);
    expect(bodyOf(next.candidate)).toBe('other');
  });

  it('keeps cycling a single-candidate stack on the same candidate', () => {
    const single = [pick('only', 1)];
    const first = cycleDepthPick(single, null, 50, 50);
    const second = cycleDepthPick(single, first.cycle, 50, 50);
    expect(bodyOf(first.candidate)).toBe('only');
    expect(bodyOf(second.candidate)).toBe('only');
  });
});

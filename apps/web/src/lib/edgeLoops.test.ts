import { describe, expect, it } from 'vitest';
import { closedEdgeLoopCount, edgeSelectionName } from './edgeLoops';

/** A quarter arc of an r6 circle at height z, as a sampled polyline. */
function arc(quarter: number, z = 28) {
  const points: number[] = [];
  for (let step = 0; step <= 8; step += 1) {
    const angle = ((quarter + step / 8) * Math.PI) / 2;
    points.push(6 * Math.cos(angle), 6 * Math.sin(angle), z);
  }
  return { points };
}

describe('closed edge loops', () => {
  it('reads a rim split into four arcs as one closed edge', () => {
    const rim = [0, 1, 2, 3].map((quarter) => arc(quarter));
    expect(closedEdgeLoopCount(rim)).toBe(1);
    expect(edgeSelectionName(rim)).toEqual({
      label: 'Closed edge',
      noun: 'the closed edge',
      context: 'the selected closed edge'
    });
  });

  it('counts two rims as two closed edges', () => {
    const rims = [0, 1, 2, 3].flatMap((quarter) => [
      arc(quarter, 0),
      arc(quarter, 28)
    ]);
    expect(closedEdgeLoopCount(rims)).toBe(2);
    expect(edgeSelectionName(rims).label).toBe('2 closed edges');
  });

  it('keeps the plain count for an open run', () => {
    const run = [0, 1, 2].map((quarter) => arc(quarter));
    expect(closedEdgeLoopCount(run)).toBeNull();
    expect(edgeSelectionName(run).label).toBe('3 edges');
  });

  it('keeps the count when every picked edge is already its own loop', () => {
    const circle = {
      points: Array.from({ length: 17 }, (_, step) => {
        const angle = (step / 16) * 2 * Math.PI;
        return [6 * Math.cos(angle), 6 * Math.sin(angle), 0];
      }).flat()
    };
    expect(closedEdgeLoopCount([circle])).toBe(1);
    expect(edgeSelectionName([circle, arc(0, 40)]).label).toBe('2 edges');
  });
});

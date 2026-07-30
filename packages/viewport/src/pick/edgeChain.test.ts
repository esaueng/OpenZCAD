import { describe, expect, it } from 'vitest';
import type { EdgeTopology } from '@openzcad/shared';
import { edgeRunFrom } from './edgeChain';

/** An edge from a polyline given as [x, y, z] points. */
function edge(topologyId: string, points: number[][]): EdgeTopology {
  return { topologyId, hash: 0, points: points.flat() };
}

/**
 * A quarter arc from `from` to `to` about `centre`, sampled coarsely enough
 * that its end tangents are chords rather than true tangents — the same error
 * the kernel's display polylines carry.
 */
function arc(
  topologyId: string,
  centre: [number, number],
  radius: number,
  startDeg: number,
  endDeg: number,
  segments = 6
): EdgeTopology {
  const points: number[][] = [];
  for (let step = 0; step <= segments; step += 1) {
    const angle =
      ((startDeg + ((endDeg - startDeg) * step) / segments) * Math.PI) / 180;
    points.push([
      centre[0] + radius * Math.cos(angle),
      centre[1] + radius * Math.sin(angle),
      0
    ]);
  }
  return edge(topologyId, points);
}

describe('a run of one', () => {
  it('returns the seed when nothing continues from it', () => {
    const edges = [edge('a', [[0, 0, 0], [10, 0, 0]])];
    expect(edgeRunFrom(edges, 'a')).toEqual(['a']);
  });

  it('returns nothing for an edge that is not there', () => {
    expect(edgeRunFrom([], 'missing')).toEqual([]);
  });

  it('keeps an edge whose polyline is too short to have a direction', () => {
    // Degenerate geometry should not make the edge unselectable.
    const edges = [edge('a', [[1, 2, 3]])];
    expect(edgeRunFrom(edges, 'a')).toEqual(['a']);
  });

  it('does not expose an invisible periodic seam as an edge run', () => {
    const seam = edge('seam', [[0, 0, 0], [0, 0, 10]]);
    seam.displayRole = 'seam';
    expect(edgeRunFrom([seam], 'seam')).toEqual([]);
  });
});

describe('walking a smooth run', () => {
  it('follows collinear edges in both directions from the seed', () => {
    const edges = [
      edge('left', [[0, 0, 0], [10, 0, 0]]),
      edge('middle', [[10, 0, 0], [20, 0, 0]]),
      edge('right', [[20, 0, 0], [30, 0, 0]])
    ];
    expect(edgeRunFrom(edges, 'middle')).toEqual([
      'left',
      'middle',
      'right'
    ]);
  });

  it('follows an edge stored back to front', () => {
    // Edge direction is the kernel's choice; a rim does not agree to it.
    const edges = [
      edge('a', [[0, 0, 0], [10, 0, 0]]),
      edge('b', [[20, 0, 0], [10, 0, 0]])
    ];
    expect(edgeRunFrom(edges, 'a')).toEqual(['a', 'b']);
  });

  it('stops at a sharp corner', () => {
    const edges = [
      edge('along-x', [[0, 0, 0], [10, 0, 0]]),
      edge('along-y', [[10, 0, 0], [10, 10, 0]])
    ];
    expect(edgeRunFrom(edges, 'along-x')).toEqual(['along-x']);
  });

  it('ignores an edge that passes nearby without meeting', () => {
    const edges = [
      edge('a', [[0, 0, 0], [10, 0, 0]]),
      edge('gapped', [[10.5, 0, 0], [20, 0, 0]])
    ];
    expect(edgeRunFrom(edges, 'a')).toEqual(['a']);
  });
});

describe('a filleted rim', () => {
  /**
   * The top rim of a box whose four vertical edges have been filleted: four
   * straight runs joined by four quarter arcs, alternating all the way round.
   */
  const rim: EdgeTopology[] = [
    edge('side-s', [[3, 0, 0], [17, 0, 0]]),
    arc('corner-se', [17, 3], 3, -90, 0),
    edge('side-e', [[20, 3, 0], [20, 17, 0]]),
    arc('corner-ne', [17, 17], 3, 0, 90),
    edge('side-n', [[17, 20, 0], [3, 20, 0]]),
    arc('corner-nw', [3, 17], 3, 90, 180),
    edge('side-w', [[0, 17, 0], [0, 3, 0]]),
    arc('corner-sw', [3, 3], 3, 180, 270)
  ];

  it('selects the whole rim from any one of its edges', () => {
    for (const seed of rim) {
      const chain = edgeRunFrom(rim, seed.topologyId);
      expect(chain).toHaveLength(rim.length);
      expect(new Set(chain).size).toBe(rim.length);
      expect(chain).toContain(seed.topologyId);
    }
  });

  it('orders the run so consecutive entries touch', () => {
    const chain = edgeRunFrom(rim, 'side-s');
    const order = chain.map((id) => rim.findIndex((e) => e.topologyId === id));
    // Consecutive around the ring, in one direction or the other.
    const steps = order
      .slice(1)
      .map((value, index) => (value - order[index]! + 8) % 8);
    expect(new Set(steps).size).toBe(1);
  });

  it('walks the rim the kernel actually emits, whose arcs are one chord', () => {
    // Measured from a filleted box: every edge comes back as two points, so a
    // quarter arc is a bare chord and meets its neighbours at 45 degrees while
    // the perpendicular rim edge and the wall below both sit at 90. The
    // default tolerance has to separate those, not merely pass on well
    // sampled arcs.
    const chorded: EdgeTopology[] = [
      edge('side-s', [[3, 0, 0], [17, 0, 0]]),
      edge('corner-se', [[17, 0, 0], [20, 3, 0]]),
      edge('side-e', [[20, 3, 0], [20, 17, 0]]),
      edge('wall-se', [[20, 3, 0], [20, 3, -10]])
    ];
    const run = edgeRunFrom(chorded, 'side-s');
    expect(run).toEqual(['side-s', 'corner-se', 'side-e']);
    expect(run).not.toContain('wall-se');
  });

  it('does not run off the rim onto the wall below it', () => {
    // A vertical edge shares the corner but turns 90 degrees out of the rim.
    const withWall = [
      ...rim,
      edge('wall-se', [[20, 3, 0], [20, 3, -10]])
    ];
    expect(edgeRunFrom(withWall, 'side-s')).not.toContain('wall-se');
  });
});

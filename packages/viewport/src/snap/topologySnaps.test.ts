import { describe, expect, it } from 'vitest';
import type { EdgeTopology } from '@openzcad/shared';
import { snapsFromEdges } from './topologySnaps';

function edge(topologyId: string, points: number[][]): EdgeTopology {
  return { topologyId, hash: 0, points: points.flat() };
}

/** A circle in the z = plane, sampled evenly and closed on its seam. */
function circle(
  topologyId: string,
  cx: number,
  cy: number,
  z: number,
  radius: number,
  segments = 24
): EdgeTopology {
  const points: number[][] = [];
  for (let step = 0; step <= segments; step += 1) {
    const angle = (step / segments) * Math.PI * 2;
    points.push([
      cx + Math.cos(angle) * radius,
      cy + Math.sin(angle) * radius,
      z
    ]);
  }
  return edge(topologyId, points);
}

const kinds = (edges: EdgeTopology[]) =>
  snapsFromEdges(edges).map((candidate) => candidate.kind);

describe('what a straight edge offers', () => {
  const line = edge('a', [[0, 0, 0], [10, 0, 0]]);

  it('offers both ends and the middle', () => {
    expect(kinds([line]).sort()).toEqual(['endpoint', 'endpoint', 'midpoint']);
  });

  it('puts the midpoint halfway along', () => {
    const middle = snapsFromEdges([line]).find((c) => c.kind === 'midpoint');
    expect(middle?.point).toEqual({ x: 5, y: 0, z: 0 });
  });

  it('measures the middle by length, not by sample count', () => {
    // A sampler that crowds one end must not drag the midpoint with it.
    const uneven = edge('b', [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [10, 0, 0]
    ]);
    const middle = snapsFromEdges([uneven]).find((c) => c.kind === 'midpoint');
    expect(middle?.point.x).toBeCloseTo(5, 6);
  });
});

describe('what a closed edge offers', () => {
  const rim = circle('rim', 4, -2, 7, 3);

  it('offers its centre', () => {
    const found = snapsFromEdges([rim]);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe('center');
    expect(found[0]!.point.x).toBeCloseTo(4, 6);
    expect(found[0]!.point.y).toBeCloseTo(-2, 6);
    expect(found[0]!.point.z).toBeCloseTo(7, 6);
  });

  it('offers no ends, since a ring has none anyone aims at', () => {
    expect(kinds([rim])).toEqual(['center']);
  });

  it('leaves an open edge without a centre', () => {
    const arcish = edge('open', [[0, 0, 0], [3, 4, 0], [6, 0, 0]]);
    expect(kinds([arcish])).not.toContain('center');
  });
});

describe('sharing a model', () => {
  it('offers a shared corner once, not once per edge meeting it', () => {
    const meeting = [
      edge('x', [[0, 0, 0], [10, 0, 0]]),
      edge('y', [[0, 0, 0], [0, 10, 0]]),
      edge('z', [[0, 0, 0], [0, 0, 10]])
    ];
    const corners = snapsFromEdges(meeting).filter(
      (c) => c.kind === 'endpoint' && c.point.x === 0 && c.point.y === 0 && c.point.z === 0
    );
    expect(corners).toHaveLength(1);
  });

  it('narrows to the kinds a caller asked for', () => {
    const model = [edge('a', [[0, 0, 0], [10, 0, 0]]), circle('r', 0, 0, 0, 5)];
    expect(kinds(model)).toContain('midpoint');
    expect(
      snapsFromEdges(model, { kinds: ['endpoint', 'center'] }).map((c) => c.kind)
    ).not.toContain('midpoint');
  });

  it('skips an edge with nothing to measure', () => {
    expect(kinds([edge('degenerate', [[1, 2, 3]])])).toEqual([]);
  });

  it('carries the label a caller supplied, for the readout', () => {
    const labelled = snapsFromEdges([edge('a', [[0, 0, 0], [1, 0, 0]])], {
      label: 'Box Body'
    });
    expect(labelled.every((c) => c.label === 'Box Body')).toBe(true);
  });
});

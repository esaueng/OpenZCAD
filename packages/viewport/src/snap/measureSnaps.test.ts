import { describe, expect, it } from 'vitest';
import type { EdgeTopology } from '@openzcad/shared';
import { measureSnapEdges } from './measureSnaps';
import { snapsFromEdges } from './topologySnaps';

/**
 * The broadphase that keeps hover snapping from scaling with the model.
 *
 * `resolveSnap` projects every candidate it is handed, so the cost of snapping
 * is set here rather than there.
 */

/**
 * Each edge gets its own segment. `snapsFromEdges` dedupes candidates by
 * position — deliberately, so edges meeting at a vertex offer one glyph rather
 * than three — which would collapse a thousand identical fixtures to three
 * candidates and quietly make the cost test prove nothing.
 */
function edge(
  id: string,
  vertexIds?: [number, number],
  faces?: number[]
): EdgeTopology {
  const at = Number(id) || 0;
  return {
    topologyId: `edge:${id}`,
    hash: at || 1,
    points: [at, 0, 0, at, 1, 0],
    ...(vertexIds ? { vertexIds } : {}),
    ...(faces ? { adjacentFaceHashes: faces } : {})
  };
}

const ids = (edges: readonly EdgeTopology[]) =>
  edges.map((entry) => entry.topologyId);

describe('scoping to the edge under the pointer', () => {
  it('takes the edge and everything sharing a vertex with it', () => {
    const hovered = edge('1', [10, 11]);
    const edges = [
      hovered,
      edge('2', [11, 12]), // shares vertex 11
      edge('3', [99, 10]), // shares vertex 10
      edge('4', [50, 51]) // shares nothing
    ];
    expect(ids(measureSnapEdges(edges, { edge: hovered }))).toEqual([
      'edge:1',
      'edge:2',
      'edge:3'
    ]);
  });

  it('keeps the hovered edge even when it publishes no incidence', () => {
    // Without `vertexIds` there is no neighbourhood to widen to, and inferring
    // one from endpoint positions is exactly what that field exists to replace.
    const hovered = edge('1');
    const edges = [hovered, edge('2', [1, 2])];
    expect(ids(measureSnapEdges(edges, { edge: hovered }))).toEqual(['edge:1']);
  });

  it('does not treat an absent vertexIds on a neighbour as a match', () => {
    const hovered = edge('1', [10, 11]);
    const edges = [hovered, edge('2')];
    expect(ids(measureSnapEdges(edges, { edge: hovered }))).toEqual(['edge:1']);
  });
});

describe('scoping to the face under the pointer', () => {
  it('takes the edges that bound it', () => {
    const edges = [
      edge('1', [1, 2], [500, 600]),
      edge('2', [2, 3], [500, 700]),
      edge('3', [3, 4], [800, 900])
    ];
    expect(ids(measureSnapEdges(edges, { faceHash: 500 }))).toEqual([
      'edge:1',
      'edge:2'
    ]);
  });

  it('matches a face hash of zero rather than treating it as absent', () => {
    // FNV-1a maps a zero hash to 1 by construction, so this is defensive
    // rather than reachable — but `if (!faceHash)` would be wrong the day it
    // is, and the failure would be a face that silently offers no snaps.
    const edges = [edge('1', [1, 2], [0])];
    expect(ids(measureSnapEdges(edges, { faceHash: 0 }))).toEqual(['edge:1']);
  });
});

describe('scoping to nothing', () => {
  it('offers nothing rather than the whole body', () => {
    // The case the broadphase exists for. A hover over background handing the
    // model's every edge to `resolveSnap` is the hundred-thousand-projection
    // frame, and there is nothing under the pointer to snap to anyway.
    const edges = [edge('1', [1, 2]), edge('2', [2, 3])];
    expect(measureSnapEdges(edges, {})).toEqual([]);
    expect(measureSnapEdges(edges, { edge: null, faceHash: null })).toEqual([]);
  });
});

describe('the cost it actually buys', () => {
  it('keeps the candidate count bounded by local degree, not model size', () => {
    // A body big enough that the difference is the point: 4,000 edges, of
    // which four touch the hovered one.
    const hovered = edge('0', [0, 1]);
    const edges: EdgeTopology[] = [hovered];
    for (let index = 1; index < 4000; index += 1) {
      // Only the first few share a vertex with the hovered edge.
      const shares = index < 5;
      edges.push(
        edge(
          String(index),
          shares ? [1, index + 100] : [index + 1000, index + 2000]
        )
      );
    }

    const scoped = measureSnapEdges(edges, { edge: hovered });
    expect(scoped).toHaveLength(5);

    // What that means downstream: `snapsFromEdges` emits up to three per edge,
    // and every one of them gets projected on every hover frame.
    const scopedCandidates = snapsFromEdges(scoped);
    const wholeBody = snapsFromEdges(edges);
    expect(scopedCandidates.length).toBeLessThan(20);
    expect(wholeBody.length).toBeGreaterThan(1000);
    // Two orders of magnitude, on a body an imported assembly would dwarf.
    expect(
      wholeBody.length / Math.max(scopedCandidates.length, 1)
    ).toBeGreaterThan(100);
  });
});

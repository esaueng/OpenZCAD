import { describe, expect, it } from 'vitest';
import {
  toBodyId,
  toFeatureId,
  type EdgeTopology,
  type EdgeTopologyReferenceV5
} from '@openzcad/shared';
import { edgeRunFrom, edgeRunSelections } from './edgeChain';

/** An edge from a polyline given as [x, y, z] points. */
function edge(topologyId: string, points: number[][]): EdgeTopology {
  return { topologyId, hash: 0, points: points.flat() };
}

/**
 * A quarter arc from `from` to `to` about `centre`, sampled coarsely so that a
 * walk reading directions off the polyline sees chords rather than tangents.
 *
 * The kernel does not sample this coarsely — a display arc arrives with 28
 * points — but coarse sampling is what tells a chord-read direction apart from
 * one read off `EdgeCurve.circle`, which is what the tests below need.
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

  // A test that used to sit here asserted the run on a rim whose arcs were a
  // single chord, "the rim the kernel actually emits". The kernel does not
  // emit that: at the app's real display deflection a quarter arc arrives with
  // 28 points, and it is 28 across three decades of radius because the
  // deflection is size-relative. Deleted rather than relaxed — it was the only
  // thing pinning the 50 degree default and it pinned it for a reason that was
  // never true. What 50 is really holding together is measured against the
  // kernel in `test/edge-chain-characterization.test.ts`.

  it('does not run off the rim onto the wall below it', () => {
    // A vertical edge shares the corner but turns 90 degrees out of the rim.
    const withWall = [
      ...rim,
      edge('wall-se', [[20, 3, 0], [20, 3, -10]])
    ];
    expect(edgeRunFrom(withWall, 'side-s')).not.toContain('wall-se');
  });
});

describe('incidence by vertex identity', () => {
  /** The same edge, with the kernel's vertices attached. */
  function withVertices(
    entry: EdgeTopology,
    vertexIds: [number, number]
  ): EdgeTopology {
    return { ...entry, vertexIds };
  }

  it('refuses two edges that touch in space but name different vertices', () => {
    // Two solids that merely touch. Coincident to the last bit, and still not
    // one run: the kernel considers them separate topology, and the vertex
    // numbering says so.
    const edges = [
      withVertices(edge('left', [[0, 0, 0], [10, 0, 0]]), [0, 1]),
      withVertices(edge('right', [[10, 0, 0], [20, 0, 0]]), [2, 3])
    ];
    expect(edgeRunFrom(edges, 'left')).toEqual(['left']);
  });

  it('joins two edges that name one vertex however far apart their polylines start', () => {
    // The converse, and the reason identity is not a tighter tolerance: a
    // sampler is free to start a polyline away from the edge's own vertex, and
    // the walk must not care.
    const edges = [
      withVertices(edge('left', [[0, 0, 0], [10, 0, 0]]), [0, 1]),
      withVertices(edge('right', [[10.5, 0, 0], [20, 0, 0]]), [1, 2])
    ];
    expect(edgeRunFrom(edges, 'left')).toEqual(['left', 'right']);
  });

  it('answers the same at 1x, 1000x and 0.001x', () => {
    // Nothing in the topological path has a length in it. The geometric
    // fallback is relative to the body, so it does not either.
    for (const scale of [1, 1000, 0.001]) {
      const geometry = [
        edge('left', [[0, 0, 0], [10 * scale, 0, 0]]),
        edge('middle', [[10 * scale, 0, 0], [20 * scale, 0, 0]]),
        edge('corner', [[20 * scale, 0, 0], [20 * scale, 10 * scale, 0]])
      ];
      expect(edgeRunFrom(geometry, 'left'), `${scale}x geometric`).toEqual([
        'left',
        'middle'
      ]);
      const topological = [
        withVertices(geometry[0]!, [0, 1]),
        withVertices(geometry[1]!, [1, 2]),
        withVertices(geometry[2]!, [2, 3])
      ];
      expect(edgeRunFrom(topological, 'left'), `${scale}x topological`).toEqual([
        'left',
        'middle'
      ]);
    }
  });

  it('keeps a closed edge a run of one', () => {
    // A bore rim names one vertex twice. It leaves that vertex and comes back
    // to it, so a run through it has nowhere to go, and the payload cannot say
    // which way it leaves anyway.
    const rim = withVertices(
      arc('bore-rim', [0, 0], 3, 0, 360, 12),
      [0, 0]
    );
    const stem = withVertices(edge('stem', [[3, 0, 0], [3, 0, -10]]), [0, 1]);
    expect(edgeRunFrom([rim, stem], 'bore-rim')).toEqual(['bore-rim']);
    expect(edgeRunFrom([rim, stem], 'stem')).toEqual(['stem']);
  });

  it('falls back to welding for an edge with no vertices of its own', () => {
    // A payload written before `vertexIds` existed, or one edge of it the
    // kernel refused. The rest of the body still walks topologically; this one
    // is reached the old way.
    const edges = [
      withVertices(edge('left', [[0, 0, 0], [10, 0, 0]]), [0, 1]),
      edge('middle', [[10, 0, 0], [20, 0, 0]]),
      withVertices(edge('right', [[20, 0, 0], [30, 0, 0]]), [2, 3])
    ];
    expect(edgeRunFrom(edges, 'left')).toEqual(['left', 'middle', 'right']);
  });
});

describe('the run as selections', () => {
  const bodyId = toBodyId('body-1');

  function reference(lineageName: string): EdgeTopologyReferenceV5 {
    return {
      kind: 'edge',
      producingFeatureId: toFeatureId('feature-1'),
      lineageName,
      currentHash: 0,
      witnessVersion: 1,
      witness: {
        curveType: 'LINE',
        length: 10,
        closed: false,
        endpoints: [
          [0, 0, 0],
          [10_000_000, 0, 0]
        ],
        midpoint: [5_000_000, 0, 0]
      }
    };
  }

  /** Three collinear edges, published the way a referenced body publishes
   *  them: hash and v5 reference alongside the polyline. */
  function referencedRun(): EdgeTopology[] {
    return [
      {
        ...edge('left', [[0, 0, 0], [10, 0, 0]]),
        hash: 11,
        reference: reference('edge.left')
      },
      {
        ...edge('middle', [[10, 0, 0], [20, 0, 0]]),
        hash: 12,
        reference: reference('edge.middle')
      },
      {
        ...edge('right', [[20, 0, 0], [30, 0, 0]]),
        hash: 13,
        reference: reference('edge.right')
      }
    ];
  }

  it('carries hash and reference for every edge of the run', () => {
    // The reference is what lets a chain-selected fillet or chamfer survive an
    // upstream parameter edit: a closed edge's ADR-011 hash embeds its
    // circumference, so persisting the run hash-only fails closed on the first
    // radius change. This mapping once dropped `reference`, and the create
    // form's all-or-nothing guard turned that into zero persisted references.
    const run = referencedRun();
    const selections = edgeRunSelections(run, 'middle', bodyId);
    expect(selections.map((selection) => selection.topologyId)).toEqual([
      'left',
      'middle',
      'right'
    ]);
    selections.forEach((selection, index) => {
      expect(selection.bodyId).toBe(bodyId);
      expect(selection.kind).toBe('edge');
      expect(selection.hash).toBe(run[index]!.hash);
      expect(selection.reference).toBe(run[index]!.reference);
    });
    // The exact guard the create form applies: references are persisted only
    // when every selected edge carries one. A full run must pass it.
    const references = selections.flatMap((selection) =>
      selection.reference?.kind === 'edge' ? [selection.reference] : []
    );
    expect(references).toHaveLength(selections.length);
  });

  it('omits the reference key for an edge the kernel could not prove', () => {
    const run = referencedRun();
    delete run[1]!.reference;
    const selections = edgeRunSelections(run, 'left', bodyId);
    expect(selections.map((selection) => 'reference' in selection)).toEqual([
      true,
      false,
      true
    ]);
  });
});

describe('directions read from the exact curve', () => {
  const circle = (radius: number) => ({
    type: 'CIRCLE',
    circle: {
      center: { x: 0, y: 0, z: 0 },
      axis: { x: 0, y: 0, z: 1 },
      radius
    }
  });

  /** A quarter arc sampled so that its end chord is 11.25 degrees off. */
  const coarse: EdgeTopology = {
    ...arc('arc', [0, 0], 3, -90, 0, 4),
    curve: circle(3)
  };
  const tangentLine = edge('line', [[3, 0, 0], [3, 10, 0]]);

  it('holds a tangent join that the sampled chord would break', () => {
    // At a 5 degree cone the chord's 11.25 degrees is a corner and the true
    // tangent is a straight line. The exact circle is what the walk uses.
    expect(
      edgeRunFrom([coarse, tangentLine], 'arc', { tangentToleranceDeg: 5 })
    ).toEqual(['arc', 'line']);
    const withoutCurve = { ...coarse, curve: undefined };
    expect(
      edgeRunFrom([withoutCurve, tangentLine], 'arc', {
        tangentToleranceDeg: 5
      })
    ).toEqual(['arc']);
  });

  it('ignores a circle that does not describe the edge it is attached to', () => {
    // `EdgeCurve.circle.axis` is unoriented by contract, so the tangent it
    // yields is a line and the polyline picks the direction. A record that
    // disagrees with the polyline outright is not describing this end, and the
    // chord is used instead of a confidently wrong answer.
    const mismatched: EdgeTopology = {
      ...coarse,
      curve: {
        type: 'CIRCLE',
        circle: {
          center: { x: 0, y: 0, z: 0 },
          axis: { x: 0, y: 1, z: 0 },
          radius: 3
        }
      }
    };
    expect(
      edgeRunFrom([mismatched, tangentLine], 'arc', { tangentToleranceDeg: 5 })
    ).toEqual(['arc']);
  });

  it('takes the same run whichever way the unoriented axis points', () => {
    const flipped: EdgeTopology = {
      ...coarse,
      curve: {
        type: 'CIRCLE',
        circle: {
          center: { x: 0, y: 0, z: 0 },
          axis: { x: 0, y: 0, z: -1 },
          radius: 3
        }
      }
    };
    expect(
      edgeRunFrom([flipped, tangentLine], 'arc', { tangentToleranceDeg: 5 })
    ).toEqual(['arc', 'line']);
  });
});

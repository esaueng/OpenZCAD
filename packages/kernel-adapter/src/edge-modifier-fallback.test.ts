import { describe, expect, it } from 'vitest';
import {
  blendAdviceOf,
  closedEdgeLoopCount,
  EdgeModifierRefusalError,
  edgeModifierFailureMessage,
  edgeModifierRefusal
} from './exact-edge-modifiers';
import type { RemusKernel } from './remus-runtime';

/**
 * A kernel that refuses everything: every probe on the size ladder throws,
 * and so does every later topology question. That is the one path where no
 * smaller size built and no cause could be named.
 */
const refusingKernel = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error('refused');
    }
  }
) as RemusKernel;

describe('edge modifier fallback advice', () => {
  it.each(['fillet', 'chamfer'] as const)(
    'does not advise selecting fewer edges for a single refused %s edge',
    (kind) => {
      const message = edgeModifierFailureMessage(
        refusingKernel,
        1,
        [2],
        kind,
        2.1,
        false
      );
      expect(message).not.toContain('fewer edges');
      expect(message).toContain('neighboring faces');
      expect(message).not.toContain('Try a smaller');
    }
  );

  it('does not advise a smaller size once every smaller size was refused', () => {
    const fillet = edgeModifierFailureMessage(
      refusingKernel,
      1,
      [2, 3],
      'fillet',
      3,
      false
    );
    expect(fillet).toBe(
      'Fillet could not be created on 2 selected edges with radius 3. ' +
        'Smaller radii were refused too, so a different size is unlikely to help. ' +
        'Try rounding fewer edges at once, or different edges.'
    );
    const chamfer = edgeModifierFailureMessage(
      refusingKernel,
      1,
      [2],
      'chamfer',
      1.5,
      false
    );
    expect(chamfer).toBe(
      'Chamfer could not be created on 1 selected edge with distance 1.5. ' +
        'Smaller distances were refused too. The kernel could not build this edge ' +
        'with its current neighboring faces. Try a different edge or change the adjacent geometry.'
    );
    expect(chamfer).not.toContain('Try a smaller');
  });

  it('returns the same verdict as data, so a control never reads the sentence', () => {
    const refusal = edgeModifierRefusal(
      refusingKernel,
      1,
      [2, 3],
      'fillet',
      3,
      false
    );
    expect(refusal.advice).toEqual({
      operation: 'fillet',
      edges: 2,
      kind: 'structural',
      cause: 'unknown',
      reason:
        'Smaller radii were refused too, so a different size is unlikely to help. ' +
        'Try rounding fewer edges at once, or different edges.'
    });
    // The reason is the message without its preamble, never a second wording.
    expect(refusal.message.endsWith(refusal.advice!.reason)).toBe(true);
    const thrown = new EdgeModifierRefusalError(
      refusal.message,
      refusal.advice
    );
    expect(blendAdviceOf(thrown)).toBe(refusal.advice);
    expect(blendAdviceOf(new Error(refusal.message))).toBeUndefined();
  });
});

/**
 * The rim of a unioned r6 cylinder, as the boolean leaves it: four quarter
 * arcs (edges 1–4) joined end to end through vertices 11–14, between the
 * flat cap (face 8) and the cylindrical wall (face 9). An earlier round
 * (face 10, a torus) shares edge 5 with the wall, away from the rim.
 * Anything this table does not answer throws, as a refusing kernel does.
 */
function rimKernel(): RemusKernel {
  const arcVertices: Record<number, [number, number]> = {
    1: [11, 12],
    2: [12, 13],
    3: [13, 14],
    4: [14, 11]
  };
  const point = (vertex: number) => {
    const angle = ((vertex - 11) * Math.PI) / 2;
    return [6 * Math.cos(angle), 6 * Math.sin(angle), 28];
  };
  const faceEdges: Record<number, number[]> = {
    8: [1, 2, 3, 4],
    9: [1, 2, 3, 4, 5],
    10: [5, 6]
  };
  const surfaces: Record<number, string> = {
    8: 'plane',
    9: 'cylinder',
    10: 'torus'
  };
  const table: Record<string, (...args: number[]) => unknown> = {
    getEdgeVertexHandles: (edge) =>
      Uint32Array.from(arcVertices[edge] ?? [21, 22]),
    getEdgeVertices: (edge) => {
      const [start, end] = arcVertices[edge]!;
      return Float64Array.from([...point(start), ...point(end)]);
    },
    getEdgeCurveType: () => 'CIRCLE',
    edgeLength: () => 3 * Math.PI,
    getEdgeCurveParameters: () => Float64Array.from([0, Math.PI / 2]),
    evaluateEdgeCurve: () => Float64Array.from([4.24, 4.24, 28]),
    getSolidFaces: () => Uint32Array.from([8, 9, 10]),
    getFaceEdges: (face) => Uint32Array.from(faceEdges[face] ?? []),
    getSurfaceType: (face) => surfaces[face] ?? 'plane'
  };
  return new Proxy(
    {},
    {
      get: (_target, name: string) =>
        table[name] ??
        (() => {
          throw new Error('refused');
        })
    }
  ) as RemusKernel;
}

describe('a closed rim split into arcs', () => {
  it('counts the four arcs as the one closed edge the user picked', () => {
    expect(closedEdgeLoopCount(rimKernel(), [1, 2, 3, 4])).toBe(1);
    // Three of the four arcs are an open run, not a loop.
    expect(closedEdgeLoopCount(rimKernel(), [1, 2, 3])).toBeNull();
  });

  it('names the rim as one edge and does not advise picking fewer of it', () => {
    const message = edgeModifierFailureMessage(
      rimKernel(),
      7,
      [1, 2, 3, 4],
      'fillet',
      1,
      false
    );
    expect(message).toMatch(
      /^Fillet could not be created on the selected closed edge with radius 1\./
    );
    expect(message).not.toContain('4 selected edges');
    expect(message).not.toContain('fewer edges');
  });

  it('explains a trimming refusal on the wall that meets an earlier round', () => {
    const message = edgeModifierFailureMessage(
      rimKernel(),
      7,
      [1, 2, 3, 4],
      'fillet',
      1,
      false,
      'trimming-failure: blend: trimming failure on face Id(9)'
    );
    expect(message).toBe(
      'Fillet could not be created on the selected closed edge with radius 1. ' +
        'The modeling engine could not trim the cylindrical face beside it, ' +
        'which also meets an earlier fillet or chamfer. Smaller radii failed ' +
        'too, so a different size is unlikely to help. Try a different edge, or ' +
        'try adding this edge to that earlier feature so both are built together.'
    );
  });

  it('does not blame an earlier round the trimmed face never meets', () => {
    const message = edgeModifierFailureMessage(
      rimKernel(),
      7,
      [1, 2, 3, 4],
      'chamfer',
      1,
      false,
      'trimming-failure: blend: trimming failure on face Id(8)'
    );
    expect(message).toContain('could not trim the flat face beside it.');
    expect(message).not.toContain('earlier fillet');
    expect(message).toContain('Smaller distances failed too');
  });
});

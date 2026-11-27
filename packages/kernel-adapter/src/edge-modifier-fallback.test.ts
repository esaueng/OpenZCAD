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
    // Every rung refused with the requested size's own code: the one proof
    // "smaller sizes were refused too" rests on.
    const fillet = edgeModifierFailureMessage(
      ladderKernel('fillet-failed').kernel,
      1,
      [2, 3],
      'fillet',
      3,
      false,
      'fillet-failed: an invented kernel sentence',
      undefined,
      undefined,
      'fillet-failed'
    );
    expect(fillet).toBe(
      'Fillet could not be created on 2 selected edges with radius 3. ' +
        'Smaller radii were refused too, so a different size is unlikely to help. ' +
        'Try rounding fewer edges at once, or different edges.'
    );
    const chamfer = edgeModifierFailureMessage(
      ladderKernel('fillet-failed').kernel,
      1,
      [2],
      'chamfer',
      1.5,
      false,
      'fillet-failed: an invented kernel sentence',
      undefined,
      undefined,
      'fillet-failed'
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
      ladderKernel('fillet-failed').kernel,
      1,
      [2, 3],
      'fillet',
      3,
      false,
      'fillet-failed: an invented kernel sentence',
      undefined,
      undefined,
      'fillet-failed'
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
function rimKernel(refusalCode?: string): RemusKernel {
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
    getSurfaceType: (face) => surfaces[face] ?? 'plane',
    // With a code, every rung of the ladder reaches the kernel's typed
    // blend and is refused with it; without one, the rungs throw.
    ...(refusalCode
      ? {
          boundingBox: () => Float64Array.from([-6, -6, 0, 6, 6, 28]),
          filletDetailed: () => typedRefusal(refusalCode),
          chamferDetailed: () => typedRefusal(refusalCode)
        }
      : {})
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

function typedRefusal(code: string) {
  return {
    status: 'error',
    code,
    category: 'internal',
    details: { kernelCode: code, message: 'an invented kernel sentence' }
  };
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
      rimKernel('trimming-failure'),
      7,
      [1, 2, 3, 4],
      'fillet',
      1,
      false,
      'trimming-failure: blend: trimming failure on face Id(9)',
      undefined,
      undefined,
      'trimming-failure'
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
      rimKernel('trimming-failure'),
      7,
      [1, 2, 3, 4],
      'chamfer',
      1,
      false,
      'trimming-failure: blend: trimming failure on face Id(8)',
      undefined,
      undefined,
      'trimming-failure'
    );
    expect(message).toContain('could not trim the flat face beside it.');
    expect(message).not.toContain('earlier fillet');
    expect(message).toContain('Smaller distances failed too');
  });
});

/**
 * A body the probe ladder can run on: every rung reaches the kernel's typed
 * fillet or chamfer and is refused with `code`. Any other question throws,
 * so no cause is named and the diagnosis reaches its fallback. `calls`
 * counts the rungs that ran.
 */
function ladderKernel(code: string): { kernel: RemusKernel; calls: number[] } {
  const calls: number[] = [];
  const refuse = (_target: number, _edges: Uint32Array, size: number) => {
    calls.push(size);
    return {
      status: 'error',
      code,
      category: 'internal',
      details: { kernelCode: code, message: 'an invented kernel sentence' }
    };
  };
  const table: Record<string, unknown> = {
    boundingBox: () => Float64Array.from([0, 0, 0, 10, 10, 10]),
    filletDetailed: refuse,
    chamferDetailed: refuse
  };
  const kernel = new Proxy(
    {},
    {
      get: (_target, name: string) =>
        table[name] ??
        (() => {
          throw new Error('refused');
        })
    }
  ) as RemusKernel;
  return { kernel, calls };
}

/**
 * "Smaller sizes were refused too" is a claim about rungs of the ladder, so
 * it is made only when a rung ran and the kernel refused it the way it
 * refused the requested size (#2201's rule for its inner-loop cause, here
 * for the older fallbacks). Otherwise the sentence makes no claim.
 */
describe('the fallback claims smaller sizes failed only when one was tried', () => {
  it.each([
    ['chamfer', [2], 'neighbor-faces'],
    ['fillet', [2, 3], 'unknown']
  ] as const)(
    'makes no claim for a %s too small for any rung to run',
    (kind, edges, cause) => {
      // Every rung of 1.5e-9 is at or under GEOMETRY_EPSILON, so none runs.
      const refusal = edgeModifierRefusal(
        refusingKernel,
        1,
        [...edges],
        kind,
        1.5e-9,
        false
      );
      expect(refusal.advice).toMatchObject({ kind: 'structural', cause });
      expect(refusal.message).not.toMatch(/[Ss]maller/);
      expect(refusal.message.endsWith(refusal.advice!.reason)).toBe(true);
    }
  );

  it('words the no-claim fallbacks in full', () => {
    expect(
      edgeModifierRefusal(refusingKernel, 1, [2], 'chamfer', 1.5e-9, false)
        .advice?.reason
    ).toBe(
      'The kernel could not build this edge with its current neighboring faces. Try a different edge or change the adjacent geometry.'
    );
    expect(
      edgeModifierRefusal(refusingKernel, 1, [2, 3], 'chamfer', 1.5e-9, false)
        .advice?.reason
    ).toBe('Try chamfering fewer edges at once, or different edges.');
  });

  it('makes no claim when the smaller rungs were refused for another reason', () => {
    const { kernel, calls } = ladderKernel('fillet-failed');
    const refusal = edgeModifierRefusal(
      kernel,
      1,
      [2],
      'chamfer',
      4,
      false,
      'cliff-encountered: an invented kernel sentence',
      undefined,
      undefined,
      'cliff-encountered'
    );
    // The ladder did run, all three rungs, and every one was refused.
    expect(calls).toEqual([2, 0.5, 0.0625]);
    expect(refusal.advice).toMatchObject({
      kind: 'structural',
      cause: 'neighbor-faces'
    });
    expect(refusal.message).not.toMatch(/[Ss]maller/);
  });

  it('keeps the claim when a smaller rung was refused with the same code', () => {
    const { kernel, calls } = ladderKernel('fillet-failed');
    const refusal = edgeModifierRefusal(
      kernel,
      1,
      [2, 3],
      'fillet',
      4,
      false,
      'fillet-failed: an invented kernel sentence',
      undefined,
      undefined,
      'fillet-failed'
    );
    expect(calls).toHaveLength(3);
    expect(refusal.advice).toEqual({
      operation: 'fillet',
      edges: 2,
      kind: 'structural',
      cause: 'unknown',
      reason:
        'Smaller radii were refused too, so a different size is unlikely to help. ' +
        'Try rounding fewer edges at once, or different edges.'
    });
  });

  it('makes no claim when a rung was discarded without a code', () => {
    // The requested radius 4 came back unaccepted with no typed refusal, and
    // so did every rung: the exact-only probe discards an approximate result
    // without a code, though the normal build would accept that size. Two
    // missing codes are not the same refusal (review of 72942e1).
    const calls: number[] = [];
    const table: Record<string, unknown> = {
      boundingBox: () => Float64Array.from([0, 0, 0, 10, 10, 10]),
      filletDetailed: (_target: number, _edges: Uint32Array, size: number) => {
        calls.push(size);
        return { status: 'ok', value: 99, details: { quality: 'approximate' } };
      }
    };
    const kernel = new Proxy(
      {},
      {
        get: (_target, name: string) =>
          table[name] ??
          (() => {
            throw new Error('refused');
          })
      }
    ) as RemusKernel;
    for (const edges of [[2], [2, 3]]) {
      calls.length = 0;
      const refusal = edgeModifierRefusal(
        kernel,
        1,
        edges,
        'fillet',
        4,
        false,
        'Fillet did not produce a changed solid.',
        undefined,
        undefined,
        null
      );
      // The ladder ran every rung, and none is a refusal.
      expect(calls).toEqual([2, 0.5, 0.0625]);
      expect(refusal.advice?.kind).toBe('structural');
      expect(refusal.message, edges.join(',')).not.toMatch(/[Ss]maller/);
    }
  });

  it('makes no claim for a named cause whose rungs threw', () => {
    // Throwing rungs carry no code, so the trim-face sentence makes no claim
    // even though the requested size was typed.
    const message = edgeModifierFailureMessage(
      rimKernel(),
      7,
      [1, 2, 3, 4],
      'fillet',
      1,
      false,
      'trimming-failure: blend: trimming failure on face Id(9)',
      undefined,
      undefined,
      'trimming-failure'
    );
    expect(message).toContain('could not trim the cylindrical face beside it');
    expect(message).not.toMatch(/[Ss]maller/);
  });

  it('drops the claim from a named cause too when no rung ran', () => {
    const message = edgeModifierFailureMessage(
      rimKernel(),
      7,
      [1, 2, 3, 4],
      'chamfer',
      1.5e-9,
      false,
      'trimming-failure: blend: trimming failure on face Id(8)'
    );
    expect(message).toContain('could not trim the flat face beside it.');
    expect(message).not.toMatch(/[Ss]maller/);
    expect(message).toMatch(
      /could not trim the flat face beside it\. Try a different edge, or change the geometry next to it first\.$/
    );
  });
});

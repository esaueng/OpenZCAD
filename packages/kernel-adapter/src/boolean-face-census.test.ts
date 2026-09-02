/**
 * The post-boolean face-count census.
 *
 * Remus's booleans can abandon exact surface intersection on sliver and
 * near-tangent contacts — thin glyph stems and touching letters produce
 * exactly that — and return a triangulated, all-planar approximation instead.
 * The result is watertight, passes validation, and has a plausible volume and
 * triangle count, so none of the existing distrust checks notice. The faces
 * are the signal: every curved surface becomes planar and the count explodes.
 */
import { describe, expect, it } from 'vitest';
import {
  booleanFacetFallbackWarning,
  censusOfSolids,
  directEditFacetFallbackWarning,
  type FaceCensusSubject
} from './boolean-result-validation';

function kernelOf(
  solids: Readonly<Record<number, string[]>>
): FaceCensusSubject {
  const surfaceBySolidFace = new Map<number, string>();
  const facesBySolid = new Map<number, number[]>();
  let nextFace = 1;
  for (const [solid, surfaces] of Object.entries(solids)) {
    const handles: number[] = [];
    for (const surface of surfaces) {
      surfaceBySolidFace.set(nextFace, surface);
      handles.push(nextFace);
      nextFace += 1;
    }
    facesBySolid.set(Number(solid), handles);
  }
  return {
    getSolidFaces: (solid) => facesBySolid.get(solid) ?? [],
    getSurfaceType: (face) => surfaceBySolidFace.get(face) ?? 'plane'
  };
}

describe('censusOfSolids', () => {
  it('counts faces and separates curved surfaces from planes', () => {
    const kernel = kernelOf({
      1: ['plane', 'plane', 'cylinder'],
      2: ['plane', 'sphere', 'torus', 'bspline']
    });
    expect(censusOfSolids(kernel, [1, 2])).toEqual({
      faces: 7,
      curvedFaces: 4
    });
  });

  it('is empty for no solids', () => {
    expect(censusOfSolids(kernelOf({}), [])).toEqual({
      faces: 0,
      curvedFaces: 0
    });
  });
});

describe('booleanFacetFallbackWarning', () => {
  it('says nothing about an ordinary boolean of planar solids', () => {
    // Two boxes cut: six planar faces in, ten or so out. Nothing curved was
    // ever there to lose, and the growth is modest.
    expect(
      booleanFacetFallbackWarning({
        operands: { faces: 12, curvedFaces: 0 },
        result: { faces: 16, curvedFaces: 0 }
      })
    ).toBeNull();
  });

  it('says nothing when a boolean splits curved faces normally', () => {
    expect(
      booleanFacetFallbackWarning({
        operands: { faces: 8, curvedFaces: 3 },
        result: { faces: 14, curvedFaces: 4 }
      })
    ).toBeNull();
  });

  it('flags the real case: curvature lost and face count exploded', () => {
    // These are the numbers a shallow cylinder union actually produces
    // against the pinned kernel.
    const warning = booleanFacetFallbackWarning({
      operands: { faces: 6, curvedFaces: 2 },
      result: { faces: 193, curvedFaces: 0 }
    });
    expect(warning).toContain('could only be built as an approximation');
    expect(warning).toContain('6 operand faces (2 curved)');
    expect(warning).toContain('193 result faces (0 curved)');
  });

  it('flags losing every curved face even without an explosion', () => {
    const warning = booleanFacetFallbackWarning({
      operands: { faces: 8, curvedFaces: 2 },
      result: { faces: 10, curvedFaces: 0 }
    });
    expect(warning).toContain('replaced every curved surface with flat faces');
  });

  it('flags an explosion even when nothing curved was involved', () => {
    // All-planar text fused into an all-planar slab still facets; there is
    // just no curvature left to lose, so face count is the only tell.
    const warning = booleanFacetFallbackWarning({
      operands: { faces: 30, curvedFaces: 0 },
      result: { faces: 400, curvedFaces: 0 }
    });
    expect(warning).toContain('far more faces than its operands');
  });

  it('leaves headroom for small operands that legitimately split', () => {
    // A six-face box cut by a six-face box can reach the high twenties
    // without anything being wrong. The additive slack covers that; the
    // multiplicative bound alone would not.
    expect(
      booleanFacetFallbackWarning({
        operands: { faces: 12, curvedFaces: 0 },
        result: { faces: 44, curvedFaces: 0 }
      })
    ).toBeNull();
    expect(
      booleanFacetFallbackWarning({
        operands: { faces: 12, curvedFaces: 0 },
        result: { faces: 81, curvedFaces: 0 }
      })
    ).not.toBeNull();
  });
});

describe('directEditFacetFallbackWarning', () => {
  it('accepts an offset that preserves analytic faces without exploding', () => {
    expect(
      directEditFacetFallbackWarning({
        operands: { faces: 8, curvedFaces: 2 },
        result: { faces: 10, curvedFaces: 2 }
      })
    ).toBeNull();
  });

  it('rejects an offset that replaces the source curvature with planes', () => {
    expect(
      directEditFacetFallbackWarning({
        operands: { faces: 5, curvedFaces: 2 },
        result: { faces: 96, curvedFaces: 0 }
      })
    ).toBe(
      "This offset could only be built by replacing the body's exact surfaces with flat triangles, so it was refused and the body left unchanged.\n5 source faces (2 curved) became 96 result faces (0 curved)"
    );
  });

  it('rejects an explosive offset even if some curvature survives', () => {
    expect(
      directEditFacetFallbackWarning({
        operands: { faces: 5, curvedFaces: 2 },
        result: { faces: 64, curvedFaces: 1 }
      })
    ).toContain('could only be built by replacing');
  });
});

/**
 * The card shows the text before the first newline and hides the rest behind a
 * disclosure, so a refusal that leads with face counts reaches the user as
 * kernel bookkeeping instead of as something to act on.
 */
describe('facet refusal detail split', () => {
  const bothSignals = {
    operands: { faces: 6, curvedFaces: 2 },
    result: { faces: 193, curvedFaces: 0 }
  };
  const curvatureOnly = {
    operands: { faces: 8, curvedFaces: 2 },
    result: { faces: 10, curvedFaces: 0 }
  };
  const explodedOnly = {
    operands: { faces: 30, curvedFaces: 0 },
    result: { faces: 400, curvedFaces: 0 }
  };

  function split(warning: string | null): {
    sentence: string;
    detail: string;
  } {
    expect(warning).not.toBeNull();
    const boundary = warning!.indexOf('\n');
    expect(boundary).toBeGreaterThan(0);
    return {
      sentence: warning!.slice(0, boundary),
      detail: warning!.slice(boundary + 1)
    };
  }

  it.each([
    ['both signals', bothSignals],
    ['lost curvature only', curvatureOnly],
    ['exploded only', explodedOnly]
  ])('keeps the census out of the %s boolean sentence', (_name, census) => {
    const { sentence, detail } = split(
      booleanFacetFallbackWarning(census, 'union')
    );
    expect(sentence).not.toMatch(/\d/);
    expect(sentence).toContain('This union');
    expect(detail).toBe(
      `${census.operands.faces} operand faces (${census.operands.curvedFaces} curved) became ` +
        `${census.result.faces} result faces (${census.result.curvedFaces} curved)`
    );
  });

  it('keeps the census out of the offset refusal sentence', () => {
    const census = {
      operands: { faces: 5, curvedFaces: 2 },
      result: { faces: 96, curvedFaces: 0 }
    };
    const { sentence, detail } = split(directEditFacetFallbackWarning(census));
    expect(sentence).not.toMatch(/\d/);
    expect(detail).toBe(
      '5 source faces (2 curved) became 96 result faces (0 curved)'
    );
  });

  it('names the operation it was given, and stays neutral without one', () => {
    expect(booleanFacetFallbackWarning(bothSignals, 'subtract')).toContain(
      'This subtract'
    );
    expect(booleanFacetFallbackWarning(bothSignals, 'intersect')).toContain(
      'This intersection'
    );
    expect(booleanFacetFallbackWarning(bothSignals)).toContain(
      'This boolean operation'
    );
  });

  it('does not tell a subtract to subtract instead', () => {
    expect(booleanFacetFallbackWarning(bothSignals, 'union')).toContain(
      'or subtract instead'
    );
    expect(booleanFacetFallbackWarning(bothSignals, 'subtract')).not.toContain(
      'subtract instead'
    );
  });
});

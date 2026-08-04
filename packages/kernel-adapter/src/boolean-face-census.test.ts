/**
 * The post-boolean face-count census.
 *
 * BrepKit's booleans can abandon exact surface intersection on sliver and
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
    expect(warning).toContain(
      'faceted approximation instead of exact surfaces'
    );
    expect(warning).toContain('6 operand faces (2 curved)');
    expect(warning).toContain('193 result faces (0 curved)');
  });

  it('flags losing every curved face even without an explosion', () => {
    const warning = booleanFacetFallbackWarning({
      operands: { faces: 8, curvedFaces: 2 },
      result: { faces: 10, curvedFaces: 0 }
    });
    expect(warning).toContain(
      'replaced every curved surface with planar faces'
    );
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

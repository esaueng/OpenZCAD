/**
 * What is left of the post-boolean face-count census.
 *
 * The census was built to catch a boolean that silently abandoned exact
 * surface intersection and returned a triangulated, all-planar approximation:
 * the result was watertight, passed validation, and had a plausible volume
 * and triangle count, so only the faces gave it away. The pinned kernel's
 * `cut` / `fuse` / `intersect` are exact-only — they refuse that pair by name
 * instead of returning it — so the boolean arm of the census now guards
 * nothing and is gone; `exact-boolean-refusal.test.ts` pins the contract that
 * replaced it.
 *
 * Two users survive, and both are deliberate:
 *
 * - `directEditFacetFallbackWarning` guards `pushPullFace`, which is not a
 *   boolean and has no exact-only policy behind it. It still facets.
 * - `unionSwallowedCurvature` answers a different question for the union
 *   move probe: whether a candidate offset merely buries the moving body
 *   inside the anchor. That fuses perfectly exactly — and makes the user's
 *   new body disappear.
 */
import { describe, expect, it } from 'vitest';
import {
  censusOfSolids,
  directEditFacetFallbackWarning,
  unionSwallowedCurvature,
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

describe('unionSwallowedCurvature', () => {
  it('flags a candidate whose result kept no curved surface at all', () => {
    // A sphere slid to the centre of the box it was meant to sit on: the
    // fuse is exact, and the sphere is gone.
    expect(
      unionSwallowedCurvature({
        operands: { faces: 8, curvedFaces: 2 },
        result: { faces: 6, curvedFaces: 0 }
      })
    ).toBe(true);
  });

  it('accepts a union that keeps curvature', () => {
    expect(
      unionSwallowedCurvature({
        operands: { faces: 8, curvedFaces: 3 },
        result: { faces: 14, curvedFaces: 4 }
      })
    ).toBe(false);
  });

  it('says nothing about all-planar operands, which never had curvature', () => {
    expect(
      unionSwallowedCurvature({
        operands: { faces: 12, curvedFaces: 0 },
        result: { faces: 16, curvedFaces: 0 }
      })
    ).toBe(false);
  });

  it('does not judge face-count growth: a big result is not a refusal', () => {
    // The exploded-face-count half of the old census belonged to the boolean
    // fallback, which cannot happen any more. Keeping it here would refuse
    // union moves that are merely complicated.
    expect(
      unionSwallowedCurvature({
        operands: { faces: 30, curvedFaces: 0 },
        result: { faces: 400, curvedFaces: 0 }
      })
    ).toBe(false);
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

  it('leaves headroom for a small body that legitimately splits', () => {
    // A six-face box can reach the high twenties under a push/pull without
    // anything being wrong. The additive slack covers that; the
    // multiplicative bound alone would not.
    expect(
      directEditFacetFallbackWarning({
        operands: { faces: 12, curvedFaces: 0 },
        result: { faces: 44, curvedFaces: 0 }
      })
    ).toBeNull();
    expect(
      directEditFacetFallbackWarning({
        operands: { faces: 12, curvedFaces: 0 },
        result: { faces: 81, curvedFaces: 0 }
      })
    ).not.toBeNull();
  });
});

/**
 * The card shows the text before the first newline and hides the rest behind a
 * disclosure, so a refusal that leads with face counts reaches the user as
 * kernel bookkeeping instead of as something to act on.
 */
describe('facet refusal detail split', () => {
  it('keeps the census out of the offset refusal sentence', () => {
    const census = {
      operands: { faces: 5, curvedFaces: 2 },
      result: { faces: 96, curvedFaces: 0 }
    };
    const warning = directEditFacetFallbackWarning(census);
    expect(warning).not.toBeNull();
    const boundary = warning!.indexOf('\n');
    expect(boundary).toBeGreaterThan(0);
    expect(warning!.slice(0, boundary)).not.toMatch(/\d/);
    expect(warning!.slice(boundary + 1)).toBe(
      '5 source faces (2 curved) became 96 result faces (0 curved)'
    );
  });
});

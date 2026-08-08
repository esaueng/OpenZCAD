/**
 * Which published face numbers are exact, which are sampled, and by how much.
 *
 * The measurement workbench grades every figure it shows on a provenance
 * ladder, and today `faceArea` and `edgeLength` are graded identically even
 * though only one of them is exact. Before that ladder can be corrected — and
 * before a face perimeter is published at all — the actual behaviour of the
 * PINNED BrepKit build has to be measured rather than inferred from doc
 * comments, because the two claims that mattered most both turned out to be
 * wrong in this file's first run.
 *
 * The results, all measured below:
 *
 *   box face area              rel = 0            EXACT
 *   cylinder lateral area      rel = 0            EXACT   (closed form)
 *   sphere area                rel = 0            EXACT   (closed form)
 *   cylinder PLANAR cap area   rel = -1.004e-4    SAMPLED <- a planar face!
 *   any facePerimeter          rel = 0            EXACT
 *
 * The cap is the surprise. "Planar" does not imply "exact": a planar face
 * whose boundary is curved has its area computed from a polygon inscribed in
 * that boundary, so it reads LOW. The error is invariant under both scale and
 * deflection, which is what identifies it as a fixed sample count rather than
 * a tessellation artifact — see the inscribed-polygon test below, which
 * recovers the sample count from the error itself.
 *
 * This matters beyond a label. `MEASUREMENT_DEFLECTION` is the knob a caller
 * would reach for to buy accuracy, and on this class of face it buys nothing.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { BrepKernel } from '../packages/kernel-adapter/node_modules/brepkit-wasm/brepkit_wasm.js';

/** The deflection `exact.ts` passes for every published measurement. */
const MEASUREMENT_DEFLECTION = 0.08;

let kernel: BrepKernel | null = null;

function useKernel(): BrepKernel {
  kernel ??= new BrepKernel();
  return kernel;
}

afterAll(() => {
  kernel?.free();
  kernel = null;
});

function facesOf(solid: number): number[] {
  return Array.from(useKernel().getSolidFaces(solid));
}

function relativeError(value: number, exact: number): number {
  return (value - exact) / exact;
}

describe('face area provenance', () => {
  it('is exact for a planar face with straight edges', () => {
    const box = useKernel().makeBox(20, 20, 20);
    const total = facesOf(box).reduce(
      (sum, face) => sum + useKernel().faceArea(face, MEASUREMENT_DEFLECTION),
      0
    );
    expect(relativeError(total, 2400)).toBe(0);
  });

  it('is exact for analytic quadrics — cylinder wall and sphere', () => {
    const cylinder = useKernel().makeCylinder(10, 20);
    const wall = facesOf(cylinder).find(
      (face) => useKernel().getSurfaceType(face) === 'cylinder'
    )!;
    expect(
      relativeError(
        useKernel().faceArea(wall, MEASUREMENT_DEFLECTION),
        2 * Math.PI * 10 * 20
      )
    ).toBe(0);

    const sphere = useKernel().makeSphere(10, 64);
    const sphereArea = facesOf(sphere).reduce(
      (sum, face) => sum + useKernel().faceArea(face, MEASUREMENT_DEFLECTION),
      0
    );
    expect(relativeError(sphereArea, 4 * Math.PI * 100)).toBe(0);
  });

  it('is SAMPLED for a planar face with a curved boundary, and reads low', () => {
    // The disc cap of a cylinder: planar, and bounded by one circle.
    const cylinder = useKernel().makeCylinder(10, 20);
    const cap = facesOf(cylinder).find(
      (face) => useKernel().getSurfaceType(face) === 'plane'
    )!;
    const error = relativeError(
      useKernel().faceArea(cap, MEASUREMENT_DEFLECTION),
      Math.PI * 100
    );

    // Inscribed, so under-reported, by ~100 parts per million. That is
    // visible at four decimal places on a 100 mm disc.
    expect(error).toBeLessThan(0);
    expect(error).toBeCloseTo(-1.004e-4, 7);
  }, 120_000);

  it('samples that boundary a FIXED number of times — deflection buys nothing', () => {
    const cylinder = useKernel().makeCylinder(10, 20);
    const cap = facesOf(cylinder).find(
      (face) => useKernel().getSurfaceType(face) === 'plane'
    )!;

    // A 500x range of deflection, including one far finer than the app ever
    // asks for. If this were tessellation-bound the error would collapse.
    const errors = [0.5, MEASUREMENT_DEFLECTION, 0.001].map((deflection) =>
      relativeError(useKernel().faceArea(cap, deflection), Math.PI * 100)
    );
    expect(errors[1]).toBe(errors[0]);
    expect(errors[2]).toBe(errors[0]);
  }, 120_000);

  it('is scale-invariant, and the error recovers a 256-point boundary', () => {
    // Same relative error across four orders of magnitude of radius: the
    // count is fixed, not chosen from the geometry.
    const errors = [1, 10, 100, 1000].map((radius) => {
      const cylinder = useKernel().makeCylinder(radius, 20);
      const cap = facesOf(cylinder).find(
        (face) => useKernel().getSurfaceType(face) === 'plane'
      )!;
      return relativeError(
        useKernel().faceArea(cap, MEASUREMENT_DEFLECTION),
        Math.PI * radius * radius
      );
    });
    for (const error of errors) {
      expect(error).toBeCloseTo(errors[0]!, 12);
    }

    // A regular n-gon inscribed in a circle has area ratio
    // n*sin(2*pi/n)/(2*pi). Solving that against the measured error names
    // the sample count outright, which is the difference between "some
    // approximation" and a number a reader can reason about.
    const ratioFor = (n: number) =>
      (n * Math.sin((2 * Math.PI) / n)) / (2 * Math.PI);
    expect(ratioFor(256) - 1).toBeCloseTo(errors[0]!, 9);
    // Neighbouring counts do not fit, so 256 is identified rather than fitted.
    expect(ratioFor(128) - 1).not.toBeCloseTo(errors[0]!, 9);
    expect(ratioFor(512) - 1).not.toBeCloseTo(errors[0]!, 9);
  }, 120_000);
});

describe('face perimeter provenance', () => {
  it('is exact, including around a circular boundary', () => {
    const box = useKernel().makeBox(20, 20, 20);
    expect(relativeError(useKernel().facePerimeter(facesOf(box)[0]!), 80)).toBe(
      0
    );

    const cylinder = useKernel().makeCylinder(10, 20);
    const cap = facesOf(cylinder).find(
      (face) => useKernel().getSurfaceType(face) === 'plane'
    )!;
    // Exact where the AREA of the same face is not: perimeter sums exact edge
    // arclength, area inscribes a polygon. So a face can honestly publish an
    // exact perimeter beside a sampled area, and the ladder must grade the two
    // fields separately rather than grading the face.
    expect(
      relativeError(useKernel().facePerimeter(cap), 2 * Math.PI * 10)
    ).toBe(0);
  });

  it('DOUBLE-COUNTS a seam, while getFaceEdges dedupes it', () => {
    // This inverts the assumption the overhaul plan was written on, which
    // said to prefer getFaceWires + getWireEdges over getFaceEdges for a
    // boundary length. It is the wrong way round.
    //
    // A cylinder wall is one wire that walks: bottom circle, up the seam,
    // top circle, back DOWN the same seam. The seam is one edge traversed
    // twice, so a wire-order sum counts its length twice.
    const cylinder = useKernel().makeCylinder(10, 20);
    const wall = facesOf(cylinder).find(
      (face) => useKernel().getSurfaceType(face) === 'cylinder'
    )!;

    const wires = Array.from(useKernel().getFaceWires(wall));
    const viaWires = wires.flatMap((wire) =>
      Array.from(useKernel().getWireEdges(wire))
    );
    const faceEdges = Array.from(useKernel().getFaceEdges(wall));

    expect(wires).toHaveLength(1);
    // Four traversal steps over three distinct edges.
    expect(viaWires).toHaveLength(4);
    expect(new Set(viaWires).size).toBe(3);
    // getFaceEdges reports each edge once.
    expect(faceEdges).toHaveLength(3);
    expect(new Set(faceEdges).size).toBe(3);

    const circles = 2 * (2 * Math.PI * 10);
    const seam = 20;
    const dedupedSum = faceEdges.reduce(
      (total, edge) => total + useKernel().edgeLength(edge),
      0
    );

    // facePerimeter follows the wire, so it includes the seam twice.
    expect(useKernel().facePerimeter(wall)).toBeCloseTo(circles + 2 * seam, 9);
    // The deduped sum includes it once.
    expect(dedupedSum).toBeCloseTo(circles + seam, 9);

    // Neither is what a person means by "the perimeter of this face" — the
    // seam is a parameterization artifact and is not a boundary at all. So
    // a published perimeter must be built from getFaceEdges with seam edges
    // excluded (EdgeTopology.displayRole already distinguishes them), and
    // facePerimeter() must not be published raw.
    expect(useKernel().facePerimeter(wall)).not.toBeCloseTo(circles, 6);
    expect(dedupedSum).not.toBeCloseTo(circles, 6);
  }, 120_000);
});

describe('edge length provenance', () => {
  it('is exact for every curve type ordinary modelling produces', () => {
    // `kernel.edgeLength` takes no deflection parameter, unlike `faceArea`.
    // That is the whole reason the two cannot share a provenance label, and
    // it is why `EdgeTopology.length` can be graded a tier above face area.
    const box = useKernel().makeBox(20, 20, 20);
    const boxEdges = Array.from(useKernel().getSolidEdges(box));
    expect(useKernel().getEdgeCurveType(boxEdges[0]!)).toBe('LINE');
    expect(relativeError(useKernel().edgeLength(boxEdges[0]!), 20)).toBe(0);

    const cylinder = useKernel().makeCylinder(10, 20);
    const circles = Array.from(useKernel().getSolidEdges(cylinder)).filter(
      (edge) => useKernel().getEdgeCurveType(edge) === 'CIRCLE'
    );
    expect(circles).toHaveLength(2);
    for (const edge of circles) {
      expect(
        relativeError(useKernel().edgeLength(edge), 2 * Math.PI * 10)
      ).toBe(0);
    }
  }, 120_000);

  it('stays exact on a fillet blend, which is a CIRCLE rather than a spline', () => {
    // Worth pinning because a filleted body is the one shape whose VOLUME is
    // not exact (test/filleted-body-volume.test.ts). The blend's edges are
    // not the reason: they are exact quarter arcs of the fillet radius. So a
    // measured fillet edge is trustworthy even on a body whose volume is not.
    const box = useKernel().makeBox(20, 20, 20);
    let filleted: number | null = null;
    for (const edge of Array.from(useKernel().getSolidEdges(box))) {
      try {
        filleted = useKernel().fillet(box, new Uint32Array([edge]), 2);
        break;
      } catch {
        // Tangent and degenerate edges are refused; try the next one.
      }
    }
    expect(filleted).not.toBeNull();

    const arcs = Array.from(useKernel().getSolidEdges(filleted!)).filter(
      (edge) => useKernel().getEdgeCurveType(edge) === 'CIRCLE'
    );
    expect(arcs.length).toBeGreaterThan(0);
    const quarterArc = (2 * Math.PI * 2) / 4;
    for (const arc of arcs) {
      expect(relativeError(useKernel().edgeLength(arc), quarterArc)).toBe(0);
    }
  }, 120_000);

  // NOT measured here: BSPLINE_CURVE and ELLIPSE edge length. Neither arises
  // from the primitives, booleans, or blends this build produces — they come
  // from imported STEP and from lofts — so grading them would mean asserting
  // something this file did not measure. Consumers must keep treating an
  // absent `EdgeTopology.length` as "fall back and say so", per the field's
  // own contract in packages/shared/src/index.ts.
});

describe('bounding box provenance', () => {
  it('is tight on a sphere, not a loose tessellation hull', () => {
    // A loose box would be the obvious hazard for a published "size" figure.
    // It is tight, so bbox extents can be graded exact for analytic bodies.
    const sphere = useKernel().makeSphere(10, 64);
    const box = Array.from(useKernel().boundingBox(sphere));
    for (const low of box.slice(0, 3)) {
      expect(low).toBeCloseTo(-10, 9);
    }
    for (const high of box.slice(3, 6)) {
      expect(high).toBeCloseTo(10, 9);
    }
  });
});

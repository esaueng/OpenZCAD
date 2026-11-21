import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeDxf } from '@openzcad/io-dxf';
import {
  exactSolidSection,
  sectionDxfEntities,
  sectionPlaneFrame,
  tessellatedSectionWitness,
  type ExactSectionKernel,
  type ExactSectionOutcome,
  type ExactSectionPlane,
  type ExactSectionSuccess
} from '../packages/kernel-adapter/src/exact-section';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

/**
 * The exact section, measured against the geometry it claims to describe.
 *
 * These run on raw kernel solids rather than documents: the question is what
 * the pinned kernel's `section` actually returns and which of its answers the
 * adapter is right to refuse, and a primitive is the shortest path to a case
 * whose true cross-section is known in closed form.
 */

let kernel: ExactSectionKernel & {
  makeBox(dx: number, dy: number, dz: number): number;
  makeCylinder(radius: number, height: number): number;
  makeSphere(radius: number, segments: number): number;
  makePolygon(coords: Float64Array): number;
  extrude(face: number, dx: number, dy: number, dz: number, by: number): number;
  getFaceNormal(face: number): Float64Array;
  cut(a: number, b: number): number;
  transformSolid(solid: number, matrix: Float64Array): void;
  free?(): void;
};

beforeAll(() => {
  kernel = new RemusKernel();
});

afterAll(() => {
  kernel.free?.();
});

const plane = (
  origin: readonly [number, number, number],
  normal: readonly [number, number, number]
): ExactSectionPlane => ({ origin, normal });

/** Row-major translation, the only matrix layout the kernel accepts. */
const translation = (x: number, y: number, z: number) =>
  Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1);

function rotationZ(radians: number, x: number, y: number, z: number) {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return Float64Array.of(c, -s, 0, x, s, c, 0, y, 0, 0, 1, z, 0, 0, 0, 1);
}

/** A 20x10x6 bar with a 4 mm bore through its thickness at (10, 5). */
function boredBar(): number {
  const bar = kernel.makeBox(20, 10, 6);
  const bore = kernel.makeCylinder(2, 20);
  kernel.transformSolid(bore, translation(10, 5, -5));
  return kernel.cut(bar, bore);
}

/**
 * A regular polygonal prism standing on z = z0: its round walls are flats,
 * so its caps carry the chords a section kernel without analytic curves
 * would return for a circle of `radius`.
 */
function polygonPrism(
  radius: number,
  sides: number,
  center: readonly [number, number],
  z0: number,
  height: number
): number {
  const corners: number[] = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = (2 * Math.PI * i) / sides;
    corners.push(
      center[0] + radius * Math.cos(angle),
      center[1] + radius * Math.sin(angle),
      z0
    );
  }
  return kernel.extrude(
    kernel.makePolygon(Float64Array.from(corners)),
    0,
    0,
    1,
    height
  );
}

/** The upward-facing planar face of a solid that has exactly one. */
function topCap(solid: number): number {
  const caps = Array.from(kernel.getSolidFaces(solid)).filter(
    (face) =>
      kernel.getSurfaceType(face) === 'plane' &&
      kernel.getFaceNormal(face)[2]! > 0.5
  );
  expect(caps).toHaveLength(1);
  return caps[0]!;
}

/**
 * The pinned kernel sections a cylinder or sphere along its true circle.
 * The chorded-boundary verdict is still the adapter's to get right for any
 * section that comes back as chords, so these cases hand it one: `section`
 * returns `face`, a real face whose curved boundary is a polygon.
 */
function withSection<T>(face: number, run: () => T): T {
  const section = vi
    .spyOn(kernel, 'section')
    .mockReturnValue(Uint32Array.of(face));
  try {
    return run();
  } finally {
    section.mockRestore();
  }
}

/** {@link boredBar}'s section at z = 3 with its bore cut into 64 chords. */
function chordedBoredBarCap(): number {
  return topCap(
    kernel.cut(kernel.makeBox(20, 10, 3), polygonPrism(2, 64, [10, 5], -1, 5))
  );
}

function expectOk(outcome: ExactSectionOutcome): ExactSectionSuccess {
  if (outcome.status !== 'ok') {
    throw new Error(
      `Expected an exact section, got ${outcome.reason}: ${outcome.message}`
    );
  }
  return outcome;
}

/** Enclosed area of one section loop, measured in the cutting plane. */
function loopArea(
  points: readonly (readonly [number, number, number])[],
  cut: ExactSectionPlane
): number {
  const frame = sectionPlaneFrame(cut);
  const project = (p: readonly [number, number, number]) => {
    const d = [
      p[0] - cut.origin[0],
      p[1] - cut.origin[1],
      p[2] - cut.origin[2]
    ] as const;
    return [
      d[0] * frame.u[0] + d[1] * frame.u[1] + d[2] * frame.u[2],
      d[0] * frame.v[0] + d[1] * frame.v[1] + d[2] * frame.v[2]
    ] as const;
  };
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = project(points[i]!);
    const b = project(points[(i + 1) % points.length]!);
    total += (a[0] * b[1] - b[0] * a[1]) / 2;
  }
  return Math.abs(total);
}

describe('exact section of a known part', () => {
  it('returns the kernel cross-section when the tessellated witness agrees', () => {
    const bar = kernel.makeBox(20, 10, 6);
    const cut = plane([0, 0, 3], [0, 0, 1]);
    const section = expectOk(exactSolidSection(kernel, bar, cut));
    expect(section.area).toBeCloseTo(200, 9);
    expect(Math.abs(section.area - section.witnessArea)).toBeLessThanOrEqual(
      section.areaTolerance
    );
    // Four straight edges on four planar faces: nothing stands in for a curve.
    expect(section.boundary).toBe('exact');
    expect(section.loops).toHaveLength(1);
    expect(section.loops[0]!.kind).toBe('outer');
    expect(section.loops[0]!.points).toHaveLength(4);
    for (const point of section.loops[0]!.points) {
      expect(point[2]).toBeCloseTo(3, 9);
    }
    expect(section.indices.length).toBeGreaterThanOrEqual(3);
    for (let i = 2; i < section.positions.length; i += 3) {
      expect(section.positions[i]).toBeCloseTo(3, 5);
    }
  });

  it('accepts a normal that is not a unit vector', () => {
    const bar = kernel.makeBox(20, 10, 6);
    const section = expectOk(
      exactSolidSection(kernel, bar, plane([0, 0, 3], [0, 0, 7]))
    );
    expect(section.area).toBeCloseTo(200, 9);
  });

  it('refuses a degenerate plane normal', () => {
    const bar = kernel.makeBox(10, 10, 10);
    expect(() =>
      exactSolidSection(kernel, bar, plane([0, 0, 5], [0, 0, 0]))
    ).toThrow(/degenerate/);
  });
});

describe('a through hole in the section', () => {
  it('carries the bore as an inner loop', () => {
    const bar = boredBar();
    const cut = plane([0, 0, 3], [0, 0, 1]);
    const section = expectOk(exactSolidSection(kernel, bar, cut));
    expect(section.loops).toHaveLength(2);
    expect(section.loops.map((loop) => loop.kind)).toEqual(['outer', 'inner']);
    const outer = loopArea(section.loops[0]!.points, cut);
    const hole = loopArea(section.loops[1]!.points, cut);
    expect(outer).toBeCloseTo(200, 6);
    // The kernel keeps the bore's circle, so the area is the true one; the
    // loop is that circle sampled for drawing, inscribed in it.
    expect(hole).toBeGreaterThan(Math.PI * 4 * 0.99);
    expect(hole).toBeLessThan(Math.PI * 4);
    expect(Math.abs(section.area - (200 - Math.PI * 4))).toBeLessThan(1e-9);
    expect(section.boundary).toBe('exact');
    // The cut surface is drawn as material only, never over the bore.
    expect(section.positions.length / 3).toBeGreaterThan(4);
  });

  it('reports a bore kept as its circle as an exact boundary', () => {
    const section = expectOk(
      exactSolidSection(kernel, boredBar(), plane([0, 0, 3], [0, 0, 1]))
    );
    const trueArea = 200 - Math.PI * 4;
    expect(Math.abs(section.area - trueArea)).toBeLessThan(trueArea * 1e-12);
    expect(section.boundary).toBe('exact');
  });

  it('reports a chorded bore as an approximate boundary, never an exact one', () => {
    const bar = boredBar();
    const cut = plane([0, 0, 3], [0, 0, 1]);
    const section = expectOk(
      withSection(chordedBoredBarCap(), () =>
        exactSolidSection(kernel, bar, cut)
      )
    );
    const trueArea = 200 - Math.PI * 4;
    const polygonError = Math.abs(section.area - trueArea);
    // The tessellated witness cannot see this: the polygon is well inside
    // the slack a display mesh is allowed.
    expect(polygonError).toBeGreaterThan(1e-3);
    expect(polygonError).toBeLessThan(section.areaTolerance);
    const curved = section.loops.some((loop) => loop.points.length > 4);
    const exactArea = polygonError <= trueArea * 1e-6;
    // Either the kernel kept the circle and its area, or the section says
    // it did not. A polygon reported as exact is the defect.
    expect(curved).toBe(true);
    expect(section.boundary).toBe(exactArea ? 'exact' : 'approximate');
  });

  it('accepts circle edges that lie on the solid as an exact boundary', () => {
    // What a kernel that keeps analytic section curves returns for a round
    // bar: one planar face bounded by a circle edge. A second, shorter bar's
    // top cap is that face, at the height the taller one is cut.
    const rod = kernel.makeCylinder(5, 10);
    const stub = kernel.makeCylinder(5, 4);
    const cap = Array.from(kernel.getSolidFaces(stub)).find(
      (face) =>
        kernel.getSurfaceType(face) === 'plane' &&
        kernel.getFaceNormal(face)[2]! > 0.5
    )!;
    const cut = plane([0, 0, 4], [0, 0, 1]);
    const section = vi
      .spyOn(kernel, 'section')
      .mockReturnValue(Uint32Array.of(cap));
    try {
      const outcome = expectOk(exactSolidSection(kernel, rod, cut));
      expect(outcome.boundary).toBe('exact');
      expect(Math.abs(outcome.area - Math.PI * 25)).toBeLessThan(
        Math.PI * 25 * 1e-9
      );
      const entities = sectionDxfEntities(kernel, outcome.faces, cut, 1);
      expect(entities).toHaveLength(1);
      expect(entities[0]).toMatchObject({ kind: 'circle' });
      if (entities[0]!.kind !== 'circle') return;
      expect(entities[0]!.radius).toBeCloseTo(5, 9);
    } finally {
      section.mockRestore();
    }
  });

  it('does not call a boundary exact when an edge cannot be measured', () => {
    const bar = boredBar();
    const distance = vi
      .spyOn(kernel, 'pointToSolidDistance')
      .mockImplementation(() => {
        throw new Error('no point-to-face distance witness was found');
      });
    try {
      const section = expectOk(
        exactSolidSection(kernel, bar, plane([0, 0, 3], [0, 0, 1]))
      );
      expect(section.boundary).toBe('approximate');
    } finally {
      distance.mockRestore();
    }
  });

  it('calls a chorded cut approximate where the surface leans from the plane', () => {
    // Review of #1695, first round: near the top of a sphere a chord is
    // 0.0012 from the SPHERE and 0.0038 from the CIRCLE it stands in for, so
    // a figure built from the former understated the area error by half.
    // The verdict never depended on which; it is all that is reported now.
    const ball = kernel.makeSphere(10, 64);
    const cut = plane([0, 0, 9.5], [0, 0, 1]);
    const analytic = Math.PI * (10 ** 2 - 9.5 ** 2);
    // The kernel's own section keeps the circle.
    const kept = expectOk(exactSolidSection(kernel, ball, cut));
    expect(Math.abs(kept.area - analytic)).toBeLessThan(analytic * 1e-9);
    expect(kept.boundary).toBe('exact');
    // The same cut as 64 chords, their corners on the sphere.
    const chorded = topCap(
      polygonPrism(Math.sqrt(10 ** 2 - 9.5 ** 2), 64, [0, 0], 8.5, 1)
    );
    const section = expectOk(
      withSection(chorded, () => exactSolidSection(kernel, ball, cut))
    );
    expect(Math.abs(section.area - analytic)).toBeGreaterThan(analytic * 1e-4);
    expect(section.boundary).toBe('approximate');
    expect(section).not.toHaveProperty('boundaryDeviation');
    expect(section).not.toHaveProperty('areaUncertainty');
  });

  it('puts no number on a chord whose nearest boundary is another wall', () => {
    // Review of #1695, re-check: a radius-10 bar with a coaxial 64-sided
    // bore, its flats 0.001 inside the chords the kernel cuts the bar's
    // circle into. Every outer chord's midpoint is nearest one of those
    // flats, not the arc it replaces. Anything measured from "the nearest
    // boundary" reads 0.001 where the arc is 0.012 away, and bounds the area
    // error at an eighth of what it is. So nothing is measured from it.
    const sides = 64;
    const inradius = 10 * Math.cos(Math.PI / sides) - 0.001;
    const circumradius = inradius / Math.cos(Math.PI / sides);
    const corners: number[] = [];
    for (let i = 0; i < sides; i += 1) {
      const angle = (2 * Math.PI * i) / sides;
      corners.push(
        circumradius * Math.cos(angle),
        circumradius * Math.sin(angle),
        -1
      );
    }
    const bore = kernel.extrude(
      kernel.makePolygon(Float64Array.from(corners)),
      0,
      0,
      1,
      12
    );
    const sleeve = kernel.cut(kernel.makeCylinder(10, 10), bore);
    const cut = plane([0, 0, 5], [0, 0, 1]);
    // The kernel keeps the outer circle, so the scenario needs the chorded
    // section a kernel without analytic curves would give: the bar's circle
    // as 64 chords round the same 64-sided bore.
    const chorded = topCap(
      kernel.cut(
        polygonPrism(10, sides, [0, 0], 0, 5),
        polygonPrism(circumradius, sides, [0, 0], -1, 12)
      )
    );
    const section = expectOk(
      withSection(chorded, () => exactSolidSection(kernel, sleeve, cut))
    );
    expect(section.loops.map((loop) => loop.points.length)).toEqual([
      sides,
      sides
    ]);

    // The scenario is the one described: the polygon's area is half a
    // square unit short of the ring's, and the nearest boundary to an outer
    // chord's midpoint is the bore's flat, a thousandth away.
    const boreArea = sides * inradius ** 2 * Math.tan(Math.PI / sides);
    const areaError = Math.abs(section.area - (Math.PI * 100 - boreArea));
    expect(areaError).toBeGreaterThan(0.5);
    const [a, b] = section.loops[0]!.points;
    const nearest = kernel.pointToSolidDistance(
      (a![0] + b![0]) / 2,
      (a![1] + b![1]) / 2,
      5,
      sleeve
    )[0]!;
    const sagitta = 10 * (1 - Math.cos(Math.PI / sides));
    expect(nearest).toBeCloseTo(0.001, 6);
    expect(sagitta).toBeGreaterThan(nearest * 12);

    expect(section.boundary).toBe('approximate');
    expect(section).not.toHaveProperty('boundaryDeviation');
    expect(section).not.toHaveProperty('areaUncertainty');
  }, 30_000);

  it('gives one sphere one verdict, whatever unit it is modelled in', () => {
    // Review of #1695: a 0.5 mm sphere cut through its centre. Its chords
    // miss the circle by 5.9e-7 mm — 5.9e-10 in a metre document, which a
    // tolerance floored at 1e-9 of one unit called exact.
    const measured = [
      ['mm', 1],
      ['inch', 25.4],
      ['m', 1000]
    ].map(([unit, mmPerUnit]) => {
      const scale = mmPerUnit as number;
      const ball = kernel.makeSphere(0.5 / scale, 64);
      const cut = plane([0, 0, 0], [0, 0, 1]);
      const kept = expectOk(exactSolidSection(kernel, ball, cut));
      // The great circle as 2048 chords, their corners on the sphere: each
      // misses the circle by 0.5 (1 - cos(pi / 2048)) = 5.9e-7 mm.
      const chorded = topCap(
        polygonPrism(0.5 / scale, 2048, [0, 0], -0.1 / scale, 0.1 / scale)
      );
      const section = expectOk(
        withSection(chorded, () => exactSolidSection(kernel, ball, cut))
      );
      return {
        unit,
        kept: kept.boundary,
        keptAreaMm2: kept.area * scale ** 2,
        boundary: section.boundary,
        chords: section.loops[0]!.points.length,
        areaMm2: section.area * scale ** 2
      };
    });
    // The kernel's own section keeps the circle in every unit.
    expect(measured.map((result) => result.kept)).toEqual([
      'exact',
      'exact',
      'exact'
    ]);
    for (const result of measured) {
      expect(Math.abs(result.keptAreaMm2 - Math.PI * 0.25)).toBeLessThan(
        Math.PI * 0.25 * 1e-9
      );
    }
    expect(measured.map((result) => result.boundary)).toEqual([
      'approximate',
      'approximate',
      'approximate'
    ]);
    // The same polygon in each: the same chords, the same physical area,
    // short of the disc it stands in for.
    const [mm] = measured;
    for (const result of measured) {
      expect(result.chords).toBe(mm!.chords);
      expect(Math.abs(result.areaMm2 - mm!.areaMm2)).toBeLessThan(
        mm!.areaMm2 * 1e-9
      );
      expect(result.areaMm2).toBeLessThan(Math.PI * 0.25);
    }
  }, 60_000);

  it('reports an unchecked boundary as approximate, at no cost', () => {
    const bar = kernel.makeBox(20, 10, 6);
    const distance = vi.spyOn(kernel, 'pointToSolidDistance');
    try {
      const section = expectOk(
        exactSolidSection(kernel, bar, plane([0, 0, 3], [0, 0, 1]), {
          skipBoundaryCheck: true
        })
      );
      // Even a box: nobody looked, so nobody may call it exact.
      expect(section.boundary).toBe('approximate');
      expect(distance).not.toHaveBeenCalled();
    } finally {
      distance.mockRestore();
    }
  });

  it('stops at the first edge that is off the solid', () => {
    // The verdict is settled by one stray chord; the other 63 are not paid
    // for. Four outline edges on the solid, then the bore's first chord.
    const bar = boredBar();
    const chorded = chordedBoredBarCap();
    const distance = vi.spyOn(kernel, 'pointToSolidDistance');
    try {
      const section = expectOk(
        withSection(chorded, () =>
          exactSolidSection(kernel, bar, plane([0, 0, 3], [0, 0, 1]))
        )
      );
      expect(section.boundary).toBe('approximate');
      expect(distance.mock.calls.length).toBeLessThanOrEqual(5);
    } finally {
      distance.mockRestore();
    }
  });

  it('refuses a bore-parallel section without authoritative cap clipping', () => {
    const bar = boredBar();
    // Down the bore axis. The true cross-section is 20x6 minus a 4x6 slot;
    // The kernel refuses this configuration before producing an outline.
    const outcome = exactSolidSection(kernel, bar, plane([0, 5, 0], [0, 1, 0]));
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.reason).toBe('kernel-refused');
    expect(outcome.message).toContain(
      'cylindrical section parallel to axis requires authoritative cap clipping'
    );
  });

  it('independently refuses an outline that omits the bore', () => {
    const bar = boredBar();
    const undrilled = kernel.makeBox(20, 10, 6);
    const cut = plane([0, 5, 0], [0, 1, 0]);
    // Inject the historical incorrect 120 mm^2 rectangle while preserving
    // the bored solid's own tessellation as an independent 96 mm^2 witness.
    const incorrectFaces = kernel.section(
      undrilled,
      ...cut.origin,
      ...cut.normal
    );
    const section = vi.spyOn(kernel, 'section').mockReturnValue(incorrectFaces);
    try {
      const outcome = exactSolidSection(kernel, bar, cut);
      expect(outcome.status).toBe('refused');
      if (outcome.status !== 'refused') return;
      expect(outcome.reason).toBe('area-mismatch');
      expect(outcome.message).toMatch(/disagrees with the tessellated witness/);
    } finally {
      section.mockRestore();
    }
  });
});

describe('planes that break a naive section', () => {
  it('refuses a plane that misses the body entirely', () => {
    const bar = kernel.makeBox(20, 10, 6);
    const outcome = exactSolidSection(
      kernel,
      bar,
      plane([0, 0, 30], [0, 0, 1])
    );
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.reason).toBe('plane-misses-body');
  });

  it('refuses a plane flush with a planar face rather than outlining it', () => {
    const bar = kernel.makeBox(20, 10, 6);
    // The kernel hands back the top face here: full 200 mm^2, nothing cut.
    expect(Array.from(kernel.section(bar, 0, 0, 6, 0, 0, 1))).toHaveLength(1);
    const outcome = exactSolidSection(kernel, bar, plane([0, 0, 6], [0, 0, 1]));
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.reason).toBe('plane-misses-body');
  });

  it('refuses a plane tangent to a curved face', () => {
    const ball = kernel.makeSphere(5, 32);
    const outcome = exactSolidSection(
      kernel,
      ball,
      plane([0, 0, 5], [0, 0, 1])
    );
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.reason).toBe('plane-misses-body');
  });

  it('sections a body with an internal cavity, cavity included', () => {
    const block = kernel.makeBox(20, 20, 20);
    const void_ = kernel.makeSphere(4, 32);
    kernel.transformSolid(void_, translation(10, 10, 10));
    const hollow = kernel.cut(block, void_);
    const cut = plane([0, 0, 10], [0, 0, 1]);
    const section = expectOk(exactSolidSection(kernel, hollow, cut));
    expect(section.loops).toHaveLength(2);
    const cavity = loopArea(section.loops[1]!.points, cut);
    expect(cavity).toBeGreaterThan(Math.PI * 16 * 0.98);
    expect(cavity).toBeLessThan(Math.PI * 16);
    // The sphere's great circle comes back as its circle, so the area is the
    // true one; the loop is that circle sampled for drawing. The cavity is
    // an inner shell, and its boundary is checked like any other.
    expect(Math.abs(section.area - (400 - Math.PI * 16))).toBeLessThan(1e-9);
    expect(section.loops[1]!.points.length).toBeGreaterThan(8);
    expect(section.boundary).toBe('exact');
    // The same cut with the cavity's circle as chords. Only the inner shell
    // is curved, so an adapter that looked for curvature on the outer shell
    // alone would skip the boundary check and call this exact.
    const chorded = topCap(
      kernel.cut(
        kernel.makeBox(20, 20, 10),
        polygonPrism(4, 256, [10, 10], -1, 12)
      )
    );
    const chordedSection = expectOk(
      withSection(chorded, () => exactSolidSection(kernel, hollow, cut))
    );
    expect(chordedSection.loops[1]!.points).toHaveLength(256);
    expect(chordedSection.boundary).toBe('approximate');
  });

  it('sections a rotated and translated body in document space', () => {
    const bar = kernel.makeBox(20, 10, 6);
    kernel.transformSolid(bar, rotationZ(Math.PI / 6, 3, -2, 1));
    const cut = plane([0, 0, 4], [0, 0, 1]);
    const section = expectOk(exactSolidSection(kernel, bar, cut));
    // A rotation about Z leaves the horizontal cross-section area alone.
    expect(section.area).toBeCloseTo(200, 6);
    // Rounding in a turned body's vertices is not a chord.
    expect(section.boundary).toBe('exact');
    expect(loopArea(section.loops[0]!.points, cut)).toBeCloseTo(200, 6);
    for (const point of section.loops[0]!.points) {
      expect(point[2]).toBeCloseTo(4, 9);
    }
  });

  it('sections a body on a plane oblique to every axis', () => {
    const bar = kernel.makeBox(20, 10, 6);
    const axis = 1 / Math.sqrt(3);
    const cut = plane([10, 5, 3], [axis, axis, axis]);
    const section = expectOk(exactSolidSection(kernel, bar, cut));
    expect(Math.abs(section.area - section.witnessArea)).toBeLessThanOrEqual(
      section.areaTolerance
    );
    expect(section.boundary).toBe('exact');
    for (const point of section.loops[0]!.points) {
      const signed =
        (point[0] - 10) * axis + (point[1] - 5) * axis + (point[2] - 3) * axis;
      expect(signed).toBeCloseTo(0, 6);
    }
  });

  it('refuses a cross-section the kernel cannot assemble', () => {
    // Two prongs: one plane, two disjoint regions.
    const base = kernel.makeBox(30, 10, 10);
    const slot = kernel.makeBox(10, 12, 6);
    kernel.transformSolid(slot, translation(10, -1, 4));
    const fork = kernel.cut(base, slot);
    const outcome = exactSolidSection(
      kernel,
      fork,
      plane([0, 0, 7], [0, 0, 1])
    );
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.reason).toBe('kernel-refused');
    expect(outcome.message).toMatch(/could not section this body/);
  });
});

describe('the tessellated witness', () => {
  it('measures a square hole out of a square outline', () => {
    // A unit-thick slab from z=-1 to z=1: outer 10x10, inner 4x4 hole, with
    // outward normals. Only the walls matter to a z=0 section.
    const positions: number[] = [];
    const indices: number[] = [];
    const wall = (
      a: readonly [number, number],
      b: readonly [number, number],
      outward: boolean
    ) => {
      const base = positions.length / 3;
      positions.push(
        a[0],
        a[1],
        -1,
        b[0],
        b[1],
        -1,
        b[0],
        b[1],
        1,
        a[0],
        a[1],
        1
      );
      const quad = outward ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
      for (const index of quad) indices.push(base + index);
    };
    const outer: readonly (readonly [number, number])[] = [
      [-5, -5],
      [5, -5],
      [5, 5],
      [-5, 5]
    ];
    const inner: readonly (readonly [number, number])[] = [
      [-2, -2],
      [2, -2],
      [2, 2],
      [-2, 2]
    ];
    for (let i = 0; i < 4; i += 1) {
      wall(outer[i]!, outer[(i + 1) % 4]!, true);
      wall(inner[i]!, inner[(i + 1) % 4]!, false);
    }
    const witness = tessellatedSectionWitness(positions, indices, {
      origin: [0, 0, 0],
      normal: [0, 0, 1]
    });
    expect(Math.abs(witness.area)).toBeCloseTo(100 - 16, 9);
    expect(witness.perimeter).toBeCloseTo(40 + 16, 9);
    expect(witness.minDistance).toBeCloseTo(-1, 9);
    expect(witness.maxDistance).toBeCloseTo(1, 9);
  });
});

describe('section DXF export', () => {
  const cut = plane([0, 0, 3], [0, 0, 1]);

  it('writes every boundary of the section in millimetres', () => {
    const bar = boredBar();
    const section = expectOk(exactSolidSection(kernel, bar, cut));
    const entities = sectionDxfEntities(kernel, section.faces, cut, 1);
    const text = writeDxf(entities);
    const lines = text.split('\r\n').filter((line) => line.length > 0);
    const pairs = lines.map((value, index) => [index, value] as const);
    expect(text).toContain('$INSUNITS');
    // $INSUNITS 4 — millimetres. The value follows its name in the header.
    const unitsAt = pairs.find(([, value]) => value === '$INSUNITS')![0];
    expect(lines[unitsAt + 1]).toBe('70');
    expect(lines[unitsAt + 2]).toBe('4');
    // Four outline lines and the bore's circle: the file holds what the
    // section holds, and the section is exact.
    expect(section.boundary).toBe('exact');
    expect(entities.filter((entity) => entity.kind === 'line')).toHaveLength(4);
    const circles = entities.filter((entity) => entity.kind === 'circle');
    expect(circles).toHaveLength(1);
    if (circles[0]!.kind === 'circle') {
      expect(circles[0]!.radius).toBeCloseTo(2, 9);
    }
    // A section whose bore came back as 64 chords writes every chord: four
    // outline lines and the 64 of the inner wire, which is why that section
    // is reported as approximate.
    const chorded = expectOk(
      withSection(chordedBoredBarCap(), () =>
        exactSolidSection(kernel, bar, cut)
      )
    );
    expect(chorded.boundary).toBe('approximate');
    expect(
      sectionDxfEntities(kernel, chorded.faces, cut, 1).filter(
        (entity) => entity.kind === 'line'
      )
    ).toHaveLength(68);
    const extent = entities.flatMap((entity) =>
      entity.kind === 'line' ? [entity.start, entity.end] : []
    );
    // An XY section keeps world X running right and world Y up the page.
    const xs = extent.map(([x]) => x);
    const ys = extent.map(([, y]) => y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(10, 6);
  });

  it('scales an inch document to millimetres', () => {
    const bar = kernel.makeBox(2, 1, 1);
    const section = expectOk(
      exactSolidSection(kernel, bar, plane([0, 0, 0.5], [0, 0, 1]))
    );
    const entities = sectionDxfEntities(
      kernel,
      section.faces,
      plane([0, 0, 0.5], [0, 0, 1]),
      25.4
    );
    const extent = entities.flatMap((entity) =>
      entity.kind === 'line' ? [entity.start, entity.end] : []
    );
    const xs = extent.map(([x]) => x);
    const ys = extent.map(([, y]) => y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2 * 25.4, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(25.4, 6);
  });

  it('refuses an invalid unit scale', () => {
    const bar = kernel.makeBox(4, 4, 4);
    const section = expectOk(
      exactSolidSection(kernel, bar, plane([0, 0, 2], [0, 0, 1]))
    );
    expect(() => sectionDxfEntities(kernel, section.faces, cut, 0)).toThrow(
      /invalid unit scale/
    );
  });

  it('puts every region of one plane in the same frame', () => {
    const first = kernel.makeBox(4, 4, 4);
    const second = kernel.makeBox(4, 4, 4);
    kernel.transformSolid(second, translation(20, 0, 0));
    const cutAt2 = plane([0, 0, 2], [0, 0, 1]);
    const a = expectOk(exactSolidSection(kernel, first, cutAt2));
    const b = expectOk(exactSolidSection(kernel, second, cutAt2));
    const entities = sectionDxfEntities(
      kernel,
      [...a.faces, ...b.faces],
      cutAt2,
      1
    );
    const xs = entities.flatMap((entity) =>
      entity.kind === 'line' ? [entity.start[0], entity.end[0]] : []
    );
    // Both squares share the plane's own frame, so the 20 mm gap survives.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(24, 6);
  });
});

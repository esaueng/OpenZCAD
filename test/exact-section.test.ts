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
    expect(section.boundaryDeviation).toBe(0);
    expect(section.areaUncertainty).toBe(0);
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
    // The bore wall is a true cylinder, but the kernel's section cuts its
    // circle into 64 chords, so the hole is that polygon's area rather than
    // pi r^2 — within 0.2% of the circle.
    expect(hole).toBeGreaterThan(Math.PI * 4 * 0.99);
    expect(hole).toBeLessThan(Math.PI * 4);
    expect(section.area).toBeCloseTo(outer - hole, 6);
    // The cut surface is drawn as material only, never over the bore.
    expect(section.positions.length / 3).toBeGreaterThan(4);
  });

  it('reports a chorded bore as an approximate boundary, never an exact one', () => {
    const bar = boredBar();
    const cut = plane([0, 0, 3], [0, 0, 1]);
    const section = expectOk(exactSolidSection(kernel, bar, cut));
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
    // Each chord of a 64-gon in a radius-2 circle misses it by its sagitta.
    const sagitta = 2 * (1 - Math.cos(Math.PI / 64));
    expect(section.boundaryDeviation).toBeCloseTo(exactArea ? 0 : sagitta, 9);
    // The disclosed uncertainty covers the real error, without burying it.
    expect(section.areaUncertainty!).toBeGreaterThanOrEqual(polygonError);
    expect(section.areaUncertainty!).toBeLessThan(polygonError * 2 + 1e-9);
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
      expect(outcome.boundaryDeviation).toBe(0);
      expect(outcome.areaUncertainty).toBe(0);
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
      expect(section.boundaryDeviation).toBeNull();
      expect(section.areaUncertainty).toBeNull();
    } finally {
      distance.mockRestore();
    }
  });

  it("measures a chord's miss in the cutting plane, not to the surface", () => {
    // Review of #1695: near the top of a sphere the surface leans well away
    // from the plane, so a chord 0.0012 from the SPHERE is 0.0038 from the
    // CIRCLE it stands in for. Reported as the former, the uncertainty was
    // +-0.0230 mm^2 on an area 0.0492 mm^2 out.
    const ball = kernel.makeSphere(10, 64);
    const cut = plane([0, 0, 9.5], [0, 0, 1]);
    const section = expectOk(exactSolidSection(kernel, ball, cut));
    const radius = Math.sqrt(10 ** 2 - 9.5 ** 2);
    const analytic = Math.PI * radius ** 2;
    const error = Math.abs(section.area - analytic);
    expect(section.boundary).toBe('approximate');
    expect(error).toBeGreaterThan(analytic * 1e-4);
    // A figure is quoted here, and it covers the error it is quoted for.
    expect(section.areaUncertainty).not.toBeNull();
    expect(error).toBeLessThanOrEqual(section.areaUncertainty!);
    expect(section.areaUncertainty!).toBeLessThan(error * 2);
    // The deviation is the chord's sagitta in the circle of the cut — more
    // than three times its distance to the sphere.
    const chords = section.loops[0]!.points.length;
    const sagitta = radius * (1 - Math.cos(Math.PI / chords));
    expect(section.boundaryDeviation).toBeCloseTo(sagitta, 6);
    expect(section.boundaryDeviation!).toBeGreaterThan(
      3 * sagitta * (radius / 10)
    );
  });

  it('withholds the figures when the miss cannot be measured in the plane', () => {
    const bar = boredBar();
    const real = kernel.pointToSolidDistance.bind(kernel);
    // A kernel that reports every nearest surface point straight along the
    // plane normal: the distance is right, and it says nothing about which
    // way, in the plane, the true curve lies.
    const distance = vi
      .spyOn(kernel, 'pointToSolidDistance')
      .mockImplementation((x, y, z, solid) => {
        const gap = real(x, y, z, solid)[0]!;
        return Float64Array.of(gap, x, y, z + gap);
      });
    try {
      const section = expectOk(
        exactSolidSection(kernel, bar, plane([0, 0, 3], [0, 0, 1]))
      );
      // Still not exact — and no number that might understate.
      expect(section.boundary).toBe('approximate');
      expect(section.boundaryDeviation).toBeNull();
      expect(section.areaUncertainty).toBeNull();
    } finally {
      distance.mockRestore();
    }
  });

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
      const section = expectOk(
        exactSolidSection(kernel, ball, plane([0, 0, 0], [0, 0, 1]))
      );
      return {
        unit,
        boundary: section.boundary,
        chords: section.loops[0]!.points.length,
        deviationMm: section.boundaryDeviation! * scale,
        uncertaintyMm2: section.areaUncertainty! * scale ** 2,
        errorMm2: Math.abs(section.area * scale ** 2 - Math.PI * 0.25)
      };
    });
    expect(measured.map((result) => result.boundary)).toEqual([
      'approximate',
      'approximate',
      'approximate'
    ]);
    const [mm] = measured;
    const sagitta = 0.5 * (1 - Math.cos(Math.PI / mm!.chords));
    for (const result of measured) {
      expect(result.chords).toBe(mm!.chords);
      // The same physical figures, to parts in a million.
      expect(Math.abs(result.deviationMm - sagitta)).toBeLessThan(
        sagitta * 1e-6
      );
      expect(Math.abs(result.uncertaintyMm2 - mm!.uncertaintyMm2)).toBeLessThan(
        mm!.uncertaintyMm2 * 1e-6
      );
      expect(result.errorMm2).toBeLessThanOrEqual(result.uncertaintyMm2);
    }
  }, 120_000);

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
      expect(section.boundaryDeviation).toBeNull();
      expect(section.areaUncertainty).toBeNull();
      expect(distance).not.toHaveBeenCalled();
    } finally {
      distance.mockRestore();
    }
  });

  it('stops refining the figures past the probe budget, never the verdict', () => {
    // 33 radius-0.2 bores in a row: 2112 chords, more than the budget.
    let bar = kernel.makeBox(40, 4, 2);
    for (let i = 0; i < 33; i += 1) {
      const bore = kernel.makeCylinder(0.2, 6);
      kernel.transformSolid(bore, translation(1 + i * 1.15, 2, -2));
      bar = kernel.cut(bar, bore);
    }
    const distance = vi.spyOn(kernel, 'pointToSolidDistance');
    try {
      const section = expectOk(
        exactSolidSection(kernel, bar, plane([0, 0, 1], [0, 0, 1]))
      );
      expect(section.loops).toHaveLength(34);
      expect(section.boundary).toBe('approximate');
      expect(section.boundaryDeviation).toBeNull();
      expect(section.areaUncertainty).toBeNull();
      // 2048 edges at most, two queries for a chord square to the plane:
      // one to find it off the solid, one to find the curve it missed.
      expect(distance.mock.calls.length).toBeLessThanOrEqual(2048 * 2);
    } finally {
      distance.mockRestore();
    }
  }, 60_000);

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
    expect(section.area).toBeCloseTo(400 - cavity, 6);
    // The sphere's great circle comes back as chords too — finer ones than
    // a cylinder's, and still not the circle. The cavity is an inner shell:
    // its faces count when deciding whether the solid has a curve to chord.
    const chords = section.loops[1]!.points.length;
    expect(chords).toBeGreaterThan(8);
    expect(section.boundary).toBe('approximate');
    expect(section.boundaryDeviation).toBeCloseTo(
      4 * (1 - Math.cos(Math.PI / chords)),
      9
    );
    // A thousand distance queries: seconds, not milliseconds, on a busy box.
  }, 30_000);

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
    // Four outline lines plus the 64 chords the kernel cuts the bore's
    // circle into: the file holds what the section holds, which is why that
    // section is reported as approximate.
    expect(section.boundary).toBe('approximate');
    expect(entities.filter((entity) => entity.kind === 'line')).toHaveLength(
      68
    );
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

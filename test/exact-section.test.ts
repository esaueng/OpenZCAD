import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    throw new Error(`Expected an exact section, got ${outcome.reason}: ${outcome.message}`);
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
    // The kernel's bore wall is a 64-sided prism, so the hole is that
    // polygon's area rather than pi r^2 — within 0.2% of the circle.
    expect(hole).toBeGreaterThan(Math.PI * 4 * 0.99);
    expect(hole).toBeLessThan(Math.PI * 4);
    expect(section.area).toBeCloseTo(outer - hole, 6);
    // The cut surface is drawn as material only, never over the bore.
    expect(section.positions.length / 3).toBeGreaterThan(4);
  });

  it('refuses the plane where the kernel drops the bore from the outline', () => {
    const bar = boredBar();
    // Down the bore axis. The true cross-section is 20x6 minus a 4x6 slot;
    // the pinned kernel returns the undrilled 120 mm^2 rectangle instead.
    const outcome = exactSolidSection(kernel, bar, plane([0, 5, 0], [0, 1, 0]));
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.reason).toBe('area-mismatch');
    expect(outcome.message).toMatch(/disagrees with the tessellated witness/);
  });
});

describe('planes that break a naive section', () => {
  it('refuses a plane that misses the body entirely', () => {
    const bar = kernel.makeBox(20, 10, 6);
    const outcome = exactSolidSection(kernel, bar, plane([0, 0, 30], [0, 0, 1]));
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
    const outcome = exactSolidSection(kernel, ball, plane([0, 0, 5], [0, 0, 1]));
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
  });

  it('sections a rotated and translated body in document space', () => {
    const bar = kernel.makeBox(20, 10, 6);
    kernel.transformSolid(bar, rotationZ(Math.PI / 6, 3, -2, 1));
    const cut = plane([0, 0, 4], [0, 0, 1]);
    const section = expectOk(exactSolidSection(kernel, bar, cut));
    // A rotation about Z leaves the horizontal cross-section area alone.
    expect(section.area).toBeCloseTo(200, 6);
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
    const outcome = exactSolidSection(kernel, fork, plane([0, 0, 7], [0, 0, 1]));
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
      positions.push(a[0], a[1], -1, b[0], b[1], -1, b[0], b[1], 1, a[0], a[1], 1);
      const quad = outward
        ? [0, 1, 2, 0, 2, 3]
        : [0, 2, 1, 0, 3, 2];
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
    const pairs = lines.map(
      (value, index) => [index, value] as const
    );
    expect(text).toContain('$INSUNITS');
    // $INSUNITS 4 — millimetres. The value follows its name in the header.
    const unitsAt = pairs.find(([, value]) => value === '$INSUNITS')![0];
    expect(lines[unitsAt + 1]).toBe('70');
    expect(lines[unitsAt + 2]).toBe('4');
    // Four outline lines plus the bore's 64 wall segments.
    expect(entities.filter((entity) => entity.kind === 'line')).toHaveLength(68);
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

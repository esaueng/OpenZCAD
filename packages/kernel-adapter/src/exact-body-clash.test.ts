import { describe, expect, it } from 'vitest';
import type { BodyClashVerdict } from '@openzcad/shared';
import { RemusKernel } from './remus-runtime';
import {
  combineClashVerdicts,
  exactBodyClash,
  exactSolidClash,
  pairwiseBodyClash,
  rowMajorMatrix
} from './exact-body-clash';

/** Row-major rigid translation, matching `copyAndTransformSolid`. */
function translation(x: number, y: number, z: number): Float64Array {
  return Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1);
}

function moved(
  kernel: RemusKernel,
  solid: number,
  x: number,
  y: number,
  z: number
) {
  return kernel.copyAndTransformSolid(solid, translation(x, y, z));
}

/** A 20×20×10 plate with an r3 through-hole at (10, 10). */
function bored(kernel: RemusKernel): number {
  return kernel.cut(
    kernel.makeBox(20, 20, 10),
    moved(kernel, kernel.makeCylinder(3, 10), 10, 10, 0)
  );
}

function expectInside(
  kernel: RemusKernel,
  solids: number[],
  verdict: BodyClashVerdict
) {
  if (verdict.kind !== 'interference') throw new Error(verdict.kind);
  const point = verdict.point!;
  expect(point).not.toBeNull();
  for (const solid of solids) {
    expect(kernel.classifyPoint(solid, point.x, point.y, point.z, 1e-6)).toBe(
      'inside'
    );
  }
}

describe('exact body clash (M09, shared by AS04)', () => {
  it('measures overlapping boxes exactly, with the shared box and an interior witness', () => {
    const kernel = new RemusKernel();
    const a = kernel.makeBox(10, 10, 10);
    const b = moved(kernel, kernel.makeBox(10, 10, 10), 5, 5, 5);
    const verdict = exactSolidClash(kernel, a, b);
    expect(verdict).toMatchObject({
      kind: 'interference',
      proof: 'intersect',
      complete: true,
      bounds: { min: { x: 5, y: 5, z: 5 }, max: { x: 10, y: 10, z: 10 } }
    });
    if (verdict.kind !== 'interference') return;
    expect(verdict.volume).toBeCloseTo(125, 6);
    expect(verdict.point).toEqual({ x: 7.5, y: 7.5, z: 7.5 });
    expectInside(kernel, [a, b], verdict);
  });

  it('reports face contact as touching, not as interference', () => {
    const kernel = new RemusKernel();
    const a = kernel.makeBox(10, 10, 10);
    const b = moved(kernel, kernel.makeBox(10, 10, 10), 10, 0, 0);
    expect(exactSolidClash(kernel, a, b)).toMatchObject({
      kind: 'clear',
      touching: true,
      distance: 0
    });
  });

  it('reports a certified clearance with its two closest points', () => {
    const kernel = new RemusKernel();
    const a = kernel.makeBox(10, 10, 10);
    const b = moved(kernel, kernel.makeBox(10, 10, 10), 12, 0, 0);
    const verdict = exactSolidClash(kernel, a, b);
    expect(verdict).toMatchObject({
      kind: 'clear',
      touching: false,
      distance: 2,
      atLeast: 2
    });
    if (verdict.kind !== 'clear') return;
    const [p, q] = verdict.closest!;
    expect(p.x).toBeCloseTo(10, 9);
    expect(q.x).toBeCloseTo(12, 9);
  });

  it('proves a pin clear of its clearance hole where the kernel declines the empty intersection', () => {
    const kernel = new RemusKernel();
    const plate = bored(kernel);
    const pin = moved(kernel, kernel.makeCylinder(2.9, 20), 10, 10, -5);
    // The intersection itself is declined on the pin…
    expect(kernel.intersectDetailed(plate, pin).status).not.toBe('ok');
    // …so the exact difference answers instead, and there is no guess.
    expect(exactSolidClash(kernel, plate, pin)).toMatchObject({
      kind: 'clear',
      // Curved faces carry no certified distance, so contact stays unknown.
      touching: null,
      distance: null
    });
  });

  it('treats a line-to-line fit as no interference', () => {
    const kernel = new RemusKernel();
    const plate = bored(kernel);
    const pin = moved(kernel, kernel.makeCylinder(3, 20), 10, 10, -5);
    expect(exactSolidClash(kernel, plate, pin).kind).toBe('clear');
  });

  it('measures an off-axis pin that cuts into the hole wall', () => {
    const kernel = new RemusKernel();
    const plate = bored(kernel);
    const pin = moved(kernel, kernel.makeCylinder(2, 20), 11.5, 10, -5);
    const verdict = exactSolidClash(kernel, plate, pin);
    expect(verdict.kind).toBe('interference');
    if (verdict.kind !== 'interference') return;
    // Cross-checked against the exact difference: pin − (pin − plate).
    const rest = kernel.volume(kernel.cut(pin, plate), 0.01);
    expect(verdict.volume).toBeCloseTo(kernel.volume(pin, 0.01) - rest, 6);
    expect(verdict.volume!).toBeGreaterThan(13);
    expectInside(kernel, [plate, pin], verdict);
  });

  it('measures a sphere sunk into a box face', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(10, 10, 10);
    const ball = moved(kernel, kernel.makeSphere(3, 24), 10, 5, 5);
    const verdict = exactSolidClash(kernel, box, ball);
    expect(verdict.kind).toBe('interference');
    if (verdict.kind !== 'interference') return;
    // Half of a radius-3 ball.
    expect(verdict.volume).toBeCloseTo((2 / 3) * Math.PI * 27, 6);
    expectInside(kernel, [box, ball], verdict);
  });

  it('counts a small part sunk whole into a much larger one', () => {
    // A floor scaled to the pair's diagonal (≈ 1000 mm³ here) once called
    // this 1 mm³ cube clear: the floor follows the smaller body.
    const kernel = new RemusKernel();
    const beam = kernel.makeBox(10000, 10, 10);
    const cube = moved(kernel, kernel.makeBox(1, 1, 1), 5000, 4.5, 4.5);
    for (const verdict of [
      exactSolidClash(kernel, beam, cube),
      exactSolidClash(kernel, cube, beam)
    ]) {
      expect(verdict.kind).toBe('interference');
      if (verdict.kind !== 'interference') continue;
      expect(verdict.volume).toBeCloseTo(1, 6);
      expectInside(kernel, [beam, cube], verdict);
    }
  });

  it('counts a micrometre overlap of kilometre bars at the overlap’s own scale', () => {
    // Scaled to either bar, 0.1 mm³ rounds away; scaled to the region the
    // kernel built (0.001 × 10 × 10) it is plainly real.
    const kernel = new RemusKernel();
    const a = kernel.makeBox(1_000_000, 10, 10);
    const b = moved(
      kernel,
      kernel.makeBox(1_000_000, 10, 10),
      999_999.999,
      0,
      0
    );
    const verdict = exactSolidClash(kernel, a, b);
    expect(verdict.kind).toBe('interference');
    if (verdict.kind !== 'interference') return;
    expect(verdict.volume).toBeCloseTo(0.1, 3);
    // Butted end to end instead, the same bars only touch.
    const butted = moved(
      kernel,
      kernel.makeBox(1_000_000, 10, 10),
      1_000_000,
      0,
      0
    );
    expect(exactSolidClash(kernel, a, butted)).toMatchObject({
      kind: 'clear',
      touching: true
    });
  });

  it('counts a small pin sunk into a long bar where only the difference answers', () => {
    // A curved pin inside a long bar: whichever boolean measures it, a
    // sunk part is never reported clear.
    const kernel = new RemusKernel();
    const bar = kernel.makeBox(10000, 20, 20);
    const pin = moved(kernel, kernel.makeCylinder(0.5, 1), 5000, 10, 10);
    const verdict = exactSolidClash(kernel, bar, pin);
    expect(verdict.kind).toBe('interference');
    if (verdict.kind !== 'interference') return;
    expect(verdict.volume).toBeCloseTo(Math.PI * 0.25, 6);
  });

  it('separates boxes by their gap without any boolean', () => {
    const kernel = new RemusKernel();
    const a = kernel.makeBox(10, 10, 10);
    const b = moved(kernel, kernel.makeCylinder(3, 10), 30, 30, 0);
    expect(exactSolidClash(kernel, a, b)).toMatchObject({
      kind: 'clear',
      touching: false,
      atLeast: 17
    });
  });

  it('sums every solid pair of multi-solid bodies', () => {
    const kernel = new RemusKernel();
    const left = [
      kernel.makeBox(10, 10, 10),
      moved(kernel, kernel.makeBox(10, 10, 10), 30, 0, 0)
    ];
    const right = [
      moved(kernel, kernel.makeBox(10, 10, 10), 5, 0, 0),
      moved(kernel, kernel.makeBox(10, 10, 10), 35, 0, 0)
    ];
    const verdict = exactBodyClash(kernel, left, right);
    expect(verdict.kind).toBe('interference');
    if (verdict.kind !== 'interference') return;
    expect(verdict.volume).toBeCloseTo(1000, 6);
    expect(verdict.bounds).toEqual({
      min: { x: 5, y: 0, z: 0 },
      max: { x: 40, y: 10, z: 10 }
    });
  });

  it('reports every unordered pair in input order', () => {
    const kernel = new RemusKernel();
    const pairs = pairwiseBodyClash(kernel, [
      { id: 'a', solids: [kernel.makeBox(10, 10, 10)] },
      { id: 'b', solids: [moved(kernel, kernel.makeBox(10, 10, 10), 5, 0, 0)] },
      { id: 'c', solids: [moved(kernel, kernel.makeBox(10, 10, 10), 50, 0, 0)] }
    ]);
    expect(pairs.map((p) => `${p.a}${p.b}:${p.verdict.kind}`)).toEqual([
      'ab:interference',
      'ac:clear',
      'bc:clear'
    ]);
  });
});

describe('clash verdict combination', () => {
  const clear = (
    distance: number | null,
    atLeast: number | null,
    touching: boolean | null = false
  ): BodyClashVerdict => ({
    kind: 'clear',
    touching,
    distance,
    closest: null,
    atLeast
  });
  const unknown: BodyClashVerdict = {
    kind: 'unknown',
    reason: 'exact_only_unattainable',
    message: 'declined'
  };

  it('never reports an unknown pair as clear', () => {
    expect(combineClashVerdicts([clear(2, 2), unknown]).kind).toBe('unknown');
  });

  it('keeps an interference whose sibling pair is unknown, as a lower bound', () => {
    const verdict = combineClashVerdicts([
      {
        kind: 'interference',
        volume: 5,
        proof: 'intersect',
        point: { x: 0, y: 0, z: 0 },
        bounds: null,
        complete: true
      },
      unknown
    ]);
    expect(verdict).toMatchObject({
      kind: 'interference',
      volume: 5,
      complete: false
    });
  });

  it('reports the nearest certified distance only when every pair is certified', () => {
    expect(combineClashVerdicts([clear(3, 3), clear(1, 1)])).toMatchObject({
      distance: 1,
      atLeast: 1
    });
    expect(combineClashVerdicts([clear(3, 3), clear(null, 2)])).toMatchObject({
      distance: null,
      atLeast: 2
    });
    expect(
      combineClashVerdicts([clear(3, 3), clear(null, null, null)])
    ).toMatchObject({ distance: null, atLeast: null, touching: null });
  });
});

describe('component pose matrices', () => {
  it('transposes three.js column-major into the kernel row-major order', () => {
    const columnMajor = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1];
    expect(Array.from(rowMajorMatrix(columnMajor))).toEqual(
      Array.from(translation(7, 8, 9))
    );
    expect(() => rowMajorMatrix([1, 2, 3])).toThrow(/4×4/);
  });
});

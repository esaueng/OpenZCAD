import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemusKernel } from './remus-runtime';
import {
  ExactBooleanRefusal,
  exactBooleanOutcome,
  exactCut,
  exactFuse,
  exactFuseAll,
  exactIntersect
} from './exact-boolean-refusal';
import {
  exactCutWithCancellation,
  exactIntersectWithCancellation
} from './exact-cancellation';
import {
  SEALED_CAVITY_REASON,
  kernelRefusalOf,
  kernelRefusalRecordOf
} from './kernel-refusal';
import { createRemusModelingOperations } from './remus-modeling-operations';

/**
 * Issues #2383–#2386 on the real kernel: exact operations on a solid with a
 * sealed internal cavity (an inner shell that encloses a void).
 *
 * The rule under test: such a solid is legitimate, and an operation on it
 * either builds the correct body (voids kept, volume = outer − voids) or
 * refuses naming the cavity. It never refuses for a reason it cannot stand
 * behind ("reposition the overlap", "try a smaller angle").
 *
 * Every case states the pinned kernel's outcome exactly, as
 * `test/qa-2026-11-14-p1.test.ts` does, so a kernel update that starts
 * building one fails here instead of passing unnoticed. Each refusing case
 * also carries the body it should build, from closed forms, and `settle`
 * checks that body in full the moment the case is flipped to `builds`.
 *
 * The fixtures are the issues' own: a 64 × 42 × 16 stock at the origin, an
 * R3 × 6 cylinder standing at (52, 21) from z = 5 to z = 11, and a
 * 23 × 19 × 4 box from (18, 10, 6). Both tools are strictly inside the stock.
 */

const DEFLECTION = 0.0005;
const STOCK = 64 * 42 * 16;
const CYLINDER = Math.PI * 3 ** 2 * 6;
const RECT = 23 * 19 * 4;

function translation(x: number, y: number, z: number): Float64Array {
  return Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1);
}

interface Reading {
  volume: number;
  /** Face count of each shell, outer first. */
  shells: number[];
  bounds: number[];
  validationErrors: number;
}

function read(kernel: RemusKernel, solid: number): Reading {
  return {
    volume: kernel.volume(solid, DEFLECTION),
    shells: Array.from(
      kernel.getSolidShells(solid),
      (shell) => kernel.getShellFaces(shell).length
    ),
    bounds: Array.from(kernel.boundingBox(solid)),
    validationErrors: kernel.validateSolid(solid)
  };
}

interface Expected {
  volume: number;
  shells: number[];
  bounds: number[];
}

/**
 * The outcome of an operation that either builds `expected` or refuses for
 * the cavity, checked in full either way. Returns which one happened.
 */
function settle(
  kernel: RemusKernel,
  run: () => number,
  expected: Expected
): 'builds' | 'refuses' {
  let solid: number;
  try {
    solid = run();
  } catch (error) {
    const refusal = kernelRefusalOf(error);
    expect(refusal, String(error)).not.toBeNull();
    expect(refusal!.kernelReason).toBe(SEALED_CAVITY_REASON);
    return 'refuses';
  }
  const result = read(kernel, solid);
  expect(result.validationErrors).toBe(0);
  expect(result.volume).toBeCloseTo(expected.volume, 3);
  expect(result.shells).toEqual(expected.shells);
  result.bounds.forEach((value, index) =>
    expect(value).toBeCloseTo(expected.bounds[index]!, 6)
  );
  return 'builds';
}

describe('sealed internal cavities on the exact kernel', () => {
  let kernel: RemusKernel;
  const box = (
    dx: number,
    dy: number,
    dz: number,
    x: number,
    y: number,
    z: number
  ) =>
    kernel.copyAndTransformSolid(
      kernel.makeBox(dx, dy, dz),
      translation(x, y, z)
    );
  const stock = () => box(64, 42, 16, 0, 0, 0);
  const rect = () => box(23, 19, 4, 18, 10, 6);
  const cylinder = () =>
    kernel.copyAndTransformSolid(
      kernel.makeCylinder(3, 6),
      translation(52, 21, 5)
    );
  /** The stock with the sealed cylindrical cavity. */
  const housing = () => exactCut(kernel, stock(), cylinder());
  /** The stock with the sealed rectangular cavity. */
  const pocketed = () => exactCut(kernel, stock(), rect());
  /** A box whose floor at `z` clips everything below it off the stock. */
  const clipAbove = (z: number) => box(84, 62, 32, -10, -10, z);

  beforeEach(() => {
    kernel = new RemusKernel();
  });
  afterEach(() => {
    kernel.free();
  });

  it('builds each sealed cavity on its own as one solid with an inner shell', () => {
    expect(read(kernel, housing())).toMatchObject({
      shells: [6, 3],
      validationErrors: 0
    });
    expect(kernel.volume(housing(), DEFLECTION)).toBeCloseTo(
      STOCK - CYLINDER,
      3
    );
    expect(read(kernel, pocketed())).toMatchObject({
      shells: [6, 6],
      validationErrors: 0
    });
    expect(kernel.volume(pocketed(), DEFLECTION)).toBeCloseTo(STOCK - RECT, 3);
  });

  describe('#2383: a second disjoint cavity in one solid', () => {
    const both: Expected = {
      volume: STOCK - RECT - CYLINDER,
      shells: [6, 6, 3],
      bounds: [0, 0, 0, 64, 42, 16]
    };

    it('refuses the rectangular and cylindrical pair for the cavity, in both orders', () => {
      // Flip to 'builds' when the kernel carries the cavity; `settle` then
      // holds the result to 41,090.354 mm³ and two inner shells.
      expect(
        settle(kernel, () => exactCut(kernel, pocketed(), cylinder()), both)
      ).toBe('refuses');
      expect(
        settle(kernel, () => exactCut(kernel, housing(), rect()), {
          ...both,
          shells: [6, 3, 6]
        })
      ).toBe('refuses');
    });

    it('builds two rectangular cavities, and a cylinder that opens through the roof', () => {
      const second = box(5, 5, 4, 50, 18, 6);
      expect(
        settle(kernel, () => exactCut(kernel, pocketed(), second), {
          volume: STOCK - RECT - 100,
          shells: [6, 6, 6],
          bounds: [0, 0, 0, 64, 42, 16]
        })
      ).toBe('builds');
      // Raised to z = 11–17 the cylinder is a blind bore in the outer shell,
      // not a cavity: one inner shell, and the roof gains a hole.
      const bore = kernel.copyAndTransformSolid(
        kernel.makeCylinder(3, 6),
        translation(52, 21, 11)
      );
      const bored = read(kernel, exactCut(kernel, pocketed(), bore));
      expect(bored.validationErrors).toBe(0);
      expect(bored.shells).toEqual([8, 6]);
      expect(bored.volume).toBeCloseTo(STOCK - RECT - Math.PI * 3 ** 2 * 5, 3);
    });
  });

  describe('#2385: trimming a body that keeps its sealed cavity whole', () => {
    const upper: Expected = {
      volume: 64 * 42 * 13 - CYLINDER,
      shells: [6, 3],
      bounds: [0, 0, 3, 64, 42, 16]
    };

    it('refuses the clip 2 mm clear of the cylindrical cavity for the cavity', () => {
      // Flip to 'builds' when the kernel carries the cavity; `settle` then
      // holds the result to 34,774.354 mm³ and one inner shell.
      expect(
        settle(
          kernel,
          () => exactIntersect(kernel, housing(), clipAbove(3)),
          upper
        )
      ).toBe('refuses');
      expect(
        settle(
          kernel,
          () => exactIntersect(kernel, clipAbove(3), housing()),
          upper
        )
      ).toBe('refuses');
      // The equivalent Subtract: a box whose top takes the lower 3 mm off.
      expect(
        settle(
          kernel,
          () => exactCut(kernel, housing(), box(84, 62, 32, -10, -10, -29)),
          upper
        )
      ).toBe('refuses');
    });

    it('answers the cancellable entry points the same way', () => {
      expect(
        settle(
          kernel,
          () =>
            exactIntersectWithCancellation(
              kernel,
              housing(),
              clipAbove(3),
              undefined
            ),
          upper
        )
      ).toBe('refuses');
      expect(
        settle(
          kernel,
          () =>
            exactCutWithCancellation(
              kernel,
              housing(),
              box(84, 62, 32, -10, -10, -29),
              undefined
            ),
          upper
        )
      ).toBe('refuses');
    });

    it('keeps a rectangular cavity, opens a crossed one and clips plain stock', () => {
      expect(
        settle(kernel, () => exactIntersect(kernel, pocketed(), clipAbove(3)), {
          volume: 64 * 42 * 13 - RECT,
          shells: [6, 6],
          bounds: [0, 0, 3, 64, 42, 16]
        })
      ).toBe('builds');
      // At z = 8 the clip crosses the cavity, which opens onto the new face
      // as a 3 mm blind bore: no inner shell is left.
      expect(
        settle(kernel, () => exactIntersect(kernel, housing(), clipAbove(8)), {
          volume: 64 * 42 * 8 - Math.PI * 3 ** 2 * 3,
          shells: [8],
          bounds: [0, 0, 8, 64, 42, 16]
        })
      ).toBe('builds');
      expect(
        settle(kernel, () => exactIntersect(kernel, stock(), clipAbove(3)), {
          volume: 64 * 42 * 13,
          shells: [6],
          bounds: [0, 0, 3, 64, 42, 16]
        })
      ).toBe('builds');
    });

    it('says so in the sentence, and no longer advises repositioning', () => {
      let thrown: unknown;
      try {
        exactIntersect(kernel, housing(), clipAbove(3), ['Housing', 'Clip']);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ExactBooleanRefusal);
      const refusal = thrown as ExactBooleanRefusal;
      expect(kernelRefusalRecordOf(refusal)).toEqual({
        family: 'boolean',
        operation: 'intersect',
        category: 'quality_refused',
        code: 'exact_only_unattainable',
        reason: SEALED_CAVITY_REASON
      });
      const [sentence, detail] = refusal.message.split('\n');
      expect(sentence).toBe(
        'Intersect refused: "Housing" and "Clip" could not be intersected exactly because a body has a sealed internal cavity: the same intersect builds once the cavity is ignored. The exact modeling engine cannot carry this sealed cavity through the operation yet.'
      );
      expect(sentence).not.toMatch(/reposition/i);
      expect(detail).toMatch(
        /^Kernel refusal exact_only_unattainable \(quality_refused\): /
      );
    });
  });

  describe('the cavity is named only where it is the cause', () => {
    it('leaves a refusal that the filled body shares without a cause', () => {
      // A ~1 µm sliver contact on the roof refuses with or without the
      // cavity (`exact-boolean-refusal.test.ts`), so the cavity explains
      // nothing and the sentence keeps the category's own words.
      const sliver = () =>
        kernel.copyAndTransformSolid(
          kernel.makeCylinder(3, 10),
          translation(10, 10, 15.999999)
        );
      const plain = exactBooleanOutcome(kernel, 'fuse', stock(), sliver());
      expect(plain.status).toBe('refused');
      let thrown: unknown;
      try {
        exactFuseAll(kernel, [housing(), sliver()], ['Housing', 'Boss']);
      } catch (error) {
        thrown = error;
      }
      const refusal = kernelRefusalOf(thrown);
      expect(refusal?.category).toBe('quality_refused');
      expect(refusal?.kernelReason).toBeUndefined();
      expect(refusal?.message).toContain('Repositioning the overlap');
    });

    it('names no cavity for a pair that has none', () => {
      const a = kernel.makeSphere(1.0, 24);
      const b = kernel.copyAndTransformSolid(
        kernel.makeSphere(1.0, 24),
        translation(0.5, 0, 0)
      );
      let thrown: unknown;
      try {
        exactFuse(kernel, a, b);
      } catch (error) {
        thrown = error;
      }
      expect(kernelRefusalOf(thrown)?.category).toBe('quality_refused');
      expect(kernelRefusalOf(thrown)?.kernelReason).toBeUndefined();
    });

    it('leaves the probes their plain answer and runs no diagnosis for them', () => {
      const trace: number[] = [];
      const traced = Object.create(kernel) as RemusKernel;
      traced.copySolid = (solid: number) => {
        const copy = kernel.copySolid(solid);
        trace.push(copy);
        return copy;
      };
      const outcome = exactBooleanOutcome(
        traced,
        'intersect',
        housing(),
        clipAbove(3)
      );
      expect(outcome.status).toBe('refused');
      if (outcome.status === 'refused') {
        expect(outcome.refusal.kernelReason).toBeUndefined();
      }
      expect(trace).toEqual([]);
    });
  });

  it('names the cavity for a refused union member', () => {
    const boss = box(10, 10, 10, 5, 5, 12);
    expect(
      settle(
        kernel,
        () => exactFuseAll(kernel, [housing(), boss], ['Housing', 'Boss']),
        {
          volume: STOCK - CYLINDER + 10 * 10 * 6,
          shells: [11, 3],
          bounds: [0, 0, 0, 64, 42, 22]
        }
      )
    ).toBe('refuses');
  });

  describe('a through hole drilled clear of the sealed cavity', () => {
    // The one boolean found that builds beside a cylindrical cavity: the
    // hole's handle and the stray cavity piece cancel in the Euler count, so
    // the result is accepted. Its material is right.
    const drilled = () =>
      exactCut(
        kernel,
        housing(),
        kernel.copyAndTransformSolid(
          kernel.makeCylinder(2, 30),
          translation(10, 10, -5)
        )
      );

    it('removes exactly the hole and leaves a valid body', () => {
      const result = read(kernel, drilled());
      expect(result.validationErrors).toBe(0);
      expect(result.volume).toBeCloseTo(
        STOCK - CYLINDER - Math.PI * 2 ** 2 * 16,
        3
      );
    });

    // Pinned defect, same cause as the refusals above: the kept cavity is
    // filed in the outer shell (one shell of ten faces), so STEP writes one
    // disconnected CLOSED_SHELL and no BREP_WITH_VOIDS. Passes, and the
    // `fails` comes off, once the kernel files it as an inner shell.
    it.fails('keeps the cavity as an inner shell', () => {
      expect(read(kernel, drilled()).shells).toEqual([7, 3]);
    });
  });

  it('diagnoses on copies: the operands survive and every scratch solid is retired', () => {
    const body = housing();
    const before = read(kernel, body);
    const created: number[] = [];
    const released: number[] = [];
    const traced = Object.create(kernel) as RemusKernel;
    traced.copySolid = (solid: number) => {
      const copy = kernel.copySolid(solid);
      created.push(copy);
      return copy;
    };
    traced.solidFromShell = (shell: number) => {
      const solid = kernel.solidFromShell(shell);
      created.push(solid);
      return solid;
    };
    let diagnosing = false;
    traced.intersectDetailed = (a: number, b: number) => {
      const result = kernel.intersectDetailed(a, b);
      if (diagnosing && result.status === 'ok') created.push(result.value);
      diagnosing = true;
      return result;
    };
    traced.deleteSolid = (solid: number) => {
      released.push(solid);
      kernel.deleteSolid(solid);
    };
    const clip = clipAbove(3);
    expect(() => exactIntersect(traced, body, clip)).toThrowError(
      ExactBooleanRefusal
    );
    // The copy, its filled stand-in and the filled result: all scratch.
    expect(created).toHaveLength(3);
    expect(released).toEqual([...created].reverse());
    expect(released).not.toContain(body);
    expect(released).not.toContain(clip);
    expect(read(kernel, body)).toEqual(before);
    expect(kernel.volume(clip, DEFLECTION)).toBeCloseTo(84 * 62 * 32, 3);
  });

  describe('#2384 and #2386: Split and Draft on a body with a sealed cavity', () => {
    it('refuses Split by naming the cavity shells, wherever the plane is', () => {
      // The typed cause is read from this sentence
      // (`remus-operation-refusal.ts`); a kernel that words it differently,
      // or starts splitting the body, fails here.
      for (const z of [3, 8]) {
        expect(() => kernel.split(housing(), 0, 0, z, 0, 0, 1)).toThrowError(
          'split: unsupported configuration: solid has 1 cavity shell(s); split only operates on the outer shell'
        );
      }
      const halves = Array.from(
        kernel.split(stock(), 0, 0, 8, 0, 0, 1),
        (half) => read(kernel, half)
      );
      expect(halves.map((half) => half.shells)).toEqual([[6], [6]]);
      for (const half of halves) {
        expect(half.validationErrors).toBe(0);
        expect(half.volume).toBeCloseTo(STOCK / 2, 3);
      }
    });

    it('refuses Draft with the typed cavity cause and leaves the body as it was', () => {
      const body = housing();
      const before = read(kernel, body);
      const front = Array.from(kernel.getSolidFaces(body)).filter((face) => {
        try {
          return kernel.getFaceNormal(face)[1]! < -0.99;
        } catch {
          return false;
        }
      });
      expect(front).toHaveLength(1);
      for (const angleDegrees of [3, 1]) {
        let thrown: unknown;
        try {
          createRemusModelingOperations(kernel).draft({
            targetSolid: body,
            faces: front,
            pullDirection: { x: 0, y: 0, z: 1 },
            neutralPoint: { x: 0, y: 0, z: 0 },
            angleDegrees
          });
        } catch (error) {
          thrown = error;
        }
        expect(kernelRefusalRecordOf(thrown)).toEqual({
          family: 'modeling',
          category: 'unsupported',
          code: 'draft_refused',
          reason: SEALED_CAVITY_REASON
        });
        expect((thrown as Error).message).toBe(
          'Remus draft refused: draft: unsupported configuration: solid has 1 cavity shell(s); draft only operates on the outer shell'
        );
      }
      expect(read(kernel, body)).toEqual(before);
    });
  });
});

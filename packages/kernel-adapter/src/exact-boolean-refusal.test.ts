import { describe, expect, it } from 'vitest';
import { RemusKernel } from './remus-runtime';
import { censusOfSolids } from './boolean-result-validation';
import {
  ExactBooleanRefusal,
  exactBooleanOutcome,
  exactBooleanRefusalOf,
  exactBooleanRefusalReason,
  exactCut,
  exactFuse,
  exactFuseAll
} from './exact-boolean-refusal';

/** Row-major rigid translation, matching `copyAndTransformSolid`. */
function translation(x: number, y: number, z: number): Float64Array {
  return Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1);
}

/**
 * Two unit spheres offset by half a radius: the curved-curved contact the
 * exact pipeline declines. Measured against the pin, `fuse` throws and
 * `fuseDetailed` answers `exact_only_unattainable` / `quality_refused`.
 */
function offsetSpheres(kernel: RemusKernel): [number, number] {
  return [
    kernel.makeSphere(1.0, 24),
    kernel.copyAndTransformSolid(kernel.makeSphere(1.0, 24), translation(0.5, 0, 0))
  ];
}

/**
 * Remus B21 refuses severing booleans instead of silently approximating them.
 * The e2e STEP export test previously asserted the old faceted-cut warning
 * for an r=14 cylinder severing an 18-deep box; the kernel now declines that
 * cut outright, so the happy-path test uses the clean r=6 tool and this unit
 * pins both sides of the contract.
 */
describe('exact-only severing boolean refusal', () => {
  it('cuts cleanly with the default r=6 tool', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(60, 18, 24);
    const tool = kernel.copyAndTransformSolid(
      kernel.makeCylinder(6, 28),
      translation(30, 9, 0)
    );
    const cut = kernel.cut(box, tool);
    expect(kernel.validateSolid(cut)).toBe(0);
    expect(censusOfSolids(kernel, [cut]).curvedFaces).toBeGreaterThan(0);
  });

  it('refuses the r=14 severing cut instead of faceting', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(60, 18, 24);
    const tool = kernel.copyAndTransformSolid(
      kernel.makeCylinder(14, 28),
      translation(30, 9, 0)
    );
    expect(() => kernel.cut(box, tool)).toThrowError(/exact/i);
  });
});

/**
 * The plain entry points still throw kernel prose, which is the reason this
 * adapter goes through the typed twins: a bare `Error` saying "exact-only
 * policy: …" is not something a product can show or branch on.
 */
describe('the untyped contract the adapter no longer uses', () => {
  it('throws a bare error with no category on the offset spheres', () => {
    const kernel = new RemusKernel();
    const [a, b] = offsetSpheres(kernel);
    let thrown: unknown;
    try {
      kernel.fuse(a, b);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(ExactBooleanRefusal);
    expect(exactBooleanRefusalOf(thrown)).toBeNull();
  });

  /**
   * The policy decision, pinned rather than argued: a refused pair is NOT
   * rerouted to `booleanWithQuality` without `exactOnly`. On this very pair
   * that path throws "non-manifold result" — it trades one failure for a
   * worse one, so the refusal is surfaced instead.
   */
  it('is not rescued by dropping the exact-only policy', () => {
    const kernel = new RemusKernel();
    const [a, b] = offsetSpheres(kernel);
    expect(() => kernel.booleanWithQuality('fuse', a, b, false)).toThrowError();
  });
});

describe('typed boolean refusal', () => {
  it('names the operation, the bodies and the kernel category', () => {
    const kernel = new RemusKernel();
    const [a, b] = offsetSpheres(kernel);
    let thrown: unknown;
    try {
      exactFuse(kernel, a, b, ['Ball', 'Ball 2']);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExactBooleanRefusal);
    const refusal = thrown as ExactBooleanRefusal;
    expect(refusal.operation).toBe('fuse');
    expect(refusal.category).toBe('quality_refused');
    expect(refusal.kernelCode).toBe('exact_only_unattainable');

    // Plain language, naming the operation and the bodies — not a stack
    // trace and not the kernel's own sentence.
    const sentence = refusal.message.split('\n')[0]!;
    expect(sentence).toContain('Union refused');
    expect(sentence).toContain('"Ball" and "Ball 2"');
    expect(sentence).toContain('could not be combined exactly');
    expect(sentence).not.toContain('exact-only policy');

    // The kernel's own code and prose stay behind the detail split, where
    // the feature cards already hide census-style detail.
    const detail = refusal.message.slice(refusal.message.indexOf('\n') + 1);
    expect(detail).toContain('exact_only_unattainable');
    expect(detail).toContain('quality_refused');
  });

  it('stays neutral when the caller has no names to give', () => {
    const kernel = new RemusKernel();
    const [a, b] = offsetSpheres(kernel);
    const outcome = exactBooleanOutcome(kernel, 'fuse', a, b);
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.refusal.message).toContain(
      'these bodies could not be combined exactly'
    );
  });

  it('reports a refusal as data, without throwing, for the probes', () => {
    const kernel = new RemusKernel();
    const [a, b] = offsetSpheres(kernel);
    expect(() => exactBooleanOutcome(kernel, 'fuse', a, b)).not.toThrow();
  });

  it('survives a caller that wraps it with its own heading', () => {
    const kernel = new RemusKernel();
    const [a, b] = offsetSpheres(kernel);
    let wrapped: unknown;
    try {
      try {
        exactFuse(kernel, a, b);
      } catch (error) {
        throw new Error(
          `Filling the through-hole failed: ${exactBooleanRefusalReason(error)}.`,
          { cause: error }
        );
      }
    } catch (error) {
      wrapped = error;
    }
    expect((wrapped as Error).message).toBe(
      'Filling the through-hole failed: these bodies could not be combined ' +
        'exactly, and an approximate result was declined.'
    );
    // The category survives the wrapping, which is the whole point of
    // walking the cause chain rather than matching the sentence.
    expect(exactBooleanRefusalOf(wrapped)?.category).toBe('quality_refused');
  });

  it('reports an invalid handle as invalid_input rather than throwing', () => {
    const kernel = new RemusKernel();
    const outcome = exactBooleanOutcome(kernel, 'cut', 999_999, 999_998);
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    expect(outcome.refusal.category).toBe('invalid_input');
  });
});

describe('the ordinary boolean is unchanged', () => {
  it('cuts a box with a cylinder and returns the same solid as before', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(60, 18, 24);
    const tool = kernel.copyAndTransformSolid(
      kernel.makeCylinder(6, 28),
      translation(30, 9, 0)
    );
    const outcome = exactBooleanOutcome(kernel, 'cut', box, tool);
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(kernel.validateSolid(outcome.solid)).toBe(0);
    expect(censusOfSolids(kernel, [outcome.solid]).curvedFaces).toBeGreaterThan(
      0
    );
    // The box less a bore of r=6 running its full 24 mm Z extent — the tool
    // is axis-origin and 28 long, so it clears both faces.
    expect(kernel.volume(outcome.solid, 0.01)).toBeCloseTo(
      60 * 18 * 24 - Math.PI * 36 * 24,
      3
    );
  });

  it('cuts through the typed wrapper with the same handle contract', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(60, 18, 24);
    const tool = kernel.copyAndTransformSolid(
      kernel.makeCylinder(6, 28),
      translation(30, 9, 0)
    );
    const solid = exactCut(kernel, box, tool, ['Plate', 'Bore']);
    expect(kernel.validateSolid(solid)).toBe(0);
    expect(kernel.volume(solid, 0.01)).toBeGreaterThan(0);
  });
});

describe('a refused cluster fuse names its member', () => {
  it('fuses an ordinary overlapping pair', () => {
    const kernel = new RemusKernel();
    const left = kernel.makeBox(10, 10, 10);
    const right = kernel.copyAndTransformSolid(
      kernel.makeBox(10, 10, 10),
      translation(5, 0, 0)
    );
    const fused = exactFuseAll(kernel, [left, right], ['Block', 'instance 2']);
    expect(kernel.validateSolid(fused)).toBe(0);
    expect(kernel.volume(fused, 0.01)).toBeCloseTo(1500, 3);
  });

  it('says which instance the exact engine declined', () => {
    const kernel = new RemusKernel();
    const anchor = kernel.makeSphere(1.0, 24);
    const second = kernel.copyAndTransformSolid(
      kernel.makeSphere(1.0, 24),
      translation(0.5, 0, 0)
    );
    let thrown: unknown;
    try {
      exactFuseAll(kernel, [anchor, second], ['the original', 'instance 2']);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExactBooleanRefusal);
    const refusal = thrown as ExactBooleanRefusal;
    expect(refusal.operands).toEqual(['instance 2']);
    expect(refusal.message).toContain('"instance 2"');
    expect(refusal.category).toBe('quality_refused');
    // The kernel's own `fuseAll` throw is kept as the cause: the fold below
    // it is diagnosis, and the original refusal is still the reason.
    expect(refusal.cause).toBeInstanceOf(Error);
  });
});

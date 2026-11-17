import { describe, expect, it } from 'vitest';
import type { RemusKernel } from './remus-runtime';
import {
  DirectEditRefusal,
  resizeCylindricalFaceTyped
} from './exact-direct-edit-refusal';
import {
  kernelRefusalCategoryOf,
  kernelRefusalRecordOf
} from './kernel-refusal';

/**
 * The resize twin's envelope, mapped without reading its sentence. The kernel
 * itself is exercised end to end in `test/sphere-boss-resize.test.ts` (the seam-filleted refusal);
 * these fakes pin the mapping, including a message that matches no prose
 * pattern, so the fields can only have come from the typed details.
 */
function kernelAnswering(result: unknown, legacy?: () => number): RemusKernel {
  return {
    resizeCylindricalFaceDetailed: () => result,
    resizeCylindricalFace:
      legacy ??
      (() => {
        throw new Error('the legacy resize must not run beside the twin');
      })
  } as unknown as RemusKernel;
}

describe('typed cylindrical-face resize', () => {
  it('preserves a typed diameter limit with an actionable message', () => {
    const kernel = kernelAnswering({
      status: 'error',
      code: 'operation_failed',
      category: 'nonconvergence',
      value: null,
      details: {
        kernelCode: 'cylinder-diameter-unbuildable',
        requestedDiameter: 60,
        message: 'opaque kernel detail'
      }
    });
    try {
      resizeCylindricalFaceTyped(kernel, 1, 2, 30);
      throw new Error('Expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(DirectEditRefusal);
      expect((error as Error).message).toContain('Try a smaller diameter');
      expect(kernelRefusalRecordOf(error)).toMatchObject({
        code: 'cylinder-diameter-unbuildable',
        category: 'nonconvergence'
      });
    }
  });

  const SIZE_LIMIT =
    'That diameter does not fit the existing supports and fillets. Try a smaller diameter.';
  const NO_REFILLET =
    "The fillets around this wall can't be rebuilt at that diameter. Change or remove those fillets in History, then resize the wall.";
  function diameterRefusal(reason?: string): DirectEditRefusal {
    const kernel = kernelAnswering({
      status: 'error',
      code: 'cylinder-diameter-unbuildable',
      category: 'internal',
      value: null,
      details: {
        kernelCode: 'cylinder-diameter-unbuildable',
        ...(reason ? { reason } : {}),
        requestedDiameter: 60,
        message: 'opaque kernel detail'
      }
    });
    try {
      resizeCylindricalFaceTyped(kernel, 1, 2, 30);
    } catch (error) {
      expect(error).toBeInstanceOf(DirectEditRefusal);
      return error as DirectEditRefusal;
    }
    throw new Error('Expected refusal');
  }

  // esaueng/remus#1747 adds `details.reason`; the pinned kernel sends none.
  it.each([
    ['an older kernel that sends no cause', undefined, SIZE_LIMIT],
    ['a wall that would meet another face', 'wall_meets_face', SIZE_LIMIT],
    [
      'a blend group that does not re-fillet',
      'group_reblend_failed',
      NO_REFILLET
    ]
  ])(
    'words a refused diameter for %s from the typed cause',
    (_case, reason, sentence) => {
      const refusal = diameterRefusal(reason);
      expect(refusal.reason).toBe(sentence);
      // The kernel's own words stay behind the sentence for "Why?".
      expect(refusal.message).toBe(`${sentence}\nopaque kernel detail`);
      expect(refusal.kernelMessage).toBe('opaque kernel detail');
      expect(kernelRefusalRecordOf(refusal)).toEqual({
        family: 'direct-edit',
        operation: 'resize-cylindrical-face',
        category: 'internal',
        code: 'cylinder-diameter-unbuildable',
        ...(reason ? { reason } : {})
      });
    }
  );

  it('does not advise a smaller diameter when the fillets cannot re-fillet', () => {
    expect(diameterRefusal('group_reblend_failed').message).not.toMatch(
      /smaller diameter/i
    );
  });

  it('returns the solid on success', () => {
    const kernel = kernelAnswering({
      status: 'ok',
      value: 42,
      details: { quality: 'exact', radius: 7 }
    });
    expect(resizeCylindricalFaceTyped(kernel, 1, 2, 7)).toBe(42);
  });

  it('carries the code, category, cause and neighbour onto the record', () => {
    const kernel = kernelAnswering({
      status: 'error',
      value: null,
      code: 'unsupported_move_face',
      category: 'unsupported',
      details: {
        kernelCode: 'unsupported_move_face',
        reason: 'unsupported_neighbor',
        surfaceType: 'cylinder',
        neighborSurfaceType: 'sphere',
        neighborFace: 7,
        operation: 'resizeCylindricalFace',
        message: 'an opaque sentence'
      }
    });
    let thrown: unknown;
    try {
      resizeCylindricalFaceTyped(kernel, 1, 2, 7);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DirectEditRefusal);
    // The warning text stays the kernel's sentence, byte for byte.
    expect((thrown as Error).message).toBe('an opaque sentence');
    expect(kernelRefusalCategoryOf(thrown)).toBe('unsupported');
    expect(
      kernelRefusalRecordOf(new Error('wrapped', { cause: thrown }))
    ).toEqual({
      family: 'direct-edit',
      operation: 'resize-cylindrical-face',
      category: 'unsupported',
      code: 'unsupported_move_face',
      reason: 'unsupported_neighbor',
      neighborSurfaceType: 'sphere'
    });
  });

  it('omits the neighbour for a partial reversed wall', () => {
    const kernel = kernelAnswering({
      status: 'error',
      value: null,
      code: 'unsupported_move_face',
      category: 'unsupported',
      details: {
        kernelCode: 'unsupported_move_face',
        reason: 'partial_reversed_wall',
        surfaceType: 'cylinder',
        message: 'another opaque sentence'
      }
    });
    expect(() => resizeCylindricalFaceTyped(kernel, 1, 2, 7)).toThrow(
      DirectEditRefusal
    );
    try {
      resizeCylindricalFaceTyped(kernel, 1, 2, 7);
    } catch (error) {
      expect(kernelRefusalRecordOf(error)).toEqual({
        family: 'direct-edit',
        operation: 'resize-cylindrical-face',
        category: 'unsupported',
        code: 'unsupported_move_face',
        reason: 'partial_reversed_wall'
      });
    }
  });

  it('keeps the legacy call on a kernel without the twin', () => {
    const kernel = {
      resizeCylindricalFace: () => 9
    } as unknown as RemusKernel;
    expect(resizeCylindricalFaceTyped(kernel, 1, 2, 7)).toBe(9);
  });
});

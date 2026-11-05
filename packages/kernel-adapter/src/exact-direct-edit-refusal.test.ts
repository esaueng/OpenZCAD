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
 * itself is exercised end to end in `test/sphere-boss-resize-refusal.test.ts`;
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

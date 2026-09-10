import { describe, expect, it } from 'vitest';
import {
  unifyUnionFacesChecked,
  verdictRefusesUnion
} from '../packages/kernel-adapter/src/exact-boolean-helpers';
import type { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

// A closed tetrahedron: the display projection the union gate inspects.
const TETRAHEDRON_POSITIONS = new Float32Array([
  0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1
]);
const TETRAHEDRON_INDICES = new Uint32Array([
  0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3
]);
// One face missing: open.
const OPEN_INDICES = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2]);

interface StubOptions {
  report: {
    facesMerged: number;
    inputErrors: number;
    resultErrors: number;
    reverted: boolean;
  } | Error;
  meshOf: (solid: number) => Uint32Array;
}

function stubKernel(options: StubOptions) {
  const calls: string[] = [];
  const kernel = {
    copyAndTransformSolid: (solid: number) => {
      calls.push(`copy ${solid}`);
      return solid + 100;
    },
    unifyFacesChecked: (solid: number) => {
      calls.push(`unifyFacesChecked ${solid}`);
      if (options.report instanceof Error) throw options.report;
      return JSON.stringify(options.report);
    },
    validateSolid: (solid: number) => {
      calls.push(`validateSolid ${solid}`);
      return 0;
    },
    boundingBox: () => Float64Array.of(0, 0, 0, 1, 1, 1),
    tessellateSolidGroupedBinary: (solid: number) => {
      calls.push(`tessellate ${solid}`);
      return {
        positions: TETRAHEDRON_POSITIONS,
        indices: options.meshOf(solid),
        faceOffsets: new Uint32Array([0]),
        free: () => {}
      };
    }
  };
  return { kernel: kernel as unknown as RemusKernel, calls };
}

describe('union gate verdict reuse', () => {
  it('accepts the unified copy on the kernel verdict without validating again', () => {
    const { kernel, calls } = stubKernel({
      report: { facesMerged: 3, inputErrors: 0, resultErrors: 0, reverted: false },
      meshOf: () => TETRAHEDRON_INDICES
    });
    const unified = unifyUnionFacesChecked(kernel, 7);
    expect(unified).toEqual({
      solid: 107,
      verdict: { strictErrors: 0, meshClosed: true }
    });
    expect(verdictRefusesUnion(unified.verdict)).toBe(false);
    expect(calls).toEqual(['copy 7', 'unifyFacesChecked 107', 'tessellate 107']);
  });

  it('keeps the raw union with the input verdict when the merge was reverted', () => {
    const { kernel, calls } = stubKernel({
      report: { facesMerged: 0, inputErrors: 0, resultErrors: 0, reverted: true },
      // A reverted merge must not even tessellate the copy.
      meshOf: (solid) => (solid === 107 ? OPEN_INDICES : TETRAHEDRON_INDICES)
    });
    const unified = unifyUnionFacesChecked(kernel, 7);
    expect(unified).toEqual({
      solid: 7,
      verdict: { strictErrors: 0, meshClosed: true }
    });
    expect(calls).not.toContain('validateSolid 7');
    expect(calls).not.toContain('tessellate 107');
    expect(calls).toContain('tessellate 7');
  });

  it('refuses without tessellating when the kernel reports strict errors on both', () => {
    const { kernel, calls } = stubKernel({
      report: { facesMerged: 2, inputErrors: 3, resultErrors: 3, reverted: false },
      meshOf: () => TETRAHEDRON_INDICES
    });
    const unified = unifyUnionFacesChecked(kernel, 7);
    expect(unified).toEqual({ solid: 7, verdict: { strictErrors: 3 } });
    expect(verdictRefusesUnion(unified.verdict)).toBe(true);
    expect(calls.filter((c) => c.startsWith('tessellate'))).toEqual([]);
    expect(calls).not.toContain('validateSolid 7');
  });

  it('falls back to validating the raw union when healing throws', () => {
    const { kernel, calls } = stubKernel({
      report: new Error('heal failed'),
      meshOf: () => TETRAHEDRON_INDICES
    });
    const unified = unifyUnionFacesChecked(kernel, 7);
    expect(unified).toEqual({
      solid: 7,
      verdict: { strictErrors: 0, meshClosed: true }
    });
    expect(calls).toContain('validateSolid 7');
  });

  it('treats an unknown mesh closure as a refusal', () => {
    expect(verdictRefusesUnion({ strictErrors: 0 })).toBe(true);
    expect(verdictRefusesUnion({ strictErrors: 0, meshClosed: false })).toBe(true);
    expect(verdictRefusesUnion({ strictErrors: 1, meshClosed: true })).toBe(true);
  });
});

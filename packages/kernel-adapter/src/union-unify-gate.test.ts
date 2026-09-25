import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemusKernel } from './remus-runtime';
import {
  fuseUniformSolid,
  unifyUnionFaces,
  unifyUnionFacesChecked,
  unifyUnionFacesWithVerdict
} from './exact-boolean-helpers';
import { transformMatrix } from './exact-math';

/**
 * The union gate, decided by `unifyFacesChecked` (Remus bridge row B16).
 *
 * The gate used to unify a copy with `unifyFaces` and then ask
 * `validateSolid` about the copy, then about the raw union, and the
 * measurement pass asked again. The kernel's unification report already
 * carries both strict verdicts, so these cases pin that the gate adopts,
 * refuses and reports from that report alone — with no strict validation
 * call of its own on the way.
 */

/**
 * Two 10 mm boxes overlapping at a corner: an L-shaped union whose top and
 * bottom the fuse leaves split into three coplanar pieces each (14 faces),
 * so the gate has a real merge to accept (4 faces, down to 10). Offset along
 * one axis only, the fuse already merges them and the gate has nothing to do.
 */
function overlappingBoxes(kernel: RemusKernel): number {
  const left = kernel.makeBox(10, 10, 10);
  const right = kernel.makeBox(10, 10, 10);
  kernel.transformSolid(
    right,
    transformMatrix({ x: 5, y: 5, z: 0 }, { x: 0, y: 0, z: 0 })
  );
  return kernel.fuseAll(Uint32Array.from([left, right]));
}

/** Spies on both strict validators, so neither can stand in for the other. */
function spyOnValidation() {
  return {
    plain: vi.spyOn(RemusKernel.prototype, 'validateSolid'),
    detailed: vi.spyOn(RemusKernel.prototype, 'validateSolidDetailed'),
    checked: vi.spyOn(RemusKernel.prototype, 'unifyFacesChecked')
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the union gate on unifyFacesChecked', () => {
  it('adopts an accepted unify from the report, validating nothing itself', () => {
    const kernel = new RemusKernel();
    const raw = overlappingBoxes(kernel);
    const rawFaces = kernel.getSolidFaces(raw).length;
    const spies = spyOnValidation();

    const accepted: number[] = [];
    const unified = unifyUnionFacesChecked(kernel, raw, (solid) =>
      accepted.push(solid)
    );

    // One checked call decided it, and neither validator ran.
    expect(spies.checked).toHaveBeenCalledTimes(1);
    expect(spies.plain).not.toHaveBeenCalled();
    expect(spies.detailed).not.toHaveBeenCalled();
    const report = JSON.parse(
      spies.checked.mock.results[0]!.value as string
    ) as { facesMerged: number; inputErrors: number; resultErrors: number };
    expect(report.facesMerged).toBeGreaterThan(0);
    expect(report.inputErrors).toBe(0);
    expect(report.resultErrors).toBe(0);

    // The merged copy ships, with the verdict the measurement pass reuses.
    expect(unified.solid).not.toBe(raw);
    expect(accepted).toEqual([unified.solid]);
    expect(unified.verdict).toEqual({ strictErrors: 0, meshClosed: true });
    expect(kernel.getSolidFaces(unified.solid).length).toBe(
      rawFaces - report.facesMerged
    );
    // The raw union was healed on a copy, never in place.
    expect(kernel.getSolidFaces(raw).length).toBe(rawFaces);
    spies.plain.mockRestore();
    expect(kernel.validateSolid(unified.solid)).toBe(0);
  });

  it('keeps the raw union when unification opens its projection', () => {
    const kernel = new RemusKernel();
    const raw = overlappingBoxes(kernel);
    // Every solid but the raw union projects to one open triangle: what a
    // unification that merged a wall across a base notch looks like to the
    // viewport. The kernel's report still calls the copy strict.
    const original = RemusKernel.prototype.tessellateSolidGroupedBinary;
    vi.spyOn(
      RemusKernel.prototype,
      'tessellateSolidGroupedBinary'
    ).mockImplementation(function (this: RemusKernel, solid, ...rest) {
      if (solid === raw) {
        return original.call(this, solid, ...rest);
      }
      return {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]),
        free() {}
      } as ReturnType<RemusKernel['tessellateSolidGroupedBinary']>;
    });
    const spies = spyOnValidation();

    const unified = unifyUnionFacesChecked(kernel, raw);

    expect(unified.solid).toBe(raw);
    expect(unified.verdict).toEqual({ strictErrors: 0, meshClosed: true });
    expect(spies.plain).not.toHaveBeenCalled();
    expect(spies.detailed).not.toHaveBeenCalled();
  });

  it('keeps the raw union with the kernel verdict when the merge is refused', () => {
    const kernel = new RemusKernel();
    const raw = overlappingBoxes(kernel);
    const copy = kernel.copySolid(raw);
    const spies = spyOnValidation();
    const accepted: number[] = [];

    // A reverted merge: the candidate failed strict validation while the
    // input passed, so the input's verdict is the one that stands.
    const reverted = unifyUnionFacesWithVerdict(
      kernel,
      raw,
      { facesMerged: 0, inputErrors: 0, resultErrors: 0, reverted: true },
      copy,
      (solid) => accepted.push(solid)
    );
    expect(reverted.solid).toBe(raw);
    expect(reverted.verdict).toEqual({ strictErrors: 0, meshClosed: true });

    // A merge whose result is not strict leaves the raw union and its own
    // count, and a raw union that already failed is refused without being
    // tessellated at all.
    const invalid = unifyUnionFacesWithVerdict(
      kernel,
      raw,
      { facesMerged: 2, inputErrors: 3, resultErrors: 1, reverted: false },
      copy,
      (solid) => accepted.push(solid)
    );
    expect(invalid).toEqual({ solid: raw, verdict: { strictErrors: 3 } });

    expect(accepted).toEqual([]);
    expect(spies.plain).not.toHaveBeenCalled();
    expect(spies.detailed).not.toHaveBeenCalled();
  });

  it('keeps the raw handle when the checked unify merges nothing', () => {
    // Offset along one axis, the fuse has already merged the coplanar
    // pieces, so the gate's copy merges nothing: it is the same body, and
    // the raw handle ships with the kernel's verdict on it.
    const kernel = new RemusKernel();
    const left = kernel.makeBox(10, 10, 10);
    const right = kernel.copyAndTransformSolid(
      kernel.makeBox(10, 10, 10),
      transformMatrix({ x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    );
    const raw = kernel.fuseAll(Uint32Array.from([left, right]));
    const spies = spyOnValidation();

    const unified = unifyUnionFacesChecked(kernel, raw);

    expect(
      JSON.parse(spies.checked.mock.results[0]!.value as string)
    ).toMatchObject({ facesMerged: 0, inputErrors: 0, resultErrors: 0 });
    expect(unified).toEqual({
      solid: raw,
      verdict: { strictErrors: 0, meshClosed: true }
    });
    expect(spies.plain).not.toHaveBeenCalled();
    expect(spies.detailed).not.toHaveBeenCalled();
  });

  it('routes every union through the same checked gate', () => {
    const kernel = new RemusKernel();
    const spies = spyOnValidation();
    const plain = unifyUnionFaces(kernel, overlappingBoxes(kernel));
    const left = kernel.makeBox(10, 10, 10);
    const right = kernel.copyAndTransformSolid(
      kernel.makeBox(10, 10, 10),
      transformMatrix({ x: 5, y: 5, z: 0 }, { x: 0, y: 0, z: 0 })
    );
    const fused = fuseUniformSolid(kernel, [left, right]);

    expect(spies.checked).toHaveBeenCalledTimes(2);
    expect(spies.plain).not.toHaveBeenCalled();
    expect(spies.detailed).not.toHaveBeenCalled();
    spies.plain.mockRestore();
    expect(kernel.validateSolid(plain)).toBe(0);
    expect(kernel.validateSolid(fused)).toBe(0);
    // Both reached the gate with 14 faces and shipped the merged 10.
    expect(kernel.getSolidFaces(plain).length).toBe(10);
    expect(kernel.getSolidFaces(fused).length).toBe(10);
  });

  it('validates the raw union once only when the kernel gave no report', () => {
    const kernel = new RemusKernel();
    const raw = overlappingBoxes(kernel);
    const spies = spyOnValidation();
    spies.checked.mockImplementation(() => {
      throw new Error('topology lookup failed');
    });

    const unified = unifyUnionFacesChecked(kernel, raw);

    // No report means no verdict to reuse: the raw union stands and is
    // validated exactly once, through the detailed twin.
    expect(unified.solid).toBe(raw);
    expect(unified.verdict).toEqual({ strictErrors: 0, meshClosed: true });
    expect(spies.detailed).toHaveBeenCalledTimes(1);
    expect(spies.plain).not.toHaveBeenCalled();
  });

  it('leaves no bare validateSolid or unifyFaces on the gate', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./exact-boolean-helpers.ts', import.meta.url)),
      'utf8'
    );
    expect(source).not.toMatch(/\bvalidateSolid\(/);
    expect(source).not.toContain('isStrictBooleanSolid');
    // `unifyBooleanFaces` (cut and intersect) is the one bare unify left: it
    // keeps every merge and never re-validates to decide.
    expect(source.match(/kernel\.unifyFaces\(/g) ?? []).toHaveLength(1);
    const copyHeal = readFileSync(
      fileURLToPath(
        new URL('./boolean-result-validation.ts', import.meta.url)
      ),
      'utf8'
    );
    expect(copyHeal).toContain('unifyFacesReport');
    expect(copyHeal).not.toMatch(/\bunifyFaces\(/);
  });
});

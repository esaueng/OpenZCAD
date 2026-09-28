import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemusKernel } from './remus-runtime';
import {
  takeUnionDisplayMeshForMeasurement,
  UnionVerdictsWithMeshBudget,
  unifyUnionFacesWithVerdict
} from './exact-boolean-helpers';
import { displayTessellationForExtents } from './display-tessellation';

const acceptedReport = {
  facesMerged: 1,
  inputErrors: 0,
  resultErrors: 0,
  reverted: false
};

function deflections(kernel: RemusKernel, solid: number) {
  const bounds = kernel.boundingBox(solid);
  return displayTessellationForExtents(
    bounds[3]! - bounds[0]!,
    bounds[4]! - bounds[1]!,
    bounds[5]! - bounds[2]!
  );
}

function box(kernel: RemusKernel): number {
  return kernel.makeBox(10, 10, 10);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('union display mesh reuse', () => {
  it('copies a closed selected solid before freeing the WASM mesh and consumes it once', () => {
    const kernel = new RemusKernel();
    const raw = box(kernel);
    const healed = kernel.copySolid(raw);
    const original = RemusKernel.prototype.tessellateSolidGroupedBinary;
    const free = vi.fn();
    let wasmPositions: Float32Array | undefined;
    vi.spyOn(
      RemusKernel.prototype,
      'tessellateSolidGroupedBinary'
    ).mockImplementation(function (this: RemusKernel, solid, ...args) {
      const mesh = original.call(this, solid, ...args);
      if (solid === healed) {
        wasmPositions = mesh.positions;
        vi.spyOn(mesh, 'free').mockImplementation(free);
      }
      return mesh;
    });

    const result = unifyUnionFacesWithVerdict(
      kernel,
      raw,
      acceptedReport,
      healed,
      undefined,
      true
    );
    const projection = result.verdict.displayMesh;

    expect(result.solid).toBe(healed);
    expect(projection).toBeDefined();
    expect(projection?.positions).not.toBe(wasmPositions);
    expect(free).toHaveBeenCalledTimes(1);

    const display = deflections(kernel, healed);
    const taken = takeUnionDisplayMeshForMeasurement(
      result.verdict,
      kernel,
      healed,
      display.linearDeflection,
      display.angularDeflection
    );
    expect(taken?.positions).toBe(projection?.positions);
    expect(taken?.indices).toBe(projection?.indices);
    expect(taken?.faceOffsets).toBe(projection?.faceOffsets);
    taken?.free();
    expect(free).toHaveBeenCalledTimes(1);
    expect(result.verdict.displayMesh).toBeUndefined();
    expect(
      takeUnionDisplayMeshForMeasurement(
        result.verdict,
        kernel,
        healed,
        display.linearDeflection,
        display.angularDeflection
      )
    ).toBeUndefined();
  });

  it('does not copy a closed mesh when its verdict will not be retained', () => {
    const kernel = new RemusKernel();
    const raw = box(kernel);
    const healed = kernel.copySolid(raw);
    const result = unifyUnionFacesWithVerdict(
      kernel,
      raw,
      acceptedReport,
      healed
    );

    expect(result.solid).toBe(healed);
    expect(result.verdict.meshClosed).toBe(true);
    expect(result.verdict.displayMesh).toBeUndefined();
  });

  it('keeps a cached payload when kernel identity, solid, or deflection does not match', () => {
    const kernel = new RemusKernel();
    const raw = box(kernel);
    const healed = kernel.copySolid(raw);
    const result = unifyUnionFacesWithVerdict(
      kernel,
      raw,
      acceptedReport,
      healed,
      undefined,
      true
    );
    const display = deflections(kernel, healed);
    const otherKernel = new RemusKernel();

    expect(
      takeUnionDisplayMeshForMeasurement(
        result.verdict,
        otherKernel,
        healed,
        display.linearDeflection,
        display.angularDeflection
      )
    ).toBeUndefined();
    expect(
      takeUnionDisplayMeshForMeasurement(
        result.verdict,
        kernel,
        raw,
        display.linearDeflection,
        display.angularDeflection
      )
    ).toBeUndefined();
    expect(
      takeUnionDisplayMeshForMeasurement(
        result.verdict,
        kernel,
        healed,
        display.linearDeflection * 2,
        display.angularDeflection
      )
    ).toBeUndefined();
    expect(
      takeUnionDisplayMeshForMeasurement(
        result.verdict,
        kernel,
        healed,
        display.linearDeflection,
        display.angularDeflection * 2
      )
    ).toBeUndefined();
    expect(result.verdict.displayMesh).toBeDefined();
  });

  it('does not retain a closed projection larger than the payload budget', () => {
    const kernel = new RemusKernel();
    const raw = box(kernel);
    const healed = kernel.copySolid(raw);
    const original = RemusKernel.prototype.tessellateSolidGroupedBinary;
    const free = vi.fn();
    vi.spyOn(
      RemusKernel.prototype,
      'tessellateSolidGroupedBinary'
    ).mockImplementation(function (this: RemusKernel, solid, ...args) {
      const mesh = original.call(this, solid, ...args);
      if (solid !== healed) return mesh;
      const oversizedPositions = new Float32Array(
        mesh.positions.length + 2_200_000
      );
      oversizedPositions.set(mesh.positions);
      vi.spyOn(mesh, 'free').mockImplementation(free);
      return {
        positions: oversizedPositions,
        indices: mesh.indices,
        faceOffsets: mesh.faceOffsets,
        free: mesh.free.bind(mesh)
      } as ReturnType<RemusKernel['tessellateSolidGroupedBinary']>;
    });

    const result = unifyUnionFacesWithVerdict(
      kernel,
      raw,
      acceptedReport,
      healed,
      undefined,
      true
    );

    expect(result.solid).toBe(healed);
    expect(result.verdict.meshClosed).toBe(true);
    expect(result.verdict.displayMesh).toBeUndefined();
    expect(free).toHaveBeenCalledTimes(1);
  });

  it('enforces one total budget across a sync and releases bytes when consumed', () => {
    const kernel = new RemusKernel();
    const firstSolid = box(kernel);
    const secondSolid = box(kernel);
    const display = deflections(kernel, firstSolid);
    const verdicts = new UnionVerdictsWithMeshBudget();
    const payload = (solid: number) => ({
      kernel,
      solid,
      linearDeflection: display.linearDeflection,
      angularDeflection: display.angularDeflection,
      positions: new Float32Array(1_310_720),
      indices: new Uint32Array([0, 1, 2]),
      faceOffsets: new Uint32Array([0, 3]),
      bytes: 5_242_900
    });
    const first = payload(firstSolid);
    const second = payload(secondSolid);
    verdicts.set(1, { strictErrors: 0, meshClosed: true, displayMesh: first });
    verdicts.set(2, { strictErrors: 0, meshClosed: true, displayMesh: second });

    expect(verdicts.get(1)?.displayMesh).toBe(first);
    expect(verdicts.get(2)?.displayMesh).toBeUndefined();
    const consumed = takeUnionDisplayMeshForMeasurement(
      verdicts.get(1),
      kernel,
      firstSolid,
      display.linearDeflection,
      display.angularDeflection
    );
    expect(consumed).toBeDefined();
    const third = payload(secondSolid);
    verdicts.set(3, { strictErrors: 0, meshClosed: true, displayMesh: third });
    expect(verdicts.get(3)?.displayMesh).toBe(third);
  });

  it('discards an open healed candidate and caches only the closed raw fallback', () => {
    const kernel = new RemusKernel();
    const raw = box(kernel);
    const healed = kernel.copySolid(raw);
    const original = RemusKernel.prototype.tessellateSolidGroupedBinary;
    const calls: number[] = [];
    const frees = [vi.fn(), vi.fn()];
    vi.spyOn(
      RemusKernel.prototype,
      'tessellateSolidGroupedBinary'
    ).mockImplementation(function (this: RemusKernel, solid, ...args) {
      calls.push(solid);
      const mesh = original.call(this, solid, ...args);
      const callIndex = calls.length - 1;
      vi.spyOn(mesh, 'free').mockImplementation(frees[callIndex]!);
      if (solid !== healed) return mesh;
      return {
        positions: mesh.positions,
        indices: mesh.indices.slice(0, mesh.indices.length - 3),
        faceOffsets: mesh.faceOffsets,
        free: mesh.free.bind(mesh)
      } as ReturnType<RemusKernel['tessellateSolidGroupedBinary']>;
    });

    const result = unifyUnionFacesWithVerdict(
      kernel,
      raw,
      acceptedReport,
      healed,
      undefined,
      true
    );

    expect(calls).toEqual([healed, raw]);
    expect(frees.map((free) => free.mock.calls.length)).toEqual([1, 1]);
    expect(result.solid).toBe(raw);
    expect(result.verdict.meshClosed).toBe(true);
    expect(result.verdict.displayMesh?.solid).toBe(raw);
  });

  it('frees meshes and declines reuse when closure inspection fails', () => {
    const kernel = new RemusKernel();
    const raw = box(kernel);
    const healed = kernel.copySolid(raw);
    const original = RemusKernel.prototype.tessellateSolidGroupedBinary;
    const frees = [vi.fn(), vi.fn()];
    vi.spyOn(
      RemusKernel.prototype,
      'tessellateSolidGroupedBinary'
    ).mockImplementation(function (this: RemusKernel, solid, ...args) {
      const mesh = original.call(this, solid, ...args);
      const free = frees[solid === healed ? 0 : 1]!;
      vi.spyOn(mesh, 'free').mockImplementation(free);
      if (solid !== healed) return mesh;
      return {
        get positions(): Float32Array {
          throw new Error('unavailable mesh buffer');
        },
        indices: mesh.indices,
        faceOffsets: mesh.faceOffsets,
        free: mesh.free.bind(mesh)
      } as ReturnType<RemusKernel['tessellateSolidGroupedBinary']>;
    });

    const result = unifyUnionFacesWithVerdict(
      kernel,
      raw,
      acceptedReport,
      healed,
      undefined,
      true
    );

    expect(frees.map((free) => free.mock.calls.length)).toEqual([1, 1]);
    expect(result.solid).toBe(raw);
    expect(result.verdict.meshClosed).toBe(true);
    expect(result.verdict.displayMesh?.solid).toBe(raw);
  });
});

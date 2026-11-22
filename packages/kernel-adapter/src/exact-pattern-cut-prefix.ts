import { MAX_PATTERN_INSTANCES } from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';

interface CheckedCuts {
  projectId: string;
  targetVolume: number;
  count: number;
  operands: Uint8Array;
  solid: Uint8Array;
}

const checked = new WeakMap<RemusKernel, CheckedCuts>();
// A 100-hole plate uses 331,008 bytes for its cutters and checked result.
const MAX_BYTES = 384 * 1024;

export function clearPatternCutPrefix(kernel: RemusKernel): void {
  checked.delete(kernel);
}

export function patternCutPrefix(
  kernel: RemusKernel,
  projectId: string,
  original: number,
  targetVolume: number,
  copies: readonly number[][]
) {
  if (
    copies.length < 8 ||
    copies.length > MAX_PATTERN_INSTANCES ||
    copies.some((tools) => tools.length !== 1)
  )
    return undefined;
  try {
    const faces = kernel.getSolidFaces(original);
    if (
      faces.length > 8 ||
      !faces.every((face) => {
        const kind = kernel.getSurfaceType(face);
        return kind === 'plane' || kind === 'cylinder';
      })
    )
      return undefined;
    const handles = [original, ...copies.map((tools) => tools[0]!)];
    const operands = (count: number) =>
      kernel.serializeSolids(Uint32Array.from(handles.slice(0, count + 1)));
    let solid = original;
    let count = 0;
    const old = checked.get(kernel);
    if (
      old?.projectId === projectId &&
      old.targetVolume === targetVolume &&
      old.count <= copies.length
    ) {
      const current = operands(old.count);
      if (
        current.length === old.operands.length &&
        current.every((byte, i) => byte === old.operands[i])
      ) {
        const restored = kernel.deserializeSolids(old.solid);
        if (restored.length === 1) {
          solid = restored[0]!;
          count = old.count;
        } else {
          for (const handle of restored) kernel.deleteSolid(handle);
        }
      }
    }
    let candidate: CheckedCuts | undefined;
    return {
      solid,
      count,
      capture(after: number, result: number) {
        // Keep one checked result that can serve the next three tail skips.
        if (after !== copies.length - 3 || after <= count) return;
        try {
          const input = operands(after);
          if (input.length >= MAX_BYTES) return;
          const output = kernel.serializeSolids(Uint32Array.of(result));
          if (input.length + output.length <= MAX_BYTES)
            candidate = {
              projectId,
              targetVolume,
              count: after,
              operands: input,
              solid: output
            };
        } catch {
          // Capturing an optional prefix cannot refuse a checked cut.
        }
      },
      commit() {
        if (candidate) checked.set(kernel, candidate);
      }
    };
  } catch {
    return undefined;
  }
}

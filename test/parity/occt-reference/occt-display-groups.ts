import type { OcctKernel, ShapeHandle } from 'occt-wasm';

const HASH_UPPER_BOUND = 2_147_483_647;

/** Resolve display ranges by OCCT identity, independent of traversal order. */
export function indexOcctDisplayGroups(
  kernel: OcctKernel,
  shapes: readonly ShapeHandle[],
  groups: Int32Array,
  dataLength: number,
  kind: 'face' | 'edge'
): Map<ShapeHandle, { start: number; count: number }> {
  const byHash = new Map<number, ShapeHandle>();
  for (const shape of shapes) {
    const hash = kernel.hashCode(shape, HASH_UPPER_BOUND);
    if (byHash.has(hash)) {
      throw new Error(`OCCT ${kind} handles have an ambiguous display hash.`);
    }
    byHash.set(hash, shape);
  }
  if (groups.length % 3 !== 0) {
    throw new Error(`OCCT returned incomplete ${kind} display groups.`);
  }
  const ranges = new Map<ShapeHandle, { start: number; count: number }>();
  for (let index = 0; index < groups.length; index += 3) {
    const start = groups[index]!;
    const count = groups[index + 1]!;
    const shape = byHash.get(groups[index + 2]!);
    if (shape === undefined || ranges.has(shape)) {
      throw new Error(
        `OCCT ${kind} display groups do not name unique handles.`
      );
    }
    if (
      start < 0 ||
      count < 0 ||
      start % 3 !== 0 ||
      count % 3 !== 0 ||
      start + count > dataLength
    ) {
      throw new Error(`OCCT returned an invalid ${kind} display range.`);
    }
    ranges.set(shape, { start, count });
  }
  return ranges;
}

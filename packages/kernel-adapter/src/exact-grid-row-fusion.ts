import { GEOMETRY_EPSILON } from './exact-math';
import { RemusKernel } from './remus-runtime';

/**
 * In a complete orthogonal grid of rectangular stock, every row is the same
 * union translated along the second axis. A gap between rows lets fuseAll
 * assemble them in their original order. Keep the raw row's face partitions:
 * the union's normal checked unification belongs to the assembled solid.
 */
export function fuseSeparatedGridRows(
  kernel: RemusKernel,
  solids: readonly number[],
  rows: number,
  rowAxis: 'x' | 'y' | 'z',
  matrix: (ordinal: number) => Float64Array
): number | undefined {
  let scratch: RemusKernel | undefined;
  try {
    const bounds = kernel.boundingBox(solids[0]!);
    const axis = { x: 0, y: 1, z: 2 }[rowAxis];
    const step = matrix(1)[4 * axis + 3]!;
    const extent = bounds[axis + 3]! - bounds[axis]!;
    // The open gap must clear the kernel contact band. A very distant row
    // can classify differently from the original because world-coordinate
    // rounding consumes the modeling tolerance, even with a wide gap.
    const last = matrix(solids.length - 1);
    const worldExtent =
      Math.max(...Array.from(bounds, Math.abs)) +
      Math.max(Math.abs(last[3]!), Math.abs(last[7]!), Math.abs(last[11]!));
    if (!(
      Math.abs(step) - extent > 1e-6 &&
      32 * Number.EPSILON * worldExtent < GEOMETRY_EPSILON
    ))
      return undefined;

    const firstRow = solids.filter((_, ordinal) => ordinal % rows === 0);
    // Retiring row handles one by one scans the live arena for references.
    // A private kernel can release the whole intermediate build at once.
    scratch = new RemusKernel();
    const copies = scratch.deserializeSolids(
      kernel.serializeSolids(Uint32Array.from(firstRow))
    );
    const row = scratch.fuseAll(copies);
    const placed = [row];
    for (let index = 1; index < rows; index++) {
      placed.push(scratch.copyAndTransformSolid(row, matrix(index)));
    }
    const assembled = scratch.fuseAll(Uint32Array.from(placed));
    return kernel.deserializeSolids(
      scratch.serializeSolids(Uint32Array.of(assembled))
    )[0];
  } catch {
    // Retry with all original instances so a refusal identifies the same
    // operand and follows the same diagnostic path as an ordinary pattern.
    return undefined;
  } finally {
    scratch?.free();
  }
}

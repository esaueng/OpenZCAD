/**
 * Whether two display-mesh buffers hold the same bytes.
 *
 * Projection diffing compares every unchanged body's positions and indices on
 * each publication, so this runs over millions of elements per edit on a
 * multi-body model. Reading both buffers through `Uint32Array` views keeps
 * the loop monomorphic whatever the element type, which is roughly ten times
 * faster than indexing a `Float32Array | Uint32Array` union.
 *
 * Bitwise equality is at least as strict as element `===` everywhere it
 * matters: identical bytes are identical data. It differs only for
 * `-0`/`+0` (reported different, which just republishes) and identical NaN
 * payloads (reported equal, which they are).
 */
export function sameMeshBuffer(
  left: Float32Array | Uint32Array,
  right: Float32Array | Uint32Array
): boolean {
  if (left === right) return true;
  if (left.constructor !== right.constructor || left.length !== right.length)
    return false;
  const a = new Uint32Array(left.buffer, left.byteOffset, left.length);
  const b = new Uint32Array(right.buffer, right.byteOffset, right.length);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

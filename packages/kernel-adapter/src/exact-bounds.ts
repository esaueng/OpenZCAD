/**
 * A solid's published box: the kernel's, pulled in wherever its own display
 * mesh proves it loose.
 *
 * The pinned kernel boxes a cylinder or cone face by a full circle at each of
 * its vertices' axial slices, whatever arc the face actually spans, so a
 * partial face — the result of an Intersect, a D-flat, an arc left by a cut —
 * reports the whole cylinder (production QA CAD-02: an intersection showing
 * 30 × 30 × 12 mm whose geometry is 4.14 × 6.18 × 12). Sphere and torus faces
 * are already trimmed; the cylinder/cone fix belongs upstream, and this holds
 * the published size to the geometry until the pin carries it.
 *
 * Every display-mesh vertex lies on the surface, and the surface leaves the
 * mesh by at most the chord deflection it was tessellated at. So a side of
 * the kernel's box that stands further than that beyond the mesh is provably
 * loose, and is pulled in to the mesh's extreme — which is also what the
 * exported STL/3MF/OBJ bounds show. A side within that tolerance is kept as
 * the kernel's, so exact boxes (a whole cylinder's, a plane's) are unchanged.
 *
 * @param bounds `[minX, minY, minZ, maxX, maxY, maxZ]` from the kernel.
 * @param positions The solid's display mesh, flat xyz.
 * @param deflection The linear deflection that mesh was tessellated at.
 */
export function tightenBoundsToMesh(
  bounds: ArrayLike<number>,
  positions: ArrayLike<number>,
  deflection: number
): number[] {
  const tightened = Array.from(bounds).slice(0, 6);
  if (positions.length < 3) {
    return tightened;
  }
  const meshMin = [Infinity, Infinity, Infinity];
  const meshMax = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis]!;
      if (value < meshMin[axis]!) meshMin[axis] = value;
      if (value > meshMax[axis]!) meshMax[axis] = value;
    }
  }
  // Float32 positions carry their own rounding on top of the chord error.
  for (let axis = 0; axis < 3; axis += 1) {
    const slack =
      deflection +
      4 *
        Math.fround(
          Math.max(Math.abs(meshMin[axis]!), Math.abs(meshMax[axis]!))
        ) *
        2 ** -23;
    if (tightened[axis]! < meshMin[axis]! - slack) {
      tightened[axis] = meshMin[axis]!;
    }
    if (tightened[axis + 3]! > meshMax[axis]! + slack) {
      tightened[axis + 3] = meshMax[axis]!;
    }
  }
  return tightened;
}

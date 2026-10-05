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

/** One face of a solid, as {@link refineBoundsAtSplineFaces} judges it. */
export interface BoundsFace {
  /** The kernel's surface word: `plane`, `bspline`, `cylinder`, ... */
  surfaceType: string;
}

/** A solid's face-grouped mesh, as `tessellateSolidGroupedBinary` returns. */
export interface GroupedMesh {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** Index offsets of each face's triangles (faces + 1). */
  faceOffsets: ArrayLike<number>;
}

/** The finest re-tessellation tried, as a fraction of the display deflection. */
const MIN_REFINEMENT_RATIO = 1 / 16;

/**
 * Smallest gap worth a second mesh, as a fraction of the display deflection:
 * a quarter of a chord tolerance is below what any size readout shows.
 */
const MIN_REFINED_GAP_RATIO = 1 / 4;

/**
 * Solids with more faces than this keep the kernel's side rather than pay
 * for a whole finer mesh; a long engraved label is a few thousand faces.
 */
const MAX_REFINED_FACES = 4096;

function float32Slack(value: number): number {
  return 4 * Math.fround(Math.abs(value)) * 2 ** -23;
}

/** Per-face mesh extremes, `[minX, minY, minZ, maxX, maxY, maxZ]` each. */
function faceExtremes(mesh: GroupedMesh, faceCount: number): number[][] {
  const { positions, indices, faceOffsets } = mesh;
  if (faceOffsets.length !== faceCount + 1) {
    throw new Error('Mesh face groups do not match the faces.');
  }
  return Array.from({ length: faceCount }, (_, face) => {
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let at = faceOffsets[face]!; at < faceOffsets[face + 1]!; at += 1) {
      const vertex = indices[at]! * 3;
      for (let axis = 0; axis < 3; axis += 1) {
        const value = positions[vertex + axis]!;
        if (value < box[axis]!) box[axis] = value;
        if (value > box[axis + 3]!) box[axis + 3] = value;
      }
    }
    return box;
  });
}

/**
 * Pull in a side of the box that {@link tightenBoundsToMesh} had to keep
 * because it was loose by less than one display deflection, when only
 * B-spline faces could be responsible for it.
 *
 * The pinned kernel boxes a trimmed B-spline face by its untrimmed surface.
 * On-face text is the case that shows it: the coplanar-cap pierce sweeps the
 * glyph walls 0.01 past the face it cuts, the cut trims them back to the
 * face, and the body still reports the walls' full height — a 10 mm slab
 * reads 10.01 although its mesh, its volume and its export are all 10. That
 * 0.01 sits inside the 0.0124 display deflection of a 62 mm part, so the
 * mesh alone cannot prove it loose: a curved face may truly bulge that far
 * past its chords. (`tessellateFace` on such a face also meshes the
 * untrimmed height, so the refinement re-meshes the whole solid, whose
 * grouped tessellation is trimmed.)
 *
 * Here the bound is certified face by face instead. For one side, every face
 * whose display mesh reaches within a deflection of the solid's extreme can
 * hold the true extreme; no other face can. Of those:
 *
 * - a plane is exact at its mesh: all of a plane facing along the axis lies
 *   at one level, and any other plane takes its extreme on its boundary,
 *   where a straight edge is exact at its vertices and a curved edge is
 *   shared with a curved neighbour that is itself one of these faces (it
 *   carries the same edge samples) and is refined below;
 * - a B-spline face is re-meshed finer, and its true extent is within that
 *   finer deflection of the new mesh;
 * - any other surface (cylinder, cone, sphere, torus) declines the side: its
 *   box is already exact or handled by the mesh rule, and the gap may be a
 *   real chord shortfall.
 *
 * When the certified bound still sits inside the kernel's side, the side is
 * pulled in to the certified bound, retaining the finer deflection and
 * Float32 margin so geometry between mesh vertices stays inside the box.
 *
 * @param bounds The box after {@link tightenBoundsToMesh}.
 * @param display The solid's display mesh, grouped by face.
 * @param faces Each face's surface, in the mesh's face order.
 * @param deflection The linear deflection the display mesh was built at.
 * @param remesh The same solid's grouped mesh at a finer deflection.
 */
export function refineBoundsAtSplineFaces(
  bounds: readonly number[],
  display: GroupedMesh,
  faces: readonly BoundsFace[],
  deflection: number,
  remesh: (deflection: number) => GroupedMesh
): number[] {
  const refined = Array.from(bounds).slice(0, 6);
  if (faces.length > MAX_REFINED_FACES) return refined;
  let displayBounds: number[][];
  try {
    displayBounds = faceExtremes(display, faces.length);
  } catch {
    return refined;
  }
  const fineMeshes = new Map<number, number[][] | null>();
  const fineBoundsAt = (fine: number): number[][] | null => {
    if (!fineMeshes.has(fine)) {
      try {
        fineMeshes.set(fine, faceExtremes(remesh(fine), faces.length));
      } catch {
        fineMeshes.set(fine, null);
      }
    }
    return fineMeshes.get(fine)!;
  };

  for (let side = 0; side < 6; side += 1) {
    // Work in "larger is outward" terms: negate the min sides.
    const sign = side < 3 ? -1 : 1;
    const outward = (box: readonly number[]): number => sign * box[side]!;
    let meshExtreme = -Infinity;
    for (const box of displayBounds) {
      meshExtreme = Math.max(meshExtreme, outward(box));
    }
    if (!Number.isFinite(meshExtreme)) continue;
    const kernelSide = sign * refined[side]!;
    const gap = kernelSide - meshExtreme;
    if (
      gap <= float32Slack(meshExtreme) ||
      gap < deflection * MIN_REFINED_GAP_RATIO
    ) {
      continue;
    }
    const reach = meshExtreme - deflection - float32Slack(meshExtreme);
    const candidates = displayBounds.flatMap((box, face) =>
      outward(box) >= reach ? [face] : []
    );
    const types = candidates.map((face) => faces[face]!.surfaceType);
    if (
      !types.includes('bspline') ||
      types.some((type) => type !== 'plane' && type !== 'bspline')
    ) {
      continue;
    }
    // One fine mesh serves every side: snap the gap-derived deflection down
    // to a power-of-two fraction of the display's, floored.
    const wanted = Math.max(gap / 4, deflection * MIN_REFINEMENT_RATIO);
    const fine = deflection * 2 ** Math.floor(Math.log2(wanted / deflection));
    const fineBounds = fineBoundsAt(fine);
    if (!fineBounds) continue;
    let certified = -Infinity;
    for (const face of candidates) {
      const plane = faces[face]!.surfaceType === 'plane';
      const value = outward(plane ? displayBounds[face]! : fineBounds[face]!);
      if (!Number.isFinite(value)) {
        certified = Infinity;
        break;
      }
      certified = Math.max(
        certified,
        value + (plane ? 0 : fine) + float32Slack(value)
      );
    }
    if (certified < kernelSide) {
      refined[side] = sign * certified;
    }
  }
  return refined;
}

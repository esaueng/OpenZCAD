import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import type {
  FaceTopology,
  OffsetFaceSnapshot,
  Vector3
} from '@openzcad/shared';
import {
  dot,
  offsetFacesName,
  setFaces,
  snapshot,
  unit,
  type FaceSetOffsetFacesInput
} from './faceSetOffset';

/**
 * M07: the chained move of an armed face set offset, as the workspace
 * previews it. Loaded when a face set's Offset verb arms (see
 * `handleOffsetFaceSet` in App), so its ordering stays out of the entry
 * chunk; until it has loaded a drag previews the whole chain alone.
 */

/**
 * Two faces of a set lie on one plane when their heights along the shared
 * normal differ by no more than this: the kernel's own fixed plane
 * tolerance (`DIRECT_EDIT_TOLERANCE`), never one scaled by the body's
 * distance from the origin.
 */
const PLANE_TOLERANCE = 1e-6;

/**
 * Two normals face one way for the chain when the sine between them is no
 * more than this (the kernel's `OFFSET_SET_CHAIN_PARALLEL_SINE`), and two
 * direction components closer than this compare equal when the directions
 * are ordered (its `OFFSET_SET_DIRECTION_ORDER_TOLERANCE`).
 */
const DIRECTION_TOLERANCE = 1e-9;

interface PlaneEntry {
  face: FaceTopology;
  order: number;
  normal: Vector3;
  center: Vector3;
}

function compareVectors(a: Vector3, b: Vector3): number {
  return a.x - b.x || a.y - b.y || a.z - b.z;
}

/**
 * The faces of an armed set grouped by the plane they lie on, in the order
 * the kernel's chained move takes them (its `offsetSetGroups`), from the
 * geometry alone:
 *
 * 1. Direction classes, faces whose normals are parallel to construction
 *    precision, in descending order of the class normal's z, then y, then
 *    x: tops before side walls before downward faces.
 * 2. Within a class, the plane the move leads with first (the outermost for
 *    a positive offset, the innermost for a negative one), the faces of a
 *    plane in the set's own order.
 *
 * The first group is the chain's first step. One group is one plane: a
 * coplanar set, which needs no chain. Null when a face no longer resolves.
 */
export function faceSetOffsetPlanes(
  input: FaceSetOffsetFacesInput,
  offset: number
): FaceTopology[][] | null {
  const faces = setFaces(input);
  if (!faces) return null;
  const classes: PlaneEntry[][] = [];
  // Seeded in a geometry-only order, as the kernel seeds its classes.
  for (const entry of faces
    .map((face, order) => ({
      face,
      order,
      normal: unit(face.geometry!.normal!)!,
      center: face.geometry!.center
    }))
    .sort(
      (a, b) =>
        compareVectors(a.normal, b.normal) ||
        compareVectors(a.center, b.center) ||
        a.order - b.order
    )) {
    const n = classes.find(
      ([first]) =>
        dot(first!.normal, entry.normal) > 0 &&
        Math.hypot(
          first!.normal.y * entry.normal.z - first!.normal.z * entry.normal.y,
          first!.normal.z * entry.normal.x - first!.normal.x * entry.normal.z,
          first!.normal.x * entry.normal.y - first!.normal.y * entry.normal.x
        ) <= DIRECTION_TOLERANCE
    );
    if (n) n.push(entry);
    else classes.push([entry]);
  }
  const directions = classes.map((members) => ({
    members,
    axis: unit(
      members.reduce(
        (sum, { normal }) => ({
          x: sum.x + normal.x,
          y: sum.y + normal.y,
          z: sum.z + normal.z
        }),
        { x: 0, y: 0, z: 0 }
      )
    )!
  }));
  directions.sort((a, b) => {
    for (const key of ['z', 'y', 'x'] as const) {
      const difference = b.axis[key] - a.axis[key];
      if (Math.abs(difference) > DIRECTION_TOLERANCE) return difference;
    }
    return 0;
  });
  return directions.flatMap(({ axis, members }) => {
    const height = (entry: PlaneEntry) => dot(axis, entry.center);
    const planes: PlaneEntry[][] = [];
    for (const entry of members.sort(
      (a, b) => height(a) - height(b) || a.order - b.order
    )) {
      const last = planes.at(-1);
      if (
        last &&
        Math.abs(height(entry) - height(last.at(-1)!)) <= PLANE_TOLERANCE
      ) {
        last.push(entry);
      } else {
        planes.push([entry]);
      }
    }
    if (offset > 0) planes.reverse();
    return planes.map((plane) =>
      plane.sort((a, b) => a.order - b.order).map((entry) => entry.face)
    );
  });
}

/**
 * A chained set's drag preview of its leading plane alone (M07): the faces
 * the chain moves first, at `offset`, on the source body. Its kernel move is
 * the chain's own first step, so a drag can show it from a prepared move
 * every frame while the whole chain is rebuilt at a coarse rate. Display
 * only: it never authors a commit, which replays the whole set. Null for a
 * set on one plane (nothing to chain) or a face that no longer resolves.
 */
export function buildOffsetFaceSetLead(
  input: FaceSetOffsetFacesInput & { offset: number }
): AnyCommand | null {
  const planes = faceSetOffsetPlanes(input, input.offset);
  if (!planes || planes.length < 2) return null;
  const [first, ...rest] = planes[0]!;
  const firstSnapshot = snapshot(first!);
  if (!firstSnapshot) return null;
  const offset = Math.round(input.offset * 1000) / 1000;
  if (rest.length === 0) {
    // One face leads: the same move as an `offset-face` of it.
    return commandFactories.directEditBody({
      name: offsetFacesName(planes.flat().length),
      targetBodyId: input.bodyId,
      operation: { kind: 'offset-face', ...firstSnapshot, offset }
    });
  }
  const additionalFaces: OffsetFaceSnapshot[] = [];
  for (const face of rest) {
    const entry = snapshot(face);
    if (!entry) return null;
    additionalFaces.push(entry);
  }
  return commandFactories.directEditBody({
    name: offsetFacesName(planes.flat().length),
    targetBodyId: input.bodyId,
    operation: {
      kind: 'offset-faces',
      ...firstSnapshot,
      offset,
      additionalFaces
    }
  });
}

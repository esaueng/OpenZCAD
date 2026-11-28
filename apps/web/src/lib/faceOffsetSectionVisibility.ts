import type {
  BodyRepresentation,
  BoundingBox,
  Vector3
} from '@openzcad/shared';
import {
  sectionClippingPlane,
  type SectionViewSettings
} from '@openzcad/viewport';

const AXES = ['x', 'y', 'z'] as const;
// Float32 mesh and clipping arithmetic, as in the extrude's section check: a
// face lying in the cut plane itself is drawn, so it never counts as hidden.
const FLOAT32_CLIP_SLACK = 16 * 2 ** -23;

/** The note the command bar shows while a section cut hides the offset. */
export const FACE_OFFSET_SECTION_NOTE = 'Section view hides part of this face';

/**
 * The axis-aligned box of one face's triangles in a body's display mesh, or
 * null when the body has no such face or its mesh does not cover it.
 */
export function faceMeshBounds(
  body: Pick<BodyRepresentation, 'mesh' | 'topology'>,
  topologyId: string
): BoundingBox | null {
  const face = body.topology?.faces.find(
    (candidate) => candidate.topologyId === topologyId
  );
  if (!face || face.triangleCount <= 0) return null;
  const { vertices, indices } = body.mesh;
  const start = face.triangleStart * 3;
  const end = (face.triangleStart + face.triangleCount) * 3;
  if (start < 0 || end > indices.length) return null;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let index = start; index < end; index++) {
    const vertex = indices[index]! * 3;
    if (vertex + 2 >= vertices.length) return null;
    const x = vertices[vertex]!;
    const y = vertices[vertex + 1]!;
    const z = vertices[vertex + 2]!;
    if (x < min.x) min.x = x;
    if (y < min.y) min.y = y;
    if (z < min.z) min.z = z;
    if (x > max.x) max.x = x;
    if (y > max.y) max.y = y;
    if (z > max.z) max.z = z;
  }
  return AXES.every(
    (axis) => Number.isFinite(min[axis]) && Number.isFinite(max[axis])
  )
    ? { min, max }
    : null;
}

/** One face an offset moves: where it is, and which way the offset moves it. */
export interface OffsetFaceExtent {
  topologyId: string;
  /** The face's display-mesh bounds (`faceMeshBounds`). */
  bounds: BoundingBox;
  /**
   * The face's own outward unit normal: an offset moves every face of a set
   * by the same signed distance along its own normal.
   */
  normal: Vector3;
}

/** The axis a canonical section plane cuts across. */
const CUT_AXIS = { XY: 'z', XZ: 'y', YZ: 'x' } as const;

/**
 * Whether the section view on screen hides part of a face being offset, or
 * part of where its preview puts it.
 *
 * Approximation, kept cheap on purpose: each face is its display-mesh
 * bounding box, and the previewed face is that box moved along the face's
 * own normal by the previewed offset (exact for the plane of a flat face;
 * the outline a preview grows or trims against its neighbours is not
 * followed). The change is taken as both boxes, so a face moved into or out
 * of the cut is reported either way. A box with any corner on the cut-away
 * side of the section plane counts as partly hidden; one touching the plane
 * does not.
 */
export function sectionHidesFaceOffset(
  input: {
    /** Every face the offset moves, each with its own normal. */
    faces: readonly OffsetFaceExtent[];
    /** Signed offset the preview on screen shows; null or 0 when none. */
    previewOffset: number | null;
    /**
     * The faces that frame moved, when it moved only some of them (a face
     * set's leading-plane frame); the others stay where they are. Absent:
     * every face moved.
     */
    movedTopologyIds?: readonly string[] | undefined;
  },
  section: SectionViewSettings
): boolean {
  if (!Number.isFinite(section.offset) || input.faces.length === 0) {
    return false;
  }
  const shift =
    input.previewOffset !== null && Number.isFinite(input.previewOffset)
      ? input.previewOffset
      : 0;
  const { normal: cut, constant } = sectionClippingPlane(section);
  const axis = CUT_AXIS[section.plane];
  const boxes: BoundingBox[] = [];
  const moved = input.movedTopologyIds ? new Set(input.movedTopologyIds) : null;
  for (const { topologyId, bounds, normal } of input.faces) {
    boxes.push(bounds);
    if (shift !== 0 && (!moved || moved.has(topologyId))) {
      if (![normal.x, normal.y, normal.z].every(Number.isFinite)) return false;
      boxes.push({
        min: {
          x: bounds.min.x + normal.x * shift,
          y: bounds.min.y + normal.y * shift,
          z: bounds.min.z + normal.z * shift
        },
        max: {
          x: bounds.max.x + normal.x * shift,
          y: bounds.max.y + normal.y * shift,
          z: bounds.max.z + normal.z * shift
        }
      });
    }
  }
  // The slack scales with the coordinate the cut is measured along only: a
  // face far from the origin across the plane keeps a fine tolerance along
  // the cut axis, where the mesh still resolves it.
  let scale = Math.max(1, Math.abs(section.offset));
  for (const box of boxes) {
    for (const each of AXES) {
      const low = box.min[each];
      const high = box.max[each];
      if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) {
        return false;
      }
    }
    scale = Math.max(scale, Math.abs(box.min[axis]), Math.abs(box.max[axis]));
  }
  const clearance = scale * FLOAT32_CLIP_SLACK;
  // Canonical sections have one nonzero normal component, so the box's
  // lowest signed distance is at one of its two opposite corners.
  return boxes.some(
    (box) =>
      Math.min(cut.dot(box.min), cut.dot(box.max)) + constant < -clearance
  );
}

/**
 * The faces an offset moves, as `sectionHidesFaceOffset` reads them: the
 * handle's face along the handle's normal, then each face of a set along
 * its own measured normal. A face whose mesh does not cover it is left out;
 * a set face with no plane normal keeps its place unshifted.
 */
export function offsetFaceExtents(
  body: Pick<BodyRepresentation, 'mesh' | 'topology'>,
  target: {
    topologyId: string;
    normal: readonly [number, number, number];
    offsetFaceSet?: readonly { topologyId: string }[] | undefined;
  }
): OffsetFaceExtent[] {
  const extents: OffsetFaceExtent[] = [];
  const handle = faceMeshBounds(body, target.topologyId);
  if (handle) {
    const [x, y, z] = target.normal;
    extents.push({
      topologyId: target.topologyId,
      bounds: handle,
      normal: { x, y, z }
    });
  }
  for (const member of target.offsetFaceSet ?? []) {
    const bounds = faceMeshBounds(body, member.topologyId);
    if (!bounds) continue;
    const measured = body.topology?.faces.find(
      (face) => face.topologyId === member.topologyId
    )?.geometry?.normal;
    const length = measured
      ? Math.hypot(measured.x, measured.y, measured.z)
      : 0;
    extents.push({
      topologyId: member.topologyId,
      bounds,
      normal:
        measured && Number.isFinite(length) && length > 0
          ? {
              x: measured.x / length,
              y: measured.y / length,
              z: measured.z / length
            }
          : { x: 0, y: 0, z: 0 }
    });
  }
  return extents;
}

/** A face displacement as drawn: its offset, and the faces it moved. */
export interface ShownFaceFrame {
  offset?: number | undefined;
  /** The faces it moved, when only some; absent: every face of the edit. */
  movedTopologyIds?: readonly string[] | undefined;
}

/**
 * What the viewer draws the edit at, read from the same state it draws
 * from: the exact frame when one is up, its leading-plane frame moving only
 * the faces it names; otherwise the viewer's own mesh proxy, which follows
 * the hand while no exact frame comes (a primitive face held still never
 * gets one); otherwise nothing has moved (none yet, or a frame taken down
 * after a refusal), as the offset handle reads it too.
 */
export function shownFaceOffset(
  frame: ShownFaceFrame | null,
  projected: ShownFaceFrame | null = null
): {
  previewOffset: number | null;
  movedTopologyIds?: readonly string[];
} {
  const drawn = [frame, projected].find(
    (candidate) =>
      candidate?.offset !== undefined && Number.isFinite(candidate.offset)
  );
  if (!drawn) return { previewOffset: null };
  return {
    previewOffset: drawn.offset!,
    ...(drawn.movedTopologyIds
      ? { movedTopologyIds: drawn.movedTopologyIds }
      : {})
  };
}

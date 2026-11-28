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

/**
 * Whether the section view on screen hides part of a face being offset, or
 * part of where its preview puts it.
 *
 * Approximation, kept cheap on purpose: each face is its display-mesh
 * bounding box, and the previewed face is that box moved along the face
 * normal by the previewed offset (exact for the plane of a flat face; the
 * outline a preview grows or trims against its neighbours is not followed).
 * The change is taken as both boxes, so a face moved into or out of the cut
 * is reported either way. A box with any corner on the cut-away side of the
 * section plane counts as partly hidden; one touching the plane does not.
 */
export function sectionHidesFaceOffset(
  input: {
    /** The bounds of every face the offset moves. */
    faces: readonly BoundingBox[];
    /** Outward unit normal of the offset; the previewed move runs along it. */
    normal: Vector3;
    /** Signed offset the preview on screen shows; null or 0 when none. */
    previewOffset: number | null;
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
  const boxes: BoundingBox[] = [];
  for (const face of input.faces) {
    boxes.push(face);
    if (shift !== 0) {
      boxes.push({
        min: {
          x: face.min.x + input.normal.x * shift,
          y: face.min.y + input.normal.y * shift,
          z: face.min.z + input.normal.z * shift
        },
        max: {
          x: face.max.x + input.normal.x * shift,
          y: face.max.y + input.normal.y * shift,
          z: face.max.z + input.normal.z * shift
        }
      });
    }
  }
  let scale = Math.max(1, Math.abs(section.offset));
  for (const box of boxes) {
    for (const axis of AXES) {
      const low = box.min[axis];
      const high = box.max[axis];
      if (!Number.isFinite(low) || !Number.isFinite(high) || low > high) {
        return false;
      }
      scale = Math.max(scale, Math.abs(low), Math.abs(high));
    }
  }
  const clearance = scale * FLOAT32_CLIP_SLACK;
  // Canonical sections have one nonzero normal component, so the box's
  // lowest signed distance is at one of its two opposite corners.
  return boxes.some(
    (box) =>
      Math.min(cut.dot(box.min), cut.dot(box.max)) + constant < -clearance
  );
}

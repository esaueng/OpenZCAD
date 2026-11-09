import * as THREE from 'three';
import { forEachMesh } from '@openzcad/viewport';

/**
 * How far, in radians, an opposing face's outward normal may lean from the
 * exact reverse of the dragged face's before it stops counting as the face
 * across from it. Tight on purpose: a span to a leaning face depends on where
 * the line crosses it, so it is not a dimension the offset can be typed in.
 */
export const OPPOSING_PLANE_ANGLE_TOLERANCE = 1e-3;

const MIN_DOT = Math.cos(OPPOSING_PLANE_ANGLE_TOLERANCE);

/** Exact surface classes that are curved everywhere: never a reference. */
const CURVED_SURFACES = new Set([
  'cylinder',
  'cylindrical',
  'cone',
  'conical',
  'sphere',
  'spherical',
  'torus',
  'toroidal'
]);

interface TopologyFace {
  topologyId?: string;
  triangleStart: number;
  triangleCount: number;
  geometry?: {
    surfaceType?: string;
    normal?: { x: number; y: number; z: number };
  };
}

interface Crossing {
  distance: number;
  /** Whether the line leaves the solid here (else it enters it). */
  leaves: boolean;
  /** The crossed face's outward world normal, when it is an opposing plane. */
  opposing: THREE.Vector3 | null;
  point: THREE.Vector3;
}

/**
 * The span "Total" reads on an in-place face push/pull: the distance from
 * the dragged planar face to the planar face across the material from it.
 *
 * A line runs from the picked point back through the part. The reference is
 * the first face it leaves the solid by whose outward normal is the dragged
 * face's reversed (within {@link OPPOSING_PLANE_ANGLE_TOLERANCE}) and which is
 * planar — proved by the face's exact surface type where the body carries
 * topology, else by every triangle of it lying flat. A hole wall, fillet,
 * chamfer or any other curved or leaning face the line leaves by is not the
 * reference: the line carries on through the void behind it and, where it
 * meets material again, on to the next face. So a pick straight in front of a
 * through hole reads the same width as one beside it, while a pick on a thin
 * tab still reads the tab, not the block under it.
 *
 * The span is measured plane to plane — the perpendicular distance from the
 * plane the gesture started on to the opposing plane — not along the line.
 *
 * `lift` is how far a preview has moved the face in front of the plane the
 * gesture started on (`faceLift`); the line starts on the face as rendered.
 *
 * Null when no such face exists behind the pick — the line does not start in
 * material, or leaves it only by curved or leaning faces — and Total is then
 * not offered: a span to a curved face changes with the pick and cannot be
 * typed against.
 */
export function opposingPlaneSpan(
  object: THREE.Object3D,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  lift = 0
): number | null {
  const forward = direction.clone().normalize();
  const back = forward.clone().negate();
  const start = origin.clone().addScaledVector(forward, lift);
  const ray = new THREE.Ray(start, back);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const hit = new THREE.Vector3();
  const facing = new THREE.Vector3();
  const edge = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  object.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(object);
  // The armed face's own triangles lie on the line's start; skip them.
  const tolerance = Math.max(1e-9, bounds.getSize(edge).length() * 1e-7);
  const crossings: Crossing[] = [];
  // Body meshes only: a section cap or a selection overlay is not material.
  forEachMesh(object, (mesh) => {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position') as
      THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    if (!position) {
      return;
    }
    const normals = geometry.getAttribute('normal') as
      THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    const index = geometry.getIndex();
    const count = index ? index.count : position.count;
    const faces = (mesh.userData as { topology?: { faces?: TopologyFace[] } })
      .topology?.faces;
    normalMatrix.getNormalMatrix(mesh.matrixWorld);
    const corner = (triangle: number, which: number) => {
      const at = triangle * 3 + which;
      return index ? index.getX(at) : at;
    };
    const worldTriangle = (triangle: number) => {
      a.fromBufferAttribute(position, corner(triangle, 0)).applyMatrix4(
        mesh.matrixWorld
      );
      b.fromBufferAttribute(position, corner(triangle, 1)).applyMatrix4(
        mesh.matrixWorld
      );
      c.fromBufferAttribute(position, corner(triangle, 2)).applyMatrix4(
        mesh.matrixWorld
      );
    };
    // Whether a face's triangles all lie flat and face back: the planarity
    // proof for a face whose exact surface class cannot answer it.
    const flatBehind = (first: number, last: number): THREE.Vector3 | null => {
      const sum = new THREE.Vector3();
      const own = new THREE.Vector3();
      for (let triangle = first; triangle < last; triangle += 1) {
        worldTriangle(triangle);
        own.subVectors(b, a).cross(edge.subVectors(c, a));
        const length = own.length();
        // Slivers carry no reliable direction; their neighbours decide.
        if (length <= tolerance * tolerance) continue;
        own.divideScalar(length);
        if (own.dot(back) < MIN_DOT) return null;
        sum.add(own);
      }
      return sum.lengthSq() > 0 ? sum.normalize() : null;
    };
    const verdicts = new Map<TopologyFace, THREE.Vector3 | null>();
    // The outward world normal of the face a triangle belongs to when that
    // face is a plane opposing the dragged one, else null.
    const opposingNormal = (
      triangle: number,
      leaves: boolean
    ): THREE.Vector3 | null => {
      if (!leaves) return null;
      const face = faces?.find(
        (candidate) =>
          triangle >= candidate.triangleStart &&
          triangle < candidate.triangleStart + candidate.triangleCount
      );
      if (!face) {
        // No topology for this triangle: only its own flat facet can answer.
        return flatBehind(triangle, triangle + 1);
      }
      if (verdicts.has(face)) return verdicts.get(face) ?? null;
      let verdict: THREE.Vector3 | null;
      const surface = face.geometry?.surfaceType?.toLowerCase();
      const exact = face.geometry?.normal;
      if (surface !== undefined && CURVED_SURFACES.has(surface)) {
        verdict = null;
      } else if (surface === 'plane' && exact) {
        const normal = new THREE.Vector3(exact.x, exact.y, exact.z)
          .applyMatrix3(normalMatrix)
          .normalize();
        verdict = normal.dot(back) >= MIN_DOT ? normal : null;
      } else {
        // A plane without an exact equation (NURBS-backed, imported) or a
        // free-form class: planar only if every facet of it is.
        verdict = flatBehind(
          face.triangleStart,
          face.triangleStart + face.triangleCount
        );
      }
      verdicts.set(face, verdict);
      return verdict;
    };
    for (let triangle = 0; triangle * 3 + 2 < count; triangle += 1) {
      worldTriangle(triangle);
      if (!ray.intersectTriangle(a, b, c, false, hit)) {
        continue;
      }
      const distance = hit.distanceTo(start);
      if (distance <= tolerance) {
        continue;
      }
      // Shading normals face out even where a double-sided material hides
      // the winding; without them, wind.
      if (normals) {
        facing
          .fromBufferAttribute(normals, corner(triangle, 0))
          .add(edge.fromBufferAttribute(normals, corner(triangle, 1)))
          .add(edge.fromBufferAttribute(normals, corner(triangle, 2)))
          .applyMatrix3(normalMatrix);
      } else {
        facing.subVectors(b, a).cross(edge.subVectors(c, a));
      }
      const leaves = facing.dot(back) > 0;
      const point = hit.clone();
      crossings.push({
        distance,
        leaves,
        opposing: opposingNormal(triangle, leaves),
        point
      });
    }
  });
  crossings.sort((left, right) => left.distance - right.distance);
  // Walk the line through the part. Crossings level with each other (an
  // edge or vertex shared by several triangles, or two solids touching) are
  // one event: the line leaves there if any of them leaves, and the
  // reference is any opposing plane among them.
  let inside = true;
  for (let first = 0; first < crossings.length;) {
    let last = first;
    while (
      last + 1 < crossings.length &&
      crossings[last + 1]!.distance - crossings[first]!.distance <= tolerance
    ) {
      last += 1;
    }
    const group = crossings.slice(first, last + 1);
    const leaves = group.some((crossing) => crossing.leaves);
    const enters = group.some((crossing) => !crossing.leaves);
    if (inside && leaves) {
      const reference = group.find((crossing) => crossing.opposing !== null);
      if (reference) {
        // Plane to plane: the starting plane through `origin` to the
        // opposing plane through the crossing, along that plane's normal.
        const span = reference.opposing!.dot(
          edge.subVectors(reference.point, origin)
        );
        return span > tolerance ? span : null;
      }
      // A curved or leaning exit, or one level with an entry (a seam
      // between touching solids, or a tangent graze): carry on.
      inside = enters;
    } else if (!inside && enters) {
      inside = true;
    } else if (inside && !leaves) {
      // The line enters material it was supposedly already in: it did not
      // start inside the solid.
      if (first === 0) return null;
    }
    first = last + 1;
  }
  return null;
}

/**
 * {@link opposingPlaneSpan} from the pick, falling back to the dragged face's
 * own footprint: where the line from the pick leaves only by a curved face (a
 * pick beside a rounded back edge), the line from the face's area centroid
 * may still reach the opposing plane, and the plane-to-plane span it reads is
 * the same one. The centroid is moved onto the pick's plane first, and a
 * centroid off the face (a ring's, in its hole) starts outside the material
 * and answers null on its own.
 */
export function faceTotalSpan(
  object: THREE.Object3D,
  topologyId: string,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  lift = 0
): number | null {
  const fromPick = opposingPlaneSpan(object, origin, direction, lift);
  if (fromPick !== null) return fromPick;
  const footprint = faceCentroid(object, topologyId);
  if (!footprint) return null;
  const forward = direction.clone().normalize();
  footprint.addScaledVector(
    forward,
    -forward.dot(new THREE.Vector3().subVectors(footprint, origin))
  );
  return opposingPlaneSpan(object, footprint, direction, lift);
}

/** The world area centroid of a planar face in the body's topology table. */
function faceCentroid(
  object: THREE.Object3D,
  topologyId: string
): THREE.Vector3 | null {
  let found: THREE.Vector3 | null = null;
  object.updateWorldMatrix(true, true);
  forEachMesh(object, (mesh) => {
    if (found) return;
    const face = (
      mesh.userData as {
        topology?: {
          faces?: (TopologyFace & {
            geometry?: { centroid?: { x: number; y: number; z: number } };
          })[];
        };
      }
    ).topology?.faces?.find((candidate) => candidate.topologyId === topologyId);
    const centroid = face?.geometry?.centroid;
    if (!centroid) return;
    found = new THREE.Vector3(centroid.x, centroid.y, centroid.z).applyMatrix4(
      mesh.matrixWorld
    );
  });
  return found;
}

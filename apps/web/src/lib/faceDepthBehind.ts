import * as THREE from 'three';

/** A point on the armed face, and the share of the face's area it stands for. */
export interface FaceSample {
  point: THREE.Vector3;
  weight: number;
}

const SAMPLE_BUDGET = 64;

/** Radical inverse in `base`: a low-discrepancy, deterministic sequence. */
function halton(index: number, base: number): number {
  let result = 0;
  let fraction = 1 / base;
  let rest = index;
  while (rest > 0) {
    result += fraction * (rest % base);
    rest = Math.floor(rest / base);
    fraction /= base;
  }
  return result;
}

/**
 * Points spread over a face of the body's display mesh by area, in world
 * space. Empty when the face is not in the mesh's topology table.
 */
export function faceSamples(
  object: THREE.Object3D,
  topologyId: string
): FaceSample[] {
  const holders: {
    mesh: THREE.Mesh<THREE.BufferGeometry>;
    triangleStart: number;
    triangleCount: number;
  }[] = [];
  object.traverse((child) => {
    if (holders.length > 0 || !(child instanceof THREE.Mesh)) {
      return;
    }
    const faces = (
      child.userData as {
        topology?: {
          faces: {
            topologyId: string;
            triangleStart: number;
            triangleCount: number;
          }[];
        };
      }
    ).topology?.faces;
    const face = faces?.find(
      (candidate) => candidate.topologyId === topologyId
    );
    if (face) {
      holders.push({
        mesh: child as THREE.Mesh<THREE.BufferGeometry>,
        triangleStart: face.triangleStart,
        triangleCount: face.triangleCount
      });
    }
  });
  const holder = holders[0];
  if (!holder) {
    return [];
  }
  const { mesh: found, triangleStart, triangleCount } = holder;
  const position = found.geometry.getAttribute('position');
  const index = found.geometry.getIndex();
  if (!position) {
    return [];
  }
  found.updateWorldMatrix(true, false);
  const corners: [THREE.Vector3, THREE.Vector3, THREE.Vector3][] = [];
  const areas: number[] = [];
  const edge = new THREE.Vector3();
  const other = new THREE.Vector3();
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const corner = (triangleStart + triangle) * 3;
    const vertex = (offset: number) =>
      new THREE.Vector3()
        .fromBufferAttribute(
          position,
          index ? index.getX(corner + offset) : corner + offset
        )
        .applyMatrix4(found.matrixWorld);
    const a = vertex(0);
    const b = vertex(1);
    const c = vertex(2);
    corners.push([a, b, c]);
    areas.push(
      edge.subVectors(b, a).cross(other.subVectors(c, a)).length() / 2
    );
  }
  const total = areas.reduce((sum, area) => sum + area, 0);
  if (!(total > 0)) {
    return [];
  }
  const samples: FaceSample[] = [];
  let drawn = 0;
  corners.forEach(([a, b, c], triangle) => {
    const area = areas[triangle]!;
    if (area <= 0) return;
    const count = Math.max(1, Math.round((SAMPLE_BUDGET * area) / total));
    for (let sample = 0; sample < count; sample += 1) {
      drawn += 1;
      // Uniform over the triangle: fold the unit square onto it.
      const r = Math.sqrt(halton(drawn, 2));
      const s = halton(drawn, 3);
      samples.push({
        point: new THREE.Vector3()
          .addScaledVector(a, 1 - r)
          .addScaledVector(b, r * (1 - s))
          .addScaledVector(c, r * s),
        weight: area / count
      });
    }
  });
  return samples;
}

/**
 * How deep the material runs behind a face: from each sample point back
 * along `-direction` to where that ray leaves the solid, and the depth most
 * of the face's area shares (the area-weighted median). This is the span an
 * offset arrow's "Total" reads — the thickness of the part the face belongs
 * to, not the whole body's reach behind the face's plane, which on a
 * multi-lobed part measured to an unrelated lobe. The median keeps a hole
 * under part of the face, or a rib meeting a strip of it, from deciding it.
 *
 * Depths count from the plane through `origin` (where the gesture started):
 * a rig re-armed after a preview landed samples the moved face.
 *
 * Null when most of the face has no material behind it (the normal faces
 * in, or the mesh has no surface there).
 */
export function faceDepthBehind(
  object: THREE.Object3D,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  samples: readonly FaceSample[]
): number | null {
  if (samples.length === 0) {
    return null;
  }
  const back = direction.clone().normalize().negate();
  // A plane basis across the rays, to skip triangles a ray cannot touch.
  const u = new THREE.Vector3()
    .crossVectors(
      back,
      Math.abs(back.x) < 0.9
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 1, 0)
    )
    .normalize();
  const v = new THREE.Vector3().crossVectors(back, u);
  // Per triangle: three world corners, the outward facing, a u/v box.
  const triangles: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const facing = new THREE.Vector3();
  const edge = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  object.updateWorldMatrix(true, true);
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }
    const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
    const position = mesh.geometry.getAttribute('position') as
      THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    if (!position) {
      return;
    }
    const normals = mesh.geometry.getAttribute('normal') as
      THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : position.count;
    normalMatrix.getNormalMatrix(mesh.matrixWorld);
    for (let corner = 0; corner + 2 < count; corner += 3) {
      const i = index ? index.getX(corner) : corner;
      const j = index ? index.getX(corner + 1) : corner + 1;
      const k = index ? index.getX(corner + 2) : corner + 2;
      a.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(position, j).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(position, k).applyMatrix4(mesh.matrixWorld);
      // Whether a ray leaves or enters the solid here. Shading normals are
      // what the viewer lights, so they face out even where a double-sided
      // material hides the winding; without them, wind.
      if (normals) {
        facing
          .fromBufferAttribute(normals, i)
          .add(edge.fromBufferAttribute(normals, j))
          .add(edge.fromBufferAttribute(normals, k))
          .applyMatrix3(normalMatrix);
      } else {
        facing.subVectors(b, a).cross(edge.subVectors(c, a));
      }
      const au = a.dot(u);
      const bu = b.dot(u);
      const cu = c.dot(u);
      const av = a.dot(v);
      const bv = b.dot(v);
      const cv = c.dot(v);
      triangles.push(
        a.x,
        a.y,
        a.z,
        b.x,
        b.y,
        b.z,
        c.x,
        c.y,
        c.z,
        facing.dot(back),
        Math.min(au, bu, cu),
        Math.max(au, bu, cu),
        Math.min(av, bv, cv),
        Math.max(av, bv, cv)
      );
    }
  });
  const bounds = new THREE.Box3().setFromObject(object);
  // The armed face's own triangles lie on the rays' starts; skip them.
  const tolerance = Math.max(1e-9, bounds.getSize(edge).length() * 1e-7);
  const ray = new THREE.Ray();
  const hit = new THREE.Vector3();
  const depths: { depth: number; weight: number }[] = [];
  let totalWeight = 0;
  for (const sample of samples) {
    totalWeight += sample.weight;
    ray.set(sample.point, back);
    const pu = sample.point.dot(u);
    const pv = sample.point.dot(v);
    let nearest = Number.POSITIVE_INFINITY;
    let leaves = false;
    for (let base = 0; base < triangles.length; base += 14) {
      if (
        pu < triangles[base + 10]! ||
        pu > triangles[base + 11]! ||
        pv < triangles[base + 12]! ||
        pv > triangles[base + 13]!
      ) {
        continue;
      }
      a.set(triangles[base]!, triangles[base + 1]!, triangles[base + 2]);
      b.set(triangles[base + 3]!, triangles[base + 4]!, triangles[base + 5]);
      c.set(triangles[base + 6]!, triangles[base + 7]!, triangles[base + 8]);
      if (!ray.intersectTriangle(a, b, c, false, hit)) {
        continue;
      }
      const distance = hit.distanceTo(sample.point);
      if (distance <= tolerance || distance >= nearest) {
        continue;
      }
      nearest = distance;
      leaves = triangles[base + 9]! > 0;
    }
    if (Number.isFinite(nearest) && leaves) {
      const lift = edge.subVectors(sample.point, origin).dot(back);
      depths.push({ depth: nearest + lift, weight: sample.weight });
    }
  }
  const inside = depths.reduce((sum, entry) => sum + entry.weight, 0);
  if (inside < totalWeight / 2) {
    return null;
  }
  depths.sort((left, right) => left.depth - right.depth);
  let running = 0;
  for (const entry of depths) {
    running += entry.weight;
    if (running >= inside / 2) {
      return entry.depth;
    }
  }
  return depths.at(-1)?.depth ?? null;
}

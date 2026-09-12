import * as THREE from 'three';
import type { ViewerMesh } from '../pick/meshes';

/** Raster-only section geometry, never a document face or a picking target. */
export const SECTION_CAP = 'viewport-section-cap';

/**
 * Intersect the disposable tessellation, weld its face seams, and triangulate
 * closed contours by nesting depth (outer material, hole, island, ...).
 * Open/branched contours are deliberately not filled: an incomplete display
 * mesh must not invent material. This tolerance only welds display vertices;
 * it never participates in kernel operations or exported geometry.
 */
export function sectionCapGeometry(
  geometry: THREE.BufferGeometry,
  plane: THREE.Plane
): THREE.BufferGeometry | null {
  const positions = geometry.getAttribute('position');
  if (!positions) return null;
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox!;
  const tolerance = Math.max(
    bounds.getSize(new THREE.Vector3()).length() * 1e-7,
    1e-7
  );
  const normal = plane.normal.clone().normalize();
  const u = new THREE.Vector3(
    Math.abs(normal.x) < 0.9 ? 1 : 0,
    Math.abs(normal.x) < 0.9 ? 0 : 1,
    0
  )
    .cross(normal)
    .normalize();
  const v = normal.clone().cross(u);
  const origin = plane.coplanarPoint(new THREE.Vector3());
  const points: THREE.Vector2[] = [];
  const neighbors: Set<number>[] = [];
  const buckets = new Map<string, number[]>();
  const weld = (point: THREE.Vector3) => {
    const relative = point.clone().sub(origin);
    const p = new THREE.Vector2(relative.dot(u), relative.dot(v));
    const x = Math.floor(p.x / tolerance);
    const y = Math.floor(p.y / tolerance);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const id of buckets.get(`${x + dx},${y + dy}`) ?? []) {
          if (points[id]!.distanceToSquared(p) <= tolerance * tolerance)
            return id;
        }
      }
    }
    const id = points.length;
    points.push(p);
    neighbors.push(new Set());
    const key = `${x},${y}`;
    buckets.set(key, [...(buckets.get(key) ?? []), id]);
    return id;
  };
  const index = geometry.index;
  const count = index?.count ?? positions.count;
  const vertices = [
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3()
  ];
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let i = 0; i < count; i += 3) {
    const distances = vertices.map((point, j) => {
      point.fromBufferAttribute(positions, index ? index.getX(i + j) : i + j);
      const distance = plane.distanceToPoint(point);
      minimum = Math.min(minimum, distance);
      maximum = Math.max(maximum, distance);
      return Math.abs(distance) <= tolerance ? 0 : distance;
    });
    const intersections: THREE.Vector3[] = [];
    for (let j = 0; j < 3; j++) {
      const k = (j + 1) % 3;
      const a = distances[j]!;
      const b = distances[k]!;
      // Half-open classification avoids double edges when the plane passes
      // through a tessellation vertex/edge. Coplanar triangles add no contour.
      if (a > 0 === b > 0) continue;
      intersections.push(vertices[j]!.clone().lerp(vertices[k]!, a / (a - b)));
    }
    if (intersections.length !== 2) continue;
    const a = weld(intersections[0]!);
    const b = weld(intersections[1]!);
    if (a === b) continue;
    neighbors[a]!.add(b);
    neighbors[b]!.add(a);
  }
  // At a tangent/extreme plane the existing face is already the boundary.
  if (minimum >= -tolerance || maximum <= tolerance) return null;

  const visited = new Set<number>();
  const loops: THREE.Vector2[][] = [];
  for (let start = 0; start < points.length; start++) {
    if (visited.has(start)) continue;
    const component: number[] = [];
    const pending = [start];
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      component.push(id);
      pending.push(...neighbors[id]!);
    }
    if (component.every((id) => neighbors[id]!.size === 0)) continue;
    if (
      component.length < 3 ||
      component.some((id) => neighbors[id]!.size !== 2)
    ) {
      return null;
    }
    const loop: THREE.Vector2[] = [];
    let previous = -1;
    let current = start;
    do {
      loop.push(points[current]!);
      const next = [...neighbors[current]!].find((id) => id !== previous)!;
      previous = current;
      current = next;
    } while (current !== start);
    if (Math.abs(THREE.ShapeUtils.area(loop)) > tolerance * tolerance)
      loops.push(loop);
  }
  const contains = (loop: THREE.Vector2[], point: THREE.Vector2) => {
    let inside = false;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[i]!;
      const b = loop[j]!;
      if (
        a.y > point.y !== b.y > point.y &&
        point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
      )
        inside = !inside;
    }
    return inside;
  };
  const areas = loops.map((loop) => Math.abs(THREE.ShapeUtils.area(loop)));
  const parents = loops.map((loop, i) => {
    let parent = -1;
    for (let j = 0; j < loops.length; j++) {
      if (
        areas[j]! > areas[i]! &&
        (parent < 0 || areas[j]! < areas[parent]!) &&
        contains(loops[j]!, loop[0]!)
      )
        parent = j;
    }
    return parent;
  });
  const depths = parents.map((parent) => {
    let depth = 0;
    while (parent >= 0) {
      depth++;
      parent = parents[parent]!;
    }
    return depth;
  });
  const output: number[] = [];
  loops.forEach((loop, i) => {
    if (depths[i]! % 2 !== 0) return;
    const holes = loops.filter((_, j) => parents[j] === i);
    const flat = [loop, ...holes].flat();
    for (const triangle of THREE.ShapeUtils.triangulateShape(loop, holes)) {
      for (const id of triangle) {
        const p = flat[id]!;
        const point = origin
          .clone()
          .addScaledVector(u, p.x)
          .addScaledVector(v, p.y);
        output.push(point.x, point.y, point.z);
      }
    }
  });
  if (!output.length) return null;
  const cap = new THREE.BufferGeometry();
  cap.setAttribute('position', new THREE.Float32BufferAttribute(output, 3));
  cap.computeVertexNormals();
  return cap;
}

interface CapState {
  geometry: THREE.BufferGeometry;
  position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  positionVersion: number;
  index: THREE.BufferAttribute | null;
  indexVersion: number;
  plane: THREE.Plane;
  cap: ViewerMesh | null;
}
const caps = new WeakMap<ViewerMesh, CapState>();

export function updateSectionCap(
  mesh: ViewerMesh,
  worldPlane: THREE.Plane | null
) {
  const previous = caps.get(mesh);
  const plane = worldPlane
    ?.clone()
    .applyMatrix4(mesh.matrixWorld.clone().invert());
  const position = mesh.geometry.getAttribute('position');
  const positionVersion =
    position instanceof THREE.InterleavedBufferAttribute
      ? position.data.version
      : position?.version;
  const index = mesh.geometry.index;
  const unchanged =
    previous &&
    plane &&
    previous.geometry === mesh.geometry &&
    previous.position === position &&
    previous.positionVersion === positionVersion &&
    previous.index === index &&
    previous.indexVersion === (index?.version ?? 0) &&
    previous.plane.equals(plane);
  if (!unchanged) {
    if (previous?.cap) {
      mesh.remove(previous.cap);
      previous.cap.geometry.dispose();
      previous.cap.material.dispose();
    }
    caps.delete(mesh);
    if (!plane || !position) return;
    const geometry = sectionCapGeometry(mesh.geometry, plane);
    const cap = geometry
      ? new THREE.Mesh(geometry, mesh.material.clone())
      : null;
    if (cap) {
      cap.name = SECTION_CAP;
      cap.userData.sectionCap = true;
      cap.raycast = () => undefined;
      cap.renderOrder = mesh.renderOrder;
      mesh.add(cap);
    }
    caps.set(mesh, {
      geometry: mesh.geometry,
      position,
      positionVersion,
      index,
      indexVersion: index?.version ?? 0,
      plane,
      cap
    });
  }
  const cap = caps.get(mesh)?.cap;
  if (cap) {
    cap.castShadow = mesh.castShadow;
    cap.material.copy(mesh.material);
    cap.material.clippingPlanes = null;
    cap.material.side = THREE.DoubleSide;
    // Hover animation updates emissive between section applications.
    cap.onBeforeRender = () => {
      cap.material.color.copy(mesh.material.color);
      cap.material.emissive.copy(mesh.material.emissive);
      cap.material.opacity = mesh.material.opacity;
    };
  }
}

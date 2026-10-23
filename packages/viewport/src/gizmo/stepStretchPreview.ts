import * as THREE from 'three';
import type { Vector3 } from '@openzcad/shared';
import type { CylinderProfilePreview } from './cylinderProfilePreview';

/** Cells per axis of the grid vertex keys are quantized on. */
export const STEP_PREVIEW_GRID = 1 << 17;

/**
 * An exact integer key for a position on a grid of `quantum` cells anchored
 * just below `origin`. Each axis gets 17 bits, so keys stay below 2^53.
 * Positions off the grid key to -1, which no moving vertex has.
 */
export function stepPreviewKey(
  x: number,
  y: number,
  z: number,
  origin: Vector3,
  quantum: number
): number {
  const i = Math.round((x - origin.x) / quantum) + 4;
  const j = Math.round((y - origin.y) / quantum) + 4;
  const k = Math.round((z - origin.z) / quantum) + 4;
  if (
    i < 0 ||
    j < 0 ||
    k < 0 ||
    i >= STEP_PREVIEW_GRID ||
    j >= STEP_PREVIEW_GRID ||
    k >= STEP_PREVIEW_GRID
  )
    return -1;
  return i + j * STEP_PREVIEW_GRID + k * STEP_PREVIEW_GRID * STEP_PREVIEW_GRID;
}

/** The key itself first, then the 26 cells around it. */
export function stepPreviewNeighbourKeys(key: number): number[] {
  if (key < 0) return [];
  const grid = STEP_PREVIEW_GRID;
  const i = key % grid,
    j = Math.floor(key / grid) % grid,
    k = Math.floor(key / (grid * grid));
  const keys = [key];
  for (let dk = -1; dk <= 1; dk++)
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj && !dk) continue;
        const a = i + di,
          b = j + dj,
          c = k + dk;
        if (a < 0 || b < 0 || c < 0 || a >= grid || b >= grid || c >= grid)
          continue;
        keys.push(a + b * grid + c * grid * grid);
      }
  return keys;
}

/**
 * A planar push/pull that translates one region of a body along `normal`:
 * every vertex whose grid key is in `movingKeys`. Faces that region touches
 * stretch because only their shared vertices move. Recognition lives with the
 * caller, which knows the topology.
 */
export interface StepPreviewProfile {
  /** Unit drag direction, the picked face's outward normal. */
  normal: Vector3;
  /** Grid anchor and cell size the keys were made with. */
  origin: Vector3;
  quantum: number;
  /** Grid keys of the moving vertices, in the body's local frame. */
  movingKeys: ReadonlySet<number>;
  /** Deepest push the preview can show before a stretched face folds. */
  span: number;
  /** Furthest pull, likewise; Infinity when nothing limits it. */
  reach: number;
  /**
   * Planar faces that stretch far enough to fold some of their triangles.
   * Their outline stays a valid polygon longer than their triangulation, so
   * past `push` or `pull` the viewport triangulates them afresh.
   */
  planarFaces?: readonly StepPreviewPlanarFace[];
}

export interface StepPreviewPlanarFace {
  /** The face's range in the body mesh's triangle order. */
  triangleStart: number;
  triangleCount: number;
  /** Outward normal of the face's plane. */
  normal: Vector3;
  /** Drag distances, each way, at which its first triangle folds. */
  push: number;
  pull: number;
}

type PositionAttribute =
  THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

/**
 * Moves only the region's vertices, in place, on the installed mesh and its
 * edge lines. Unlike the profile previews it keeps no copy of the vertices
 * that stay put, so it scales to imported bodies with large meshes.
 */
export function createStepStretchPreview(
  object: THREE.Object3D,
  profile: StepPreviewProfile
): CylinderProfilePreview | null {
  const { normal, movingKeys } = profile;
  if (!(profile.span > 0) || movingKeys.size === 0) return null;
  const moves = stepPreviewMatcher(profile);
  const attributes = new Set<PositionAttribute>();
  const geometries = new Set<THREE.BufferGeometry>();
  object.traverse((child) => {
    const geometry = (child as THREE.Mesh).geometry;
    if (!(geometry instanceof THREE.BufferGeometry)) return;
    geometries.add(geometry);
    // Fat lines' position describes their screen-space quad, not model points.
    const names = geometry.hasAttribute('instanceStart')
      ? ['instanceStart', 'instanceEnd']
      : ['position'];
    for (const name of names) {
      const attribute = geometry.getAttribute(name);
      if (attribute && attribute.itemSize === 3) attributes.add(attribute);
    }
  });
  const entries: {
    attribute: PositionAttribute;
    indices: Uint32Array;
    original: Float32Array;
  }[] = [];
  let moved = 0;
  for (const attribute of attributes) {
    const indices: number[] = [];
    for (let index = 0; index < attribute.count; index += 1) {
      if (
        moves(
          attribute.getX(index),
          attribute.getY(index),
          attribute.getZ(index)
        )
      )
        indices.push(index);
    }
    if (!indices.length) continue;
    const original = new Float32Array(indices.length * 3);
    indices.forEach((index, slot) => {
      original[slot * 3] = attribute.getX(index);
      original[slot * 3 + 1] = attribute.getY(index);
      original[slot * 3 + 2] = attribute.getZ(index);
    });
    entries.push({ attribute, indices: Uint32Array.from(indices), original });
    moved += indices.length;
  }
  if (moved === 0) return null;
  const planar = planarRetriangulations(object, profile.planarFaces ?? []);
  if (!planar) return null;
  function write(delta: number) {
    const dx = normal.x * delta,
      dy = normal.y * delta,
      dz = normal.z * delta;
    for (const { attribute, indices, original } of entries) {
      for (let slot = 0; slot < indices.length; slot += 1) {
        attribute.setXYZ(
          indices[slot]!,
          original[slot * 3]! + dx,
          original[slot * 3 + 1]! + dy,
          original[slot * 3 + 2]! + dz
        );
      }
      if (attribute instanceof THREE.InterleavedBufferAttribute) {
        attribute.data.needsUpdate = true;
      } else {
        attribute.needsUpdate = true;
      }
    }
    for (const geometry of geometries) {
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
    }
  }
  return {
    cachedBytes: moved * 16,
    apply(delta) {
      if (
        !Number.isFinite(delta) ||
        delta <= -profile.span + 1e-6 ||
        delta >= profile.reach - 1e-6
      )
        return false;
      write(delta);
      if (!planar.update(delta)) {
        write(0);
        planar.update(0);
        return false;
      }
      return true;
    },
    restore() {
      write(0);
      planar.update(0);
    }
  };
}

interface PlanarRetriangulation {
  start: number;
  original: Uint32Array;
  loops: number[][];
  face: StepPreviewPlanarFace;
  u: THREE.Vector3;
  v: THREE.Vector3;
  active: boolean;
}

/**
 * Prepares each folding planar face for triangulation from its outline: the
 * face's boundary loops, in render vertices of the body mesh's index. Returns
 * null when a face's range or outline cannot be read.
 */
function planarRetriangulations(
  object: THREE.Object3D,
  faces: readonly StepPreviewPlanarFace[]
): { update(delta: number): boolean } | null {
  if (!faces.length) return { update: () => true };
  const mesh = object as THREE.Mesh;
  const index = mesh.geometry?.index;
  const position = mesh.geometry?.getAttribute('position');
  if (!index || !position) return null;
  const entries: PlanarRetriangulation[] = [];
  for (const face of faces) {
    const start = face.triangleStart * 3;
    const end = start + face.triangleCount * 3;
    if (start < 0 || end > index.count) return null;
    const original = new Uint32Array(face.triangleCount * 3);
    for (let i = 0; i < original.length; i++)
      original[i] = index.getX(start + i);
    const loops = boundaryLoops(original);
    if (!loops) return null;
    const n = new THREE.Vector3(
      face.normal.x,
      face.normal.y,
      face.normal.z
    ).normalize();
    const u = new THREE.Vector3(1, 0, 0);
    if (Math.abs(n.x) > 0.9) u.set(0, 1, 0);
    u.addScaledVector(n, -u.dot(n)).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    entries.push({ start, original, loops, face, u, v, active: false });
  }
  const point = new THREE.Vector3();
  const flat = (vertex: number, entry: PlanarRetriangulation) => {
    point.fromBufferAttribute(position, vertex);
    return new THREE.Vector2(point.dot(entry.u), point.dot(entry.v));
  };
  return {
    update(delta) {
      let changed = false;
      for (const entry of entries) {
        const folds =
          delta > 0 ? delta >= entry.face.pull : -delta >= entry.face.push;
        if (!folds) {
          if (entry.active) {
            for (let i = 0; i < entry.original.length; i++)
              index.setX(entry.start + i, entry.original[i]!);
            entry.active = false;
            changed = true;
          }
          continue;
        }
        const rings = entry.loops.map((loop) =>
          loop.map((vertex) => flat(vertex, entry))
        );
        if (ringsCross(rings)) return false;
        let outer = 0;
        rings.forEach((ring, i) => {
          if (
            Math.abs(THREE.ShapeUtils.area(ring)) >
            Math.abs(THREE.ShapeUtils.area(rings[outer]!))
          )
            outer = i;
        });
        const order = [outer, ...rings.keys()].filter(
          (i, k) => k === 0 || i !== outer
        );
        const ids = order.flatMap((i) => entry.loops[i]!);
        const triangles = THREE.ShapeUtils.triangulateShape(
          rings[outer]!.slice(),
          order.slice(1).map((i) => rings[i]!.slice())
        );
        if (triangles.length * 3 > entry.original.length) return false;
        let slot = entry.start;
        for (const [a, b, c] of triangles) {
          const pa = flat(ids[a!]!, entry),
            pb = flat(ids[b!]!, entry),
            pc = flat(ids[c!]!, entry);
          // Keep the face's outward winding.
          const ccw =
            (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x) >= 0;
          index.setX(slot++, ids[a!]!);
          index.setX(slot++, ids[ccw ? b! : c!]!);
          index.setX(slot++, ids[ccw ? c! : b!]!);
        }
        // Spare slots of a face that had interior vertices draw nothing.
        const spare = ids[0]!;
        while (slot < entry.start + entry.original.length)
          index.setX(slot++, spare);
        entry.active = true;
        changed = true;
      }
      if (changed) index.needsUpdate = true;
      return true;
    }
  };
}

/** Closed boundary loops of a triangle set, from its unpaired directed edges. */
function boundaryLoops(triangles: Uint32Array): number[][] | null {
  const directed = new Set<string>();
  for (let t = 0; t < triangles.length; t += 3)
    for (let k = 0; k < 3; k++)
      directed.add(`${triangles[t + k]},${triangles[t + ((k + 1) % 3)]}`);
  const next = new Map<number, number>();
  for (const edge of directed) {
    const [a, b] = edge.split(',').map(Number) as [number, number];
    if (a === b || directed.has(`${b},${a}`)) continue;
    if (next.has(a)) return null;
    next.set(a, b);
  }
  const loops: number[][] = [];
  const visited = new Set<number>();
  for (const first of next.keys()) {
    if (visited.has(first)) continue;
    const loop: number[] = [];
    let vertex: number | undefined = first;
    while (vertex !== undefined && !visited.has(vertex)) {
      visited.add(vertex);
      loop.push(vertex);
      vertex = next.get(vertex);
    }
    if (vertex !== first || loop.length < 3) return null;
    loops.push(loop);
  }
  return loops.length ? loops : null;
}

/** Whether any two edges of the rings cross, which no triangulation can fix. */
function ringsCross(rings: THREE.Vector2[][]): boolean {
  const edges: [THREE.Vector2, THREE.Vector2][] = [];
  for (const ring of rings)
    ring.forEach((a, i) => edges.push([a, ring[(i + 1) % ring.length]!]));
  const orient = (a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2) =>
    Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  for (let i = 0; i < edges.length; i++) {
    const [a, b] = edges[i]!;
    for (let j = i + 1; j < edges.length; j++) {
      const [c, d] = edges[j]!;
      if (a === c || a === d || b === c || b === d) continue;
      if (
        orient(a, b, c) * orient(a, b, d) < 0 &&
        orient(c, d, a) * orient(c, d, b) < 0
      )
        return true;
    }
  }
  return false;
}

/**
 * Whether a position belongs to the profile's moving region. Recognition
 * welded shared vertices across a cell boundary, so a match in a neighbouring
 * cell is the same point.
 */
export function stepPreviewMatcher(
  profile: StepPreviewProfile
): (x: number, y: number, z: number) => boolean {
  const { origin, quantum, movingKeys } = profile;
  const bounds = movingBounds(profile);
  return (x, y, z) =>
    x >= bounds.min.x &&
    y >= bounds.min.y &&
    z >= bounds.min.z &&
    x <= bounds.max.x &&
    y <= bounds.max.y &&
    z <= bounds.max.z &&
    stepPreviewNeighbourKeys(stepPreviewKey(x, y, z, origin, quantum)).some(
      (cell) => movingKeys.has(cell)
    );
}

/** The moving cells' extent, padded by the welding reach. */
function movingBounds(profile: StepPreviewProfile) {
  const { origin, quantum, movingKeys } = profile;
  const grid = STEP_PREVIEW_GRID;
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const key of movingKeys) {
    const x = origin.x + ((key % grid) - 4) * quantum,
      y = origin.y + ((Math.floor(key / grid) % grid) - 4) * quantum,
      z = origin.z + (Math.floor(key / (grid * grid)) - 4) * quantum;
    if (x < min.x) min.x = x;
    if (y < min.y) min.y = y;
    if (z < min.z) min.z = z;
    if (x > max.x) max.x = x;
    if (y > max.y) max.y = y;
    if (z > max.z) max.z = z;
  }
  const pad = quantum * 3;
  return {
    min: { x: min.x - pad, y: min.y - pad, z: min.z - pad },
    max: { x: max.x + pad, y: max.y + pad, z: max.z + pad }
  };
}

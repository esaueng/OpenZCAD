import type { HandleVec3 } from './DragRig';
import type { SweepGhostParams } from './rigs';

/**
 * The swept-volume profile of one planar face of a display mesh: its
 * triangles as the cap, its boundary as the wall loops.
 *
 * The exact topology carries no boundary loops for a face, only its triangle
 * range, so the outline is recovered from the triangles themselves: an edge
 * used by exactly one triangle of the face is on its boundary, and the
 * boundary edges chain into closed loops. Vertices are welded by position
 * first, because a tessellation may repeat a corner for each triangle that
 * touches it, and a boundary is only a boundary once shared corners are one
 * vertex.
 *
 * Fails closed: null when the triangles do not close into loops (a broken or
 * non-manifold range), so the caller can fall back to a flat ghost rather
 * than draw a torn wall.
 */
export function faceSweepProfile(
  vertices: ArrayLike<number>,
  indices: ArrayLike<number>,
  triangleStart: number,
  triangleCount: number
): SweepGhostParams | null {
  if (triangleCount <= 0) {
    return null;
  }
  const welded = new Map<string, number>();
  const positions: number[] = [];
  const capIndices: number[] = [];
  const weld = (vertex: number): number => {
    const x = vertices[vertex * 3] ?? 0;
    const y = vertices[vertex * 3 + 1] ?? 0;
    const z = vertices[vertex * 3 + 2] ?? 0;
    const key = `${quantize(x)},${quantize(y)},${quantize(z)}`;
    const known = welded.get(key);
    if (known !== undefined) {
      return known;
    }
    const index = positions.length / 3;
    welded.set(key, index);
    positions.push(x, y, z);
    return index;
  };
  // Directed edges: a shared edge appears once in each direction on a
  // consistently wound mesh, so a direction with no opposite is boundary.
  const directed = new Map<string, { from: number; to: number }>();
  for (let t = triangleStart; t < triangleStart + triangleCount; t += 1) {
    const corners = [0, 1, 2].map((k) => weld(indices[t * 3 + k] ?? 0));
    if (new Set(corners).size < 3) {
      continue;
    }
    capIndices.push(...corners);
    for (let k = 0; k < 3; k += 1) {
      const from = corners[k]!;
      const to = corners[(k + 1) % 3]!;
      directed.set(`${from}>${to}`, { from, to });
    }
  }
  const next = new Map<number, number>();
  for (const { from, to } of directed.values()) {
    if (directed.has(`${to}>${from}`)) {
      continue;
    }
    // A corner where two holes touch has two outgoing boundary edges; the
    // loops there are ambiguous, and a guess would draw a wall through the
    // face.
    if (next.has(from)) {
      return null;
    }
    next.set(from, to);
  }
  if (next.size === 0) {
    return null;
  }
  const loops: HandleVec3[][] = [];
  const visited = new Set<number>();
  for (const start of next.keys()) {
    if (visited.has(start)) {
      continue;
    }
    const loop: HandleVec3[] = [];
    let cursor = start;
    do {
      if (visited.has(cursor)) {
        return null;
      }
      visited.add(cursor);
      loop.push({
        x: positions[cursor * 3]!,
        y: positions[cursor * 3 + 1]!,
        z: positions[cursor * 3 + 2]!
      });
      const following = next.get(cursor);
      if (following === undefined) {
        return null;
      }
      cursor = following;
    } while (cursor !== start);
    if (loop.length < 3) {
      return null;
    }
    loops.push(loop);
  }
  // Outer first: the loop that reaches furthest from the face's centre
  // bounds the others. Holes follow in any order.
  const centre = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < positions.length; i += 3) {
    centre.x += positions[i]!;
    centre.y += positions[i + 1]!;
    centre.z += positions[i + 2]!;
  }
  const count = positions.length / 3;
  centre.x /= count;
  centre.y /= count;
  centre.z /= count;
  const reach = (loop: HandleVec3[]) =>
    loop.reduce((best, point) => {
      const dx = point.x - centre.x;
      const dy = point.y - centre.y;
      const dz = point.z - centre.z;
      return Math.max(best, dx * dx + dy * dy + dz * dz);
    }, 0);
  loops.sort((left, right) => reach(right) - reach(left));
  return {
    cap: { positions: Float32Array.from(positions), indices: capIndices },
    loops
  };
}

function quantize(value: number): number {
  return Math.round(value * 1e6);
}

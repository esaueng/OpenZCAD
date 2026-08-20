/**
 * Mesh-level acceptance probes for the kernel parity harness.
 *
 * The edge-use probe is the cheapest watertightness oracle: quantize every
 * vertex, count how many triangles use each undirected edge, and require
 * every edge to be used exactly twice. Position-based welding means
 * duplicated vertices at coincident coordinates cannot mask a crack, and
 * degenerate (collapsed) triangles are skipped.
 */

export interface EdgeUseReport {
  /** Edges used by exactly one triangle (holes). Watertight ⇒ 0. */
  boundaryEdges: number;
  /** Edges used by three or more triangles (branching). Manifold ⇒ 0. */
  nonManifoldEdges: number;
  /** Non-degenerate triangles counted. */
  triangles: number;
}

const QUANTIZE = 1e-4;

function quantize(value: number): number {
  return Math.round(value / QUANTIZE);
}

/** Edge-use census of an indexed triangle mesh (flat vertex/index arrays). */
export function meshEdgeUse(vertices: ArrayLike<number>, indices: ArrayLike<number>): EdgeUseReport {
  const keyOf = (index: number): string => {
    const base = index * 3;
    return `${quantize(vertices[base] ?? 0)},${quantize(vertices[base + 1] ?? 0)},${quantize(vertices[base + 2] ?? 0)}`;
  };
  const uses = new Map<string, number>();
  let triangles = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = keyOf(indices[t]!);
    const b = keyOf(indices[t + 1]!);
    const c = keyOf(indices[t + 2]!);
    if (a === b || b === c || a === c) {
      continue;
    }
    triangles += 1;
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a]
    ] as const) {
      const key = p < q ? `${p}|${q}` : `${q}|${p}`;
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (const count of uses.values()) {
    if (count === 1) {
      boundaryEdges += 1;
    } else if (count > 2) {
      nonManifoldEdges += 1;
    }
  }
  return { boundaryEdges, nonManifoldEdges, triangles };
}

/** Parse an ASCII STL string into flat vertex/index arrays (no welding). */
export function parseAsciiStl(text: string): { vertices: number[]; indices: number[] } {
  const vertices: number[] = [];
  const indices: number[] = [];
  const pattern = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    vertices.push(Number(match[1]), Number(match[2]), Number(match[3]));
    indices.push(index);
    index += 1;
  }
  if (index % 3 !== 0) {
    throw new Error(`ASCII STL vertex count ${index} is not a multiple of 3`);
  }
  return { vertices, indices };
}

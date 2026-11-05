/**
 * How many closed loops a set of picked edges makes, or `null` when any of
 * them belongs to an open run.
 *
 * A boolean leaves the rim of a unioned cylinder as four quarter arcs. A
 * user who clicked that one circle read "4 edges" as a miscount, and "fewer
 * edges" advice as something they could not do: the circle is the smallest
 * thing they can pick. The readout names it by what was picked instead.
 *
 * Edges are joined at their polyline endpoints within `tolerance` (model
 * units). Each endpoint must meet exactly one other, so a loop with a spur,
 * or three edges at one corner, is not a loop.
 */
export function closedEdgeLoopCount(
  edges: readonly { points: readonly number[] }[],
  tolerance = 1e-5
): number | null {
  if (edges.length === 0) return null;
  const ends: [number, number, number][] = [];
  for (const edge of edges) {
    const p = edge.points;
    if (p.length < 6) return null;
    ends.push([p[0]!, p[1]!, p[2]!], [p.at(-3)!, p.at(-2)!, p.at(-1)!]);
  }
  // Endpoint i belongs to edge i >> 1; union the edges whose ends meet.
  const parent = edges.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!;
      index = parent[index]!;
    }
    return index;
  };
  const near = (a: number[], b: number[]) =>
    Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) <= tolerance;
  for (let i = 0; i < ends.length; i += 1) {
    let partners = 0;
    for (let j = 0; j < ends.length; j += 1) {
      if (i === j || !near(ends[i]!, ends[j]!)) continue;
      // An edge closing on itself pairs its own two ends.
      partners += 1;
      parent[find(i >> 1)] = find(j >> 1);
    }
    if (partners !== 1) return null;
  }
  return new Set(edges.map((_, index) => find(index))).size;
}

/**
 * The readout's name for a multi-edge pick: "Closed edge" for a rim stored
 * as several arcs, else the plain count.
 */
export function edgeSelectionName(
  edges: readonly { points: readonly number[] }[]
): {
  /** The readout's label. */
  label: string;
  /** Completes "the fillet on ___". */
  noun: string;
  /** Completes "Ask about ___". */
  context: string;
} {
  const loops = edges.length > 1 ? closedEdgeLoopCount(edges) : null;
  if (loops !== null && loops < edges.length) {
    return loops === 1
      ? {
          label: 'Closed edge',
          noun: 'the closed edge',
          context: 'the selected closed edge'
        }
      : {
          label: `${loops} closed edges`,
          noun: `${loops} closed edges`,
          context: `${loops} selected closed edges`
        };
  }
  const count = edges.length;
  return count === 1
    ? { label: '1 edge', noun: 'edge', context: '1 selected edge' }
    : {
        label: `${count} edges`,
        noun: `${count} edges`,
        context: `${count} selected edges`
      };
}

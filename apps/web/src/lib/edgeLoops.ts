import type { EdgeTopologyReferenceV5 } from '@openzcad/shared';

/**
 * An edge as loop-finding sees it: a polyline whose ends may meet other
 * edges, or an edge already known to close on itself (a stored witness of a
 * full circle carries its centre, not a point on the curve).
 */
export type LoopEdge =
  { readonly points: readonly number[] } | { readonly closed: true };

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
  picked: readonly LoopEdge[],
  tolerance = 1e-5
): number | null {
  if (picked.length === 0) return null;
  const edges = picked.filter(
    (edge): edge is { readonly points: readonly number[] } => 'points' in edge
  );
  // An edge known to close on itself is a loop of its own.
  const selfClosed = picked.length - edges.length;
  if (edges.length === 0) return selfClosed;
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
  return selfClosed + new Set(edges.map((_, index) => find(index))).size;
}

/** What every edge-selection name carries. */
export interface EdgeSelectionName {
  /** The readout's label. */
  label: string;
  /** Completes "the fillet on ___". */
  noun: string;
  /** Completes "Ask about ___". */
  context: string;
}

/**
 * "Closed edge" / "N closed edges" when several picked edges close into
 * fewer loops (a rim stored as several arcs), else `null`.
 */
export function closedLoopSelectionName(
  edges: readonly LoopEdge[]
): EdgeSelectionName | null {
  const loops = edges.length > 1 ? closedEdgeLoopCount(edges) : null;
  if (loops === null || loops >= edges.length) return null;
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

/**
 * The readout's name for a multi-edge pick: "Closed edge" for a rim stored
 * as several arcs, else the plain count.
 */
export function edgeSelectionName(
  edges: readonly LoopEdge[]
): EdgeSelectionName {
  const closed = closedLoopSelectionName(edges);
  if (closed) return closed;
  const count = edges.length;
  return count === 1
    ? { label: '1 edge', noun: 'edge', context: '1 selected edge' }
    : {
        label: `${count} edges`,
        noun: `${count} edges`,
        context: `${count} selected edges`
      };
}

/** ADR-011 witnesses store points as integers in a 1e-6 document-unit quantum. */
const WITNESS_QUANTUM = 1e-6;

/**
 * The edges a committed fillet or chamfer picked, as loop-finding reads them
 * from the witnesses its edge references stored. The edges themselves are
 * gone from the body once the blend replaced them, so the body's topology
 * cannot answer. One entry per distinct hash; `null` when any picked edge
 * has no usable witness (an older document, a hash-only pick), so the caller
 * falls back to the plain count.
 */
export function storedLoopEdges(
  edgeHashes: readonly number[] | undefined,
  edgeReferences: readonly EdgeTopologyReferenceV5[] | undefined
): LoopEdge[] | null {
  const hashes = [...new Set(edgeHashes ?? [])];
  if (hashes.length === 0 || edgeReferences === undefined) return null;
  const edges: LoopEdge[] = [];
  for (const hash of hashes) {
    // Documents are untrusted JSON, so the witness is checked, not assumed.
    const reference = edgeReferences.find(
      (candidate) =>
        (candidate as { currentHash?: unknown } | null)?.currentHash === hash
    );
    const witness = reference?.witness as
      { closed?: unknown; endpoints?: unknown } | undefined;
    if (witness?.closed === true) {
      edges.push({ closed: true });
      continue;
    }
    const points: number[] = [];
    if (witness?.closed === false && Array.isArray(witness.endpoints)) {
      for (const end of witness.endpoints as unknown[]) {
        if (!Array.isArray(end)) return null;
        for (const value of end as unknown[]) {
          if (typeof value !== 'number' || !Number.isFinite(value)) return null;
          points.push(value * WITNESS_QUANTUM);
        }
      }
    }
    if (points.length !== 6) return null;
    edges.push({ points });
  }
  return edges;
}

/**
 * "4 edges", "1 edge", or — for a rim stored as several arcs — "the closed
 * edge" / "2 closed edges", as the status line reports a committed blend.
 */
export function committedEdgesPhrase(
  edgeHashes: readonly number[],
  edgeReferences: readonly EdgeTopologyReferenceV5[] | undefined
): string {
  const edges = storedLoopEdges(edgeHashes, edgeReferences);
  const closed = edges ? closedLoopSelectionName(edges) : null;
  const count = edgeHashes.length;
  return closed?.noun ?? `${count} edge${count === 1 ? '' : 's'}`;
}

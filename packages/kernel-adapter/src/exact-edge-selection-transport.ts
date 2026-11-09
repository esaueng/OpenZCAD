/**
 * Carries a hash-only fillet or chamfer selection across an upstream
 * parameter edit.
 *
 * An edge pick that the lineage publisher could not name is stored as its
 * ADR-011 witness hash, and that hash is a fingerprint of the edge's
 * geometry: its endpoints, its length. Resizing a Box that a later Chamfer
 * breaks moves those edges, so the hash no longer matches anything and the
 * Chamfer refuses with "A selected edge no longer exists" — although every
 * selected edge is still there, on the same faces, only longer or shifted.
 * Every face drag that drives an upstream parameter (Resize Body, a cylinder
 * height, an extrude distance) hit this as soon as a later modifier held an
 * unnamed edge, and a merged coplanar boolean face, a blend trimmed by a
 * later blend or a repeated boundary is enough to leave one unnamed.
 *
 * What survives such an edit is the structure. Each successful resolution
 * labels the input solid's faces and edges with what a resize cannot change —
 * surface and curve types, a plane's outward normal, a cylinder's axis, a
 * straight edge's direction — refines those labels over face/edge incidence
 * a fixed number of rounds, and records the label of every selected edge
 * together with the multiset of all labels (the layout). A later rebuild
 * whose stored hash no longer resolves may take an edge only when the new
 * input has exactly the same layout and exactly one edge carries the
 * recorded label. The labels never read kernel traversal order (which a
 * resize can permute) or a position, so a face that appeared or vanished, a
 * turned edge or a symmetric twin leaves the selection unresolved, exactly
 * as before.
 *
 * The record is session state, filled by the build that runs before any edit
 * can be made, and it never overrides a hash that still resolves. The builder
 * reports each carried selection so the app can persist the new hashes, after
 * which the stored selection resolves directly again, including after a
 * reload.
 */
import type { EdgeWitnessV1 } from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';
import { edgeWitnessOf, faceWitnessOf } from './exact-witnesses';

/** The input solid's structure, independent of where anything sits. */
export interface EdgeTopologyLayout {
  signature: string;
  /** Final structural label per edge handle. */
  labels: Map<number, string>;
  /** How many edges carry each label. */
  counts: Map<string, number>;
}

/** Refinement rounds: enough to separate a part's sides by what they meet. */
const ROUNDS = 6;
/** Layouts per feature: a drag can pass through a different topology. */
const LAYOUTS_PER_FEATURE = 4;
const FEATURES = 512;
const records = new Map<string, Map<string, Map<number, string>>>();

export function edgeSelectionKey(projectId: string, featureId: string): string {
  return `${projectId}\u0000${featureId}`;
}

/** 53-bit string hash (cyrb53); labels are compared, never decoded. */
function digest(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function direction(
  vector: readonly number[],
  oriented: boolean
): string | null {
  const length = Math.hypot(...vector);
  if (!(length > 0) || vector.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const unit = vector.map((component) => component / length);
  // A line's endpoints and an axis carry no sense; make the leading
  // non-zero component positive. An outward normal keeps its own.
  const lead = unit.find((component) => Math.abs(component) > 1e-6) ?? 1;
  const sign = !oriented && lead < 0 ? -1 : 1;
  return unit
    .map((component) => {
      // Round before printing: -1e-17 would otherwise read "-0.000".
      const rounded = Math.round(sign * component * 1000) / 1000;
      return (rounded === 0 ? 0 : rounded).toFixed(3);
    })
    .join(',');
}

/**
 * What a resize cannot change about an edge: a straight edge's direction,
 * a closed curve's axis. Other curves are held by their type and neighbours.
 */
export function edgeHeading(witness: EdgeWitnessV1): string {
  if (witness.closed) {
    return `${witness.curveType}@${witness.axis ? direction(witness.axis, false) : '-'}`;
  }
  if (witness.curveType.toUpperCase() !== 'LINE') return witness.curveType;
  const [start, end] = witness.endpoints;
  return `LINE:${direction(
    [end[0] - start[0], end[1] - start[1], end[2] - start[2]],
    false
  )}`;
}

function faceLabel(kernel: RemusKernel, face: number): string {
  const witness = faceWitnessOf(kernel, face);
  if (witness.surfaceType === 'plane') {
    try {
      const normal = Array.from(kernel.getFaceNormal(face)).slice(0, 3);
      return `plane:${direction(normal, true)}`;
    } catch {
      return 'plane';
    }
  }
  if (witness.analytic.kind === 'cylinder') {
    return `cylinder:${direction(witness.analytic.axis, false)}`;
  }
  return witness.surfaceType;
}

export function edgeTopologyLayout(
  kernel: RemusKernel,
  solid: number
): EdgeTopologyLayout {
  const faces = Array.from(kernel.getSolidFaces(solid));
  const edges = Array.from(kernel.getSolidEdges(solid));
  const facesOfEdge = new Map<number, number[]>(edges.map((e) => [e, []]));
  const edgesOfFace = new Map<number, number[]>();
  for (const face of faces) {
    const bounding = [...new Set(kernel.getFaceEdges(face))];
    edgesOfFace.set(face, bounding);
    for (const edge of bounding) facesOfEdge.get(edge)?.push(face);
  }
  let faceLabels = new Map(
    faces.map((face) => [face, faceLabel(kernel, face)])
  );
  let edgeLabels = new Map(
    edges.map((edge) => [edge, edgeHeading(edgeWitnessOf(kernel, edge))])
  );
  for (let round = 0; round < ROUNDS; round += 1) {
    const nextFaces = new Map<number, string>();
    for (const face of faces) {
      const around = (edgesOfFace.get(face) ?? [])
        .map((edge) => edgeLabels.get(edge)!)
        .sort();
      nextFaces.set(
        face,
        digest(`${faceLabels.get(face)}|${around.join(',')}`)
      );
    }
    const nextEdges = new Map<number, string>();
    for (const edge of edges) {
      const around = (facesOfEdge.get(edge) ?? [])
        .map((face) => faceLabels.get(face)!)
        .sort();
      nextEdges.set(
        edge,
        digest(`${edgeLabels.get(edge)}|${around.join(',')}`)
      );
    }
    faceLabels = nextFaces;
    edgeLabels = nextEdges;
  }
  const counts = new Map<string, number>();
  for (const label of edgeLabels.values()) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return {
    signature: digest(
      `${[...faceLabels.values()].sort().join(',')}|${[...edgeLabels.values()]
        .sort()
        .join(',')}`
    ),
    labels: edgeLabels,
    counts
  };
}

/** Remember the structural label of each selected edge on this input. */
export function recordEdgeSelection(
  key: string,
  layout: EdgeTopologyLayout,
  resolved: readonly {
    storedHash: number;
    currentHash: number;
    handle: number;
  }[]
): void {
  const positions = new Map<number, string>();
  for (const { storedHash, currentHash, handle } of resolved) {
    const label = layout.labels.get(handle);
    // A label two edges share cannot name one of them later.
    if (label === undefined || layout.counts.get(label) !== 1) continue;
    positions.set(storedHash, label);
    positions.set(currentHash, label);
  }
  const byLayout = records.get(key) ?? new Map<string, Map<number, string>>();
  byLayout.delete(layout.signature);
  byLayout.set(layout.signature, positions);
  while (byLayout.size > LAYOUTS_PER_FEATURE) {
    byLayout.delete(byLayout.keys().next().value!);
  }
  records.delete(key);
  records.set(key, byLayout);
  while (records.size > FEATURES) {
    records.delete(records.keys().next().value!);
  }
}

/**
 * The edge a stored hash named on an earlier build of this same input
 * structure, or null when nothing proves exactly one.
 */
export function carriedEdge(
  key: string,
  layout: EdgeTopologyLayout,
  storedHash: number
): number | null {
  const label = records.get(key)?.get(layout.signature)?.get(storedHash);
  if (label === undefined || layout.counts.get(label) !== 1) return null;
  for (const [handle, candidate] of layout.labels) {
    if (candidate === label) return handle;
  }
  return null;
}

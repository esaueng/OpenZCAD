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
 *
 * What survives such an edit is the structure, read in a frame that the edit
 * did not move. Each successful resolution labels the input solid's faces and
 * edges by surface and curve type, a plane's outward normal, a cylinder's
 * axis and a straight edge's direction, refined over face/edge incidence a
 * fixed number of rounds. It records, for that input:
 *
 * - the label of every edge, keyed by the edge's own witness hash;
 * - the label of every selected edge, keyed by its stored hash;
 * - the offsets of the planes facing each direction.
 *
 * A later rebuild whose stored hash no longer resolves may take the edge with
 * the recorded label only when all of these hold:
 *
 * 1. The new input has exactly the same label layout, and exactly one edge
 *    carries the label. A symmetric twin fails closed.
 * 2. The frame is fixed. At least one edge that is not being carried still
 *    resolves by its own hash, and every edge that resolves by its own hash
 *    (selected or not) keeps its recorded label. A resize keeps the fixed
 *    side or a cylinder rim where it was; a rotation or mirror moves every
 *    such anchor, or turns it so that its neighbours read differently.
 * 3. The edit stretched along a single line. Planes moved only along one
 *    normal direction (both senses allowed). Turning a 30 × 18 part 90°
 *    about its own centre keeps a centred rim fixed, but it moves the x and
 *    y planes together, so it is refused.
 *
 * Labels are world-frame directions, so these checks are what keep a turned
 * or mirrored part from matching by its label multiset alone. Anything else —
 * no record for this input, a changed structure, a stored hash that resolves
 * to an edge whose label disagrees with the record — refuses exactly as
 * before.
 *
 * Records are adapter state, cleared with the adapter, and filled by the
 * build that runs before any edit can be made. A hash that still resolves is
 * never overridden. The builder reports each carried selection so the app can
 * persist the new hashes in the same revision as the edit, after which the
 * stored selection resolves directly again, including after a reload.
 */
import type { EdgeWitnessV1 } from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';
import { faceWitnessOf } from './exact-witnesses';

/** Refinement rounds: enough to separate a part's sides by what they meet. */
const ROUNDS = 6;
/** Layouts per feature: a drag can pass through a different topology. */
const LAYOUTS_PER_FEATURE = 4;
const FEATURES = 512;
/** Plane offsets compare at 1 µm; finer noise reads as a move and refuses. */
const OFFSET_QUANTUM = 1e-3;
/** Distinct tokens for offsets that could not be measured. */
let unmeasured = 0;

/** One edge of the input solid, measured once by the resolver. */
export interface LayoutEdge {
  handle: number;
  witness: EdgeWitnessV1;
  /** The edge's own ADR-011 witness hash. */
  hash: number;
}

/** The input solid's structure, independent of where anything sits. */
export interface EdgeTopologyLayout {
  signature: string;
  /** Final structural label per edge handle. */
  labels: Map<number, string>;
  /** How many edges carry each label. */
  counts: Map<string, number>;
  /** Oriented plane normal → sorted, quantised plane offsets. */
  planes: Map<string, string>;
}

interface SelectionRecord {
  /** Witness hash → label, for every edge whose hash is unique. */
  edgeLabels: Map<number, string>;
  /** Stored selection hash → label, for selected edges with unique labels. */
  selected: Map<number, string>;
  planes: Map<string, string>;
  /** Cheap identity of the input: its sorted edge witness hashes. */
  hashSet: string;
  /** The selection the record was made for. */
  selection: string;
}

/**
 * Per-adapter memory of hash-only selections, keyed by project and feature.
 * Bounded, and cleared when the adapter is disposed, so a fresh adapter (a
 * reload) starts with nothing to carry from.
 */
export class EdgeSelectionMemory {
  private readonly records = new Map<string, Map<string, SelectionRecord>>();
  /** Signature of the most recent record per key. */
  private readonly latest = new Map<string, string>();

  get size(): number {
    return this.records.size;
  }

  clear(): void {
    this.records.clear();
    this.latest.clear();
  }

  forget(key: string): void {
    this.records.delete(key);
    this.latest.delete(key);
  }

  lookup(key: string, signature: string): SelectionRecord | undefined {
    return this.records.get(key)?.get(signature);
  }

  latestRecord(key: string): SelectionRecord | undefined {
    const signature = this.latest.get(key);
    return signature === undefined
      ? undefined
      : this.records.get(key)?.get(signature);
  }

  store(key: string, signature: string, record: SelectionRecord): void {
    const byLayout = this.records.get(key) ?? new Map<string, SelectionRecord>();
    byLayout.delete(signature);
    byLayout.set(signature, record);
    while (byLayout.size > LAYOUTS_PER_FEATURE) {
      byLayout.delete(byLayout.keys().next().value!);
    }
    this.records.delete(key);
    this.records.set(key, byLayout);
    this.latest.set(key, signature);
    while (this.records.size > FEATURES) {
      const oldest = this.records.keys().next().value!;
      this.forget(oldest);
    }
  }
}

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

/**
 * A direction as text, rounded to 1e-3. An unoriented direction (a line, an
 * axis) takes the sign that makes its leading non-zero *rounded* component
 * positive, so near-axis noise can never pick a different sign than the one
 * printed, and a mirror twin always reads the same way on every build.
 */
export function direction(
  vector: readonly number[],
  oriented: boolean
): string | null {
  const length = Math.hypot(...vector);
  if (!(length > 0) || vector.some((value) => !Number.isFinite(value))) {
    return null;
  }
  const rounded = vector.map((component) => {
    const value = Math.round((component / length) * 1000) / 1000;
    return value === 0 ? 0 : value;
  });
  const lead = rounded.find((component) => component !== 0) ?? 1;
  const sign = !oriented && lead < 0 ? -1 : 1;
  return rounded
    .map((component) => {
      const value = sign * component;
      return (value === 0 ? 0 : value).toFixed(3);
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

interface FaceReading {
  label: string;
  /** Oriented normal and quantised offset, planes only. */
  plane?: { normal: string; offset: string };
}

function readFace(kernel: RemusKernel, face: number): FaceReading {
  const witness = faceWitnessOf(kernel, face);
  if (witness.surfaceType === 'plane') {
    try {
      const normal = Array.from(kernel.getFaceNormal(face)).slice(0, 3);
      const key = direction(normal, true);
      const centroid = witness.centroid;
      const offset =
        centroid && key !== null
          ? Math.round(
              (normal[0]! * centroid[0] +
                normal[1]! * centroid[1] +
                normal[2]! * centroid[2]) /
                Math.hypot(normal[0]!, normal[1]!, normal[2]!) /
                OFFSET_QUANTUM
            )
          : null;
      return {
        label: `plane:${key}`,
        ...(key !== null
          ? {
              plane: {
                normal: key,
                // An unmeasurable offset never compares equal to itself.
                offset:
                  offset === null
                    ? `?${(unmeasured += 1)}`
                    : String(offset || 0)
              }
            }
          : {})
      };
    } catch {
      return { label: 'plane' };
    }
  }
  if (witness.analytic.kind === 'cylinder') {
    return { label: `cylinder:${direction(witness.analytic.axis, false)}` };
  }
  return { label: witness.surfaceType };
}

/**
 * Labels the input solid. `edges` are the resolver's own measurements, so
 * no edge witness is read twice.
 */
export function edgeTopologyLayout(
  kernel: RemusKernel,
  solid: number,
  edges: readonly LayoutEdge[]
): EdgeTopologyLayout {
  const faces = Array.from(kernel.getSolidFaces(solid));
  const facesOfEdge = new Map<number, number[]>(
    edges.map((edge) => [edge.handle, []])
  );
  const edgesOfFace = new Map<number, number[]>();
  for (const face of faces) {
    const bounding = [...new Set(kernel.getFaceEdges(face))];
    edgesOfFace.set(face, bounding);
    for (const edge of bounding) facesOfEdge.get(edge)?.push(face);
  }
  const readings = new Map(faces.map((face) => [face, readFace(kernel, face)]));
  const planeOffsets = new Map<string, string[]>();
  for (const { plane } of readings.values()) {
    if (!plane) continue;
    const offsets = planeOffsets.get(plane.normal) ?? [];
    offsets.push(plane.offset);
    planeOffsets.set(plane.normal, offsets);
  }
  let faceLabels = new Map(
    faces.map((face) => [face, readings.get(face)!.label])
  );
  let edgeLabels = new Map(
    edges.map((edge) => [edge.handle, edgeHeading(edge.witness)])
  );
  for (let round = 0; round < ROUNDS; round += 1) {
    const nextFaces = new Map<number, string>();
    for (const face of faces) {
      const around = (edgesOfFace.get(face) ?? [])
        .map((edge) => edgeLabels.get(edge) ?? '?')
        .sort();
      nextFaces.set(
        face,
        digest(`${faceLabels.get(face)}|${around.join(',')}`)
      );
    }
    const nextEdges = new Map<number, string>();
    for (const { handle } of edges) {
      const around = (facesOfEdge.get(handle) ?? [])
        .map((face) => faceLabels.get(face)!)
        .sort();
      nextEdges.set(
        handle,
        digest(`${edgeLabels.get(handle)}|${around.join(',')}`)
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
    counts,
    planes: new Map(
      [...planeOffsets].map(([normal, offsets]) => [
        normal,
        offsets.sort().join(',')
      ])
    )
  };
}

function hashSetOf(edges: readonly LayoutEdge[]): string {
  return edges
    .map((edge) => edge.hash)
    .sort((left, right) => left - right)
    .join(',');
}

function selectionOf(requested: readonly number[]): string {
  return [...requested].sort((left, right) => left - right).join(',');
}

/** Witness hash → handle for every hash exactly one edge carries. */
function uniqueHashes(edges: readonly LayoutEdge[]): Map<number, number> {
  const seen = new Map<number, number | null>();
  for (const { hash, handle } of edges) {
    seen.set(hash, seen.has(hash) ? null : handle);
  }
  const unique = new Map<number, number>();
  for (const [hash, handle] of seen) {
    if (handle !== null) unique.set(hash, handle);
  }
  return unique;
}

/**
 * Remember a selection that resolved by its stored hashes alone.
 *
 * Skips the layout when the input is the one already recorded for this exact
 * selection (a drag downstream, a repeated sync), so a steady document pays
 * one sorted hash list per resolution and no refinement.
 *
 * A stored hash that resolves directly to an edge whose label disagrees with
 * the record for the same structure means the record cannot be trusted to
 * name that edge; the feature's records are dropped, so any later carry
 * fails closed until a consistent build records again.
 */
export function rememberEdgeSelection(
  memory: EdgeSelectionMemory,
  key: string,
  kernel: RemusKernel,
  solid: number,
  edges: readonly LayoutEdge[],
  selected: readonly { storedHash: number; handle: number }[],
  layout?: EdgeTopologyLayout
): void {
  const hashSet = hashSetOf(edges);
  const selection = selectionOf(selected.map((entry) => entry.storedHash));
  const latest = memory.latestRecord(key);
  if (
    !layout &&
    latest &&
    latest.hashSet === hashSet &&
    latest.selection === selection
  ) {
    return;
  }
  const current = layout ?? edgeTopologyLayout(kernel, solid, edges);
  const previous = memory.lookup(key, current.signature);
  if (previous) {
    for (const { storedHash, handle } of selected) {
      const recorded = previous.selected.get(storedHash);
      if (recorded !== undefined && recorded !== current.labels.get(handle)) {
        memory.forget(key);
        return;
      }
    }
  }
  const edgeLabels = new Map<number, string>();
  for (const [hash, handle] of uniqueHashes(edges)) {
    edgeLabels.set(hash, current.labels.get(handle)!);
  }
  const selectedLabels = new Map<number, string>();
  for (const { storedHash, handle } of selected) {
    const label = current.labels.get(handle);
    // A label two edges share cannot name one of them later.
    if (label === undefined || current.counts.get(label) !== 1) continue;
    selectedLabels.set(storedHash, label);
  }
  memory.store(key, current.signature, {
    edgeLabels,
    selected: selectedLabels,
    planes: current.planes,
    hashSet,
    selection
  });
}

/**
 * The edges stored hashes named on an earlier build of this same input
 * structure, or null when anything fails to prove each one in a fixed frame.
 *
 * `direct` holds the selected hashes that still resolve by themselves; each
 * must keep its recorded label. `missing` are the hashes to carry.
 */
export function carryEdgeSelection(
  memory: EdgeSelectionMemory,
  key: string,
  layout: EdgeTopologyLayout,
  edges: readonly LayoutEdge[],
  direct: readonly { storedHash: number; handle: number }[],
  missing: readonly number[]
): Map<number, number> | null {
  const record = memory.lookup(key, layout.signature);
  if (!record) return null;

  for (const { storedHash, handle } of direct) {
    const recorded = record.selected.get(storedHash);
    if (recorded !== undefined && recorded !== layout.labels.get(handle)) {
      return null;
    }
  }

  const carried = new Map<number, number>();
  for (const hash of missing) {
    const label = record.selected.get(hash);
    if (label === undefined || layout.counts.get(label) !== 1) return null;
    let target: number | null = null;
    for (const [handle, candidate] of layout.labels) {
      if (candidate === label) target = handle;
    }
    if (target === null) return null;
    carried.set(hash, target);
  }
  const targets = new Set(carried.values());

  // A fixed frame: an edge that kept its own hash keeps its label, and at
  // least one such edge is not one of the edges being carried.
  let anchors = 0;
  for (const [hash, handle] of uniqueHashes(edges)) {
    const recorded = record.edgeLabels.get(hash);
    if (recorded === undefined) continue;
    if (recorded !== layout.labels.get(handle)) return null;
    if (!targets.has(handle)) anchors += 1;
  }
  if (anchors === 0) return null;

  // A stretch along one line: the planes that moved all face one way or
  // its opposite.
  const moved = new Set<string>();
  for (const normal of new Set([...record.planes.keys(), ...layout.planes.keys()])) {
    if (record.planes.get(normal) === layout.planes.get(normal)) continue;
    const line = direction(normal.split(',').map(Number), false);
    if (line === null) return null;
    moved.add(line);
  }
  if (moved.size > 1) return null;

  return carried;
}

import type {
  BodyRepresentation,
  EdgeTopology,
  FaceTopology,
  TopologySelection,
  Vector3
} from '@openzcad/shared';
import { GEOMETRY_LINEAR_TOLERANCE } from '@openzcad/geometry';
import { formatNumber } from './model';
import { resolveEdge, resolveFace } from './topologyResolution';

/**
 * Human-readable names for picked topology. Raw fingerprints like
 * `face:2298710382` are stable identity for the kernel, not something a person
 * should have to read; every user-facing surface goes through here.
 */

const AXIS_TOLERANCE = 0.999;

function dominantAxis(
  normal: Vector3
): { axis: 'x' | 'y' | 'z'; sign: 1 | -1 } | null {
  const magnitude = Math.hypot(normal.x, normal.y, normal.z);
  if (magnitude < 1e-9) {
    return null;
  }
  const x = Math.abs(normal.x / magnitude);
  const y = Math.abs(normal.y / magnitude);
  const z = Math.abs(normal.z / magnitude);
  if (x >= AXIS_TOLERANCE) {
    return { axis: 'x', sign: normal.x >= 0 ? 1 : -1 };
  }
  if (y >= AXIS_TOLERANCE) {
    return { axis: 'y', sign: normal.y >= 0 ? 1 : -1 };
  }
  if (z >= AXIS_TOLERANCE) {
    return { axis: 'z', sign: normal.z >= 0 ? 1 : -1 };
  }
  return null;
}

/** Directional planar names assume the app's Z-up world. */
const PLANAR_DIRECTIONS: Record<string, string> = {
  'z:1': 'Top',
  'z:-1': 'Bottom',
  'x:1': 'Right',
  'x:-1': 'Left',
  'y:1': 'Back',
  'y:-1': 'Front'
};

/**
 * Both lookups go through the same fail-closed resolver the measurement tape
 * uses, so the two can never disagree about what a pick refers to.
 *
 * That mattered in practice: a sphere's two faces carry one ADR-011 hash, and
 * while the tape refused to measure either, the selection chip went on
 * confidently printing an area for "Face 1" — two answers to one pick, which
 * is exactly the divergence a single shared derivation exists to prevent.
 */
function findFace(
  body: BodyRepresentation | undefined,
  hash: number | undefined,
  topologyId: string | undefined
): { face: FaceTopology; index: number } | null {
  const found = resolveFace(body, { hash, topologyId });
  return found.ok ? { face: found.entry, index: found.index } : null;
}

function findEdge(
  body: BodyRepresentation | undefined,
  hash: number | undefined,
  topologyId: string | undefined
): { edge: EdgeTopology; index: number } | null {
  const found = resolveEdge(body, { hash, topologyId });
  return found.ok ? { edge: found.entry, index: found.index } : null;
}

/** Which way an axis-aligned planar face points, if it is one. */
function planarDirection(
  geometry: FaceTopology['geometry'] | undefined
): string | undefined {
  if (geometry?.surfaceType !== 'plane' || !geometry.normal) {
    return undefined;
  }
  const axis = dominantAxis(geometry.normal);
  return axis
    ? PLANAR_DIRECTIONS[`${axis.axis}:${axis.sign}`]
    : undefined;
}

/**
 * Names a picked face from its exact surface measurements: directional names
 * for axis-aligned planes, feature names for holes/cylinders, and a stable
 * ordinal as the last resort. Never leaks the raw fingerprint.
 */
export function faceLabel(
  body: BodyRepresentation | undefined,
  hash: number | undefined,
  topologyId?: string
): string {
  const match = findFace(body, hash, topologyId);
  if (!match) {
    return 'Face';
  }
  const { face, index } = match;
  const geometry = face.geometry;
  if (
    geometry?.featureType === 'blend' &&
    geometry.blendRadius !== undefined &&
    Number.isFinite(geometry.blendRadius) &&
    geometry.blendRadius > GEOMETRY_LINEAR_TOLERANCE
  ) {
    return `Blend face R${formatNumber(geometry.blendRadius)}`;
  }
  if (
    geometry?.featureType === 'through-hole' &&
    geometry.diameter !== undefined
  ) {
    return `Through hole Ø${formatNumber(geometry.diameter)}`;
  }
  if (geometry?.surfaceType === 'plane' && geometry.normal) {
    const direction = planarDirection(geometry);
    return direction ? `${direction} face` : 'Planar face';
  }
  if (geometry?.surfaceType === 'cylinder') {
    return geometry.diameter !== undefined
      ? `Cylindrical face Ø${formatNumber(geometry.diameter)}`
      : 'Cylindrical face';
  }
  return `Face ${index + 1}`;
}

/**
 * The faces an edge bounds, deduplicated.
 *
 * `adjacentFaceHashes` keeps multiplicity — a seam edge names its one face
 * twice — and on a sphere two patches share one hash, so this narrows to
 * distinct faces and gives up entirely if any of them fails to resolve.
 */
function adjacentFaces(
  body: BodyRepresentation | undefined,
  edge: EdgeTopology
): FaceTopology[] {
  const byHash = new Map<number, FaceTopology>();
  for (const faceHash of edge.adjacentFaceHashes ?? []) {
    const found = resolveFace(body, { hash: faceHash });
    if (!found.ok) {
      return [];
    }
    byHash.set(faceHash, found.entry);
  }
  return [...byHash.values()];
}

/**
 * Names a picked edge by what it is, falling back to its stable ordinal.
 *
 * An ordinal is identity, not a description: "Edge 25" and "Edge 28" tell the
 * user which edge only by elimination. The kernel already publishes the faces
 * an edge bounds and the circle it runs on, which is enough to say what most
 * edges actually are.
 */
export function edgeLabel(
  body: BodyRepresentation | undefined,
  hash: number | undefined,
  topologyId?: string
): string {
  const match = findEdge(body, hash, topologyId);
  if (!match) {
    return 'Edge';
  }
  const neighbours = adjacentFaces(body, match.edge);
  const radius = match.edge.curve?.circle?.radius;
  if (
    radius !== undefined &&
    Number.isFinite(radius) &&
    radius > GEOMETRY_LINEAR_TOLERANCE
  ) {
    // A rim reads in the notation of the feature it belongs to: a hole and a
    // cylinder are diameters, a blend is the radius that was filleted.
    if (neighbours.some((face) => face.geometry?.featureType === 'blend')) {
      return `Blend edge R${formatNumber(radius)}`;
    }
    const hole = neighbours.some(
      (face) => face.geometry?.featureType === 'through-hole'
    );
    return `${hole ? 'Hole' : 'Circular'} edge Ø${formatNumber(radius * 2)}`;
  }
  // Two axis-aligned planes meeting is the most specific thing a straight edge
  // is, and the only pairing that names itself well: "Cylindrical face Ø40"
  // does not belong in the middle of an edge's name.
  const directions = neighbours.flatMap(
    (face) => planarDirection(face.geometry) ?? []
  );
  if (directions.length === 2 && neighbours.length === 2) {
    return `${directions[0]} · ${directions[1]} edge`;
  }
  return `Edge ${match.index + 1}`;
}

/**
 * One complete pick name for the measurement tape, selection summaries, and
 * select-other list. Keeping the body prefix here prevents those surfaces
 * from growing subtly different naming vocabularies.
 */
export function topologySelectionLabel(
  body: BodyRepresentation | undefined,
  selection: Pick<TopologySelection, 'kind' | 'hash' | 'topologyId'>
): string {
  if (selection.kind === 'body') {
    return body?.name ?? 'Body';
  }
  const entity =
    selection.kind === 'edge'
      ? edgeLabel(body, selection.hash, selection.topologyId)
      : faceLabel(body, selection.hash, selection.topologyId);
  return body ? `${body.name} · ${entity}` : entity;
}

/**
 * `exact-kernel` rather than the old `kernel-integrated`: `kernel.edgeLength`
 * takes no deflection parameter, and is exact for LINE and for the CIRCLE a
 * fillet blend turns out to be — the only two curve types this build's
 * primitives, booleans and blends produce. Measured in
 * `test/measurement-provenance.test.ts`, which also declines to grade
 * BSPLINE_CURVE and ELLIPSE because it did not measure them.
 */
export type EdgeLengthQuality = 'exact-kernel' | 'sampled';

/**
 * Length of an edge in document units, with the provenance needed to present
 * it honestly. New projections publish the kernel measurement; sampled
 * display points remain a backwards-compatible approximate fallback.
 */
export function edgeLengthMeasurement(
  body: BodyRepresentation | undefined,
  hash: number | undefined,
  topologyId?: string
): { value: number; quality: EdgeLengthQuality } | null {
  const match = findEdge(body, hash, topologyId);
  if (!match) {
    return null;
  }
  if (match.edge.length !== undefined && Number.isFinite(match.edge.length)) {
    return { value: match.edge.length, quality: 'exact-kernel' };
  }
  const points = match.edge.points;
  let length = 0;
  for (let index = 3; index + 2 < points.length; index += 3) {
    length += Math.hypot(
      points[index]! - points[index - 3]!,
      points[index + 1]! - points[index - 2]!,
      points[index + 2]! - points[index - 1]!
    );
  }
  return { value: length, quality: 'sampled' };
}

/** Length-only compatibility helper for selection labels and older callers. */
export function edgeLength(
  body: BodyRepresentation | undefined,
  hash: number | undefined,
  topologyId?: string
): number | null {
  return edgeLengthMeasurement(body, hash, topologyId)?.value ?? null;
}

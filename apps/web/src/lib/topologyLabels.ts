import type {
  BodyRepresentation,
  EdgeTopology,
  FaceTopology,
  Vector3
} from '@openzcad/shared';
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
const PLANAR_NAMES: Record<string, string> = {
  'z:1': 'Top face',
  'z:-1': 'Bottom face',
  'x:1': 'Right face',
  'x:-1': 'Left face',
  'y:1': 'Back face',
  'y:-1': 'Front face'
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
    geometry?.featureType === 'through-hole' &&
    geometry.diameter !== undefined
  ) {
    return `Through hole Ø${formatNumber(geometry.diameter)}`;
  }
  if (geometry?.surfaceType === 'plane' && geometry.normal) {
    const axis = dominantAxis(geometry.normal);
    if (axis) {
      return PLANAR_NAMES[`${axis.axis}:${axis.sign}`] ?? 'Planar face';
    }
    return 'Planar face';
  }
  if (geometry?.surfaceType === 'cylinder') {
    return geometry.diameter !== undefined
      ? `Cylindrical face Ø${formatNumber(geometry.diameter)}`
      : 'Cylindrical face';
  }
  return `Face ${index + 1}`;
}

/** Names a picked edge by its stable ordinal inside the body. */
export function edgeLabel(
  body: BodyRepresentation | undefined,
  hash: number | undefined,
  topologyId?: string
): string {
  const match = findEdge(body, hash, topologyId);
  return match ? `Edge ${match.index + 1}` : 'Edge';
}

export type EdgeLengthQuality = 'kernel-integrated' | 'sampled';

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
    return { value: match.edge.length, quality: 'kernel-integrated' };
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

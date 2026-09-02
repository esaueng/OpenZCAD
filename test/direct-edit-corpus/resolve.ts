/**
 * Geometric re-identification of a fixture's pick on a fresh rebuild.
 *
 * Never by hash. A captured `faceHash` is the thing most likely to have
 * stopped resolving, so resolving with it would hide exactly the failure the
 * corpus exists to measure. Surface class, normal alignment, and nearest
 * recorded centre are the only inputs, and an ambiguous nearest pair fails
 * closed rather than picking a coin-flip winner.
 */

import type {
  BodyRepresentation,
  EdgeTopology,
  FaceTopology,
  Vector3
} from '@openzcad/shared';

import type {
  DirectEditFixtureEdge,
  DirectEditFixtureFace
} from '../../apps/web/src/lib/directEditFixture';

/** Two candidates whose distances differ by less than this are a tie. */
const AMBIGUITY_TOLERANCE = 1e-6;

/** |dot| of two unit normals must exceed this to count as the same axis. */
const NORMAL_ALIGNMENT = 1 - 1e-6;

function distance(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function formatPoint(point: Vector3): string {
  return `(${point.x}, ${point.y}, ${point.z})`;
}

/** Nearest candidate to `target`, refusing a tie. */
function nearest<T>(
  candidates: readonly T[],
  centerOf: (candidate: T) => Vector3,
  target: Vector3,
  subject: string
): T {
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      gap: distance(centerOf(candidate), target)
    }))
    .sort((left, right) => left.gap - right.gap);
  const best = ranked[0];
  if (!best) {
    throw new Error(
      `${subject}: no candidate remains for the recorded centre ${formatPoint(target)}.`
    );
  }
  const runnerUp = ranked[1];
  if (runnerUp && Math.abs(runnerUp.gap - best.gap) <= AMBIGUITY_TOLERANCE) {
    throw new Error(
      `${subject}: the recorded centre ${formatPoint(target)} is ambiguous — ` +
        `two candidates sit ${best.gap} away.`
    );
  }
  return best.candidate;
}

export function resolveFixtureFace(
  body: BodyRepresentation,
  face: DirectEditFixtureFace
): FaceTopology {
  const faces = body.topology?.faces ?? [];
  const bySurface = faces.filter(
    (candidate) => candidate.geometry?.surfaceType === face.surfaceType
  );
  if (bySurface.length === 0) {
    throw new Error(
      `Face pick: the rebuilt body "${body.name}" publishes no ${face.surfaceType} face ` +
        `(it has ${faces.length} faces).`
    );
  }
  const recordedNormal = face.normal;
  const aligned = recordedNormal
    ? bySurface.filter((candidate) => {
        const normal = candidate.geometry?.normal;
        return normal !== undefined
          ? Math.abs(dot(normal, recordedNormal)) > NORMAL_ALIGNMENT
          : false;
      })
    : bySurface;
  if (aligned.length === 0) {
    throw new Error(
      `Face pick: no ${face.surfaceType} face on "${body.name}" aligns with the recorded ` +
        `normal ${formatPoint(recordedNormal ?? { x: 0, y: 0, z: 0 })}.`
    );
  }
  return nearest(
    aligned,
    // Every survivor of the surface-type filter carries geometry.
    (candidate) => candidate.geometry?.center ?? { x: 0, y: 0, z: 0 },
    face.center,
    'Face pick'
  );
}

/** Mean of an edge's sampled display points, matching what the capture records. */
export function edgeCenter(edge: Pick<EdgeTopology, 'points'>): Vector3 {
  const points = edge.points;
  const count = Math.floor(points.length / 3);
  if (count === 0) {
    return { x: 0, y: 0, z: 0 };
  }
  let x = 0;
  let y = 0;
  let z = 0;
  for (let index = 0; index + 2 < points.length; index += 3) {
    x += points[index] ?? 0;
    y += points[index + 1] ?? 0;
    z += points[index + 2] ?? 0;
  }
  return { x: x / count, y: y / count, z: z / count };
}

export function resolveFixtureEdges(
  body: BodyRepresentation,
  edges: readonly DirectEditFixtureEdge[]
): EdgeTopology[] {
  // Seams close a periodic surface's parameterization; they are never pickable
  // in the viewport, so they are never what a capture recorded.
  const candidates = (body.topology?.edges ?? []).filter(
    (edge) => edge.displayRole !== 'seam'
  );
  if (candidates.length === 0) {
    throw new Error(
      `Edge pick: the rebuilt body "${body.name}" publishes no selectable edges.`
    );
  }
  return edges.map((edge) =>
    nearest(candidates, edgeCenter, edge.center, 'Edge pick')
  );
}

export function faceSelector(
  face: FaceTopology,
  hasReference?: boolean
): DirectEditFixtureFace {
  const geometry = face.geometry;
  if (!geometry) {
    throw new Error(
      'Cannot record a face pick: the face publishes no geometry.'
    );
  }
  return {
    surfaceType: geometry.surfaceType,
    center: geometry.center,
    ...(geometry.normal ? { normal: geometry.normal } : {}),
    area: geometry.area,
    hash: face.hash,
    hasReference: hasReference ?? face.reference !== undefined
  };
}

export function edgeSelector(edge: EdgeTopology): DirectEditFixtureEdge {
  return {
    center: edgeCenter(edge),
    ...(edge.length !== undefined ? { length: edge.length } : {}),
    hash: edge.hash,
    hasReference: edge.reference !== undefined
  };
}

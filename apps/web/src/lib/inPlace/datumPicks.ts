import {
  canonicalAxisDirection,
  edgeDatumAxis,
  newCanonicalPlaneRef
} from '@openzcad/geometry';
import type {
  FeatureId,
  PlaneId,
  ProjectDocument,
  TopologySelection,
  Vector3
} from '@openzcad/shared';
import { datumAxisEdgeFromPick, datumAxisFaceFromPick } from '../datumAxes';
import {
  datumFaceSourceFromPick,
  datumSourceKey,
  datumVertexFromEdgePick,
  datumVertexKey,
  edgeEnds,
  requireResolvedDatums
} from '../datumPlanes';
import { edgeClickIsEnd, type RefPick } from './datums';
import type { RevolveAxisCandidate } from './revolve';

/**
 * Viewport picks as the datum sources an in-place Plane or Axis takes
 * (U09). Lazy, with the datum libraries it reads: the workspace loads it
 * when one of those commands starts, so none of it rides the entry chunk.
 */

type Refused = { reason: string };

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** A ghost principal plane, as a plane source on its own normal. */
export function canonicalPlaneRef(plane: PlaneId, normal: Vector3): RefPick {
  const source = newCanonicalPlaneRef(plane, 0);
  return {
    kind: 'plane',
    key: datumSourceKey(source),
    source,
    origin: { x: 0, y: 0, z: 0 },
    normal
  };
}

/** A datum plane, by id; refused while it has not resolved. */
export function datumPlaneRef(
  document: ProjectDocument,
  featureId: FeatureId
): RefPick | Refused {
  const frame = document.derived.datumFrames?.[featureId];
  if (!frame) {
    return {
      reason: 'This plane has not resolved, so nothing can be built on it.'
    };
  }
  const source = { type: 'datum' as const, datumFeatureId: featureId };
  return {
    kind: 'plane',
    key: datumSourceKey(source),
    source,
    origin: { ...frame.origin },
    normal: { ...frame.normal }
  };
}

/** A flat face as a plane source, followed by its lineage. */
export function facePlaneRef(
  document: ProjectDocument,
  selection: TopologySelection
): RefPick | Refused {
  try {
    const source = datumFaceSourceFromPick(document, 'the datum', selection);
    const face = document.derived.bodyRepresentations[
      selection.bodyId
    ]?.topology?.faces.find((candidate) => candidate.hash === selection.hash);
    const normal = face?.geometry?.normal;
    if (!normal) return { reason: 'This face has no normal to build on.' };
    return {
      kind: 'plane',
      key: datumSourceKey(source),
      source,
      origin: { ...source.sourceCentroid },
      normal: { ...normal }
    };
  } catch (error) {
    return { reason: message(error, 'This face cannot be a plane source.') };
  }
}

/** A cylinder or cone, whose axis an Axis follows. */
export function revolutionRef(
  document: ProjectDocument,
  selection: TopologySelection
): RefPick | Refused {
  const source = datumAxisFaceFromPick(document, selection);
  if ('reason' in source) return source;
  return { kind: 'revolution', key: JSON.stringify(source), source };
}

/**
 * What a face click gives a command taking `kinds`: a flat face is a
 * plane, a cylinder or cone its axis.
 */
export function faceRef(
  document: ProjectDocument,
  selection: TopologySelection,
  kinds: readonly RefPick['kind'][]
): RefPick | Refused {
  const face = document.derived.bodyRepresentations[
    selection.bodyId
  ]?.topology?.faces.find((candidate) => candidate.hash === selection.hash);
  const type = face?.geometry?.surfaceType.toLowerCase();
  if ((type === 'cylinder' || type === 'cone') && kinds.includes('revolution'))
    return revolutionRef(document, selection);
  if (kinds.includes('plane')) return facePlaneRef(document, selection);
  return { reason: 'Pick a flat face.' };
}

/**
 * What an edge click gives a command taking `kinds`: the edge itself (a
 * straight edge clicked away from its ends, for an Axis), else the end
 * nearer the click as a point. `pointsPicked` points already chosen make
 * any edge click the next point.
 */
export function edgeRef(
  document: ProjectDocument,
  selection: TopologySelection,
  click: Vector3 | null,
  kinds: readonly RefPick['kind'][],
  pointsPicked: number
): RefPick | Refused {
  const edge = document.derived.bodyRepresentations[
    selection.bodyId
  ]?.topology?.edges.find((candidate) => candidate.hash === selection.hash);
  const witness = edge?.reference?.witness;
  const ends = witness ? edgeEnds(witness) : null;
  const straight = Boolean(
    witness && !witness.closed && /^line$/i.test(witness.curveType)
  );
  const asEnd =
    !kinds.includes('edge') ||
    pointsPicked > 0 ||
    (ends !== null && edgeClickIsEnd(ends, click, straight));
  if (!asEnd) {
    const source = datumAxisEdgeFromPick(document, selection);
    if ('reason' in source) return source;
    if (!ends) return { reason: 'This edge has no ends to run between.' };
    return { kind: 'edge', key: JSON.stringify(source), source, ends };
  }
  if (!kinds.includes('point')) return { reason: 'Pick a straight edge.' };
  const source = datumVertexFromEdgePick(document, selection, click);
  if ('reason' in source) return source;
  const at = edgeEnds(source.edgeReference.witness)?.[source.end];
  if (!at) return { reason: 'This edge has no end to pass through.' };
  return { kind: 'point', key: datumVertexKey(source), source, at };
}

/**
 * Throws unless the candidate resolved the new datum: a datum has no body
 * to prove it built, so its published frame or line is the proof.
 */
export function requireNewDatum(
  base: ProjectDocument,
  derived: ProjectDocument['derived'],
  featureId: FeatureId,
  name: string,
  kind: 'datum-plane' | 'datum-axis'
): void {
  requireResolvedDatums(base, derived, featureId, name, kind);
}

/**
 * A straight edge as an axis a turn or a ring takes (U09): the line its
 * datum axis would follow, from its end 0 toward its end 1, and the datum
 * definition Done adds for it.
 */
export function edgeAxisLine(
  document: ProjectDocument,
  selection: TopologySelection
): RevolveAxisCandidate | Refused {
  const source = datumAxisEdgeFromPick(document, selection);
  if ('reason' in source) return source;
  const ends = edgeEnds(source.edgeReference.witness);
  if (!ends) return { reason: 'This edge has no ends to run between.' };
  try {
    const line = edgeDatumAxis(ends[0], ends[1]);
    return {
      id: `edge:${selection.bodyId}:${selection.hash}`,
      label: 'The picked edge',
      origin: line.origin,
      direction: line.direction,
      choice: { define: { kind: 'edge', source } }
    };
  } catch (error) {
    return { reason: message(error, 'This edge cannot be an axis.') };
  }
}

/**
 * A cylinder's or cone's axis, in the canonical sense its datum axis takes:
 * through the middle of a cylinder's span, or a cone's apex.
 */
export function faceAxisLine(
  document: ProjectDocument,
  selection: TopologySelection
): RevolveAxisCandidate | Refused {
  const source = datumAxisFaceFromPick(document, selection);
  if ('reason' in source) return source;
  const geometry = document.derived.bodyRepresentations[
    selection.bodyId
  ]?.topology?.faces.find((face) => face.hash === selection.hash)?.geometry;
  const start = geometry?.axisStart;
  const end = geometry?.axisEnd;
  const origin =
    start && end
      ? {
          x: (start.x + end.x) / 2,
          y: (start.y + end.y) / 2,
          z: (start.z + end.z) / 2
        }
      : geometry?.apex;
  const along =
    start && end
      ? { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z }
      : geometry?.axis;
  if (!origin || !along) {
    return { reason: 'This face does not say where its axis runs.' };
  }
  try {
    return {
      id: `face:${selection.bodyId}:${selection.hash}`,
      label: 'The picked face’s axis',
      origin: { ...origin },
      direction: canonicalAxisDirection(along),
      choice: { define: { kind: 'cylinder', source } }
    };
  } catch (error) {
    return { reason: message(error, 'This face cannot give an axis.') };
  }
}

/** A flat face's outward normal, as a direction to repeat along. */
export function faceNormal(
  document: ProjectDocument,
  selection: TopologySelection
): Vector3 | Refused {
  const geometry = document.derived.bodyRepresentations[
    selection.bodyId
  ]?.topology?.faces.find((face) => face.hash === selection.hash)?.geometry;
  if (geometry?.surfaceType.toLowerCase() !== 'plane' || !geometry.normal) {
    return {
      reason: 'A direction is a straight edge, a flat face’s normal or an axis.'
    };
  }
  return { ...geometry.normal };
}

/**
 * A straight edge's direction, from its drawn polyline's first point to its
 * last: a linear pattern repeats along it. Unlike an axis it needs no
 * lineage (the vector is stored as numbers), only a line.
 */
export function edgeDirection(
  document: ProjectDocument,
  selection: TopologySelection
): Vector3 | Refused {
  const points =
    document.derived.bodyRepresentations[
      selection.bodyId
    ]?.topology?.edges.find((edge) => edge.hash === selection.hash)?.points ??
    [];
  const count = Math.floor(points.length / 3);
  if (count < 2) return { reason: 'This edge has no ends to run between.' };
  const at = (index: number) => ({
    x: points[index * 3]!,
    y: points[index * 3 + 1]!,
    z: points[index * 3 + 2]!
  });
  const start = at(0);
  const end = at(count - 1);
  const along = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
  const length = Math.hypot(along.x, along.y, along.z);
  if (!(length > 0)) return { reason: 'This edge has no length to run along.' };
  const unit = {
    x: along.x / length,
    y: along.y / length,
    z: along.z / length
  };
  // Every drawn point on the line through its ends, or it is curved.
  for (let index = 1; index < count - 1; index += 1) {
    const point = at(index);
    const offset = {
      x: point.x - start.x,
      y: point.y - start.y,
      z: point.z - start.z
    };
    const on = offset.x * unit.x + offset.y * unit.y + offset.z * unit.z;
    const off = Math.hypot(
      offset.x - unit.x * on,
      offset.y - unit.y * on,
      offset.z - unit.z * on
    );
    if (off > length * 1e-6) {
      return {
        reason: 'A direction runs along a straight edge; this edge is curved.'
      };
    }
  }
  return unit;
}

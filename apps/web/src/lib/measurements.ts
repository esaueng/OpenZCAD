import type {
  BodyRepresentation,
  EdgeTopology,
  FaceTopology,
  TopologyReferenceV5,
  TopologySelection,
  UnitSystem,
  Vector3
} from '@openzcad/shared';
import { edgeLabel, edgeLengthMeasurement, faceLabel } from './topologyLabels';
import {
  resolveEdge,
  resolveFace,
  type TopologyResolutionReason
} from './topologyResolution';

export type MeasurementMode = 'smart' | 'distance' | 'angle';

export type MeasurementKind =
  | 'edge-length'
  | 'edge-total'
  | 'diameter'
  | 'face-area'
  | 'body'
  | 'distance'
  | 'angle';

export type MeasurementQuality =
  'exact-analytic' | 'kernel-integrated' | 'sampled' | 'unavailable';

export type MeasurementStatus = 'current' | 'stale' | 'unresolved';
export type MeasurementDimension = 'length' | 'area' | 'volume' | 'angle';
export type RadialDisplay = 'diameter' | 'radius';

export interface MeasurementTarget {
  bodyId: BodyRepresentation['bodyId'];
  bodyName: string;
  kind: TopologySelection['kind'];
  topologyId?: string;
  hash?: number;
  reference?: TopologyReferenceV5;
  label: string;
  point?: Vector3;
  direction?: Vector3;
  semantic:
    'body-center' | 'face-center' | 'circle-center' | 'edge-midpoint' | 'pick';
  quality: MeasurementQuality;
}

export interface MeasurementQuantity {
  label: string;
  value: number;
  dimension: MeasurementDimension;
}

export interface MeasurementResult {
  value: number;
  dimension: MeasurementDimension;
  /** Distance deltas or body extents, in the source document's length unit. */
  components?: Vector3;
  secondary?: MeasurementQuantity;
}

export interface MeasurementSegment {
  start: Vector3;
  end: Vector3;
}

export interface MeasurementAnnotation {
  anchor: Vector3;
  segments: MeasurementSegment[];
}

export interface MeasurementViewportAnnotation extends MeasurementAnnotation {
  id: string;
  label: string;
  selected: boolean;
  status: MeasurementStatus;
}

/** Runtime-only measurement. It never enters the project document/history. */
export interface Measurement {
  id: string;
  kind: MeasurementKind;
  label: string;
  renamed?: boolean;
  note?: string;
  targets: MeasurementTarget[];
  result: MeasurementResult;
  quality: MeasurementQuality;
  status: MeasurementStatus;
  /**
   * Why the row stopped resolving, when it has. Kept beside `status` rather
   * than folded into it because "gone" and "now ambiguous" call for different
   * repairs, and only the second is fixed by re-picking.
   */
  reason?: TopologyResolutionReason;
  sourceRevision: number;
  sourceUnit: UnitSystem;
  visible: boolean;
  annotation?: MeasurementAnnotation;
}

export interface MeasurementDisplayOptions {
  unit: UnitSystem;
  precision: number;
  radialDisplay: RadialDisplay;
}

export interface FormattedMeasurement {
  value: string;
  detail?: string;
  quality: string;
}

/** Keep a long inspection pass bounded without tying it to document state. */
export const MEASUREMENT_LIMIT = 50;

const UNIT_TO_MM: Record<UnitSystem, number> = {
  mm: 1,
  cm: 10,
  m: 1000,
  inch: 25.4
};

const QUALITY_RANK: Record<MeasurementQuality, number> = {
  'exact-analytic': 0,
  'kernel-integrated': 1,
  sampled: 2,
  unavailable: 3
};

function vector(x: number, y: number, z: number): Vector3 {
  return { x, y, z };
}

function addScaled(
  origin: Vector3,
  direction: Vector3,
  scale: number
): Vector3 {
  return vector(
    origin.x + direction.x * scale,
    origin.y + direction.y * scale,
    origin.z + direction.z * scale
  );
}

function midpoint(first: Vector3, second: Vector3): Vector3 {
  return vector(
    (first.x + second.x) / 2,
    (first.y + second.y) / 2,
    (first.z + second.z) / 2
  );
}

function normalized(direction: Vector3): Vector3 | null {
  const magnitude = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(magnitude) || magnitude <= 1e-12) {
    return null;
  }
  return vector(
    direction.x / magnitude,
    direction.y / magnitude,
    direction.z / magnitude
  );
}

function distance(first: Vector3, second: Vector3): number {
  return Math.hypot(second.x - first.x, second.y - first.y, second.z - first.z);
}

function bodyCenter(body: BodyRepresentation): Vector3 {
  return midpoint(body.bbox.min, body.bbox.max);
}

function edgeEndpoints(edge: EdgeTopology): [Vector3, Vector3] | null {
  if (edge.points.length < 6) {
    return null;
  }
  const last = edge.points.length - 3;
  return [
    vector(edge.points[0]!, edge.points[1]!, edge.points[2]!),
    vector(edge.points[last]!, edge.points[last + 1]!, edge.points[last + 2]!)
  ];
}

/**
 * Both lookups fail closed through {@link resolveEdge}/{@link resolveFace}:
 * an identity carried by more than one sub-shape yields nothing rather than
 * the first candidate, so an ambiguous pick is refused instead of measured
 * against a guess. See ADR-011 and `topologyResolution.ts` for why the
 * previous `Array.prototype.find` was a live defect on a plain sphere.
 */
function findEdge(
  body: BodyRepresentation,
  selection: Pick<TopologySelection, 'topologyId' | 'hash' | 'reference'>
): EdgeTopology | undefined {
  const found = resolveEdge(body, selection);
  return found.ok ? found.entry : undefined;
}

function findFace(
  body: BodyRepresentation,
  selection: Pick<TopologySelection, 'topologyId' | 'hash' | 'reference'>
): FaceTopology | undefined {
  const found = resolveFace(body, selection);
  return found.ok ? found.entry : undefined;
}

/**
 * Why a target stopped resolving, for the row to explain and for a person to
 * repair by re-picking. `null` when it resolves.
 */
export function measurementTargetFailure(
  target: MeasurementTarget,
  bodies: readonly BodyRepresentation[]
): TopologyResolutionReason | null {
  const body = bodies.find((candidate) => candidate.bodyId === target.bodyId);
  if (!body) {
    return 'body-missing';
  }
  if (target.kind === 'body') {
    return null;
  }
  const identity = selectionForTarget(target);
  const found =
    target.kind === 'edge'
      ? resolveEdge(body, identity)
      : resolveFace(body, identity);
  return found.ok ? null : found.reason;
}

function targetKey(target: MeasurementTarget): string {
  const identity =
    target.reference?.lineageName ?? target.topologyId ?? target.hash ?? 'body';
  const point = target.point
    ? `:${target.point.x.toFixed(8)},${target.point.y.toFixed(8)},${target.point.z.toFixed(8)}`
    : '';
  return `${target.bodyId}/${target.kind}/${identity}/${target.semantic}${point}`;
}

function worstQuality(
  qualities: readonly MeasurementQuality[]
): MeasurementQuality {
  let worst: MeasurementQuality = 'exact-analytic';
  for (const quality of qualities) {
    if (QUALITY_RANK[quality] > QUALITY_RANK[worst]) {
      worst = quality;
    }
  }
  return worst;
}

function selectionForTarget(target: MeasurementTarget): TopologySelection {
  return {
    bodyId: target.bodyId,
    kind: target.kind,
    ...(target.topologyId ? { topologyId: target.topologyId } : {}),
    ...(target.hash !== undefined ? { hash: target.hash } : {}),
    ...(target.reference ? { reference: target.reference } : {})
  };
}

export function measurementTargetFromSelection(
  body: BodyRepresentation,
  selection: TopologySelection,
  point: Vector3 | undefined,
  purpose: MeasurementMode
): MeasurementTarget | null {
  const base = {
    bodyId: body.bodyId,
    bodyName: body.name,
    kind: selection.kind,
    topologyId: selection.topologyId,
    hash: selection.hash,
    reference: selection.reference
  };
  if (selection.kind === 'body') {
    return {
      ...base,
      label: body.name,
      point: bodyCenter(body),
      semantic: 'body-center',
      quality: 'kernel-integrated'
    };
  }
  if (selection.kind === 'edge') {
    const edge = findEdge(body, selection);
    if (!edge) {
      return null;
    }
    const label = `${body.name} · ${edgeLabel(body, edge.hash, edge.topologyId)}`;
    if (edge.curve?.circle) {
      return {
        ...base,
        topologyId: edge.topologyId,
        hash: edge.hash,
        reference: edge.reference,
        label: `${label} center`,
        point: edge.curve.circle.center,
        direction: edge.curve.circle.axis,
        semantic: 'circle-center',
        quality: 'exact-analytic'
      };
    }
    const endpoints = edgeEndpoints(edge);
    const lineDirection =
      edge.curve?.type.toUpperCase() === 'LINE' && endpoints
        ? normalized(
            vector(
              endpoints[1].x - endpoints[0].x,
              endpoints[1].y - endpoints[0].y,
              endpoints[1].z - endpoints[0].z
            )
          )
        : null;
    if (lineDirection) {
      return {
        ...base,
        topologyId: edge.topologyId,
        hash: edge.hash,
        reference: edge.reference,
        label: `${label} midpoint`,
        point: midpoint(endpoints![0], endpoints![1]),
        direction: lineDirection,
        semantic: 'edge-midpoint',
        quality: 'exact-analytic'
      };
    }
    return {
      ...base,
      topologyId: edge.topologyId,
      hash: edge.hash,
      reference: edge.reference,
      label,
      ...(point ? { point } : {}),
      semantic: 'pick',
      quality: 'sampled'
    };
  }
  const face = findFace(body, selection);
  if (!face) {
    return null;
  }
  const geometry = face.geometry;
  const label = `${body.name} · ${faceLabel(body, face.hash, face.topologyId)}`;
  if (
    geometry?.surfaceType === 'cylinder' &&
    geometry.axisStart &&
    geometry.axisEnd
  ) {
    return {
      ...base,
      topologyId: face.topologyId,
      hash: face.hash,
      reference: face.reference,
      label: `${label} center`,
      point: midpoint(geometry.axisStart, geometry.axisEnd),
      direction:
        normalized(
          vector(
            geometry.axisEnd.x - geometry.axisStart.x,
            geometry.axisEnd.y - geometry.axisStart.y,
            geometry.axisEnd.z - geometry.axisStart.z
          )
        ) ?? undefined,
      semantic: 'circle-center',
      quality: 'exact-analytic'
    };
  }
  if (purpose === 'angle' && geometry?.normal) {
    return {
      ...base,
      topologyId: face.topologyId,
      hash: face.hash,
      reference: face.reference,
      label,
      point: geometry.center,
      direction: geometry.normal,
      semantic: 'face-center',
      quality: 'exact-analytic'
    };
  }
  if (purpose === 'smart' && geometry?.center) {
    return {
      ...base,
      topologyId: face.topologyId,
      hash: face.hash,
      reference: face.reference,
      label,
      point: geometry.center,
      semantic: 'face-center',
      quality: 'kernel-integrated'
    };
  }
  return {
    ...base,
    topologyId: face.topologyId,
    hash: face.hash,
    reference: face.reference,
    label,
    ...(point ? { point } : {}),
    semantic: 'pick',
    quality: 'sampled'
  };
}

function annotationForEdge(
  edge: EdgeTopology
): MeasurementAnnotation | undefined {
  const endpoints = edgeEndpoints(edge);
  if (!endpoints) {
    return undefined;
  }
  return {
    anchor: midpoint(endpoints[0], endpoints[1]),
    segments: [{ start: endpoints[0], end: endpoints[1] }]
  };
}

export function createSmartMeasurement(
  body: BodyRepresentation,
  selection: TopologySelection,
  point: Vector3 | undefined,
  sourceRevision: number,
  sourceUnit: UnitSystem
): Measurement | null {
  const target = measurementTargetFromSelection(
    body,
    selection,
    point,
    'smart'
  );
  if (!target) {
    return null;
  }
  const common = {
    targets: [target],
    status: 'current' as const,
    sourceRevision,
    sourceUnit,
    visible: true
  };
  if (selection.kind === 'body') {
    const components = vector(
      body.bbox.max.x - body.bbox.min.x,
      body.bbox.max.y - body.bbox.min.y,
      body.bbox.max.z - body.bbox.min.z
    );
    return {
      ...common,
      id: `body:${body.bodyId}`,
      kind: 'body',
      label: body.name,
      result: { value: body.volume, dimension: 'volume', components },
      quality: 'kernel-integrated',
      annotation: { anchor: bodyCenter(body), segments: [] }
    };
  }
  if (selection.kind === 'edge') {
    const edge = findEdge(body, selection);
    const measured = edge
      ? edgeLengthMeasurement(body, edge.hash, edge.topologyId)
      : null;
    if (!edge || !measured || measured.value <= 0) {
      return null;
    }
    return {
      ...common,
      id: `edge:${targetKey(target)}`,
      kind: 'edge-length',
      label: target.label.replace(/ center$| midpoint$/, ''),
      result: { value: measured.value, dimension: 'length' },
      quality: measured.quality,
      annotation: annotationForEdge(edge)
    };
  }
  const face = findFace(body, selection);
  const geometry = face?.geometry;
  if (!face || !geometry) {
    return null;
  }
  if (geometry.surfaceType === 'cylinder' && geometry.diameter !== undefined) {
    return {
      ...common,
      id: `diameter:${targetKey(target)}`,
      kind: 'diameter',
      label:
        geometry.featureType === 'through-hole'
          ? `${body.name} · Through hole`
          : target.label.replace(/ center$/, ''),
      result: {
        value: geometry.diameter,
        dimension: 'length',
        secondary: {
          label: 'Area',
          value: geometry.area,
          dimension: 'area'
        }
      },
      quality: 'exact-analytic',
      annotation: target.point
        ? { anchor: target.point, segments: [] }
        : undefined
    };
  }
  if (!Number.isFinite(geometry.area) || geometry.area <= 0) {
    return null;
  }
  return {
    ...common,
    id: `area:${targetKey(target)}`,
    kind: 'face-area',
    label: target.label,
    result: { value: geometry.area, dimension: 'area' },
    quality: 'kernel-integrated',
    annotation: target.point
      ? { anchor: target.point, segments: [] }
      : undefined
  };
}

export function createEdgeTotalMeasurement(
  bodies: readonly BodyRepresentation[],
  selections: readonly TopologySelection[],
  sourceRevision: number,
  sourceUnit: UnitSystem
): Measurement | null {
  const targets: MeasurementTarget[] = [];
  const segments: MeasurementSegment[] = [];
  const qualities: MeasurementQuality[] = [];
  let total = 0;
  for (const selection of selections) {
    if (selection.kind !== 'edge') {
      continue;
    }
    const body = bodies.find(
      (candidate) => candidate.bodyId === selection.bodyId
    );
    if (!body) {
      return null;
    }
    const edge = findEdge(body, selection);
    const measured = edge
      ? edgeLengthMeasurement(body, edge.hash, edge.topologyId)
      : null;
    const target = measurementTargetFromSelection(
      body,
      selection,
      undefined,
      'smart'
    );
    if (!edge || !measured || !target) {
      return null;
    }
    targets.push(target);
    total += measured.value;
    qualities.push(measured.quality);
    const annotation = annotationForEdge(edge);
    if (annotation) {
      segments.push(...annotation.segments);
    }
  }
  if (targets.length < 2 || total <= 0) {
    return null;
  }
  const ids = targets.map(targetKey).sort().join('|');
  const firstSegment = segments[0];
  return {
    id: `edge-total:${ids}`,
    kind: 'edge-total',
    label: `${targets.length} edges`,
    targets,
    result: { value: total, dimension: 'length' },
    quality: worstQuality(qualities),
    status: 'current',
    sourceRevision,
    sourceUnit,
    visible: true,
    annotation: firstSegment
      ? {
          anchor: midpoint(firstSegment.start, firstSegment.end),
          segments
        }
      : undefined
  };
}

export function createDistanceMeasurement(
  first: MeasurementTarget,
  second: MeasurementTarget,
  sourceRevision: number,
  sourceUnit: UnitSystem
): Measurement | null {
  if (!first.point || !second.point) {
    return null;
  }
  const components = vector(
    second.point.x - first.point.x,
    second.point.y - first.point.y,
    second.point.z - first.point.z
  );
  return {
    id: `distance:${targetKey(first)}:${targetKey(second)}`,
    kind: 'distance',
    label: `${first.label} ↔ ${second.label}`,
    targets: [first, second],
    result: {
      value: Math.hypot(components.x, components.y, components.z),
      dimension: 'length',
      components
    },
    quality: worstQuality([first.quality, second.quality]),
    status: 'current',
    sourceRevision,
    sourceUnit,
    visible: true,
    annotation: {
      anchor: midpoint(first.point, second.point),
      segments: [{ start: first.point, end: second.point }]
    }
  };
}

export function createAngleMeasurement(
  first: MeasurementTarget,
  second: MeasurementTarget,
  sourceRevision: number,
  sourceUnit: UnitSystem
): Measurement | null {
  const firstDirection = first.direction ? normalized(first.direction) : null;
  const secondDirection = second.direction
    ? normalized(second.direction)
    : null;
  if (!firstDirection || !secondDirection || !first.point || !second.point) {
    return null;
  }
  const dot = Math.min(
    1,
    Math.max(
      0,
      Math.abs(
        firstDirection.x * secondDirection.x +
          firstDirection.y * secondDirection.y +
          firstDirection.z * secondDirection.z
      )
    )
  );
  const angleDeg = (Math.acos(dot) * 180) / Math.PI;
  const separation = distance(first.point, second.point);
  const armLength = separation > 1e-9 ? separation * 0.45 : 10;
  const origin = first.point;
  return {
    id: `angle:${targetKey(first)}:${targetKey(second)}`,
    kind: 'angle',
    label: `${first.label} ∠ ${second.label}`,
    targets: [first, second],
    result: { value: angleDeg, dimension: 'angle' },
    quality: worstQuality([first.quality, second.quality]),
    status: 'current',
    sourceRevision,
    sourceUnit,
    visible: true,
    annotation: {
      anchor: addScaled(origin, firstDirection, armLength * 0.6),
      segments: [
        { start: origin, end: addScaled(origin, firstDirection, armLength) },
        { start: origin, end: addScaled(origin, secondDirection, armLength) }
      ]
    }
  };
}

export function appendMeasurement(
  list: readonly Measurement[],
  next: Measurement
): Measurement[] {
  const at = list.findIndex((entry) => entry.id === next.id);
  if (at !== -1) {
    const existing = list[at]!;
    const scale = Math.max(
      Math.abs(existing.result.value),
      Math.abs(next.result.value),
      1
    );
    if (
      existing.label === next.label &&
      existing.note === next.note &&
      existing.kind === next.kind &&
      existing.quality === next.quality &&
      existing.status === next.status &&
      existing.visible === next.visible &&
      Math.abs(existing.result.value - next.result.value) <= scale * 1e-12
    ) {
      return list as Measurement[];
    }
    const replaced = [...list];
    replaced[at] = {
      ...next,
      label: existing.renamed ? existing.label : next.label,
      renamed: existing.renamed,
      note: existing.note,
      visible: existing.visible
    };
    return replaced;
  }
  const appended = [...list, next];
  return appended.length > MEASUREMENT_LIMIT
    ? appended.slice(appended.length - MEASUREMENT_LIMIT)
    : appended;
}

function resolvedTarget(
  target: MeasurementTarget,
  bodies: readonly BodyRepresentation[],
  purpose: MeasurementMode
): MeasurementTarget | null {
  const body = bodies.find((candidate) => candidate.bodyId === target.bodyId);
  if (!body) {
    return null;
  }
  if (target.kind === 'body') {
    return measurementTargetFromSelection(
      body,
      { bodyId: body.bodyId, kind: 'body' },
      undefined,
      purpose
    );
  }
  const selection = selectionForTarget(target);
  const found =
    target.kind === 'edge'
      ? resolveEdge(body, selection)
      : resolveFace(body, selection);
  if (!found.ok) {
    return null;
  }
  // A target anchored to a raw surface pick rather than to a derived centre
  // used to be discarded outright outside smart mode, which meant a distance
  // taken from anywhere on a face could never survive a rebuild. It can, but
  // only on the hash rung: an ADR-011 hash is a fingerprint of quantized
  // geometry, so its resolving is proof the surface is still where it was and
  // the stored point still lies on it. A lineage-only answer proves the same
  // FEATURE, not the same position — ADR-013 keeps lineage across rigid
  // transforms by design — so the point is dropped rather than carried onto
  // geometry that may have moved out from under it.
  const anchor =
    target.semantic === 'pick'
      ? found.via === 'hash'
        ? target.point
        : undefined
      : undefined;
  if (target.semantic === 'pick' && !anchor) {
    return null;
  }
  return measurementTargetFromSelection(body, selection, anchor, purpose);
}

function retainRowState(
  previous: Measurement,
  refreshed: Measurement
): Measurement {
  return {
    ...refreshed,
    id: previous.id,
    label: previous.renamed ? previous.label : refreshed.label,
    renamed: previous.renamed,
    note: previous.note,
    visible: previous.visible
  };
}

/**
 * The first reason any of a measurement's targets failed to resolve, or `null`
 * when all of them still do. Ordered by the targets themselves so the message
 * names the same target the row lists first.
 */
function firstTargetFailure(
  measurement: Measurement,
  bodies: readonly BodyRepresentation[]
): TopologyResolutionReason | null {
  for (const target of measurement.targets) {
    const failure = measurementTargetFailure(target, bodies);
    if (failure) {
      return failure;
    }
  }
  return null;
}

/** Re-resolve only by authoritative body/topology identity; never proximity. */
export function refreshMeasurements(
  list: readonly Measurement[],
  bodies: readonly BodyRepresentation[],
  sourceRevision: number
): Measurement[] {
  let changed = false;
  const refreshedList = list.map((measurement) => {
    if (measurement.sourceRevision === sourceRevision) {
      return measurement;
    }
    const purpose: MeasurementMode =
      measurement.kind === 'distance'
        ? 'distance'
        : measurement.kind === 'angle'
          ? 'angle'
          : 'smart';
    const targets = measurement.targets.map((target) =>
      resolvedTarget(target, bodies, purpose)
    );
    if (targets.some((target) => target === null)) {
      // The topology may still be there and merely unusable for this kind of
      // measurement (`stale`), or genuinely gone/ambiguous (`unresolved`).
      const failure = firstTargetFailure(measurement, bodies);
      const status: MeasurementStatus = failure ? 'unresolved' : 'stale';
      // `sourceRevision` advances even though no value was recomputed. Without
      // this the row never matches the short-circuit at the top of the loop, so
      // it re-evaluates on EVERY refresh — including the ones triggered by
      // merely hiding a body, which is how a once-stale row could go on to
      // demote itself against a body list it was never meant to be judged by.
      if (
        measurement.status === status &&
        measurement.reason === (failure ?? undefined) &&
        measurement.sourceRevision === sourceRevision
      ) {
        return measurement;
      }
      changed = true;
      return {
        ...measurement,
        status,
        sourceRevision,
        ...(failure ? { reason: failure } : {})
      };
    }
    const resolved = targets as MeasurementTarget[];
    let refreshed: Measurement | null = null;
    if (measurement.kind === 'distance') {
      refreshed = createDistanceMeasurement(
        resolved[0]!,
        resolved[1]!,
        sourceRevision,
        measurement.sourceUnit
      );
    } else if (measurement.kind === 'angle') {
      refreshed = createAngleMeasurement(
        resolved[0]!,
        resolved[1]!,
        sourceRevision,
        measurement.sourceUnit
      );
    } else if (measurement.kind === 'edge-total') {
      refreshed = createEdgeTotalMeasurement(
        bodies,
        resolved.map(selectionForTarget),
        sourceRevision,
        measurement.sourceUnit
      );
    } else {
      const target = resolved[0]!;
      const body = bodies.find(
        (candidate) => candidate.bodyId === target.bodyId
      );
      if (body) {
        refreshed = createSmartMeasurement(
          body,
          selectionForTarget(target),
          target.point,
          sourceRevision,
          measurement.sourceUnit
        );
      }
    }
    changed = true;
    if (refreshed) {
      // `refreshed` carries no `reason`, so a row that starts resolving again
      // sheds its explanation rather than keeping a stale one beside a fresh
      // number.
      return retainRowState(measurement, refreshed);
    }
    // Every target resolved, yet no measurement could be rebuilt from them —
    // the topology is present but no longer supports this kind of figure.
    return {
      ...measurement,
      status: 'unresolved' as const,
      sourceRevision,
      reason: firstTargetFailure(measurement, bodies) ?? 'not-found'
    };
  });
  return changed ? refreshedList : (list as Measurement[]);
}

function convertedValue(
  value: number,
  dimension: MeasurementDimension,
  from: UnitSystem,
  to: UnitSystem
): number {
  if (dimension === 'angle' || from === to) {
    return value;
  }
  const exponent = dimension === 'length' ? 1 : dimension === 'area' ? 2 : 3;
  return value * Math.pow(UNIT_TO_MM[from] / UNIT_TO_MM[to], exponent);
}

function unitLabel(dimension: MeasurementDimension, unit: UnitSystem): string {
  if (dimension === 'angle') {
    return '°';
  }
  const label = unit === 'inch' ? 'in' : unit;
  return dimension === 'length'
    ? label
    : dimension === 'area'
      ? `${label}²`
      : `${label}³`;
}

function fixed(value: number, precision: number): string {
  const safe = Math.abs(value) < Math.pow(10, -precision) / 2 ? 0 : value;
  return safe.toFixed(precision);
}

function formatQuantity(
  quantity: MeasurementQuantity,
  sourceUnit: UnitSystem,
  options: MeasurementDisplayOptions
): string {
  const value = convertedValue(
    quantity.value,
    quantity.dimension,
    sourceUnit,
    options.unit
  );
  return `${fixed(value, options.precision)} ${unitLabel(
    quantity.dimension,
    options.unit
  )}`;
}

export function measurementQualityLabel(quality: MeasurementQuality): string {
  switch (quality) {
    case 'exact-analytic':
      return 'Exact';
    case 'kernel-integrated':
      return 'Kernel';
    case 'sampled':
      return 'Approx';
    case 'unavailable':
      return 'Unavailable';
  }
}

export function formatMeasurement(
  measurement: Measurement,
  options: MeasurementDisplayOptions
): FormattedMeasurement {
  const { result } = measurement;
  const quality = measurementQualityLabel(measurement.quality);
  if (measurement.kind === 'body' && result.components) {
    const components = [
      result.components.x,
      result.components.y,
      result.components.z
    ].map((value) =>
      fixed(
        convertedValue(value, 'length', measurement.sourceUnit, options.unit),
        options.precision
      )
    );
    return {
      value: `${components.join(' × ')} ${unitLabel('length', options.unit)}`,
      detail: `Volume ${formatQuantity(
        { label: 'Volume', value: result.value, dimension: 'volume' },
        measurement.sourceUnit,
        options
      )}`,
      quality
    };
  }
  const displayValue =
    measurement.kind === 'diameter' && options.radialDisplay === 'radius'
      ? result.value / 2
      : result.value;
  const prefix =
    measurement.kind === 'diameter'
      ? options.radialDisplay === 'radius'
        ? 'R '
        : 'Ø '
      : measurement.quality === 'sampled'
        ? '≈ '
        : '';
  const value = `${prefix}${fixed(
    convertedValue(
      displayValue,
      result.dimension,
      measurement.sourceUnit,
      options.unit
    ),
    options.precision
  )} ${unitLabel(result.dimension, options.unit)}`;
  let detail: string | undefined;
  if (measurement.kind === 'distance' && result.components) {
    const component = (value: number) =>
      fixed(
        convertedValue(value, 'length', measurement.sourceUnit, options.unit),
        options.precision
      );
    detail = `ΔX ${component(result.components.x)} · ΔY ${component(
      result.components.y
    )} · ΔZ ${component(result.components.z)} ${unitLabel(
      'length',
      options.unit
    )}`;
  } else if (result.secondary) {
    detail = `${result.secondary.label} ${formatQuantity(
      result.secondary,
      measurement.sourceUnit,
      options
    )}`;
  }
  return { value, detail, quality };
}

export function measurementToViewportAnnotation(
  measurement: Measurement,
  options: MeasurementDisplayOptions,
  selected: boolean
): MeasurementViewportAnnotation | null {
  if (!measurement.visible || !measurement.annotation) {
    return null;
  }
  const formatted = formatMeasurement(measurement, options);
  return {
    id: measurement.id,
    label: formatted.value,
    selected,
    status: measurement.status,
    anchor: measurement.annotation.anchor,
    segments: measurement.annotation.segments
  };
}

export function measurementsToText(
  list: readonly Measurement[],
  options: MeasurementDisplayOptions
): string {
  return list
    .map((entry) => {
      const formatted = formatMeasurement(entry, options);
      return [
        entry.label,
        formatted.value,
        formatted.detail ?? '',
        formatted.quality,
        entry.status,
        entry.note ?? ''
      ].join('\t');
    })
    .join('\n');
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function measurementsToCsv(
  list: readonly Measurement[],
  options: MeasurementDisplayOptions
): string {
  const rows = list.map((entry) => {
    const resultUnit = unitLabel(entry.result.dimension, options.unit);
    const value = convertedValue(
      entry.kind === 'diameter' && options.radialDisplay === 'radius'
        ? entry.result.value / 2
        : entry.result.value,
      entry.result.dimension,
      entry.sourceUnit,
      options.unit
    );
    const components = entry.result.components;
    const component = (value: number | undefined) =>
      value === undefined
        ? ''
        : convertedValue(value, 'length', entry.sourceUnit, options.unit);
    const secondary = entry.result.secondary;
    return [
      entry.kind,
      entry.label,
      entry.targets[0]?.label ?? '',
      entry.targets[1]?.label ?? '',
      value,
      resultUnit,
      component(components?.x),
      component(components?.y),
      component(components?.z),
      secondary
        ? convertedValue(
            secondary.value,
            secondary.dimension,
            entry.sourceUnit,
            options.unit
          )
        : '',
      secondary ? unitLabel(secondary.dimension, options.unit) : '',
      entry.quality,
      entry.status,
      entry.sourceRevision,
      entry.note ?? ''
    ]
      .map(csvCell)
      .join(',');
  });
  return [
    'kind,label,target_a,target_b,value,unit,delta_x,delta_y,delta_z,secondary_value,secondary_unit,quality,status,source_revision,note',
    ...rows
  ].join('\n');
}

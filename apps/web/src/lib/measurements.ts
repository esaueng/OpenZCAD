import type {
  BodyRepresentation,
  BoundingBox,
  EdgeTopology,
  EdgeTopologyReferenceV5,
  FaceAreaProvenance,
  FaceTopology,
  TopologyReferenceV5,
  TopologySelection,
  UnitSystem,
  Vector3
} from '@openzcad/shared';
import { millimetresPerUnit } from '@openzcad/shared';
import {
  matchScaledTopology,
  scaledEdgeGeometryMatches,
  scaledFaceGeometryMatches
} from '@openzcad/kernel-adapter/units-witness-match';
import {
  centralDistance,
  maximumDistance,
  parallelDistance,
  type MeasureEntity
} from './measureDistances';
import {
  edgeLengthMeasurement,
  topologySelectionLabel
} from './topologyLabels';
import {
  resolveEdge,
  resolveFace,
  topologyResolutionMessage,
  type TopologyResolutionReason
} from './topologyResolution';
import {
  ANGLE_CONVENTION_LABELS,
  angleBetweenDirections,
  angleBetweenEdges,
  angleBetweenFaces,
  angleBetweenLineAndPlane,
  type AngleConvention,
  type AngleMeasurement
} from './measurementGeometry';

import type { MeasurePointKind } from './measurePointKinds';
export {
  MEASURE_POINT_KINDS,
  measureSnapKindsFor,
  type MeasurePointKind
} from './measurePointKinds';

export type MeasurementMode =
  | 'smart'
  | 'distance'
  | 'angle'
  /** M13: the farthest two picks are apart. */
  | 'maximum'
  /** M13: from a circle's centre or a cylinder's axis to the other pick. */
  | 'central'
  /** M13: between parallel edges, faces or axes, or concentric radii. */
  | 'parallel';

/** M13: the distance kinds each two-pick entity mode records. */
export const ENTITY_DISTANCE_KINDS = {
  maximum: 'max-distance',
  central: 'central-distance',
  parallel: 'parallel-distance'
} as const;

export type EntityDistanceMode = keyof typeof ENTITY_DISTANCE_KINDS;
export type EntityDistanceKind =
  (typeof ENTITY_DISTANCE_KINDS)[EntityDistanceMode];

export function isEntityDistanceMode(
  mode: MeasurementMode
): mode is EntityDistanceMode {
  return mode === 'maximum' || mode === 'central' || mode === 'parallel';
}

export function isEntityDistanceKind(
  kind: MeasurementKind
): kind is EntityDistanceKind {
  return (
    kind === 'max-distance' ||
    kind === 'central-distance' ||
    kind === 'parallel-distance'
  );
}

export type MeasurementKind =
  | 'edge-length'
  | 'edge-total'
  | 'diameter'
  | 'face-area'
  | 'body'
  | 'distance'
  /** M13: maximum, central and parallel distances; two targets each. */
  | 'max-distance'
  | 'central-distance'
  | 'parallel-distance'
  | 'angle'
  /**
   * A 3-point angle with the vertex at the middle pick. Three targets, unlike
   * `angle`, which always carries exactly two.
   */
  | 'point-angle';

/**
 * Where a figure came from, and therefore how far it can be trusted.
 *
 * `kernel-integrated` used to cover both an edge length and a face area, which
 * are not comparable: `kernel.edgeLength` takes no deflection parameter and is
 * exact for every curve type ordinary modelling produces, while
 * `kernel.faceArea` takes one — and, per `test/measurement-provenance.test.ts`,
 * is not even bounded by it. A planar face with a curved boundary reads
 * 1.004e-4 low from a fixed 256-point inscribed polygon no matter what
 * deflection is asked for.
 *
 * The split matters now rather than later: Stage 4 persists these strings, and
 * a stored vocabulary that conflates exact with approximate cannot be corrected
 * afterwards without a migration.
 *
 * `tessellated` is a floor, not a verdict. A box face's area is exact and is
 * still labelled `tessellated` today, because nothing published per-face says
 * which is which. Publishing that provenance is what promotes those figures.
 */
export type MeasurementQuality =
  /** Closed form computed here from exact published parameters. */
  | 'exact-analytic'
  /** A kernel measurement with no deflection parameter and no sampling. */
  | 'exact-kernel'
  /** A kernel measurement bounded by, or sampled at, a fixed resolution. */
  | 'tessellated'
  /** Derived from display geometry or from where the pointer landed. */
  | 'sampled'
  | 'unavailable';

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
  /**
   * A straight edge's two ends. Carried so two edges can be told apart from
   * two edges that MEET: only a shared corner makes an included angle over
   * 0-180 defensible, because an edge's `direction` follows the kernel's
   * traversal order rather than the geometry. See `measurementGeometry.ts`.
   */
  endpoints?: readonly [Vector3, Vector3];
  semantic:
    | 'body-center'
    | 'face-center'
    | 'circle-center'
    | 'edge-midpoint'
    /**
     * One end of an edge, in the edge's own direction — the same direction its
     * display polyline is sampled in. Start and end are kernel traversal
     * order, not a geometric ranking, which is why both ends are nameable:
     * re-deriving "the nearer one" from a stored point would be proximity
     * rebinding, which ADR-011 forbids.
     */
    | 'vertex-start'
    | 'vertex-end'
    | 'pick';
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
  /**
   * What the segments mean, which decides how they are drawn.
   *
   * A measured SPAN gets a drawing's dimension — witness ticks standing it off
   * the geometry, arrowheads whose tips land on the measured points. An angle's
   * two arms are not a span: they radiate from a shared corner, and putting an
   * arrowhead on the far end of each would claim the arm length was the
   * measurement.
   */
  graphic: 'span' | 'arms' | 'anchor';
  /**
   * World-space box of the face or body an `anchor` figure describes, so the
   * viewport can stand the label just outside that face rather than outside
   * the whole model. Derived from the bodies the viewport draws, for display
   * only; never stored with the measurement.
   */
  extent?: MeasurementExtent;
}

/** A measured face's or body's box, and the body it was read from. */
export interface MeasurementExtent extends BoundingBox {
  bodyId: BodyRepresentation['bodyId'];
}

/** Which graphic each measurement kind earns. */
function annotationGraphic(
  kind: MeasurementKind
): MeasurementViewportAnnotation['graphic'] {
  switch (kind) {
    case 'distance':
    case 'max-distance':
    case 'central-distance':
    case 'parallel-distance':
    case 'edge-length':
    case 'edge-total':
      return 'span';
    case 'angle':
    case 'point-angle':
      return 'arms';
    // A diameter, an area and a body have a point to label but no span to
    // draw between: the figure describes a whole face or solid, not a gap.
    case 'diameter':
    case 'face-area':
    case 'body':
      return 'anchor';
  }
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
  /**
   * Which angle was measured, for `kind: 'angle'` or `'point-angle'`. Shown
   * beside the figure because a bare "30°" between two faces does not say
   * whether it describes the material or its normals, and those differ by 120.
   * A 3-point angle always reports `included`: both arms are oriented away
   * from the vertex pick, so the corner is well defined over the full 0-180.
   */
  angleConvention?: AngleConvention;
  /**
   * The document revision whose geometry produced `result`. A refresh that
   * cannot re-measure the row (it went stale or unresolved) keeps it, so a
   * retained number always names the model it was read from, never a later
   * revision that has no such geometry (#2360).
   */
  sourceRevision: number;
  /**
   * The revision the row was last re-resolved against, when that attempt
   * did not produce `result` (status `stale` or `unresolved`). Absent on
   * a current row, whose `sourceRevision` is also the revision checked.
   */
  checkedRevision?: number;
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

const QUALITY_RANK: Record<MeasurementQuality, number> = {
  'exact-analytic': 0,
  'exact-kernel': 1,
  tessellated: 2,
  sampled: 3,
  unavailable: 4
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

function subtractVectors(from: Vector3, to: Vector3): Vector3 {
  return vector(from.x - to.x, from.y - to.y, from.z - to.z);
}

function dotVectors(first: Vector3, second: Vector3): number {
  return first.x * second.x + first.y * second.y + first.z * second.z;
}

function crossVectors(first: Vector3, second: Vector3): Vector3 {
  return vector(
    first.y * second.z - first.z * second.y,
    first.z * second.x - first.x * second.z,
    first.x * second.y - first.y * second.x
  );
}

/**
 * How far a face's published area can be trusted.
 *
 * The adapter decides this per face, because only it can see the boundary: a
 * plane bounded by straight edges is exact where the same plane bounded by a
 * circle is not, and both arrive here as `surfaceType: 'plane'`. An older
 * projection carries no verdict at all, which must read as approximate rather
 * than as exact — absence of evidence is not a promise.
 */
function faceAreaQuality(geometry: {
  areaProvenance?: FaceAreaProvenance;
}): MeasurementQuality {
  return geometry.areaProvenance === 'exact' ? 'exact-kernel' : 'tessellated';
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
 * Why a pick cannot be measured, in the words the status bar should use, or
 * `null` when it can. Kept here rather than at the call site so a refusal
 * names the actual obstacle — "two features match this equally" is something a
 * person can act on, where "does not expose a trustworthy measurement" is not.
 */
export function measurementSelectionFailure(
  body: BodyRepresentation,
  selection: Pick<
    TopologySelection,
    'kind' | 'topologyId' | 'hash' | 'reference'
  >
): string | null {
  if (selection.kind === 'body') {
    if (body.meshReference)
      return 'Solid volume is unavailable for a mesh reference.';
    return null;
  }
  const found =
    selection.kind === 'edge'
      ? resolveEdge(body, selection)
      : resolveFace(body, selection);
  return found.ok ? null : topologyResolutionMessage(found.reason);
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

type TargetBase = Pick<
  MeasurementTarget,
  'bodyId' | 'bodyName' | 'kind' | 'topologyId' | 'hash' | 'reference'
>;

/**
 * How far a face centroid can be trusted. The adapter publishes the
 * integrator's own verdict beside the point: `exact` only when every boundary
 * edge is straight, `sampled` once any curved boundary is inscribed. Absent on
 * older projections, which read as approximate — absence of evidence is not a
 * promise.
 */
function faceCentroidQuality(geometry: {
  centroidProvenance?: FaceAreaProvenance;
}): MeasurementQuality {
  return geometry.centroidProvenance === 'exact'
    ? 'exact-analytic'
    : 'tessellated';
}

function edgeCircleCenterTarget(
  base: TargetBase,
  edge: EdgeTopology,
  label: string
): MeasurementTarget | null {
  if (!edge.curve?.circle) {
    return null;
  }
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

function lineMidpointTarget(
  base: TargetBase,
  edge: EdgeTopology,
  label: string
): MeasurementTarget | null {
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
  if (!lineDirection || !endpoints) {
    return null;
  }
  return {
    ...base,
    topologyId: edge.topologyId,
    hash: edge.hash,
    reference: edge.reference,
    label: `${label} midpoint`,
    point: midpoint(endpoints[0], endpoints[1]),
    direction: lineDirection,
    endpoints,
    semantic: 'edge-midpoint',
    quality: 'exact-analytic'
  };
}

function cylinderCenterTarget(
  base: TargetBase,
  face: FaceTopology,
  geometry: NonNullable<FaceTopology['geometry']>,
  label: string
): MeasurementTarget | null {
  if (
    geometry.surfaceType !== 'cylinder' ||
    !geometry.axisStart ||
    !geometry.axisEnd
  ) {
    return null;
  }
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

/** A closed edge repeats its first point, so any smaller gap is an open arc. */
const ARC_MIDPOINT_CLOSED_TOLERANCE = 1e-9;

/**
 * The middle sample of the edge's display polyline. Used only to choose which
 * side of the circle the trimmed arc runs on — a discrete choice the sampled
 * data answers reliably — never as the measured point itself.
 */
function polylineInteriorPoint(edge: EdgeTopology): Vector3 | null {
  const count = Math.floor(edge.points.length / 3);
  if (count < 2) {
    return null;
  }
  const at = Math.floor(count / 2) * 3;
  return vector(edge.points[at]!, edge.points[at + 1]!, edge.points[at + 2]!);
}

/**
 * Midpoint of a circular arc's TRIMMED range, on the arc itself.
 *
 * This is not the chord midpoint: for a 90-degree arc of radius 4 the chord
 * midpoint sits ~1.17 inside the arc, and the error grows with the subtended
 * angle. The trimmed range is recovered from the published full circle plus
 * the edge's own endpoints: both ends give radii, and the sampled polyline's
 * middle says which way round the interior runs, which fixes the signed sweep
 * and its half. The kernel's exact edge length then checks the answer and the
 * function fails closed when the three sources disagree.
 *
 * Closed edges (a full rim) have no single midpoint and return null; their
 * centre remains available as `circle-center`.
 */
function edgeArcMidpoint(edge: EdgeTopology): Vector3 | null {
  const circle = edge.curve?.circle;
  if (
    !circle ||
    !Number.isFinite(circle.radius) ||
    circle.radius <= 0 ||
    edge.curve?.type.toUpperCase() !== 'CIRCLE'
  ) {
    return null;
  }
  const ends = edgeEndpoints(edge);
  if (!ends) {
    return null;
  }
  if (distance(ends[0], ends[1]) <= ARC_MIDPOINT_CLOSED_TOLERANCE) {
    return null;
  }
  const axis = normalized(circle.axis);
  if (!axis) {
    return null;
  }
  const radial = (point: Vector3): Vector3 | null => {
    const offset = subtractVectors(point, circle.center);
    const axial = dotVectors(offset, axis);
    return normalized(
      vector(
        offset.x - axis.x * axial,
        offset.y - axis.y * axial,
        offset.z - axis.z * axial
      )
    );
  };
  const startRadius = radial(ends[0]);
  const endRadius = radial(ends[1]);
  const interior = polylineInteriorPoint(edge);
  const middleRadius = interior ? radial(interior) : null;
  if (!startRadius || !endRadius || !middleRadius) {
    return null;
  }
  // In-plane frame from the start radius. (u, v, axis) is right-handed, so the
  // measured angle grows counter-clockwise about the published axis.
  const side = normalized(crossVectors(axis, startRadius));
  if (!side) {
    return null;
  }
  const angleOf = (unit: Vector3): number =>
    Math.atan2(dotVectors(unit, side), dotVectors(unit, startRadius));
  const TAU = Math.PI * 2;
  const positive = (turn: number): number => ((turn % TAU) + TAU) % TAU;
  const sweepToEnd = positive(angleOf(endRadius) - angleOf(startRadius));
  const sweepToMiddle = positive(angleOf(middleRadius) - angleOf(startRadius));
  const sweep = sweepToMiddle <= sweepToEnd ? sweepToEnd : sweepToEnd - TAU;
  if (edge.length !== undefined && Number.isFinite(edge.length)) {
    if (edge.length <= 0) {
      return null;
    }
    const swept = Math.abs(sweep) * circle.radius;
    if (Math.abs(swept - edge.length) > Math.max(edge.length * 1e-6, 1e-9)) {
      return null;
    }
  }
  const half = angleOf(startRadius) + sweep / 2;
  return vector(
    circle.center.x +
      circle.radius *
        (Math.cos(half) * startRadius.x + Math.sin(half) * side.x),
    circle.center.y +
      circle.radius *
        (Math.cos(half) * startRadius.y + Math.sin(half) * side.y),
    circle.center.z +
      circle.radius * (Math.cos(half) * startRadius.z + Math.sin(half) * side.z)
  );
}

/**
 * A point on picked topology with an exact derivation, for point-to-point
 * distance and 3-point angle. Every kind resolves from the published exact
 * record — kernel vertices, the proven circle, the axis endpoints, the area
 * centroid — never from where the pointer landed or from the vertex mean that
 * `FaceGeometry.center` publishes for fingerprinting.
 *
 * Which kinds apply depends on the pick: vertices and midpoints on edges
 * (midpoints exact for lines and circular arcs), circle centres on circular
 * edges, hole centres and face centroids on faces. Anything else returns null
 * rather than an approximate substitute; the raw pick path stays available
 * for those through `measurementTargetFromSelection`.
 */
export type NotablePointKind =
  | 'vertex-start'
  | 'vertex-end'
  | 'edge-midpoint'
  | 'circle-center'
  | 'face-centroid';

export function notablePointTarget(
  body: BodyRepresentation,
  selection: TopologySelection,
  kind: NotablePointKind
): MeasurementTarget | null {
  const base: TargetBase = {
    bodyId: body.bodyId,
    bodyName: body.name,
    kind: selection.kind,
    topologyId: selection.topologyId,
    hash: selection.hash,
    reference: selection.reference
  };
  if (selection.kind === 'edge') {
    const edge = findEdge(body, selection);
    if (!edge) {
      return null;
    }
    const label = topologySelectionLabel(body, {
      kind: 'edge',
      hash: edge.hash,
      topologyId: edge.topologyId
    });
    if (kind === 'vertex-start' || kind === 'vertex-end') {
      const ends = edgeEndpoints(edge);
      if (!ends) {
        return null;
      }
      // Edge ends are the kernel's own vertices, reported through the
      // polyline's first and last samples; the sampler starts and ends at
      // the vertices rather than interpolating them.
      return {
        ...base,
        topologyId: edge.topologyId,
        hash: edge.hash,
        reference: edge.reference,
        label: `${label} ${kind === 'vertex-start' ? 'start' : 'end'}`,
        point: kind === 'vertex-start' ? ends[0] : ends[1],
        // M13: the edge's ends as picked, so a refresh can tell a reversed
        // edge (its ends swapped) from a moved one (both shifted together).
        endpoints: ends,
        semantic: kind,
        quality: 'exact-analytic'
      };
    }
    if (kind === 'circle-center') {
      return edgeCircleCenterTarget(base, edge, label);
    }
    if (kind === 'edge-midpoint') {
      if (edge.curve?.circle) {
        const arc = edgeArcMidpoint(edge);
        if (!arc) {
          return null;
        }
        return {
          ...base,
          topologyId: edge.topologyId,
          hash: edge.hash,
          reference: edge.reference,
          label: `${label} midpoint`,
          point: arc,
          semantic: 'edge-midpoint',
          quality: 'exact-analytic'
        };
      }
      // A straight edge's chord midpoint IS its trimmed midpoint.
      return lineMidpointTarget(base, edge, label);
    }
    return null;
  }
  if (selection.kind === 'face') {
    const face = findFace(body, selection);
    const geometry = face?.geometry;
    if (!face || !geometry) {
      return null;
    }
    const label = topologySelectionLabel(body, {
      kind: 'face',
      hash: face.hash,
      topologyId: face.topologyId
    });
    if (kind === 'circle-center') {
      return cylinderCenterTarget(base, face, geometry, label);
    }
    if (kind === 'face-centroid') {
      // Never `geometry.center`: the vertex mean of the rim, which sits on
      // the rim itself for a disc face with a single seam vertex. Absent on
      // faces whose boundary cannot be walked — "cannot answer", never a
      // substitution.
      if (!geometry.centroid) {
        return null;
      }
      return {
        ...base,
        topologyId: face.topologyId,
        hash: face.hash,
        reference: face.reference,
        label: `${label} centroid`,
        point: geometry.centroid,
        semantic: 'face-center',
        quality: faceCentroidQuality(geometry)
      };
    }
    return null;
  }
  return null;
}

/**
 * The edge point a measure snap names, as a target, or null when the snap
 * carries no source or its edge no longer yields that same point.
 *
 * The click under a snap glyph used to hand only the snapped POSITION to
 * {@link measurementTargetFromSelection}, which derives an edge's target from
 * the edge alone: a straight edge's midpoint, a circle's centre. A pick under
 * "Endpoint" therefore recorded the edge's midpoint (QA15-2E-01, 57.31 mm
 * measured for 56). The snap's source names the edge and which of its points
 * the glyph stood for, so the pick records that notable point — by identity,
 * so a rebuild re-derives the same vertex rather than carrying a stale
 * coordinate.
 *
 * `point` is where the snap drew its glyph. The derived target must land on
 * it; one that does not (a curve without an exact derivation, or an identity
 * that now resolves to another edge) is refused rather than recorded somewhere
 * the glyph did not mark.
 */
export function measurementTargetFromSnap(
  body: BodyRepresentation,
  snap: {
    edgeTopologyId: string;
    edgeHash: number;
    edgeReference?: EdgeTopologyReferenceV5;
    role: 'start' | 'end' | 'midpoint' | 'center';
  },
  point: Vector3
): MeasurementTarget | null {
  const kind: NotablePointKind =
    snap.role === 'start'
      ? 'vertex-start'
      : snap.role === 'end'
        ? 'vertex-end'
        : snap.role === 'midpoint'
          ? 'edge-midpoint'
          : 'circle-center';
  const target = notablePointTarget(
    body,
    {
      bodyId: body.bodyId,
      kind: 'edge',
      topologyId: snap.edgeTopologyId,
      hash: snap.edgeHash,
      ...(snap.edgeReference ? { reference: snap.edgeReference } : {})
    },
    kind
  );
  if (!target?.point) {
    return null;
  }
  const size = distance(body.bbox.min, body.bbox.max);
  return distance(target.point, point) <= SNAP_AGREEMENT * Math.max(1, size)
    ? target
    : null;
}

/**
 * M13: the notable point of `kind` on a picked edge or face, or null when it
 * has none. An endpoint is the end the snap glyph named, else the end nearer
 * the pick; it is recorded by identity (start or end), so a rebuild reads the
 * same vertex rather than the nearest one then.
 */
export function pointKindTarget(
  body: BodyRepresentation,
  selection: TopologySelection,
  kind: Exclude<MeasurePointKind, 'auto'>,
  point?: Vector3,
  snapRole?: 'start' | 'end' | 'midpoint' | 'center'
): MeasurementTarget | null {
  if (kind === 'endpoint') {
    if (selection.kind !== 'edge') return null;
    // A closed rim's polyline starts wherever its sampler began, not at a
    // vertex anyone can name: it has no ends to pick.
    const picked = findEdge(body, selection);
    const pickedEnds = picked ? edgeEndpoints(picked) : null;
    if (
      !pickedEnds ||
      distance(pickedEnds[0], pickedEnds[1]) <=
        SNAP_AGREEMENT * Math.max(1, distance(body.bbox.min, body.bbox.max))
    )
      return null;
    let end: NotablePointKind = 'vertex-start';
    if (snapRole === 'start' || snapRole === 'end') {
      end = snapRole === 'start' ? 'vertex-start' : 'vertex-end';
    } else if (point) {
      const edge = findEdge(body, selection);
      const ends = edge ? edgeEndpoints(edge) : null;
      if (!ends) return null;
      end =
        distance(ends[1], point) < distance(ends[0], point)
          ? 'vertex-end'
          : 'vertex-start';
    }
    return notablePointTarget(body, selection, end);
  }
  if (kind === 'midpoint')
    return selection.kind === 'edge'
      ? notablePointTarget(body, selection, 'edge-midpoint')
      : null;
  if (kind === 'center')
    return notablePointTarget(body, selection, 'circle-center');
  return selection.kind === 'face'
    ? notablePointTarget(body, selection, 'face-centroid')
    : null;
}

/**
 * M13: the edge a snap glyph was read off, as a selection, so a pick
 * records that edge's point rather than one of whatever the ray hit.
 */
export function snapSourceSelection(
  body: BodyRepresentation,
  source: {
    edgeTopologyId: string;
    edgeHash: number;
    edgeReference?: EdgeTopologyReferenceV5;
  }
): TopologySelection {
  return {
    bodyId: body.bodyId,
    kind: 'edge',
    topologyId: source.edgeTopologyId,
    hash: source.edgeHash,
    ...(source.edgeReference ? { reference: source.edgeReference } : {})
  };
}

/**
 * M13: whether a pick of `kind` recorded `target` where its glyph stood.
 * A glyph and the point it names are read through separate arithmetic, so
 * they agree to rounding, not bit for bit.
 */
export function pointKindAgrees(
  body: BodyRepresentation,
  target: MeasurementTarget | null,
  glyph: Vector3
): boolean {
  return (
    !!target?.point &&
    distance(target.point, glyph) <=
      SNAP_AGREEMENT * Math.max(1, distance(body.bbox.min, body.bbox.max))
  );
}

/** M13: why a pick has no point of `kind`, as the status line says it. */
export function pointKindFailure(
  kind: Exclude<MeasurePointKind, 'auto'>,
  selection: TopologySelection['kind']
): string {
  switch (kind) {
    case 'endpoint':
      return selection === 'edge'
        ? 'That edge has no ends to pick (a closed rim has none).'
        : 'Endpoint picks an edge: pick an edge near the end you mean.';
    case 'midpoint':
      return selection === 'edge'
        ? 'That edge has no exact midpoint (only lines and arcs do).'
        : 'Midpoint picks an edge.';
    case 'center':
      return selection === 'edge'
        ? 'That edge is not a circle or arc, so it has no center.'
        : 'That face is not a cylinder or hole, so it has no center.';
    case 'centroid':
      return selection === 'face'
        ? 'That face has no exact centroid to pick.'
        : 'Centroid picks a face.';
  }
}

/**
 * How far, relative to the body's size, a snap's drawn point and the target
 * derived from its source may differ. The two read the same exact record
 * through separate arithmetic, so they agree to rounding, not bit for bit.
 */
const SNAP_AGREEMENT = 1e-7;

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
      // The bbox midpoint. `kernel.boundingBox` is tight rather than a loose
      // tessellation hull — measured on a sphere, where a hull would show.
      quality: 'exact-kernel'
    };
  }
  if (selection.kind === 'edge') {
    const edge = findEdge(body, selection);
    if (!edge) {
      return null;
    }
    const label = topologySelectionLabel(body, {
      kind: 'edge',
      hash: edge.hash,
      topologyId: edge.topologyId
    });
    const center = edgeCircleCenterTarget(base, edge, label);
    if (center) {
      return center;
    }
    const lineMidpoint = lineMidpointTarget(base, edge, label);
    if (lineMidpoint) {
      return lineMidpoint;
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
  const label = topologySelectionLabel(body, {
    kind: 'face',
    hash: face.hash,
    topologyId: face.topologyId
  });
  if (
    geometry?.surfaceType === 'cylinder' &&
    geometry.axisStart &&
    geometry.axisEnd
  ) {
    const center = cylinderCenterTarget(base, face, geometry, label);
    if (center) {
      return center;
    }
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
      // `FaceGeometry.center` is a mean of the face's VERTEX positions, not an
      // area centroid — exactly reproducible, but not the centre of the face
      // for anything L-shaped or trimmed. Reproducible is what a measurement
      // anchor needs, so this is honest rather than exact. The area centroid
      // is the explicit `face-centroid` notable point instead.
      quality: 'tessellated'
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
    if (body.meshReference) return null;
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
      // Volume takes a deflection and is provably inexact on a filleted body —
      // 4.2e-6 low, and the error scales with the whole part rather than with
      // the blend (test/filleted-body-volume.test.ts). The bbox extents beside
      // it are exact, but the row's headline figure is the volume.
      quality: 'tessellated',
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
    // A circular edge is read the way a drawing reads it: by its diameter
    // (or radius, with Ø/R), the length along it as the detail. "Hole edge
    // Ø6 — 18.85 mm" gave the circumference, and Ø/R did nothing (I50).
    const circle = edge.curve?.circle;
    if (circle && Number.isFinite(circle.radius) && circle.radius > 0) {
      const full =
        Math.abs(measured.value - 2 * Math.PI * circle.radius) <=
        1e-6 * Math.max(1, measured.value);
      return {
        ...common,
        id: `diameter:${targetKey(target)}`,
        kind: 'diameter',
        label: target.label.replace(/ center$| midpoint$/, ''),
        result: {
          value: circle.radius * 2,
          dimension: 'length',
          secondary: {
            label: full ? 'Circumference' : 'Arc length',
            value: measured.value,
            dimension: 'length'
          }
        },
        // The kernel publishes a circle only for an exact CIRCLE curve.
        quality: 'exact-analytic',
        annotation: {
          anchor: target.point ?? circle.center,
          segments: []
        }
      };
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
    quality: faceAreaQuality(geometry),
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

/**
 * M13: what a target is, geometrically, for maximum, central and parallel
 * distances, read from the body's current topology by identity. A notable
 * point (a vertex or midpoint pick) is that point; a straight edge is its
 * segment, a circular one its circle; a planar face its plane, a cylinder
 * its axis and radius. Null for a target with no such reading (a body).
 */
function measureEntityOf(
  bodies: readonly BodyRepresentation[],
  target: MeasurementTarget
): MeasureEntity | null {
  const body = bodies.find((candidate) => candidate.bodyId === target.bodyId);
  if (!body) return null;
  // A vertex pick is that point. Any other edge pick is the edge itself:
  // Distance records a straight edge as its midpoint, which here would
  // shrink the edge to one point.
  if (
    target.point &&
    (target.semantic === 'vertex-start' || target.semantic === 'vertex-end')
  )
    return { type: 'point', point: target.point };
  const selection = selectionForTarget(target);
  if (target.kind === 'edge') {
    const edge = findEdge(body, selection);
    if (!edge) return null;
    const circle = edge.curve?.circle;
    if (circle) {
      const ends = edgeEndpoints(edge);
      const axis = unitVector(circle.axis);
      if (!axis) return null;
      return {
        type: 'circle',
        center: circle.center,
        axis,
        radius: circle.radius,
        // Closed only when the edge runs the whole circumference. A gap
        // between sampled ends cannot tell a rim from a tiny arc of a huge
        // circle; the edge's own length can.
        closed:
          edge.length !== undefined
            ? Math.abs(edge.length - 2 * Math.PI * circle.radius) <=
              1e-6 * 2 * Math.PI * circle.radius
            : !!ends && distance(ends[0], ends[1]) <= 1e-9 * circle.radius
      };
    }
    if (edge.curve?.type === 'LINE') {
      const ends = edgeEndpoints(edge);
      return ends ? { type: 'segment', start: ends[0], end: ends[1] } : null;
    }
    return null;
  }
  if (target.kind === 'face') {
    const geometry = findFace(body, selection)?.geometry;
    if (!geometry) return null;
    if (geometry.surfaceType === 'plane' && geometry.normal) {
      const normal = unitVector(geometry.normal);
      const point = geometry.centroid ?? geometry.center;
      return normal && point ? { type: 'plane', point, normal } : null;
    }
    if (
      geometry.surfaceType === 'cylinder' &&
      geometry.axisStart &&
      geometry.axisEnd &&
      geometry.radius !== undefined
    ) {
      const axis = unitVector({
        x: geometry.axisEnd.x - geometry.axisStart.x,
        y: geometry.axisEnd.y - geometry.axisStart.y,
        z: geometry.axisEnd.z - geometry.axisStart.z
      });
      return axis
        ? {
            type: 'cylinder',
            origin: geometry.axisStart,
            axis,
            radius: geometry.radius
          }
        : null;
    }
    return null;
  }
  return null;
}

function unitVector(value: Vector3): Vector3 | null {
  const size = Math.hypot(value.x, value.y, value.z);
  return size > 0
    ? vector(value.x / size, value.y / size, value.z / size)
    : null;
}

const ENTITY_DISTANCE_LABELS: Record<EntityDistanceMode, string> = {
  maximum: 'Maximum distance',
  central: 'Central distance',
  parallel: 'Parallel distance'
};

/**
 * M13: a maximum, central or parallel distance between two picks, in
 * closed form from the picks' exact geometry, or the reason there is none.
 * Exact only when both picks are; the span drawn is the one measured.
 */
export function createEntityDistanceMeasurement(
  mode: EntityDistanceMode,
  bodies: readonly BodyRepresentation[],
  first: MeasurementTarget,
  second: MeasurementTarget,
  sourceRevision: number,
  sourceUnit: UnitSystem
): Measurement | { refused: string } {
  const a = measureEntityOf(bodies, first);
  const b = measureEntityOf(bodies, second);
  if (!a || !b)
    return {
      refused:
        'Pick edges, faces, holes or points: a whole body has no single geometry to measure from.'
    };
  const size = Math.max(
    ...bodies
      .filter(
        (body) => body.bodyId === first.bodyId || body.bodyId === second.bodyId
      )
      .map((body) => distance(body.bbox.min, body.bbox.max)),
    1
  );
  let answer: ReturnType<typeof maximumDistance>;
  if (mode === 'maximum') answer = maximumDistance(a, b);
  else if (mode === 'parallel') answer = parallelDistance(a, b, size);
  else {
    if (!first.point || !second.point)
      return { refused: 'Those picks have no point to measure to.' };
    answer = centralDistance(a, first.point, b, second.point);
  }
  if ('refused' in answer) return answer;
  const label = ENTITY_DISTANCE_LABELS[mode];
  const kind = ENTITY_DISTANCE_KINDS[mode];
  return {
    id: `${kind}:${targetKey(first)}:${targetKey(second)}`,
    kind,
    label: `${first.label} ↔ ${second.label}`,
    targets: [first, second],
    result: {
      value: answer.value,
      dimension: 'length',
      secondary: {
        label: answer.note ? `${label}, ${answer.note}` : label,
        value: answer.value,
        dimension: 'length'
      }
    },
    quality: worstQuality([first.quality, second.quality]),
    status: 'current',
    sourceRevision,
    sourceUnit,
    visible: true,
    annotation: {
      anchor: midpoint(answer.from, answer.to),
      segments: [{ start: answer.from, end: answer.to }]
    }
  };
}

/**
 * Picks the angle convention the pair of picks actually supports.
 *
 * A face target carries an outward normal, which is directed; an edge target
 * carries a traversal direction, which is not. Mixing them without saying so
 * is how the old `Math.abs` came to fold every angle into 0-90.
 */
function angleBetweenTargets(
  first: MeasurementTarget,
  second: MeasurementTarget
): AngleMeasurement | null {
  const firstIsFace = first.kind === 'face' && first.semantic === 'face-center';
  const secondIsFace =
    second.kind === 'face' && second.semantic === 'face-center';
  if (!first.direction || !second.direction) {
    return null;
  }
  if (firstIsFace && secondIsFace) {
    return angleBetweenFaces(first.direction, second.direction);
  }
  if (firstIsFace !== secondIsFace) {
    const line = firstIsFace ? second : first;
    const plane = firstIsFace ? first : second;
    return angleBetweenLineAndPlane(line.direction!, plane.direction!);
  }
  return angleBetweenEdges(
    { direction: first.direction, endpoints: first.endpoints },
    { direction: second.direction, endpoints: second.endpoints }
  );
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
  const measured = angleBetweenTargets(first, second);
  if (!measured) {
    return null;
  }
  const separation = distance(first.point, second.point);
  const armLength = separation > 1e-9 ? separation * 0.45 : 10;
  const origin = first.point;
  return {
    id: `angle:${targetKey(first)}:${targetKey(second)}`,
    kind: 'angle',
    label: `${first.label} ∠ ${second.label}`,
    angleConvention: measured.convention,
    targets: [first, second],
    result: { value: measured.degrees, dimension: 'angle' },
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

/**
 * The angle at `vertex` between the arms to `first` and `third`, in degrees
 * over the full 0-180.
 *
 * Unlike the two-pick angle, which measures between stored directions, this
 * orients both arms away from the vertex pick itself — the same construction
 * as the `included` corner convention, but with the corner supplied by three
 * points rather than by two edges that share one. A coincident arm (first or
 * third on the vertex) has no angle and returns null rather than 0.
 *
 * Provenance follows the existing rule: exact only when every input point is
 * exact, via the same worst-of-inputs combination the distance row uses.
 */
export function createThreePointAngle(
  first: MeasurementTarget,
  vertex: MeasurementTarget,
  third: MeasurementTarget,
  sourceRevision: number,
  sourceUnit: UnitSystem
): Measurement | null {
  if (!first.point || !vertex.point || !third.point) {
    return null;
  }
  const toFirst = normalized(subtractVectors(first.point, vertex.point));
  const toThird = normalized(subtractVectors(third.point, vertex.point));
  if (!toFirst || !toThird) {
    return null;
  }
  const degrees = angleBetweenDirections(toFirst, toThird);
  if (degrees === null) {
    return null;
  }
  const reach = Math.max(
    distance(vertex.point, first.point),
    distance(vertex.point, third.point)
  );
  const armLength = reach > 1e-9 ? reach * 0.45 : 10;
  return {
    id: `point-angle:${targetKey(first)}:${targetKey(vertex)}:${targetKey(third)}`,
    kind: 'point-angle',
    label: `${first.label} ∠ ${vertex.label} ∠ ${third.label}`,
    angleConvention: 'included',
    targets: [first, vertex, third],
    result: { value: degrees, dimension: 'angle' },
    quality: worstQuality([first.quality, vertex.quality, third.quality]),
    status: 'current',
    sourceRevision,
    sourceUnit,
    visible: true,
    annotation: {
      anchor: vertex.point,
      segments: [
        {
          start: vertex.point,
          end: addScaled(vertex.point, toFirst, armLength)
        },
        {
          start: vertex.point,
          end: addScaled(vertex.point, toThird, armLength)
        }
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
  if (!canAppendMeasurement(list, next)) {
    return list as Measurement[];
  }
  return [...list, next];
}

/**
 * Whether a new row fits. Re-measuring something already on the list always
 * does, because that path updates in place rather than growing.
 *
 * The cap used to evict the oldest row instead of refusing. That was a
 * reasonable way to bound a scratch tape, but it is silent data loss the
 * moment the list outlives the session — someone who measures fifty-one things
 * would find the first one simply gone, with nothing having said so. A refusal
 * the caller can report is the version that survives being persisted.
 */
export function canAppendMeasurement(
  list: readonly Measurement[],
  next: Measurement
): boolean {
  return (
    list.length < MEASUREMENT_LIMIT ||
    list.some((entry) => entry.id === next.id)
  );
}

/** What to tell someone whose measurement did not fit. */
export const MEASUREMENT_LIMIT_MESSAGE = `Measurement list is full at ${MEASUREMENT_LIMIT}. Delete a row to record another.`;

/** Re-derive a notable-point target from freshly resolved topology. */
function resolveNotableTarget(
  target: MeasurementTarget,
  body: BodyRepresentation
): MeasurementTarget | null {
  const selection = selectionForTarget(target);
  if (
    target.kind === 'edge' &&
    (target.semantic === 'vertex-start' ||
      target.semantic === 'vertex-end' ||
      target.semantic === 'edge-midpoint')
  ) {
    const found = resolveEdge(body, selection);
    if (!found.ok) {
      return null;
    }
    const kind: NotablePointKind = target.semantic;
    if (kind !== 'edge-midpoint' && target.point) {
      // An edge's fingerprint does not depend on its direction, so the same
      // edge can resolve with its samples reversed and "start" would then
      // name the other vertex. A vertex the hash still finds lies exactly on
      // one end: keep the end the stored point sits on, and fall back to the
      // stored role only when it sits on neither (the edge itself moved).
      const ends = (['vertex-start', 'vertex-end'] as const).map((end) =>
        notablePointTarget(body, selection, end)
      );
      const size = distance(body.bbox.min, body.bbox.max);
      const tolerance = SNAP_AGREEMENT * Math.max(1, size);
      // M13: a row that kept its edge's ends decides reversal from the pair.
      // The ends swapped is the same edge reversed: take the other role.
      // Anything else (the edge moved, or changed length) keeps the stored
      // role, so a translation never rebinds to whichever end now sits
      // where the old one was.
      const was = target.endpoints;
      const now = ends[0]?.point && ends[1]?.point;
      if (was && now) {
        const reversed =
          distance(ends[0]!.point!, was[1]) <= tolerance &&
          distance(ends[1]!.point!, was[0]) <= tolerance &&
          distance(was[0], was[1]) > tolerance;
        const role: NotablePointKind = reversed
          ? kind === 'vertex-start'
            ? 'vertex-end'
            : 'vertex-start'
          : kind;
        return notablePointTarget(body, selection, role);
      }
      const stored = target.point;
      const same = ends.find(
        (end) =>
          end?.point &&
          distance(end.point, stored) <= SNAP_AGREEMENT * Math.max(1, size)
      );
      if (same) {
        return same;
      }
    }
    return notablePointTarget(body, selection, kind);
  }
  if (target.kind === 'face' && target.semantic === 'face-center') {
    const found = resolveFace(body, selection);
    if (!found.ok) {
      return null;
    }
    return notablePointTarget(body, selection, 'face-centroid');
  }
  return null;
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
  // Notable-point targets re-derive from the stored KIND, not from the generic
  // pick derivation, which cannot name a vertex, an arc midpoint, or a face
  // centroid: an arc-midpoint row refreshed through the generic path would
  // silently become its own circle's centre, and a vertex row its edge's
  // midpoint. The stored point is never carried — every coordinate is
  // recomputed from the freshly resolved topology.
  if (
    target.semantic === 'vertex-start' ||
    target.semantic === 'vertex-end' ||
    (target.semantic === 'edge-midpoint' && target.kind === 'edge') ||
    (target.semantic === 'face-center' && purpose === 'distance')
  ) {
    return resolveNotableTarget(target, body);
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

/**
 * M13: an entity distance's pick, re-resolved by identity only. Its point
 * (which Central measures to) is re-derived from the current topology: the
 * vertex or derived centre it named, or, for a raw surface pick, the face's
 * centre, never a stored coordinate the edit may have moved.
 */
function resolvedEntityTarget(
  target: MeasurementTarget,
  bodies: readonly BodyRepresentation[]
): MeasurementTarget | null {
  const body = bodies.find((candidate) => candidate.bodyId === target.bodyId);
  if (!body || target.kind === 'body') return null;
  const selection = selectionForTarget(target);
  const found =
    target.kind === 'edge'
      ? resolveEdge(body, selection)
      : resolveFace(body, selection);
  if (!found.ok) return null;
  if (target.semantic === 'vertex-start' || target.semantic === 'vertex-end')
    return resolveNotableTarget(target, body);
  return (
    measurementTargetFromSelection(body, selection, undefined, 'distance') ?? {
      ...target,
      point: undefined
    }
  );
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

function hasValidTargetArity(measurement: Measurement): boolean {
  for (let index = 0; index < measurement.targets.length; index += 1) {
    if (
      measurement.targets[index] === undefined ||
      measurement.targets[index] === null
    ) {
      return false;
    }
  }
  if (
    measurement.kind === 'distance' ||
    measurement.kind === 'angle' ||
    isEntityDistanceKind(measurement.kind)
  ) {
    return measurement.targets.length === 2;
  }
  if (measurement.kind === 'point-angle') {
    return measurement.targets.length === 3;
  }
  if (measurement.kind === 'edge-total') {
    return measurement.targets.length >= 2;
  }
  return measurement.targets.length === 1;
}

/**
 * Unit-free numbers of a kept measurement: identity, ordering and the
 * geometry fingerprint its targets were resolved by. Every other number in a
 * {@link Measurement} is a length, area or volume in its `sourceUnit` and
 * is rescaled by {@link measurementInUnit}. `test/measurement-stored-units.test.ts`
 * walks a measurement of every kind and fails on a number in neither list.
 *
 * Fingerprints (`hash`, `reference`) are not scaled: like a document's
 * references (I03 phase 4) they are re-captured, here by the next refresh,
 * which re-resolves each target by identity and rebuilds it from the
 * converted bodies. A target that no longer resolves leaves the row stale or
 * unresolved, which the dock already reports, never a reading in the wrong
 * unit.
 */
export const MEASUREMENT_UNIT_FREE_FIELDS: readonly string[] = [
  'sourceRevision',
  'checkedRevision',
  'targets.*.hash',
  'targets.*.reference',
  'targets.*.direction'
];

function scaledVector(vector: Vector3, factor: number): Vector3 {
  return {
    x: vector.x * factor,
    y: vector.y * factor,
    z: vector.z * factor
  };
}

/**
 * I03: a kept measurement re-expressed in another stored unit, every length,
 * area and volume it carries scaled to `unit` (k, k², k³) and `sourceUnit`
 * set to it. A document whose stored unit changed (a stored-unit conversion,
 * its undo or redo, or a reload of either) passes its rows through this
 * before re-measuring them against bodies now stored in `unit`; otherwise a
 * fresh reading in the new unit would be labelled with the old one.
 */
export function measurementInUnit(
  measurement: Measurement,
  unit: UnitSystem
): Measurement {
  if (measurement.sourceUnit === unit) return measurement;
  const k =
    millimetresPerUnit(measurement.sourceUnit) / millimetresPerUnit(unit);
  const scaled = (value: number, dimension: MeasurementDimension) =>
    convertedValue(value, dimension, measurement.sourceUnit, unit);
  const { result, annotation } = measurement;
  return {
    ...measurement,
    sourceUnit: unit,
    result: {
      ...result,
      value: scaled(result.value, result.dimension),
      ...(result.components
        ? { components: scaledVector(result.components, k) }
        : {}),
      ...(result.secondary
        ? {
            secondary: {
              ...result.secondary,
              value: scaled(result.secondary.value, result.secondary.dimension)
            }
          }
        : {})
    },
    targets: measurement.targets.map((target) => ({
      ...target,
      ...(target.point ? { point: scaledVector(target.point, k) } : {}),
      ...(target.endpoints
        ? {
            endpoints: [
              scaledVector(target.endpoints[0], k),
              scaledVector(target.endpoints[1], k)
            ] as const
          }
        : {})
    })),
    ...(annotation
      ? {
          annotation: {
            anchor: scaledVector(annotation.anchor, k),
            segments: annotation.segments.map((segment) => ({
              start: scaledVector(segment.start, k),
              end: scaledVector(segment.end, k)
            }))
          }
        }
      : {})
  };
}

/** The face or edge entries of `body` a target of `kind` can name. */
function topologyEntries(
  body: BodyRepresentation,
  kind: 'face' | 'edge'
): readonly (FaceTopology | EdgeTopology)[] {
  return (kind === 'face' ? body.topology?.faces : body.topology?.edges) ?? [];
}

/** The size the geometry oracle scales its position allowances by. */
function bodyScale(body: BodyRepresentation): number {
  const { min, max } = body.bbox;
  return Math.max(
    1,
    ...[min.x, min.y, min.z, max.x, max.y, max.z].map((value) =>
      Math.abs(value)
    )
  );
}

/** The bodies a row was last measured on, in the unit they are stored in. */
export interface MeasurementSourceBodies {
  unit: UnitSystem;
  bodies: readonly BodyRepresentation[];
}

/**
 * I03 (#2361): a kept target carried across a stored-unit conversion.
 *
 * Every ADR-011 hash, and the lineage name of an imported face, is a
 * fingerprint of geometry quantized in DOCUMENT units, so converting the
 * document gives those faces and edges new identities. The document's own
 * references are re-captured by the kernel for exactly this reason; a kept
 * measurement lives beside the document and never reached that map, so its
 * rows on a Boolean result came back `not-found` on the same solid, scaled.
 *
 * This re-attaches the target to the one entity of the converted body that
 * is the entity it named before, scaled by `factor`, by the evidence the
 * conversion itself verified: a named entity by the kernel re-capture's
 * witness rule (`matchScaledTopology`, lineage family included), an
 * unnamed one by the geometry oracle's rule for its surface or curve
 * (`scaledFaceGeometryMatches`, `scaledEdgeGeometryMatches`). What it was
 * before comes from `previous`, the bodies the row was last measured on in
 * its old unit; without them (a row first refreshed after a reload), only a
 * stored witness can carry it. It is not proximity rebinding: it runs only in
 * the refresh that rescales the row to a new stored unit, under that
 * conversion's exact scale, and anything but exactly one match leaves the
 * target as it was, to resolve by identity or report itself unresolved.
 */
function reattachedAcrossUnits(
  target: MeasurementTarget,
  bodies: readonly BodyRepresentation[],
  factor: number,
  previous: readonly BodyRepresentation[] | undefined
): MeasurementTarget {
  if (target.kind === 'body') return target;
  const kind = target.kind;
  const body = bodies.find((candidate) => candidate.bodyId === target.bodyId);
  if (!body) return target;
  const selection = selectionForTarget(target);
  const lookup = (on: BodyRepresentation) =>
    kind === 'edge' ? resolveEdge(on, selection) : resolveFace(on, selection);
  // Still the same quantized geometry: nothing to re-attach.
  const direct = lookup(body);
  if (direct.ok && direct.via === 'hash') return target;
  const before = previous?.find(
    (candidate) => candidate.bodyId === target.bodyId
  );
  const was = before ? lookup(before) : null;
  const source = was?.ok ? was.entry : null;
  const named = source ? source.reference : target.reference;
  const entries = topologyEntries(body, kind);
  let entry: FaceTopology | EdgeTopology | null = null;
  if (named?.kind === kind) {
    const match = matchScaledTopology(
      {
        kind,
        witness: named.witness,
        lineage: {
          producingFeatureId: named.producingFeatureId,
          lineageName: named.lineageName
        }
      },
      entries.flatMap((candidate) =>
        candidate.reference?.kind === kind
          ? [
              {
                kind,
                witness: candidate.reference.witness,
                lineage: {
                  producingFeatureId: candidate.reference.producingFeatureId,
                  lineageName: candidate.reference.lineageName
                },
                entry: candidate
              }
            ]
          : []
      ),
      factor
    );
    if (match.status === 'matched') entry = match.candidate.entry;
  } else if (source) {
    const scale = bodyScale(body);
    const matches = entries.filter(
      (candidate) =>
        !candidate.reference &&
        (kind === 'face'
          ? (source as FaceTopology).geometry !== undefined &&
            (candidate as FaceTopology).geometry !== undefined &&
            scaledFaceGeometryMatches(
              (source as FaceTopology).geometry!,
              (candidate as FaceTopology).geometry!,
              factor,
              scale
            )
          : scaledEdgeGeometryMatches(
              source as EdgeTopology,
              candidate as EdgeTopology,
              factor,
              scale
            ))
    );
    if (matches.length === 1) entry = matches[0]!;
  }
  if (!entry) return target;
  const { reference: _stale, ...rest } = target;
  return {
    ...rest,
    topologyId: entry.topologyId,
    hash: entry.hash,
    ...(entry.reference ? { reference: entry.reference } : {})
  };
}

/** The revision a row was last judged against, re-measured or not. */
function checkedRevisionOf(measurement: Measurement): number {
  return measurement.checkedRevision ?? measurement.sourceRevision;
}

/**
 * A row this refresh could not re-measure. Its number and `sourceRevision`
 * stay the receipt of the model that produced them; `checkedRevision`
 * records the revision that was tried (#2360). Its annotation goes: that is
 * world-space geometry of the model that produced the number, and drawing it
 * over a model that no longer has that geometry (a suppressed body, say) put
 * witness lines over empty space. A reopened project never has it to draw,
 * so dropping it here is what makes the two agree (#2359).
 */
function unmeasuredRow(
  measurement: Measurement,
  status: 'stale' | 'unresolved',
  reason: TopologyResolutionReason | undefined,
  checkedRevision: number
): Measurement {
  const {
    annotation: _annotation,
    reason: _reason,
    checkedRevision: _checked,
    ...rest
  } = measurement;
  return {
    ...rest,
    status,
    ...(reason ? { reason } : {}),
    checkedRevision
  };
}

/** Whether `measurement` already is {@link unmeasuredRow}'s answer. */
function isUnmeasuredRow(
  measurement: Measurement,
  status: 'stale' | 'unresolved',
  reason: TopologyResolutionReason | undefined,
  checkedRevision: number
): boolean {
  return (
    measurement.status === status &&
    measurement.reason === reason &&
    checkedRevisionOf(measurement) === checkedRevision &&
    measurement.annotation === undefined
  );
}

/**
 * Re-resolve only by authoritative body/topology identity; never proximity.
 *
 * `options.unit` is the unit `bodies` are stored in (the document's
 * `units`). A row kept in another unit is first rescaled to it
 * ({@link measurementInUnit}), its targets re-attached across the conversion
 * ({@link reattachedAcrossUnits}; `options.previous` are the bodies the list
 * was last refreshed against, when they were stored in another unit), and
 * then re-measured, whatever its revision.
 */
export function refreshMeasurements(
  list: readonly Measurement[],
  bodies: readonly BodyRepresentation[],
  sourceRevision: number,
  options: {
    force?: boolean;
    unit?: UnitSystem;
    previous?: MeasurementSourceBodies;
  } = {}
): Measurement[] {
  let changed = false;
  const refreshedList = list.map((original) => {
    const rescaled =
      options.unit === undefined
        ? original
        : measurementInUnit(original, options.unit);
    const measurement =
      rescaled === original || !hasValidTargetArity(rescaled)
        ? rescaled
        : {
            ...rescaled,
            targets: rescaled.targets.map((target) =>
              reattachedAcrossUnits(
                target,
                bodies,
                millimetresPerUnit(original.sourceUnit) /
                  millimetresPerUnit(rescaled.sourceUnit),
                options.previous?.unit === original.sourceUnit
                  ? options.previous.bodies
                  : undefined
              )
            )
          };
    if (measurement !== original) changed = true;
    if (
      !options.force &&
      measurement === original &&
      checkedRevisionOf(measurement) === sourceRevision
    ) {
      return measurement;
    }
    if (!hasValidTargetArity(measurement)) {
      if (
        isUnmeasuredRow(measurement, 'unresolved', 'not-found', sourceRevision)
      ) {
        return measurement;
      }
      changed = true;
      return unmeasuredRow(
        measurement,
        'unresolved',
        'not-found',
        sourceRevision
      );
    }
    const purpose: MeasurementMode =
      measurement.kind === 'distance' ||
      measurement.kind === 'point-angle' ||
      isEntityDistanceKind(measurement.kind)
        ? 'distance'
        : measurement.kind === 'angle'
          ? 'angle'
          : 'smart';
    // M13: an entity distance reads its geometry from the topology itself,
    // so its picks need only resolve by identity: a raw surface point that
    // a resize moved does not make the face it was on stale.
    const targets = measurement.targets.map((target) =>
      isEntityDistanceKind(measurement.kind)
        ? resolvedEntityTarget(target, bodies)
        : resolvedTarget(target, bodies, purpose)
    );
    if (targets.some((target) => target === null)) {
      // The topology may still be there and merely unusable for this kind of
      // measurement (`stale`), or genuinely gone/ambiguous (`unresolved`).
      const failure = firstTargetFailure(measurement, bodies) ?? undefined;
      const status = failure ? 'unresolved' : 'stale';
      // `checkedRevision` advances even though no value was recomputed.
      // Without this the row never matches the short-circuit at the top of the
      // loop, so it re-evaluates on EVERY refresh — including the ones
      // triggered by merely hiding a body, which is how a once-stale row could
      // go on to demote itself against a body list it was never meant to be
      // judged by. `sourceRevision` does not: it names the model the retained
      // number was read from.
      if (isUnmeasuredRow(measurement, status, failure, sourceRevision)) {
        return measurement;
      }
      changed = true;
      return unmeasuredRow(measurement, status, failure, sourceRevision);
    }
    const resolved = targets as MeasurementTarget[];
    let refreshed: Measurement | null = null;
    if (isEntityDistanceKind(measurement.kind)) {
      const entityMode = (
        Object.keys(ENTITY_DISTANCE_KINDS) as EntityDistanceMode[]
      ).find((mode) => ENTITY_DISTANCE_KINDS[mode] === measurement.kind)!;
      const made = createEntityDistanceMeasurement(
        entityMode,
        bodies,
        resolved[0]!,
        resolved[1]!,
        sourceRevision,
        measurement.sourceUnit
      );
      refreshed = 'refused' in made ? null : made;
    } else if (measurement.kind === 'distance') {
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
    } else if (measurement.kind === 'point-angle') {
      refreshed = createThreePointAngle(
        resolved[0]!,
        resolved[1]!,
        resolved[2]!,
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
    if (refreshed) {
      changed = true;
      // `refreshed` carries no `reason`, so a row that starts resolving again
      // sheds its explanation rather than keeping a stale one beside a fresh
      // number.
      return retainRowState(measurement, refreshed);
    }
    if (isUnmeasuredRow(measurement, 'stale', undefined, sourceRevision)) {
      return measurement;
    }
    changed = true;
    // Every target resolved, yet no measurement could be rebuilt from them —
    // the topology is present but no longer supports this kind of figure.
    return unmeasuredRow(measurement, 'stale', undefined, sourceRevision);
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
  return (
    value *
    Math.pow(millimetresPerUnit(from) / millimetresPerUnit(to), exponent)
  );
}

/**
 * How a unit is written for a reader. `inch` is the document's unit name; `in`
 * is what it is called on screen, and the measurement dock has always said so.
 * Exported because the Inspector printed the raw enum and the two panels named
 * the same solid differently — "12.5 inch³" beside "12.5 in³".
 */
export function unitLabel(
  dimension: MeasurementDimension,
  unit: UnitSystem
): string {
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

/**
 * Who reads a formatted figure. `screen` is the dock, the canvas pills and the
 * hover chip; `text` is the clipboard copy, whose rows keep the plain form
 * they have always had so a paste lines up with earlier ones.
 */
export type MeasurementTextStyle = 'screen' | 'text';

/**
 * What sits between a number and its unit. On screen the degree sign sits on
 * its number, as every other angle in the app does ("45°"), and a body's
 * three-number size keeps its unit on the last number's line.
 */
function unitGap(
  dimension: MeasurementDimension,
  style: MeasurementTextStyle,
  joined = false
): string {
  if (style === 'text') {
    return ' ';
  }
  return dimension === 'angle' ? '' : joined ? '\u00a0' : ' ';
}

function formatQuantity(
  quantity: MeasurementQuantity,
  sourceUnit: UnitSystem,
  options: MeasurementDisplayOptions,
  style: MeasurementTextStyle
): string {
  const value = convertedValue(
    quantity.value,
    quantity.dimension,
    sourceUnit,
    options.unit
  );
  return `${fixed(value, options.precision)}${unitGap(
    quantity.dimension,
    style
  )}${unitLabel(quantity.dimension, options.unit)}`;
}

export function measurementQualityLabel(quality: MeasurementQuality): string {
  switch (quality) {
    case 'exact-analytic':
    case 'exact-kernel':
      // Both are exact; the row shows that, and the CSV keeps which kind.
      return 'Exact';
    case 'tessellated':
      return 'Kernel';
    case 'sampled':
      return 'Approx';
    case 'unavailable':
      return 'Unavailable';
  }
}

export function formatMeasurement(
  measurement: Measurement,
  options: MeasurementDisplayOptions,
  style: MeasurementTextStyle = 'screen'
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
      // The value column is narrow, and "… × 24.00 mm" wrapped to leave the
      // unit alone on a second line.
      value: `${components.join(' × ')}${unitGap('length', style, true)}${unitLabel(
        'length',
        options.unit
      )}`,
      detail: `Volume ${formatQuantity(
        { label: 'Volume', value: result.value, dimension: 'volume' },
        measurement.sourceUnit,
        options,
        style
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
  )}${unitGap(result.dimension, style)}${unitLabel(
    result.dimension,
    options.unit
  )}`;
  let detail: string | undefined;
  if (
    (measurement.kind === 'angle' || measurement.kind === 'point-angle') &&
    measurement.angleConvention
  ) {
    // Never show an angle without naming which one it is: the dihedral of a
    // 30 degree wedge and the angle between its normals are both true, and
    // they differ by 120.
    detail = `Angle ${ANGLE_CONVENTION_LABELS[measurement.angleConvention]}`;
  } else if (isEntityDistanceKind(measurement.kind) && result.secondary) {
    // Named beside the figure: "3 mm" alone does not say it is a maximum.
    detail = result.secondary.label;
  } else if (measurement.kind === 'distance' && result.components) {
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
      options,
      style
    )}`;
  }
  return { value, detail, quality };
}

/** Box around one face's display triangles, from the body's own mesh. */
function faceMeshBounds(
  mesh: BodyRepresentation['mesh'],
  face: Pick<FaceTopology, 'triangleStart' | 'triangleCount'>
): BoundingBox | null {
  const start = face.triangleStart * 3;
  const end = (face.triangleStart + face.triangleCount) * 3;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > mesh.indices.length
  ) {
    return null;
  }
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let index = start; index < end; index += 1) {
    const vertex = (mesh.indices[index] ?? 0) * 3;
    const x = mesh.vertices[vertex];
    const y = mesh.vertices[vertex + 1];
    const z = mesh.vertices[vertex + 2];
    if (x === undefined || y === undefined || z === undefined) {
      return null;
    }
    min.x = Math.min(min.x, x);
    min.y = Math.min(min.y, y);
    min.z = Math.min(min.z, z);
    max.x = Math.max(max.x, x);
    max.y = Math.max(max.y, y);
    max.z = Math.max(max.z, z);
  }
  return { min, max };
}

/**
 * The world-space box of the one face or body a point-style figure (an
 * area, a diameter, a body) describes. Null for spans and angles, which the
 * viewport places along their own geometry, and whenever the target does not
 * resolve against `bodies` — which must be the bodies the viewport draws, not
 * the committed ones, or a parameter preview would leave the label beside
 * the face as it was before the edit.
 */
export function measurementExtent(
  measurement: Measurement,
  bodies: readonly BodyRepresentation[]
): MeasurementExtent | null {
  const [target, ...rest] = measurement.targets;
  if (
    annotationGraphic(measurement.kind) !== 'anchor' ||
    !target ||
    rest.length > 0
  ) {
    return null;
  }
  const body = bodies.find((candidate) => candidate.bodyId === target.bodyId);
  if (!body) {
    return null;
  }
  const face =
    target.kind === 'face'
      ? findFace(body, selectionForTarget(target))
      : undefined;
  const box =
    target.kind === 'body'
      ? body.bbox
      : face
        ? faceMeshBounds(body.mesh, face)
        : null;
  return box ? { bodyId: body.bodyId, min: box.min, max: box.max } : null;
}

export function measurementToViewportAnnotation(
  measurement: Measurement,
  options: MeasurementDisplayOptions,
  selected: boolean,
  bodies: readonly BodyRepresentation[] = []
): MeasurementViewportAnnotation | null {
  // An unresolved row's number belongs to geometry the model no longer
  // has, so nothing is drawn for it, whatever it still carries (#2359).
  if (
    !measurement.visible ||
    !measurement.annotation ||
    measurement.status === 'unresolved'
  ) {
    return null;
  }
  const formatted = formatMeasurement(measurement, options);
  const extent = measurementExtent(measurement, bodies);
  return {
    id: measurement.id,
    label: formatted.value,
    selected,
    status: measurement.status,
    graphic: annotationGraphic(measurement.kind),
    anchor: measurement.annotation.anchor,
    segments: measurement.annotation.segments,
    ...(extent ? { extent } : {})
  };
}

export function measurementsToText(
  list: readonly Measurement[],
  options: MeasurementDisplayOptions
): string {
  return list
    .map((entry) => {
      const formatted = formatMeasurement(entry, options, 'text');
      return [
        entry.label,
        formatted.value,
        formatted.detail ?? '',
        formatted.quality,
        entry.status,
        entry.note ?? ''
      ]
        .map((value) => delimitedCell(value, '\t'))
        .join('\t');
    })
    .join('\n');
}

function delimitedCell(value: string | number, delimiter: ',' | '\t'): string {
  const text = spreadsheetCell(value);
  const needsQuotes = text.includes(delimiter) || /["\r\n]/.test(text);
  return needsQuotes ? `"${text.replaceAll('"', '""')}"` : text;
}

function spreadsheetCell(value: string | number): string {
  const text = String(value);
  const formulaLike = /^[=+\-@\t\r]/.test(text) || /^\s+[=+\-@]/.test(text);
  return typeof value === 'string' && formulaLike ? `'${text}` : text;
}

export function measurementsToCsv(
  list: readonly Measurement[],
  options: MeasurementDisplayOptions
): string {
  const rows = list.map((entry) => {
    const resultUnit = unitLabel(entry.result.dimension, options.unit);
    // #2356: the number and the kind it is filed under agree. A circle read
    // as a radius exports `radius`, so a sheet that groups rows by kind
    // never reads half a diameter as one.
    const asRadius =
      entry.kind === 'diameter' && options.radialDisplay === 'radius';
    const value = convertedValue(
      asRadius ? entry.result.value / 2 : entry.result.value,
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
      asRadius ? 'radius' : entry.kind,
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
      entry.checkedRevision ?? entry.sourceRevision,
      entry.note ?? ''
    ]
      .map((value) => delimitedCell(value, ','))
      .join(',');
  });
  return [
    'kind,label,target_a,target_b,value,unit,delta_x,delta_y,delta_z,secondary_value,secondary_unit,quality,status,source_revision,checked_revision,note',
    ...rows
  ].join('\n');
}

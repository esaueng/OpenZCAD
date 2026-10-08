import type {
  BodyRepresentation,
  BoundingBox,
  EdgeTopology,
  FaceAreaProvenance,
  FaceTopology,
  TopologyReferenceV5,
  TopologySelection,
  UnitSystem,
  Vector3
} from '@openzcad/shared';
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

export type MeasurementMode = 'smart' | 'distance' | 'angle';

export type MeasurementKind =
  | 'edge-length'
  | 'edge-total'
  | 'diameter'
  | 'face-area'
  | 'body'
  | 'distance'
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
  if (measurement.kind === 'distance' || measurement.kind === 'angle') {
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

/** Re-resolve only by authoritative body/topology identity; never proximity. */
export function refreshMeasurements(
  list: readonly Measurement[],
  bodies: readonly BodyRepresentation[],
  sourceRevision: number,
  options: { force?: boolean } = {}
): Measurement[] {
  let changed = false;
  const refreshedList = list.map((measurement) => {
    if (!options.force && measurement.sourceRevision === sourceRevision) {
      return measurement;
    }
    if (!hasValidTargetArity(measurement)) {
      if (
        measurement.status === 'unresolved' &&
        measurement.reason === 'not-found' &&
        measurement.sourceRevision === sourceRevision
      ) {
        return measurement;
      }
      changed = true;
      return {
        ...measurement,
        status: 'unresolved' as const,
        sourceRevision,
        reason: 'not-found' as const
      };
    }
    const purpose: MeasurementMode =
      measurement.kind === 'distance' || measurement.kind === 'point-angle'
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
        reason: failure ?? undefined
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
    if (
      measurement.status === 'stale' &&
      measurement.reason === undefined &&
      measurement.sourceRevision === sourceRevision
    ) {
      return measurement;
    }
    changed = true;
    // Every target resolved, yet no measurement could be rebuilt from them —
    // the topology is present but no longer supports this kind of figure.
    return {
      ...measurement,
      status: 'stale' as const,
      sourceRevision,
      reason: undefined
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
  if (!measurement.visible || !measurement.annotation) {
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
  return typeof value === 'string' && formulaLike
    ? `'${text}`
    : text;
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
      .map((value) => delimitedCell(value, ','))
      .join(',');
  });
  return [
    'kind,label,target_a,target_b,value,unit,delta_x,delta_y,delta_z,secondary_value,secondary_unit,quality,status,source_revision,note',
    ...rows
  ].join('\n');
}

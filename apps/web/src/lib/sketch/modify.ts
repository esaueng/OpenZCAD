/**
 * Pure logic behind the sketch rail's app-side modify tools — Trim, Mirror,
 * and the linear and circular patterns. None of them needs the kernel: the
 * geometry is exact line/circle arithmetic on the evaluated sketch, and each
 * tool's whole result is one list of commands the app commits as a single
 * undoable transaction.
 *
 * The constraint graph is treated as part of the geometry. A trim moves or
 * splits an entity, so every relation that named a point it removed is
 * dropped, a relation on a point it kept stays, and a relation on the end of
 * a split moves to the piece that end now belongs to. A mirror or pattern
 * copy is linked back to its source with relations the solver already
 * understands, so the next solve moves them together.
 */
import {
  commandFactories,
  composeCommands,
  type AnyCommand
} from '@openzcad/command-system';
import {
  boundedArcSweepDegrees,
  boundedPolygonSides,
  computeSketchProfileAnalysis,
  geometryTolerance
} from '@openzcad/geometry';
import {
  createId,
  sketchCompositeTargetMemberIds,
  sketchReferenceDimensionObjectIds,
  toEntityId,
  type EntityId,
  type ParamValue,
  type ProjectDocument,
  type SketchConstraint,
  type SketchConstraintData,
  type SketchId,
  type SketchNode,
  type SketchObjectData,
  type SketchPointRef
} from '@openzcad/shared';

export interface Point2 {
  x: number;
  y: number;
}

type Resolve = (value: ParamValue) => number | undefined;

type LineData = Extract<SketchObjectData, { objectKind: 'line' }>;
type ArcData = Extract<SketchObjectData, { objectKind: 'arc' }>;
type CircleData = Extract<SketchObjectData, { objectKind: 'circle' }>;

/** One evaluated curve, in sketch coordinates and radians. */
export type Curve2 =
  | { kind: 'line'; a: Point2; b: Point2 }
  | { kind: 'circle'; c: Point2; r: number }
  /** Counter-clockwise from `start` through `sweep` (0, 2π]. */
  | { kind: 'arc'; c: Point2; r: number; start: number; sweep: number };

const TAU = Math.PI * 2;
/** Model-unit slack for "this point lies on that curve". */
const ON_CURVE = 1e-7;
/** Parameter slack for "this crossing is the entity's own end". */
const PARAM_EPS = 1e-9;
/** Radians an arc end may be overshot and still count, as the profile builder allows. */
const ARC_END_SLACK = 1e-9;

/** The most copies one pattern makes, so a typo cannot flood the sketch. */
export const MAX_PATTERN_COUNT = 100;

function normalizeAngle(angle: number): number {
  const wrapped = angle % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

function toDeg(angle: number): number {
  // Stored arcs read best in [0, 360); 1e-9° of rounding keeps 359.9999999…
  // from surviving as a near-full value.
  const deg = (normalizeAngle(angle) * 180) / Math.PI;
  return Math.abs(deg - 360) < 1e-9 ? 0 : deg;
}

/**
 * The arc's counter-clockwise sweep in radians, read exactly as the profile
 * builder reads it (`boundedArcSweepDegrees`): a full turn is an end one
 * turn past the start, and equal angles are no arc at all. Null when the
 * profile builder would reject the arc.
 */
function arcSweep(startDeg: number, endDeg: number): number | null {
  try {
    return (boundedArcSweepDegrees(startDeg, endDeg) * Math.PI) / 180;
  } catch {
    return null;
  }
}

function evaluateNumbers(
  values: readonly ParamValue[],
  resolve: Resolve
): number[] | null {
  const out: number[] = [];
  for (const value of values) {
    const number = resolve(value);
    if (number === undefined || !Number.isFinite(number)) {
      return null;
    }
    out.push(number);
  }
  return out;
}

/** Evaluate a primitive sketch object; null when it is composite or unresolved. */
export function evaluateCurve(
  data: SketchObjectData,
  resolve: Resolve
): Curve2 | null {
  if (data.objectKind === 'line') {
    const v = evaluateNumbers([data.x1, data.y1, data.x2, data.y2], resolve);
    return v
      ? { kind: 'line', a: { x: v[0]!, y: v[1]! }, b: { x: v[2]!, y: v[3]! } }
      : null;
  }
  if (data.objectKind === 'circle') {
    const v = evaluateNumbers(
      [data.centerX, data.centerY, data.radius],
      resolve
    );
    return v && v[2]! > 0
      ? { kind: 'circle', c: { x: v[0]!, y: v[1]! }, r: v[2]! }
      : null;
  }
  if (data.objectKind === 'arc') {
    const v = evaluateNumbers(
      [
        data.centerX,
        data.centerY,
        data.radius,
        data.startAngleDeg,
        data.endAngleDeg
      ],
      resolve
    );
    const sweep = v ? arcSweep(v[3]!, v[4]!) : null;
    return v && v[2]! > 0 && sweep !== null
      ? {
          kind: 'arc',
          c: { x: v[0]!, y: v[1]! },
          r: v[2]!,
          start: normalizeAngle((v[3]! * Math.PI) / 180),
          sweep
        }
      : null;
  }
  return null;
}

/**
 * Every curve an object contributes as a trim boundary. Composite outlines
 * cut too — a line trimmed back to a rectangle's edge is ordinary — though
 * nothing can be attached to them afterwards. Text is left out: its glyph
 * outlines need font data this module does not load.
 */
function cutterCurves(data: SketchObjectData, resolve: Resolve): Curve2[] {
  if (data.objectKind === 'polygon') {
    const v = evaluateNumbers(
      [data.sides, data.radius, data.centerX, data.centerY],
      resolve
    );
    if (!v || !(v[1]! > 0)) {
      return [];
    }
    // The profile builder's own side limits: a polygon it rejects is not
    // drawn, so it must not cut either.
    let sides: number;
    try {
      sides = boundedPolygonSides(v[0]!);
    } catch {
      return [];
    }
    const [, radius, cx, cy] = v as [number, number, number, number];
    // The profile builder's vertices (packages/geometry regions.ts): top
    // first, counter-clockwise.
    const corners = Array.from({ length: sides }, (_, index) => {
      const angle = (index / sides) * TAU + Math.PI / 2;
      return {
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius
      };
    });
    return corners.map((a, index) => ({
      kind: 'line' as const,
      a,
      b: corners[(index + 1) % sides]!
    }));
  }
  if (data.objectKind === 'rectangle') {
    const v = evaluateNumbers(
      [data.width, data.height, data.centerX, data.centerY],
      resolve
    );
    if (!v) {
      return [];
    }
    const [w, h, cx, cy] = v as [number, number, number, number];
    const corners = [
      { x: cx - w / 2, y: cy - h / 2 },
      { x: cx + w / 2, y: cy - h / 2 },
      { x: cx + w / 2, y: cy + h / 2 },
      { x: cx - w / 2, y: cy + h / 2 }
    ];
    return corners.map((a, index) => ({
      kind: 'line' as const,
      a,
      b: corners[(index + 1) % 4]!
    }));
  }
  const curve = evaluateCurve(data, resolve);
  return curve ? [curve] : [];
}

function sub(a: Point2, b: Point2): Point2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

function dot(a: Point2, b: Point2): number {
  return a.x * b.x + a.y * b.y;
}

function cross(a: Point2, b: Point2): number {
  return a.x * b.y - a.y * b.x;
}

function distance(a: Point2, b: Point2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** True when `point` (already on the curve's circle) lies inside the arc. */
function withinArc(curve: Curve2, point: Point2): boolean {
  if (curve.kind !== 'arc') {
    return true;
  }
  const offset = normalizeAngle(
    Math.atan2(point.y - curve.c.y, point.x - curve.c.x) - curve.start
  );
  // The profile builder's own angular slack (`arcOffsetsOnArc`), not a
  // length over the radius: a scaled tolerance would reach past the ends.
  return offset <= curve.sweep + ARC_END_SLACK || offset >= TAU - ARC_END_SLACK;
}

function withinSegment(
  a: Point2,
  b: Point2,
  point: Point2,
  tol = ON_CURVE
): boolean {
  const ab = sub(b, a);
  const length = Math.hypot(ab.x, ab.y);
  if (length === 0) {
    return false;
  }
  const t = dot(sub(point, a), ab) / (length * length);
  const slack = tol / length;
  return t >= -slack && t <= 1 + slack;
}

function lineCircleCrossings(
  a: Point2,
  b: Point2,
  c: Point2,
  r: number
): Point2[] {
  const d = sub(b, a);
  const f = sub(a, c);
  const qa = dot(d, d);
  if (qa === 0) {
    return [];
  }
  const qb = 2 * dot(f, d);
  const qc = dot(f, f) - r * r;
  let disc = qb * qb - 4 * qa * qc;
  // Only floating-point noise is forgiven: an exact tangent can round a
  // hair negative. A real radial gap, however small, is no crossing — the
  // profile builder's segment/arc intersection drops it the same way.
  if (disc < 0 && disc >= -1e-12 * (qb * qb + Math.abs(4 * qa * qc))) {
    disc = 0;
  }
  const foot = -qb / (2 * qa);
  if (disc < 0) {
    return [];
  }
  const root = Math.sqrt(disc);
  const ts =
    root === 0 ? [foot] : [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)];
  return ts.map((t) => ({ x: a.x + d.x * t, y: a.y + d.y * t }));
}

function circleCircleCrossings(
  c1: Point2,
  r1: number,
  c2: Point2,
  r2: number,
  tol = ON_CURVE
): Point2[] {
  const d = distance(c1, c2);
  // Centres closer than the tolerance are concentric to the profile
  // builder (`arcArcIntersections`), which then finds no crossing at all.
  if (d < tol || d > r1 + r2 + tol || d < Math.abs(r1 - r2) - tol) {
    return [];
  }
  const along = (d * d + r1 * r1 - r2 * r2) / (2 * d);
  const h = Math.sqrt(Math.max(r1 * r1 - along * along, 0));
  const ux = (c2.x - c1.x) / d;
  const uy = (c2.y - c1.y) / d;
  const mid = { x: c1.x + ux * along, y: c1.y + uy * along };
  if (h <= tol) {
    return [mid];
  }
  return [
    { x: mid.x - uy * h, y: mid.y + ux * h },
    { x: mid.x + uy * h, y: mid.y - ux * h }
  ];
}

/** Points where two curves cross or touch, bounded to both curves. */
export function curveCrossings(
  first: Curve2,
  second: Curve2,
  /** How far past its ends `first` may still touch, in model units. */
  tol = ON_CURVE,
  /** The same for `second`, which may sit at another scale (a guide). */
  secondTol = tol,
  /**
   * Both curves are profile geometry, judged at this tolerance by the
   * profile builder; its parallel cutoff then applies as well.
   */
  profileTol?: number
): Point2[] {
  // Where the two curves meet is judged at the tighter of the two.
  const touch = Math.min(tol, secondTol);
  if (first.kind === 'line' && second.kind === 'line') {
    const d1 = sub(first.b, first.a);
    const d2 = sub(second.b, second.a);
    const denom = cross(d1, d2);
    // `denom` is |d1|·|d2|·sin θ: parallel is a test on the angle, so a
    // long target and a short cutter are judged fairly. Between two profile
    // curves the profile builder's own cutoff (`segSegIntersections`,
    // |denom| < tol²) applies too, so tiny segments agree with it.
    if (
      Math.abs(denom) <=
        Math.hypot(d1.x, d1.y) * Math.hypot(d2.x, d2.y) * 1e-12 ||
      (profileTol !== undefined && Math.abs(denom) < profileTol * profileTol)
    ) {
      return [];
    }
    const delta = sub(second.a, first.a);
    const t = cross(delta, d2) / denom;
    const point = { x: first.a.x + d1.x * t, y: first.a.y + d1.y * t };
    return withinSegment(first.a, first.b, point, tol) &&
      withinSegment(second.a, second.b, point, secondTol)
      ? [point]
      : [];
  }
  if (first.kind === 'line' || second.kind === 'line') {
    const lineFirst = first.kind === 'line';
    const [line, round] = (lineFirst ? [first, second] : [second, first]) as [
      Extract<Curve2, { kind: 'line' }>,
      Exclude<Curve2, { kind: 'line' }>
    ];
    const lineTol = lineFirst ? tol : secondTol;
    return lineCircleCrossings(line.a, line.b, round.c, round.r).filter(
      (point) =>
        withinSegment(line.a, line.b, point, lineTol) && withinArc(round, point)
    );
  }
  return circleCircleCrossings(
    first.c,
    first.r,
    second.c,
    second.r,
    touch
  ).filter((point) => withinArc(first, point) && withinArc(second, point));
}

/** Where a point sits along a curve: 0…1 on a line, radians on a round. */
function curveParam(curve: Curve2, point: Point2): number {
  if (curve.kind === 'line') {
    const ab = sub(curve.b, curve.a);
    return dot(sub(point, curve.a), ab) / dot(ab, ab);
  }
  const angle = Math.atan2(point.y - curve.c.y, point.x - curve.c.x);
  return curve.kind === 'circle'
    ? normalizeAngle(angle)
    : normalizeAngle(angle - curve.start);
}

function pointOnCurve(curve: Curve2, param: number): Point2 {
  if (curve.kind === 'line') {
    return {
      x: curve.a.x + (curve.b.x - curve.a.x) * param,
      y: curve.a.y + (curve.b.y - curve.a.y) * param
    };
  }
  const angle = curve.kind === 'circle' ? param : curve.start + param;
  return {
    x: curve.c.x + Math.cos(angle) * curve.r,
    y: curve.c.y + Math.sin(angle) * curve.r
  };
}

function sketchObject(
  document: ProjectDocument,
  sketch: SketchNode,
  objectId: string
): SketchObjectData | null {
  if (!sketch.objectIds.includes(objectId as EntityId)) {
    return null;
  }
  const node = document.nodes[objectId as EntityId];
  return node?.kind === 'sketch-object' ? node.data : null;
}

function newEntityId(): EntityId {
  return toEntityId(createId('ent'));
}

function withConstruction<T extends SketchObjectData>(
  data: T,
  source: SketchObjectData
): T {
  return source.construction ? { ...data, construction: true } : data;
}

function lineObject(a: Point2, b: Point2): LineData {
  return { objectKind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

export function curveObject(
  curve: Curve2,
  source: SketchObjectData
): SketchObjectData {
  if (curve.kind === 'line') {
    return withConstruction(lineObject(curve.a, curve.b), source);
  }
  // A full-sweep copy is written as the circle it is. The solver keeps an
  // arc's two ends as separate points, so a new 360° arc's seam could open
  // on the next solve; a circle has no seam to open.
  if (
    curve.kind === 'circle' ||
    (curve.kind === 'arc' && curve.sweep >= TAU - 1e-9)
  ) {
    return withConstruction<CircleData>(
      {
        objectKind: 'circle',
        centerX: curve.c.x,
        centerY: curve.c.y,
        radius: curve.r
      },
      source
    );
  }
  return withConstruction<ArcData>(
    {
      objectKind: 'arc',
      centerX: curve.c.x,
      centerY: curve.c.y,
      radius: curve.r,
      startAngleDeg: toDeg(curve.start),
      // The end is written as start plus sweep, never wrapped, so a full
      // turn stays a 360° arc rather than collapsing to equal angles.
      endAngleDeg: toDeg(curve.start) + (curve.sweep * 180) / Math.PI
    },
    source
  );
}

/** Composite objects carry no point identity, so the tools refuse them by name. */
function compositeRefusal(data: SketchObjectData, verb: string): string | null {
  switch (data.objectKind) {
    case 'rectangle':
    case 'polygon':
      return `A ${data.objectKind} is one object with no point identity. Draw it as lines to ${verb} part of it.`;
    case 'text':
      return `Text is one object; ${verb} is not available for it.`;
    case 'ellipse':
      return `${verb[0]!.toUpperCase()}${verb.slice(1)} is not available for an ellipse yet.`;
    case 'spline':
      return `${verb[0]!.toUpperCase()}${verb.slice(1)} is not available for a spline yet.`;
    default:
      return null;
  }
}

function constraintsOf(sketch: SketchNode): readonly SketchConstraint[] {
  return sketch.constraints ?? [];
}

function referenceDimensionsOn(
  sketch: SketchNode,
  objectId: EntityId
): boolean {
  return (sketch.referenceDimensions ?? []).some((dimension) => {
    return sketchReferenceDimensionObjectIds(dimension.data).includes(objectId);
  });
}

/**
 * True when a reference distance measures this point. A trim that moves or
 * re-homes the point would leave the dimension silently measuring something
 * else, so those trims are refused instead.
 */
function referenceMeasuresPoint(
  sketch: SketchNode,
  ref: SketchPointRef
): boolean {
  return (sketch.referenceDimensions ?? []).some(({ data }) => {
    if (data.dimensionKind === 'distance')
      return [data.a, data.b].some((point) =>
        'objectId' in point
          ? point.objectId === ref.objectId && point.point === ref.point
          : sketchCompositeTargetMemberIds(point).includes(ref.objectId)
      );
    return (
      data.dimensionKind === 'angle' &&
      [data.a, data.b].some(
        (side) =>
          typeof side !== 'string' &&
          sketchCompositeTargetMemberIds(side).includes(ref.objectId)
      )
    );
  });
}

const MOVED_END_MEASURED =
  'A reference dimension measures the end this trim would move. Delete the dimension first.';

// ---------------------------------------------------------------------------
// Constraint remapping

type PointName = SketchPointRef['point'];

/**
 * How a trim treats the trimmed entity's relations. A point listed with a
 * ref moves there; listed with null it is gone, and so is every relation on
 * it. `replacement` re-homes the whole entity (a trimmed circle becomes a
 * new arc). `lengthChanged` drops what a line's length fed — equal length
 * and the midpoint of the line.
 */
interface RemapPlan {
  objectId: EntityId;
  points: Partial<Record<PointName, SketchPointRef | null>>;
  replacement?: EntityId;
  lengthChanged: boolean;
  /**
   * Which piece a point held on the trimmed entity now belongs to, after a
   * split; the entity itself when absent.
   */
  homeFor?: (point: SketchPointRef) => EntityId;
}

function remapConstraint(
  data: SketchConstraintData,
  plan: RemapPlan
): SketchConstraintData | null {
  const id = plan.objectId;
  const mapRef = (ref: SketchPointRef): SketchPointRef | null => {
    if (ref.objectId !== id) {
      return ref;
    }
    if (ref.point in plan.points) {
      return plan.points[ref.point] ?? null;
    }
    return plan.replacement
      ? { objectId: plan.replacement, point: ref.point }
      : ref;
  };
  const mapObject = (objectId: EntityId): EntityId =>
    objectId === id ? (plan.replacement ?? id) : objectId;
  switch (data.constraintKind) {
    case 'coincident':
    case 'distance': {
      const a = mapRef(data.a);
      const b = mapRef(data.b);
      return a && b ? { ...data, a, b } : null;
    }
    case 'symmetric': {
      const a = mapRef(data.a);
      const b = mapRef(data.b);
      return a && b ? { ...data, a, b, axis: mapObject(data.axis) } : null;
    }
    case 'lock': {
      const point = mapRef(data.point);
      return point ? { ...data, point } : null;
    }
    case 'point-on-object': {
      const point = mapRef(data.point);
      if (!point) {
        return null;
      }
      const objectId =
        data.objectId === id && plan.homeFor
          ? plan.homeFor(data.point)
          : mapObject(data.objectId);
      return { ...data, point, objectId };
    }
    case 'midpoint': {
      if (data.line === id && plan.lengthChanged) {
        return null;
      }
      const point = mapRef(data.point);
      return point ? { ...data, point, line: mapObject(data.line) } : null;
    }
    case 'horizontal':
    case 'vertical':
    case 'radius':
      return { ...data, objectId: mapObject(data.objectId) };
    case 'equal':
      if ((data.a === id || data.b === id) && plan.lengthChanged) {
        return null;
      }
      return { ...data, a: mapObject(data.a), b: mapObject(data.b) };
    case 'parallel':
    case 'perpendicular':
    case 'concentric':
    case 'angle':
      return { ...data, a: mapObject(data.a), b: mapObject(data.b) };
    case 'tangent': {
      if (!data.at) {
        // The point-free form is line-to-circle; a circle replaced by an arc
        // would need a contact point nobody chose.
        return plan.replacement && (data.a === id || data.b === id)
          ? null
          : data;
      }
      const at = mapRef(data.at);
      if (!at) {
        return null;
      }
      // The arc side follows its contact point: a split's far end moves to
      // the new piece, and the tangent must name that piece as its arc.
      const side = (objectId: EntityId) =>
        objectId === data.at!.objectId ? at.objectId : mapObject(objectId);
      return { ...data, a: side(data.a), b: side(data.b), at };
    }
  }
}

/** Where a constraint point sits now, or null when it does not evaluate. */
function pointPosition(
  document: ProjectDocument,
  sketch: SketchNode,
  ref: SketchPointRef,
  resolve: Resolve
): Point2 | null {
  const data = sketchObject(document, sketch, ref.objectId);
  const curve = data ? evaluateCurve(data, resolve) : null;
  if (!curve) {
    return null;
  }
  if (curve.kind === 'line') {
    return ref.point === 'start'
      ? curve.a
      : ref.point === 'end'
        ? curve.b
        : null;
  }
  if (ref.point === 'center' || curve.kind === 'circle') {
    return curve.c;
  }
  return pointOnCurve(curve, ref.point === 'start' ? 0 : curve.sweep);
}

function referencesObject(
  data: SketchConstraintData,
  objectId: EntityId
): boolean {
  return JSON.stringify(data).includes(`"${objectId}"`);
}

/**
 * The commands that bring the trimmed entity's relations in line with the
 * plan: unchanged ones are left alone, the rest are deleted and, when they
 * survive in a new form, re-added. With `replacement`, the original object
 * is deleted afterwards, which takes its old relations with it.
 */
function remapCommands(
  sketch: SketchNode,
  sketchId: SketchId,
  plan: RemapPlan
): { release: AnyCommand[]; restate: AnyCommand[]; dropped: number } {
  const release: AnyCommand[] = [];
  const restate: AnyCommand[] = [];
  let dropped = 0;
  for (const constraint of constraintsOf(sketch)) {
    if (!referencesObject(constraint.data, plan.objectId)) {
      continue;
    }
    const next = remapConstraint(constraint.data, plan);
    if (next && JSON.stringify(next) === JSON.stringify(constraint.data)) {
      continue;
    }
    if (!next) {
      dropped += 1;
    }
    if (!plan.replacement) {
      release.push(
        commandFactories.deleteSketchConstraint(
          { sketchId, constraintId: constraint.constraintId },
          'Release trimmed geometry'
        )
      );
    }
    if (next) {
      restate.push(
        // The same identity, so a placed dimension label stays where the
        // user put it.
        commandFactories.addSketchConstraint(
          {
            sketchId,
            constraint: next,
            ids: { constraintId: constraint.constraintId }
          },
          'Restate trimmed geometry'
        )
      );
    }
  }
  return { release, restate, dropped };
}

/**
 * The length under which a trim fragment counts as nothing: the profile
 * builder's tolerance for profile geometry, which it would otherwise drop
 * as degenerate, and the fixed on-curve slack for a construction guide,
 * which never reaches the profile builder.
 */
function trimTolerance(
  document: ProjectDocument,
  sketch: SketchNode,
  target: SketchObjectData,
  resolve: Resolve
): number {
  return target.construction
    ? ON_CURVE
    : profileTolerance(document, sketch, [], resolve);
}

// ---------------------------------------------------------------------------
// Trim

export type SketchModifyPlan =
  | { status: 'refuse'; reason: string }
  | {
      status: 'commands';
      label: string;
      message: string;
      commands: AnyCommand[];
      /**
       * Relations the tool would add unless the sketch already implies
       * them, appended after `commands`. Only a solve can tell, so the
       * caller keeps the ones `settleOptionalRelations` says the solver
       * needs; committing `commands` alone drops them all.
       */
      optional?: AnyCommand[];
    };

interface Crossing {
  param: number;
  /** The object it was cut against, when that object can carry a relation. */
  cutter: EntityId | null;
}

/** Entities the profile classifier rejects outright, by id. */
function profileExcluded(
  document: ProjectDocument,
  sketch: SketchNode,
  resolve: Resolve
): Set<string> {
  const objects = sketch.objectIds.flatMap((objectId) => {
    const data = sketchObject(document, sketch, objectId);
    return data ? [{ id: String(objectId), data }] : [];
  });
  try {
    return new Set(
      computeSketchProfileAnalysis(
        objects,
        (value) => resolve(value) ?? Number.NaN
      )
        .diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
        .flatMap((diagnostic) => diagnostic.sourceEntityIds)
    );
  } catch {
    return new Set();
  }
}

function crossingsOn(
  document: ProjectDocument,
  sketch: SketchNode,
  targetId: EntityId,
  target: Curve2,
  resolve: Resolve,
  tol: number,
  /** The target is construction geometry, outside profile analysis. */
  targetConstruction: boolean
): Crossing[] {
  const profileTol = profileTolerance(document, sketch, [], resolve);
  const excluded = profileExcluded(document, sketch, resolve);
  const crossings: Crossing[] = [];
  for (const objectId of sketch.objectIds) {
    if (objectId === targetId) {
      continue;
    }
    const data = sketchObject(document, sketch, objectId);
    if (!data) {
      continue;
    }
    // Profile geometry the profile builder discards (degenerate, duplicate,
    // overlapping, self-crossing) bounds nothing, so it cuts nothing either.
    if (!data.construction && excluded.has(String(objectId))) {
      continue;
    }
    const constrainable =
      data.objectKind === 'line' ||
      data.objectKind === 'arc' ||
      data.objectKind === 'circle';
    const profilePair = !data.construction && !targetConstruction;
    for (const cutter of cutterCurves(data, resolve)) {
      // A construction cutter keeps the fixed slack: it is not part of the
      // profile scale, so a scaled tolerance would reach past its ends.
      for (const point of curveCrossings(
        target,
        cutter,
        tol,
        // A construction target never meets profile analysis, so neither
        // side of the pair gets the profile-scaled bound.
        profilePair ? profileTol : ON_CURVE,
        profilePair ? profileTol : undefined
      )) {
        crossings.push({
          param: curveParam(target, point),
          cutter: constrainable ? objectId : null
        });
      }
    }
  }
  return crossings;
}

function pointRelation(
  sketchId: SketchId,
  point: SketchPointRef,
  cutter: EntityId | null
): AnyCommand[] {
  return cutter
    ? [
        commandFactories.addSketchConstraint(
          {
            sketchId,
            constraint: {
              constraintKind: 'point-on-object',
              point,
              objectId: cutter
            }
          },
          'Hold the trimmed end on its boundary'
        )
      ]
    : [];
}

function droppedNote(dropped: number): string {
  return dropped === 0
    ? ''
    : ` Dropped ${dropped} relation${dropped === 1 ? '' : 's'} on the removed part.`;
}

/** A click on a crossing names no segment: both sides end there. */
const ON_CROSSING =
  'That click is on a crossing. Click the part of the curve you want to remove.';

function deleteWhole(
  sketch: SketchNode,
  sketchId: SketchId,
  objectId: EntityId,
  kind: string
): SketchModifyPlan {
  if (referenceDimensionsOn(sketch, objectId)) {
    return {
      status: 'refuse',
      reason: `Nothing crosses that ${kind}, so Trim would delete it, and a reference dimension measures it. Delete the dimension first.`
    };
  }
  const dropped = constraintsOf(sketch).filter((constraint) =>
    referencesObject(constraint.data, objectId)
  ).length;
  return {
    status: 'commands',
    label: 'Trim',
    message: `Trim removed the whole ${kind}: nothing crosses it.${droppedNote(dropped)}`,
    commands: [
      commandFactories.deleteSketchObject(
        { sketchId, objectId },
        'Trim sketch geometry'
      )
    ]
  };
}

/**
 * Trim the picked line, arc or circle back to the crossings either side of
 * the click. The segment under the click goes; what is left keeps its
 * identity where it can — the trimmed entity is updated in place, a middle
 * cut adds one new piece for the far side — and each new end is held on the
 * curve that cut it.
 */
export function planSketchTrim(
  document: ProjectDocument,
  sketch: SketchNode,
  sketchId: SketchId,
  objectId: string,
  at: Point2,
  resolve: Resolve
): SketchModifyPlan {
  const data = sketchObject(document, sketch, objectId);
  if (!data) {
    return {
      status: 'refuse',
      reason: 'That object is not part of this sketch.'
    };
  }
  const composite = compositeRefusal(data, 'trim');
  if (composite) {
    return { status: 'refuse', reason: composite };
  }
  const curve = evaluateCurve(data, resolve);
  if (!curve) {
    return {
      status: 'refuse',
      reason: 'That entity has a dimension that does not evaluate.'
    };
  }
  const id = objectId as EntityId;
  // The profile builder's tolerance, so a cutter it treats as touching the
  // target cuts here too (a guide keeps the fixed slack).
  const tol = trimTolerance(document, sketch, data, resolve);

  // A full-sweep arc is a closed round whose seam is arbitrary: it trims
  // like a circle, with crossings chosen round the wrap, not from the seam.
  if (
    curve.kind === 'circle' ||
    (curve.kind === 'arc' && curve.sweep >= TAU - 1e-9)
  ) {
    const round = { kind: 'circle' as const, c: curve.c, r: curve.r };
    return trimCircle(
      sketch,
      sketchId,
      id,
      data as CircleData | ArcData,
      round,
      crossingsOn(
        document,
        sketch,
        id,
        round,
        resolve,
        tol,
        Boolean(data.construction)
      ),
      at,
      Math.max(PARAM_EPS * TAU, tol / curve.r)
    );
  }
  const crossings = crossingsOn(
    document,
    sketch,
    id,
    curve,
    resolve,
    tol,
    Boolean(data.construction)
  );
  const span = curve.kind === 'line' ? 1 : curve.sweep;
  // A crossing closer to an end than the profile builder's tolerance would
  // leave a fragment it calls degenerate, so it counts as that end.
  const eps =
    curve.kind === 'line'
      ? Math.max(PARAM_EPS, tol / distance(curve.a, curve.b))
      : Math.max(PARAM_EPS * TAU, tol / curve.r);
  // A click just past an arc's end reads round through 2π; take whichever
  // end it is nearer. A line's click clamps onto the segment.
  const raw = curveParam(curve, at);
  const clickParam =
    curve.kind === 'arc' && raw > span
      ? raw - span < TAU - raw
        ? span
        : 0
      : Math.min(Math.max(raw, 0), span);
  const inside = crossings.filter((c) => c.param > eps && c.param < span - eps);
  if (inside.some((c) => Math.abs(c.param - clickParam) <= eps)) {
    return { status: 'refuse', reason: ON_CROSSING };
  }
  const below = inside
    .filter((c) => c.param < clickParam)
    .sort((a, b) => b.param - a.param)[0];
  const above = inside
    .filter((c) => c.param > clickParam)
    .sort((a, b) => a.param - b.param)[0];
  const kindName = curve.kind;
  if (!below && !above) {
    return deleteWhole(sketch, sketchId, id, kindName);
  }

  const startRef: SketchPointRef = { objectId: id, point: 'start' };
  const endRef: SketchPointRef = { objectId: id, point: 'end' };
  if (!below || !above) {
    // One end goes: that end moves to the crossing; everything on it drops.
    const keepStart = Boolean(below);
    const cut = (below ?? above)!;
    const moved = keepStart ? 'end' : 'start';
    if (referenceMeasuresPoint(sketch, keepStart ? endRef : startRef)) {
      return { status: 'refuse', reason: MOVED_END_MEASURED };
    }
    const updated = trimmedData(
      data,
      curve,
      keepStart ? 0 : cut.param,
      keepStart ? cut.param : span,
      resolve
    );
    const remap = remapCommands(sketch, sketchId, {
      objectId: id,
      points: { [moved]: null },
      lengthChanged: curve.kind === 'line'
    });
    return {
      status: 'commands',
      label: 'Trim',
      message: `Trim shortened the ${kindName}.${droppedNote(remap.dropped)}`,
      commands: [
        ...remap.release,
        commandFactories.updateSketchObject(
          { sketchId, objectId: id, data: updated },
          'Trim sketch geometry'
        ),
        ...remap.restate,
        ...pointRelation(sketchId, keepStart ? endRef : startRef, cut.cutter)
      ]
    };
  }

  // A middle cut: the entity keeps [start, below]; a new piece takes
  // [above, end], and everything on the old end moves with it.
  if (referenceMeasuresPoint(sketch, endRef)) {
    return { status: 'refuse', reason: MOVED_END_MEASURED };
  }
  const pieceId = newEntityId();
  const pieceEnd: SketchPointRef = { objectId: pieceId, point: 'end' };
  const pieceStart: SketchPointRef = { objectId: pieceId, point: 'start' };
  const remap = remapCommands(sketch, sketchId, {
    objectId: id,
    points: { end: pieceEnd },
    lengthChanged: curve.kind === 'line',
    // A point held on the curve follows the piece it sits beside: the far
    // piece past the removed span, the kept one otherwise.
    homeFor: (point) => {
      const at = pointPosition(document, sketch, point, resolve);
      if (!at) {
        return id;
      }
      const param = curveParam(curve, at);
      const inSpan = curve.kind === 'line' || param <= span + eps;
      return inSpan && param > (below.param + above.param) / 2 ? pieceId : id;
    }
  });
  const kept = trimmedData(data, curve, 0, below.param, resolve);
  // Built from the stored data, so the far end it inherits keeps any
  // expression that drove it; only the new cut end is a number.
  const piece = trimmedData(data, curve, above.param, span, resolve);
  // The far piece is the same curve: collinear for a line, the same circle
  // for an arc.
  const sameCurve: AnyCommand[] =
    curve.kind === 'line'
      ? [
          commandFactories.addSketchConstraint(
            {
              sketchId,
              constraint: { constraintKind: 'parallel', a: id, b: pieceId }
            },
            'Keep the split line straight'
          ),
          commandFactories.addSketchConstraint(
            {
              sketchId,
              constraint: {
                constraintKind: 'point-on-object',
                point: pieceEnd,
                objectId: id
              }
            },
            'Keep the split line straight'
          )
        ]
      : [
          commandFactories.addSketchConstraint(
            {
              sketchId,
              constraint: { constraintKind: 'concentric', a: id, b: pieceId }
            },
            'Keep the split arc round'
          ),
          commandFactories.addSketchConstraint(
            {
              sketchId,
              constraint: { constraintKind: 'equal', a: id, b: pieceId }
            },
            'Keep the split arc round'
          )
        ];
  return {
    status: 'commands',
    label: 'Trim',
    message: `Trim split the ${kindName} in two.${droppedNote(remap.dropped)}`,
    commands: [
      ...remap.release,
      commandFactories.updateSketchObject(
        { sketchId, objectId: id, data: kept },
        'Trim sketch geometry'
      ),
      commandFactories.addSketchObjects(
        { sketchId, objects: [piece], ids: { objectNodeIds: [pieceId] } },
        'Add the far side of the trim'
      ),
      ...remap.restate,
      ...sameCurve,
      ...pointRelation(sketchId, endRef, below.cutter),
      ...pointRelation(sketchId, pieceStart, above.cutter)
    ]
  };
}

/**
 * The entity's data with only the moved ends rewritten, so an expression on
 * a field the trim did not touch stays an expression.
 */
function trimmedData(
  data: SketchObjectData,
  curve: Curve2,
  from: number,
  to: number,
  resolve: Resolve
): SketchObjectData {
  if (curve.kind === 'line' && data.objectKind === 'line') {
    const next: LineData = { ...data };
    if (from !== 0) {
      const p = pointOnCurve(curve, from);
      next.x1 = p.x;
      next.y1 = p.y;
    }
    if (to !== 1) {
      const p = pointOnCurve(curve, to);
      next.x2 = p.x;
      next.y2 = p.y;
    }
    return next;
  }
  if (curve.kind === 'arc' && data.objectKind === 'arc') {
    // Each moved angle is written in the turn of the stored angle it is
    // measured from, so an arc stored as 400°–500° trims to 410°–500°, not
    // 50°–500°, and its sweep reads the same to the profile builder.
    const toDegrees = (radians: number) => (radians * 180) / Math.PI;
    const storedStart = resolve(data.startAngleDeg) ?? toDegrees(curve.start);
    const storedEnd =
      resolve(data.endAngleDeg) ?? storedStart + toDegrees(curve.sweep);
    const next: ArcData = { ...data };
    if (from !== 0) {
      next.startAngleDeg = storedEnd - toDegrees(curve.sweep - from);
    }
    if (to !== curve.sweep) {
      next.endAngleDeg = storedStart + toDegrees(to);
    }
    return next;
  }
  throw new Error('Trim rewrites only lines and arcs in place.');
}

function trimCircle(
  sketch: SketchNode,
  sketchId: SketchId,
  id: EntityId,
  data: CircleData | ArcData,
  curve: Extract<Curve2, { kind: 'circle' }>,
  crossings: Crossing[],
  at: Point2,
  /** Angular slack under which two crossings are one point. */
  eps: number
): SketchModifyPlan {
  const distinct: Crossing[] = [];
  for (const crossing of [...crossings].sort((a, b) => a.param - b.param)) {
    const last = distinct.at(-1);
    if (!last || crossing.param - last.param > eps) {
      distinct.push(crossing);
    }
  }
  if (
    distinct.length > 1 &&
    TAU - distinct.at(-1)!.param + distinct[0]!.param <= eps
  ) {
    distinct.pop();
  }
  const kind = data.objectKind === 'arc' ? 'arc' : 'circle';
  if (distinct.length === 0) {
    return deleteWhole(sketch, sketchId, id, kind);
  }
  if (distinct.length === 1) {
    return {
      status: 'refuse',
      reason: `Only one curve touches that ${kind}, so there is no segment between two crossings to trim.`
    };
  }
  const click = curveParam(curve, at);
  if (
    distinct.some((c) => {
      const gap = Math.abs(c.param - click);
      return Math.min(gap, TAU - gap) <= eps;
    })
  ) {
    return { status: 'refuse', reason: ON_CROSSING };
  }
  // The removed segment runs counter-clockwise from the last crossing at or
  // before the click to the first one after it, wrapping through 0.
  const before =
    [...distinct].reverse().find((c) => c.param <= click) ?? distinct.at(-1)!;
  const after = distinct.find((c) => c.param > click) ?? distinct[0]!;
  if (data.objectKind === 'arc') {
    // Already an arc: it keeps its identity and gets new ends; whatever
    // sat on the old seam goes with it.
    const startRef: SketchPointRef = { objectId: id, point: 'start' };
    const endRef: SketchPointRef = { objectId: id, point: 'end' };
    if (
      referenceMeasuresPoint(sketch, startRef) ||
      referenceMeasuresPoint(sketch, endRef)
    ) {
      return { status: 'refuse', reason: MOVED_END_MEASURED };
    }
    const startDeg = toDeg(after.param);
    const remap = remapCommands(sketch, sketchId, {
      objectId: id,
      points: { start: null, end: null },
      lengthChanged: false
    });
    return {
      status: 'commands',
      label: 'Trim',
      message: `Trim opened the full arc.${droppedNote(remap.dropped)}`,
      commands: [
        ...remap.release,
        commandFactories.updateSketchObject(
          {
            sketchId,
            objectId: id,
            data: {
              ...data,
              startAngleDeg: startDeg,
              endAngleDeg:
                startDeg + toDeg(normalizeAngle(before.param - after.param))
            }
          },
          'Trim sketch geometry'
        ),
        ...remap.restate,
        ...pointRelation(sketchId, startRef, after.cutter),
        ...pointRelation(sketchId, endRef, before.cutter)
      ]
    };
  }
  if (referenceDimensionsOn(sketch, id)) {
    return {
      status: 'refuse',
      reason:
        'Trimming a circle replaces it with an arc, and a reference dimension measures the circle. Delete the dimension first.'
    };
  }
  const arcId = newEntityId();
  const arc: ArcData = withConstruction(
    {
      objectKind: 'arc',
      centerX: data.centerX,
      centerY: data.centerY,
      radius: data.radius,
      startAngleDeg: toDeg(after.param),
      endAngleDeg: toDeg(before.param)
    },
    data
  );
  const remap = remapCommands(sketch, sketchId, {
    objectId: id,
    points: {},
    replacement: arcId,
    lengthChanged: false
  });
  return {
    status: 'commands',
    label: 'Trim',
    message: `Trim turned the circle into an arc.${droppedNote(remap.dropped)}`,
    commands: [
      commandFactories.addSketchObjects(
        { sketchId, objects: [arc], ids: { objectNodeIds: [arcId] } },
        'Trim circle to an arc'
      ),
      commandFactories.deleteSketchObject(
        { sketchId, objectId: id },
        'Trim circle to an arc'
      ),
      ...remap.restate,
      ...pointRelation(
        sketchId,
        { objectId: arcId, point: 'start' },
        after.cutter
      ),
      ...pointRelation(
        sketchId,
        { objectId: arcId, point: 'end' },
        before.cutter
      )
    ]
  };
}

// ---------------------------------------------------------------------------
// Mirror

function reflect(point: Point2, a: Point2, u: Point2): Point2 {
  const rel = sub(point, a);
  const along = dot(rel, u);
  return {
    x: a.x + 2 * along * u.x - rel.x,
    y: a.y + 2 * along * u.y - rel.y
  };
}

function sameCurve(first: Curve2, second: Curve2, tol = ON_CURVE): boolean {
  const near = (p: Point2, q: Point2) => distance(p, q) <= tol;
  if (first.kind === 'line' && second.kind === 'line') {
    return (
      (near(first.a, second.a) && near(first.b, second.b)) ||
      (near(first.a, second.b) && near(first.b, second.a))
    );
  }
  if (first.kind === 'line' || second.kind === 'line') {
    return false;
  }
  if (!near(first.c, second.c) || Math.abs(first.r - second.r) > tol) {
    return false;
  }
  // A full sweep is the whole circle wherever its seam sits.
  const full = (curve: Curve2) =>
    curve.kind === 'circle' ||
    (curve.kind === 'arc' && curve.sweep >= TAU - 1e-9);
  if (full(first) || full(second)) {
    return full(first) && full(second);
  }
  if (first.kind === 'circle' || second.kind === 'circle') {
    return false;
  }
  const s = pointOnCurve(first, 0);
  const e = pointOnCurve(first, first.sweep);
  return (
    near(s, pointOnCurve(second, 0)) &&
    near(e, pointOnCurve(second, second.sweep))
  );
}

/**
 * True when two curves share more than a point: the same circle, collinear
 * lines whose spans overlap, or co-circular arcs whose sweeps overlap.
 * Touching end to end is fine; overlapping makes the profile ambiguous.
 */
function curvesOverlap(first: Curve2, second: Curve2, tol = ON_CURVE): boolean {
  if (sameCurve(first, second, tol)) {
    return true;
  }
  if (first.kind === 'line' && second.kind === 'line') {
    const d = sub(first.b, first.a);
    const length = Math.hypot(d.x, d.y);
    const u = { x: d.x / length, y: d.y / length };
    const off = (p: Point2) => Math.abs(cross(sub(p, first.a), u));
    if (off(second.a) > tol || off(second.b) > tol) {
      return false;
    }
    const t1 = dot(sub(second.a, first.a), u);
    const t2 = dot(sub(second.b, first.a), u);
    return (
      Math.min(length, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2)) > tol
    );
  }
  if (first.kind !== 'arc' || second.kind !== 'arc') {
    // A circle overlaps any co-circular arc.
    return (
      first.kind !== 'line' &&
      second.kind !== 'line' &&
      distance(first.c, second.c) <= tol &&
      Math.abs(first.r - second.r) <= tol
    );
  }
  if (distance(first.c, second.c) > tol || Math.abs(first.r - second.r) > tol) {
    return false;
  }
  // Sweep overlap on the circle: does either arc's interior start inside
  // the other?
  const slack = tol / first.r;
  const inside = (arc: typeof first, angle: number) => {
    const offset = normalizeAngle(angle - arc.start);
    return offset > slack && offset < arc.sweep - slack;
  };
  return (
    inside(first, second.start + slack * 2) ||
    inside(second, first.start + slack * 2)
  );
}

/**
 * The relations that tie one source point to its image: symmetric about the
 * axis, or — when the point sits on the axis, where symmetry has no
 * direction — coincident plus held on the axis, which is what joins a
 * half-profile to its mirror and keeps the joint a mirror when it moves.
 *
 * The hold on the axis is optional: when the sketch already keeps the point
 * there (a relation on it or a joined point, locks, dimensions that fix both
 * the point and the axis) a second statement is one the solver reports as
 * redundant. Only a solve can tell every way a sketch does that, so the
 * caller asks one — see `settleOptionalRelations`.
 */
function mirrorLink(
  sketchId: SketchId,
  source: SketchPointRef,
  image: SketchPointRef,
  sourcePoint: Point2,
  axisId: EntityId,
  onAxis: (point: Point2) => boolean
): { required: AnyCommand[]; optional: AnyCommand[] } {
  const add = (constraint: SketchConstraintData) =>
    commandFactories.addSketchConstraint(
      { sketchId, constraint },
      'Mirror about the line'
    );
  return onAxis(sourcePoint)
    ? {
        required: [add({ constraintKind: 'coincident', a: source, b: image })],
        optional: [
          add({
            constraintKind: 'point-on-object',
            point: source,
            objectId: axisId
          })
        ]
      }
    : {
        required: [
          add({
            constraintKind: 'symmetric',
            a: source,
            b: image,
            axis: axisId
          })
        ],
        optional: []
      };
}

/** What a solve reports that redundancy is judged from. */
export interface SketchRankProbe {
  dof: { numEquations: number; rank: number };
}

/**
 * Keep each optional relation of a plan only if the solver needs it. A
 * relation is redundant when stating it adds an equation without adding
 * rank, so each one is dropped when leaving it out lowers the candidate's
 * rank deficiency (equations less rank). Judging by the deficiency rather
 * than the classification works on a sketch that is already redundant
 * elsewhere, and never drops a relation that carries rank.
 *
 * A solve that fails keeps every relation: a redundant one is a status the
 * user sees, a missing one silently stops the joint following the mirror.
 */
export async function settleOptionalRelations(
  document: ProjectDocument,
  sketchId: SketchId,
  commands: readonly AnyCommand[],
  optional: readonly AnyCommand[],
  solve: (
    document: ProjectDocument,
    sketchId: SketchId
  ) => Promise<SketchRankProbe>
): Promise<AnyCommand[]> {
  if (optional.length === 0) {
    return [...commands];
  }
  const deficiency = async (candidate: readonly AnyCommand[]) => {
    const { dof } = await solve(
      composeCommands('Probe', [...commands, ...candidate]).apply(document),
      sketchId
    );
    return dof.numEquations - dof.rank;
  };
  let kept = [...optional];
  try {
    let current = await deficiency(kept);
    for (const relation of optional) {
      if (current <= 0) {
        break;
      }
      const without = kept.filter((command) => command !== relation);
      const next = await deficiency(without);
      if (next < current) {
        kept = without;
        current = next;
      }
    }
  } catch {
    kept = [...optional];
  }
  return [...commands, ...kept];
}

/**
 * Mirror one line, arc or circle about a line. The image is a new entity
 * linked back to its source with symmetric relations (equal radius for a
 * round), so editing the source and solving moves the image with it, and
 * deleting either relation releases it.
 */
export function planSketchMirror(
  document: ProjectDocument,
  sketch: SketchNode,
  sketchId: SketchId,
  sourceId: string,
  axisId: string,
  resolve: Resolve
): SketchModifyPlan {
  const data = sketchObject(document, sketch, sourceId);
  const axisData = sketchObject(document, sketch, axisId);
  if (!data || !axisData) {
    return {
      status: 'refuse',
      reason: 'That object is not part of this sketch.'
    };
  }
  const composite = compositeRefusal(data, 'mirror');
  if (composite) {
    return { status: 'refuse', reason: composite };
  }
  if (axisData.objectKind !== 'line') {
    return {
      status: 'refuse',
      reason: 'Mirror reflects about a line. Pick a line as the mirror.'
    };
  }
  const source = evaluateCurve(data, resolve);
  const axis = evaluateCurve(axisData, resolve);
  if (!source || !axis || axis.kind !== 'line') {
    return {
      status: 'refuse',
      reason: 'That entity has a dimension that does not evaluate.'
    };
  }
  if (zeroLength(source)) {
    return { status: 'refuse', reason: ZERO_LENGTH };
  }
  const axisDir = sub(axis.b, axis.a);
  const axisLength = Math.hypot(axisDir.x, axisDir.y);
  if (axisLength === 0) {
    return { status: 'refuse', reason: 'The mirror line has no length.' };
  }
  const u = { x: axisDir.x / axisLength, y: axisDir.y / axisLength };
  const r = (point: Point2) => reflect(point, axis.a, u);
  const onAxis = (point: Point2) =>
    Math.abs(cross(sub(point, axis.a), u)) <= ON_CURVE;
  let image: Curve2;
  if (source.kind === 'line') {
    image = { kind: 'line', a: r(source.a), b: r(source.b) };
  } else if (source.kind === 'circle') {
    image = { kind: 'circle', c: r(source.c), r: source.r };
  } else {
    // A reflection reverses the sweep: the image runs counter-clockwise from
    // the source's end image to its start image.
    const axisAngle = Math.atan2(u.y, u.x);
    image = {
      kind: 'arc',
      c: r(source.c),
      r: source.r,
      start: normalizeAngle(2 * axisAngle - (source.start + source.sweep)),
      sweep: source.sweep
    };
  }
  const tol = resultTolerance(
    document,
    sketch,
    [image],
    Boolean(data.construction),
    resolve
  );
  if (sameCurve(source, image, tol)) {
    return {
      status: 'refuse',
      reason:
        'That entity is already symmetric about the line; its mirror image is itself.'
    };
  }
  // A line crossing the axis off-centre, or an arc centred on it with an
  // uneven sweep, reflects onto part of itself.
  // Construction geometry never bounds a profile, so only an exact
  // duplicate (refused above) matters for it.
  if (!data.construction && curvesOverlap(source, image, tol)) {
    return {
      status: 'refuse',
      reason:
        'The mirror image would overlap part of its source. Trim the entity at the mirror line first.'
    };
  }
  if (landsOnExisting(document, sketch, sourceId, [image], resolve, tol)) {
    return { status: 'refuse', reason: LANDS_ON_EXISTING };
  }
  const imageObject = curveObject(image, data);
  const clash = profileClash(document, sketch, [imageObject], resolve);
  if (clash) {
    return { status: 'refuse', reason: clash };
  }
  const id = sourceId as EntityId;
  const axisEntity = axisId as EntityId;
  const imageId = newEntityId();
  const ref = (objectId: EntityId, point: PointName): SketchPointRef => ({
    objectId,
    point
  });
  const links: AnyCommand[] = [];
  const optional: AnyCommand[] = [];
  const link = (
    source: SketchPointRef,
    image: SketchPointRef,
    sourcePoint: Point2
  ) => {
    const made = mirrorLink(
      sketchId,
      source,
      image,
      sourcePoint,
      axisEntity,
      onAxis
    );
    links.push(...made.required);
    optional.push(...made.optional);
  };
  if (source.kind === 'line') {
    link(ref(id, 'start'), ref(imageId, 'start'), source.a);
    link(ref(id, 'end'), ref(imageId, 'end'), source.b);
  } else if (source.kind === 'circle' || source.sweep >= TAU - 1e-9) {
    // A full round is its centre and radius: a full-sweep arc's two ends
    // are one seam point, so mirroring them would leave the centre free.
    link(ref(id, 'center'), ref(imageId, 'center'), source.c);
  } else {
    // Both sweep ends mirrored plus an equal radius fix the image exactly
    // (five equations for its five freedoms); mirroring the centre as well
    // would state the radius twice and read as redundant to the solver.
    link(ref(id, 'start'), ref(imageId, 'end'), pointOnCurve(source, 0));
    link(
      ref(id, 'end'),
      ref(imageId, 'start'),
      pointOnCurve(source, source.sweep)
    );
  }
  if (source.kind !== 'line') {
    links.push(
      commandFactories.addSketchConstraint(
        {
          sketchId,
          constraint: { constraintKind: 'equal', a: id, b: imageId }
        },
        'Mirror about the line'
      )
    );
  }
  return {
    status: 'commands',
    label: 'Mirror',
    message: `Mirror added a linked ${imageObject.objectKind}.`,
    commands: [
      commandFactories.addSketchObjects(
        {
          sketchId,
          objects: [imageObject],
          ids: { objectNodeIds: [imageId] }
        },
        'Mirror sketch geometry'
      ),
      ...links
    ],
    ...(optional.length > 0 ? { optional } : {})
  };
}

// ---------------------------------------------------------------------------
// Patterns

function transformCurve(
  curve: Curve2,
  map: (p: Point2) => Point2,
  turn: number
): Curve2 {
  if (curve.kind === 'line') {
    return { kind: 'line', a: map(curve.a), b: map(curve.b) };
  }
  if (curve.kind === 'circle') {
    return { kind: 'circle', c: map(curve.c), r: curve.r };
  }
  return {
    ...curve,
    c: map(curve.c),
    start: normalizeAngle(curve.start + turn)
  };
}

/**
 * The tolerance the profile builder will judge the result with: its
 * scale-aware geometry tolerance over every curve in the sketch, the new
 * ones included (`modelScaleFor` and `geometryTolerance` in
 * packages/geometry). A tighter check here would pass geometry the profile
 * builder then rejects as overlapping.
 */
function profileTolerance(
  document: ProjectDocument,
  sketch: SketchNode,
  added: readonly Curve2[],
  resolve: Resolve
): number {
  return toleranceFor([
    // The profile builder drops construction geometry before it measures
    // the model, so a far-off guide must not loosen the tolerance here.
    ...sketch.objectIds.flatMap((objectId) => {
      const data = sketchObject(document, sketch, objectId);
      return data && !data.construction ? cutterCurves(data, resolve) : [];
    }),
    ...added
  ]);
}

/** `geometryTolerance` at the scale of these curves' bounding extent. */
function toleranceFor(curves: readonly Curve2[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let radius = 0;
  for (const curve of curves) {
    const boxes =
      curve.kind === 'line'
        ? [curve.a, curve.b]
        : [
            { x: curve.c.x - curve.r, y: curve.c.y - curve.r },
            { x: curve.c.x + curve.r, y: curve.c.y + curve.r }
          ];
    for (const p of boxes) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    if (curve.kind !== 'line') {
      radius = Math.max(radius, curve.r);
    }
  }
  const span = Number.isFinite(minX) ? Math.max(maxX - minX, maxY - minY) : 0;
  const scale = Math.max(span, radius, 1);
  return Math.max(geometryTolerance(scale), Number.EPSILON * scale * 16);
}

/**
 * The tolerance a tool's result is compared with. Profile geometry is
 * judged as the profile builder will judge it. Construction results never
 * reach the profile builder and are only checked for exact duplicates, so
 * they use the fixed on-curve slack, unaffected by any sketch's scale.
 */
function resultTolerance(
  document: ProjectDocument,
  sketch: SketchNode,
  added: readonly Curve2[],
  construction: boolean,
  resolve: Resolve
): number {
  return construction
    ? ON_CURVE
    : profileTolerance(document, sketch, added, resolve);
}

/**
 * True when any new profile curve would overlap profile geometry already in
 * the sketch other than its source, which the profile builder would then reject as a
 * duplicate or an overlapping segment.
 */
function landsOnExisting(
  document: ProjectDocument,
  sketch: SketchNode,
  sourceId: string,
  curves: readonly Curve2[],
  resolve: Resolve,
  tol: number
): boolean {
  // Construction geometry never bounds a profile, so a construction copy
  // may sit on anything and anything may sit on a construction guide.
  if (sketchObject(document, sketch, sourceId)?.construction) {
    return false;
  }
  const existing = sketch.objectIds.flatMap((objectId) => {
    if (objectId === sourceId) {
      return [];
    }
    const data = sketchObject(document, sketch, objectId);
    return data && !data.construction ? cutterCurves(data, resolve) : [];
  });
  return curves.some((curve) =>
    existing.some((other) => curvesOverlap(other, curve, tol))
  );
}

/**
 * The profile builder's own verdict: run its classifier over the sketch with
 * the new objects added and look for a duplicate or overlap it would report
 * against one of them. The checks above explain the common cases; this one
 * makes sure nothing they approximate slips through (its coordinate-bucket
 * duplicate keys, for one). Construction objects are skipped by the
 * classifier, so they never clash.
 */
function profileClash(
  document: ProjectDocument,
  sketch: SketchNode,
  added: readonly SketchObjectData[],
  resolve: Resolve
): string | null {
  const newIds = added.map((_, index) => `modify-result-${index}`);
  const existing = sketch.objectIds.flatMap((objectId) => {
    const data = sketchObject(document, sketch, objectId);
    return data ? [{ id: String(objectId), data }] : [];
  });
  const degenerate = (objects: typeof existing) =>
    computeSketchProfileAnalysis(
      objects,
      (value) => resolve(value) ?? Number.NaN
    ).diagnostics;
  try {
    // Only what the change introduces counts; a sketch may already carry
    // diagnostics of its own.
    const clashCodes = new Set([
      'duplicate-entity',
      'overlapping-segments',
      'degenerate-entity'
    ]);
    const keyOf = (diagnostic: { code: string; sourceEntityIds: string[] }) =>
      `${diagnostic.code}:${[...diagnostic.sourceEntityIds].sort().join(',')}`;
    const before = new Set(
      degenerate(existing)
        .filter((diagnostic) => clashCodes.has(diagnostic.code))
        .map(keyOf)
    );
    const introduced = degenerate([
      ...existing,
      ...added.map((data, index) => ({ id: newIds[index]!, data }))
    ]).filter(
      (diagnostic) =>
        clashCodes.has(diagnostic.code) && !before.has(keyOf(diagnostic))
    );
    if (
      introduced.some(
        (diagnostic) =>
          diagnostic.code !== 'degenerate-entity' &&
          diagnostic.sourceEntityIds.some((id) => newIds.includes(id))
      )
    ) {
      return LANDS_ON_EXISTING;
    }
    // Anything else it introduced comes from scale: a result far enough
    // away widens the profile builder's tolerance until small or close
    // geometry, new or old, reads as degenerate or merged.
    if (introduced.length > 0) {
      return 'The result would reach so far that existing geometry becomes too small or too close together to keep at that scale.';
    }
    return null;
  } catch {
    // A sketch the classifier cannot analyse is refused elsewhere; this
    // check only adds refusals it can prove.
    return null;
  }
}

const LANDS_ON_EXISTING =
  'The result would lie on top of geometry already in the sketch.';

/**
 * True when instances overlap the source or each other. Construction copies
 * never bound a profile, so for them only an exact duplicate — which adds
 * nothing — is refused.
 */
function instancesOverlap(
  source: Curve2,
  copies: Curve2[],
  construction: boolean,
  tol: number
): boolean {
  const clash = construction ? sameCurve : curvesOverlap;
  const placed = [source, ...copies];
  return placed.some((curve, index) =>
    placed.slice(0, index).some((earlier) => clash(earlier, curve, tol))
  );
}

function refuseCount(count: number): string | null {
  if (!Number.isInteger(count)) {
    return 'A pattern count is a whole number of instances.';
  }
  if (count < 2) {
    return 'A pattern needs at least 2 instances, the source included.';
  }
  if (count > MAX_PATTERN_COUNT) {
    return `A sketch pattern makes at most ${MAX_PATTERN_COUNT} instances.`;
  }
  return null;
}

function patternSource(
  document: ProjectDocument,
  sketch: SketchNode,
  sourceId: string,
  resolve: Resolve
): { data: SketchObjectData; curve: Curve2 } | { error: string } {
  const data = sketchObject(document, sketch, sourceId);
  if (!data) {
    return { error: 'That object is not part of this sketch.' };
  }
  const composite = compositeRefusal(data, 'pattern');
  if (composite) {
    return { error: composite };
  }
  const curve = evaluateCurve(data, resolve);
  if (!curve) {
    return { error: 'That entity has a dimension that does not evaluate.' };
  }
  return zeroLength(curve) ? { error: ZERO_LENGTH } : { data, curve };
}

/** A line whose ends meet has no direction to copy or link. */
function zeroLength(curve: Curve2): boolean {
  return curve.kind === 'line' && distance(curve.a, curve.b) <= ON_CURVE;
}

const ZERO_LENGTH =
  'That line has no length, so there is nothing to copy. Give it a length first.';

/**
 * Copies of one source, each tied back to it: equal length or radius always,
 * and parallel too for the lines of a linear pattern, so resizing the source
 * and solving resizes every instance. Positions are not linked yet — that is
 * the persistent pattern relation the roadmap keeps open.
 */
function patternCommands(
  sketchId: SketchId,
  sourceId: EntityId,
  data: SketchObjectData,
  copies: Curve2[],
  parallel: boolean,
  label: string
): AnyCommand[] {
  const ids = copies.map(() => newEntityId());
  const links: AnyCommand[] = [];
  for (const copyId of ids) {
    links.push(
      commandFactories.addSketchConstraint(
        {
          sketchId,
          constraint: { constraintKind: 'equal', a: sourceId, b: copyId }
        },
        `Link the ${label.toLowerCase()} instance`
      )
    );
    if (parallel) {
      links.push(
        commandFactories.addSketchConstraint(
          {
            sketchId,
            constraint: { constraintKind: 'parallel', a: sourceId, b: copyId }
          },
          `Link the ${label.toLowerCase()} instance`
        )
      );
    }
  }
  return [
    commandFactories.addSketchObjects(
      {
        sketchId,
        objects: copies.map((copy) => curveObject(copy, data)),
        ids: { objectNodeIds: ids }
      },
      `${label} sketch geometry`
    ),
    ...links
  ];
}

/**
 * `count` instances of the source (the source is the first), `spacing`
 * apart along the picked direction line, measured from its start to its end.
 */
export function planSketchLinearPattern(
  document: ProjectDocument,
  sketch: SketchNode,
  sketchId: SketchId,
  sourceId: string,
  directionId: string,
  spacing: number,
  count: number,
  resolve: Resolve
): SketchModifyPlan {
  const source = patternSource(document, sketch, sourceId, resolve);
  if ('error' in source) {
    return { status: 'refuse', reason: source.error };
  }
  const directionData = sketchObject(document, sketch, directionId);
  const direction = directionData
    ? evaluateCurve(directionData, resolve)
    : null;
  if (!direction || direction.kind !== 'line') {
    return {
      status: 'refuse',
      reason:
        'A linear pattern runs along a line. Pick a line for its direction.'
    };
  }
  const countRefusal = refuseCount(count);
  if (countRefusal) {
    return { status: 'refuse', reason: countRefusal };
  }
  if (!Number.isFinite(spacing) || Math.abs(spacing) <= ON_CURVE) {
    return {
      status: 'refuse',
      reason: 'Pattern spacing must be a non-zero distance.'
    };
  }
  const d = sub(direction.b, direction.a);
  const length = Math.hypot(d.x, d.y);
  if (length === 0) {
    return { status: 'refuse', reason: 'The direction line has no length.' };
  }
  const step = { x: (d.x / length) * spacing, y: (d.y / length) * spacing };
  const copies: Curve2[] = [];
  for (let index = 1; index < count; index += 1) {
    copies.push(
      transformCurve(
        source.curve,
        (p) => ({ x: p.x + step.x * index, y: p.y + step.y * index }),
        0
      )
    );
  }
  const tol = resultTolerance(
    document,
    sketch,
    copies,
    Boolean(source.data.construction),
    resolve
  );
  if (
    instancesOverlap(
      source.curve,
      copies,
      Boolean(source.data.construction),
      tol
    )
  ) {
    return {
      status: 'refuse',
      reason:
        'Some instances would overlap others. Use a spacing at least as long as the entity along the direction.'
    };
  }
  if (landsOnExisting(document, sketch, sourceId, copies, resolve, tol)) {
    return { status: 'refuse', reason: LANDS_ON_EXISTING };
  }
  const clash = profileClash(
    document,
    sketch,
    copies.map((copy) => curveObject(copy, source.data)),
    resolve
  );
  if (clash) {
    return { status: 'refuse', reason: clash };
  }
  return {
    status: 'commands',
    label: 'Linear pattern',
    message: `Linear pattern added ${count - 1} linked ${curveObject(copies[0]!, source.data).objectKind}${count - 1 === 1 ? '' : 's'}.`,
    commands: patternCommands(
      sketchId,
      sourceId as EntityId,
      source.data,
      copies,
      source.curve.kind === 'line',
      'Linear pattern'
    )
  };
}

/**
 * `count` instances of the source rotated about `pivot`. A full 360° turn
 * spaces them evenly with no instance on top of the source; a partial turn
 * puts the last instance at the end of the angle.
 */
export function planSketchCircularPattern(
  document: ProjectDocument,
  sketch: SketchNode,
  sketchId: SketchId,
  sourceId: string,
  pivot: Point2,
  count: number,
  totalDeg: number,
  resolve: Resolve
): SketchModifyPlan {
  const source = patternSource(document, sketch, sourceId, resolve);
  if ('error' in source) {
    return { status: 'refuse', reason: source.error };
  }
  const countRefusal = refuseCount(count);
  if (countRefusal) {
    return { status: 'refuse', reason: countRefusal };
  }
  if (!Number.isFinite(totalDeg) || totalDeg <= 0 || totalDeg > 360) {
    return {
      status: 'refuse',
      reason: 'A circular pattern spans more than 0° and at most 360°.'
    };
  }
  const full = Math.abs(totalDeg - 360) < 1e-9;
  const stepRad =
    ((full ? 360 / count : totalDeg / (count - 1)) * Math.PI) / 180;
  if (
    // A partial arc about its own centre still sweeps new quadrants; only
    // a full round turns onto itself.
    (source.curve.kind === 'circle' ||
      (source.curve.kind === 'arc' && source.curve.sweep >= TAU - 1e-9)) &&
    distance(source.curve.c, pivot) <= ON_CURVE
  ) {
    return {
      status: 'refuse',
      reason:
        'That entity is centred on the pivot, so every instance would land on it.'
    };
  }
  const copies: Curve2[] = [];
  for (let index = 1; index < count; index += 1) {
    const angle = stepRad * index;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    copies.push(
      transformCurve(
        source.curve,
        (p) => ({
          x: pivot.x + (p.x - pivot.x) * cos - (p.y - pivot.y) * sin,
          y: pivot.y + (p.x - pivot.x) * sin + (p.y - pivot.y) * cos
        }),
        angle
      )
    );
  }
  // A line through the pivot lands back on itself after half a turn, so
  // an even count would stack duplicates that break profiles.
  const tol = resultTolerance(
    document,
    sketch,
    copies,
    Boolean(source.data.construction),
    resolve
  );
  if (
    instancesOverlap(
      source.curve,
      copies,
      Boolean(source.data.construction),
      tol
    )
  ) {
    return {
      status: 'refuse',
      reason:
        'Some instances would overlap others. Change the count or the angle, or move the pivot off the entity.'
    };
  }
  if (landsOnExisting(document, sketch, sourceId, copies, resolve, tol)) {
    return { status: 'refuse', reason: LANDS_ON_EXISTING };
  }
  const clash = profileClash(
    document,
    sketch,
    copies.map((copy) => curveObject(copy, source.data)),
    resolve
  );
  if (clash) {
    return { status: 'refuse', reason: clash };
  }
  return {
    status: 'commands',
    label: 'Circular pattern',
    message: `Circular pattern added ${count - 1} linked ${curveObject(copies[0]!, source.data).objectKind}${count - 1 === 1 ? '' : 's'}.`,
    commands: patternCommands(
      sketchId,
      sourceId as EntityId,
      source.data,
      copies,
      false,
      'Circular pattern'
    )
  };
}

/**
 * The pivot a circular pattern's second pick names: the snapped point when
 * the click snapped to one, else the centre of a picked circle or arc.
 */
export function resolvePatternPivot(
  document: ProjectDocument,
  sketch: SketchNode,
  pick: string,
  resolve: Resolve
): { pivot: Point2 } | { error: string } {
  const [objectId, point] = pick.split('#') as [string, PointName | undefined];
  const data = sketchObject(document, sketch, objectId);
  if (!data) {
    return { error: 'That object is not part of this sketch.' };
  }
  const curve = evaluateCurve(data, resolve);
  if (!curve) {
    return {
      error:
        'Pick a circle or arc whose centre is the pivot, or snap to a line endpoint.'
    };
  }
  if (point === 'start' || point === 'end') {
    if (curve.kind === 'line') {
      return { pivot: point === 'start' ? curve.a : curve.b };
    }
    if (curve.kind === 'arc') {
      return {
        pivot: pointOnCurve(curve, point === 'start' ? 0 : curve.sweep)
      };
    }
  }
  if (curve.kind !== 'line') {
    return { pivot: curve.c };
  }
  return {
    error:
      'Pick a circle or arc whose centre is the pivot, or snap to a line endpoint.'
  };
}

// ---------------------------------------------------------------------------
// Construction

/**
 * Turn one existing entity into construction geometry, or back into regular
 * geometry (ZC-024). One `updateSketchObject` with every other field kept,
 * so it is one undo step and touches no relation: construction geometry
 * still solves, it only stops bounding profiles. A rectangle or polygon side
 * changes alone, so marking one side of a closed outline removes that
 * profile, exactly as it would for any loop of lines.
 */
export function planSketchConstructionToggle(
  document: ProjectDocument,
  sketch: SketchNode,
  sketchId: SketchId,
  objectId: string
): SketchModifyPlan {
  const data = sketchObject(document, sketch, objectId);
  if (!data) {
    return {
      status: 'refuse',
      reason: 'That object is not part of this sketch.'
    };
  }
  const { construction, ...rest } = data;
  const making = construction !== true;
  const next = (
    making ? { ...rest, construction: true } : rest
  ) as SketchObjectData;
  return {
    status: 'commands',
    label: making ? 'Make construction' : 'Make regular',
    message: making
      ? `The ${data.objectKind} is construction geometry now; it no longer bounds a profile.`
      : `The ${data.objectKind} is regular geometry again.`,
    commands: [
      commandFactories.updateSketchObject(
        { sketchId, objectId: objectId as EntityId, data: next },
        making ? 'Make construction' : 'Make regular'
      )
    ]
  };
}

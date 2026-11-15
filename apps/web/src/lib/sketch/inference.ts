import type {
  EntityId,
  SketchConstraintData,
  SketchObjectData,
  SketchPointRef
} from '@openzcad/shared';
import {
  snapTargetsForObject,
  type SketchPoint,
  type SnapTarget,
  type SnapTargetKind
} from './session';

/**
 * S08: inference while drawing. A drawn entity is compared with the sketch
 * it lands in, and the relations its placement already satisfies exactly
 * are proposed for the same commit:
 *
 * - always (the auto-constrain setting off or on): an end placed on another
 *   curve's end is joined to it (coincident), and an end placed on a line's
 *   midpoint is held there (midpoint);
 * - with auto-constrain on: an end on a centre (coincident), on the sketch
 *   origin (locked there), on the crossing of two lines (held on both), a
 *   horizontal or vertical line, a line perpendicular to the line it
 *   continues, and a line leaving an arc's end along its tangent (or an arc
 *   leaving a line's end tangentially).
 *
 * Every proposal is satisfied by the drawn geometry as it stands, so a
 * relation never moves anything when it is added; it only keeps the
 * relationship when something else moves later. Every proposal becomes an
 * ordinary sketch relation, drawn as a glyph and removable like one the user
 * picked: nothing is held silently.
 *
 * Coincidence is read from exact geometry (a snapped or chained end is a
 * bit-exact copy of the point it landed on). A hold on a curve is proposed
 * only from what the pointer snapped to (`hints`), because a grid point that
 * merely happens to lie on some line's extension was not put there on
 * purpose.
 */

type Resolve = (value: unknown) => number;

export interface SketchInferenceObject {
  id: string;
  data: SketchObjectData;
}

/** What the pointer snapped to when a point of the drawn entity was placed. */
export interface SketchSnapHint extends SketchPoint {
  kind: SnapTargetKind;
  sourceId?: string;
  /** The two curves an intersection snap lies on. */
  sourceIds?: readonly [string, string];
}

export type SketchInferredRelationKind =
  | 'coincident'
  | 'midpoint'
  | 'on-curve'
  | 'origin'
  | 'horizontal'
  | 'vertical'
  | 'perpendicular'
  | 'tangent';

export interface SketchInferredRelation {
  kind: SketchInferredRelationKind;
  data: SketchConstraintData;
  /**
   * True for a relation the auto-constrain setting does not gate: joining a
   * drawn end to the end it landed on, or to a line's midpoint.
   */
  connected: boolean;
  /**
   * The solver decides: an optional relation is kept only when it adds rank
   * (`settleOptionalRelations`), so an inferred relation never makes a
   * sketch redundant. Only a commit's first relation is required: it is the
   * first statement about a newly drawn entity and cannot be redundant.
   */
  optional: boolean;
}

export interface SketchInferenceOptions {
  /** The auto-constrain setting. Off keeps only connected relations. */
  autoConstrain: boolean;
  hints?: readonly SketchSnapHint[];
}

/** Relative tolerance for "exactly": far below any snap or grid distance. */
const EXACT = 1e-9;

const scaleOf = (...points: SketchPoint[]): number =>
  Math.max(
    1,
    ...points.map((point) => Math.max(Math.abs(point.x), Math.abs(point.y)))
  );

const samePoint = (a: SketchPoint, b: SketchPoint): boolean =>
  Math.hypot(a.x - b.x, a.y - b.y) <= EXACT * scaleOf(a, b);

const finitePoint = (point: SketchPoint): boolean =>
  Number.isFinite(point.x) && Number.isFinite(point.y);

/** The constraint-schema points of an object, at their evaluated positions. */
function namedPoints(
  object: SketchInferenceObject,
  resolve: Resolve
): { ref: SketchPointRef; at: SketchPoint; role: 'end' | 'center' }[] {
  return snapTargetsForObject(object.data, resolve, object.id).flatMap(
    (target) =>
      target.pointRef && finitePoint(target)
        ? [
            {
              ref: {
                objectId: object.id as EntityId,
                point: target.pointRef
              },
              at: { x: target.x, y: target.y },
              role:
                target.pointRef === 'center'
                  ? ('center' as const)
                  : ('end' as const)
            }
          ]
        : []
  );
}

function lineMidpoints(
  object: SketchInferenceObject,
  resolve: Resolve
): SnapTarget[] {
  if (object.data.objectKind !== 'line') return [];
  return snapTargetsForObject(object.data, resolve, object.id).filter(
    (target) => target.kind === 'midpoint' && finitePoint(target)
  );
}

/** A line's unit direction, or null for a degenerate or unresolved one. */
function lineDirection(
  data: SketchObjectData,
  resolve: Resolve
): { a: SketchPoint; b: SketchPoint; u: SketchPoint } | null {
  if (data.objectKind !== 'line') return null;
  const a = { x: resolve(data.x1), y: resolve(data.y1) };
  const b = { x: resolve(data.x2), y: resolve(data.y2) };
  if (!finitePoint(a) || !finitePoint(b)) return null;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(length > 0)) return null;
  return { a, b, u: { x: (b.x - a.x) / length, y: (b.y - a.y) / length } };
}

function arcCircle(
  data: SketchObjectData,
  resolve: Resolve
): { c: SketchPoint; r: number } | null {
  if (data.objectKind !== 'arc') return null;
  const c = { x: resolve(data.centerX), y: resolve(data.centerY) };
  const r = resolve(data.radius);
  return finitePoint(c) && Number.isFinite(r) && r > 0 ? { c, r } : null;
}

const isAxisAligned = (u: SketchPoint): boolean =>
  Math.abs(u.x) <= EXACT || Math.abs(u.y) <= EXACT;

/** Whether a curve can hold a point (`point-on-object`). */
const holdsPoints = (data: SketchObjectData): boolean =>
  data.objectKind === 'line' ||
  data.objectKind === 'arc' ||
  data.objectKind === 'circle' ||
  data.objectKind === 'ellipse';

/**
 * The relations a drawn entity's placement satisfies, in the order they are
 * added. `existing` is the sketch before the commit; `added` are the new
 * objects with the ids the commit gives them. Composite sides (a rectangle
 * or polygon) take only point relations: their own shape relations already
 * hold their directions.
 */
export function inferSketchRelations(
  existing: readonly SketchInferenceObject[],
  added: readonly SketchInferenceObject[],
  resolve: Resolve,
  options: SketchInferenceOptions,
  inferDirections = true
): SketchInferredRelation[] {
  const relations: SketchInferredRelation[] = [];
  const existingPoints = existing.flatMap((object) =>
    namedPoints(object, resolve)
  );
  const existingById = new Map(existing.map((object) => [object.id, object]));
  const addedById = new Map(added.map((object) => [object.id, object]));
  const midpoints = existing.flatMap((object) =>
    lineMidpoints(object, resolve)
  );
  const hints = options.hints ?? [];
  const hintAt = (point: SketchPoint) =>
    hints.find((hint) => samePoint(hint, point));
  const auto = options.autoConstrain;
  // Later objects first: a chain's previous segment wins over an older end
  // that happens to share the point.
  const newestFirst = [...existingPoints].reverse();

  type NamedPoint = ReturnType<typeof namedPoints>[number];
  /** Relates one new point; returns the existing end it joined, if any. */
  const relatePoint = (point: NamedPoint): SketchPointRef | null | false => {
    const end = newestFirst.find(
      (candidate) =>
        candidate.role === 'end' &&
        point.role === 'end' &&
        samePoint(candidate.at, point.at)
    );
    if (end) {
      relations.push({
        kind: 'coincident',
        data: { constraintKind: 'coincident', a: end.ref, b: point.ref },
        connected: true,
        optional: false
      });
      return end.ref;
    }
    const midpoint = midpoints.find((candidate) =>
      samePoint(candidate, point.at)
    );
    if (midpoint?.sourceId && (auto || point.role === 'end')) {
      relations.push({
        kind: 'midpoint',
        data: {
          constraintKind: 'midpoint',
          point: point.ref,
          line: midpoint.sourceId as EntityId
        },
        connected: point.role === 'end',
        optional: false
      });
      return null;
    }
    if (!auto) return false;
    // A centre on a centre, an end on a centre or a centre on an end.
    const shared = newestFirst.find((candidate) =>
      samePoint(candidate.at, point.at)
    );
    if (shared) {
      relations.push({
        kind: 'coincident',
        data: { constraintKind: 'coincident', a: shared.ref, b: point.ref },
        connected: false,
        optional: false
      });
      return null;
    }
    const hint = hintAt(point.at);
    if (hint?.kind === 'origin' && samePoint(point.at, { x: 0, y: 0 })) {
      relations.push({
        kind: 'origin',
        data: { constraintKind: 'lock', point: point.ref, x: 0, y: 0 },
        connected: false,
        optional: false
      });
      return null;
    }
    let held = false;
    // A guideline snap: on a line's extension, or where a line from the
    // chain's anchor touches a circle or arc.
    if (
      (hint?.kind === 'extension' || hint?.kind === 'tangent') &&
      hint.sourceId
    ) {
      const curve = existingById.get(hint.sourceId);
      if (
        curve &&
        holdsPoints(curve.data) &&
        onCurve(curve.data, point.at, resolve)
      ) {
        held = true;
        relations.push({
          kind: 'on-curve',
          data: {
            constraintKind: 'point-on-object',
            point: point.ref,
            objectId: hint.sourceId as EntityId
          },
          connected: false,
          optional: true
        });
        const drawn = addedById.get(point.ref.objectId);
        if (
          hint.kind === 'tangent' &&
          curve.data.objectKind === 'circle' &&
          drawn &&
          lineDirection(drawn.data, resolve) &&
          tangentAt(
            {
              x: resolve(curve.data.centerX),
              y: resolve(curve.data.centerY)
            },
            point.at,
            lineDirection(drawn.data, resolve)!.u
          )
        ) {
          relations.push({
            kind: 'tangent',
            data: {
              constraintKind: 'tangent',
              a: point.ref.objectId,
              b: hint.sourceId as EntityId
            },
            connected: false,
            optional: true
          });
        }
      }
    }
    if (hint?.kind === 'intersection' && hint.sourceIds) {
      for (const curveId of hint.sourceIds) {
        const curve = existingById.get(curveId);
        if (!curve || !holdsPoints(curve.data)) continue;
        if (!onCurve(curve.data, point.at, resolve)) continue;
        held = true;
        relations.push({
          kind: 'on-curve',
          data: {
            constraintKind: 'point-on-object',
            point: point.ref,
            objectId: curveId as EntityId
          },
          connected: false,
          optional: true
        });
      }
    }
    return held ? null : false;
  };

  // Where a new point has already been related: a composite's corner is
  // two sides' ends, which its own relations already join to each other.
  const related: SketchPoint[] = [];
  for (const object of added) {
    /** Existing ends joined to this object's ends, by the new point name. */
    const joined = new Map<SketchPointRef['point'], SketchPointRef>();
    for (const point of namedPoints(object, resolve)) {
      if (related.some((at) => samePoint(at, point.at))) continue;
      const result = relatePoint(point);
      if (result === false) continue;
      related.push(point.at);
      if (result) joined.set(point.ref.point, result);
    }
    if (!auto || !inferDirections) continue;
    relations.push(
      ...directionRelations(object, joined, existingById, resolve)
    );
  }
  // Only the commit's first relation is certain to add rank: it is the
  // first statement about a free new entity. Any later one may restate what
  // the entity's own shape or an earlier relation already holds (a
  // rectangle's two bottom corners both joined to a horizontal line, an arc
  // whose centre and both ends land on existing points), so the solver
  // decides for each of them.
  return relations.map((relation, index) =>
    index === 0 ? relation : { ...relation, optional: true }
  );
}

/** Horizontal/vertical, perpendicular and tangent relations of one entity. */
function directionRelations(
  object: SketchInferenceObject,
  joined: ReadonlyMap<SketchPointRef['point'], SketchPointRef>,
  existingById: ReadonlyMap<string, SketchInferenceObject>,
  resolve: Resolve
): SketchInferredRelation[] {
  const relations: SketchInferredRelation[] = [];
  const id = object.id as EntityId;
  const line = lineDirection(object.data, resolve);
  if (line) {
    const axis =
      Math.abs(line.u.y) <= EXACT
        ? ('horizontal' as const)
        : Math.abs(line.u.x) <= EXACT
          ? ('vertical' as const)
          : null;
    if (axis) {
      relations.push({
        kind: axis,
        data: { constraintKind: axis, objectId: id },
        connected: false,
        optional: true
      });
    }
    let perpendicular = false;
    for (const end of ['start', 'end'] as const) {
      const other = joined.get(end);
      const neighbour = other ? existingById.get(other.objectId) : undefined;
      if (!other || !neighbour) continue;
      const neighbourLine = lineDirection(neighbour.data, resolve);
      if (neighbourLine) {
        // One perpendicular per line: a second one at the far end of a
        // closing segment is implied by the rest of the loop.
        if (
          perpendicular ||
          axis ||
          isAxisAligned(neighbourLine.u) ||
          Math.abs(
            neighbourLine.u.x * line.u.x + neighbourLine.u.y * line.u.y
          ) > EXACT
        ) {
          continue;
        }
        perpendicular = true;
        relations.push({
          kind: 'perpendicular',
          data: {
            constraintKind: 'perpendicular',
            a: neighbour.id as EntityId,
            b: id
          },
          connected: false,
          optional: true
        });
        continue;
      }
      const arc = arcCircle(neighbour.data, resolve);
      if (arc && other.point !== 'center') {
        const at = end === 'start' ? line.a : line.b;
        if (tangentAt(arc.c, at, line.u)) {
          relations.push({
            kind: 'tangent',
            data: {
              constraintKind: 'tangent',
              a: id,
              b: neighbour.id as EntityId,
              at: other
            },
            connected: false,
            optional: true
          });
        }
      }
    }
    return relations;
  }
  const arc = arcCircle(object.data, resolve);
  if (arc) {
    for (const end of ['start', 'end'] as const) {
      const other = joined.get(end);
      const neighbour = other ? existingById.get(other.objectId) : undefined;
      const neighbourLine = neighbour
        ? lineDirection(neighbour.data, resolve)
        : null;
      if (!other || !neighbourLine) continue;
      const at = other.point === 'start' ? neighbourLine.a : neighbourLine.b;
      if (tangentAt(arc.c, at, neighbourLine.u)) {
        relations.push({
          kind: 'tangent',
          data: {
            constraintKind: 'tangent',
            a: neighbour!.id as EntityId,
            b: id,
            at: { objectId: id, point: end }
          },
          connected: false,
          optional: true
        });
      }
    }
  }
  return relations;
}

/** A line through `at` along `u` is tangent to a circle centred at `c`. */
function tangentAt(c: SketchPoint, at: SketchPoint, u: SketchPoint): boolean {
  const rx = at.x - c.x;
  const ry = at.y - c.y;
  const r = Math.hypot(rx, ry);
  return r > 0 && Math.abs(rx * u.x + ry * u.y) <= EXACT * Math.max(1, r);
}

/** Whether a point lies exactly on a line (its extension), circle or arc. */
function onCurve(
  data: SketchObjectData,
  point: SketchPoint,
  resolve: Resolve
): boolean {
  const line = lineDirection(data, resolve);
  if (line) {
    const cross =
      (point.x - line.a.x) * line.u.y - (point.y - line.a.y) * line.u.x;
    return Math.abs(cross) <= EXACT * scaleOf(point, line.a, line.b);
  }
  if (data.objectKind === 'circle' || data.objectKind === 'arc') {
    const c = { x: resolve(data.centerX), y: resolve(data.centerY) };
    const r = resolve(data.radius);
    return (
      Number.isFinite(r) &&
      Math.abs(Math.hypot(point.x - c.x, point.y - c.y) - r) <=
        EXACT * scaleOf(point, c)
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// Direction locks while a line is drawn
// ---------------------------------------------------------------------------

export type SketchDirectionLockKind =
  'horizontal' | 'vertical' | 'perpendicular' | 'tangent';

export interface SketchDirectionLock {
  point: SketchPoint;
  lock: SketchDirectionLockKind | null;
}

/** Within this angle of a lock direction, the line takes it exactly. */
const LOCK_TOLERANCE = Math.tan((5 * Math.PI) / 180);

/**
 * The directions a line from `anchor` can lock to: the sketch axes, the
 * perpendicular to a line ending at the anchor, and the tangent of an arc
 * ending there. The pointer within ~5° of one takes it exactly; a tangent
 * outranks the axes (it is the more specific reading), and the axes outrank
 * a perpendicular, which they would make redundant with the neighbour's own
 * axis relation.
 */
export function lineDirectionLock(
  anchor: SketchPoint,
  point: SketchPoint,
  objects: readonly SketchInferenceObject[],
  resolve: Resolve
): SketchDirectionLock {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return { point, lock: null };
  const candidates: { kind: SketchDirectionLockKind; u: SketchPoint }[] = [];
  for (const object of objects) {
    const line = lineDirection(object.data, resolve);
    if (line) {
      if (
        !isAxisAligned(line.u) &&
        (samePoint(line.a, anchor) || samePoint(line.b, anchor))
      ) {
        candidates.push({
          kind: 'perpendicular',
          u: { x: -line.u.y, y: line.u.x }
        });
      }
      continue;
    }
    const arc = arcCircle(object.data, resolve);
    if (!arc) continue;
    const ends = namedPoints(object, resolve).filter(
      (entry) => entry.role === 'end'
    );
    if (!ends.some((entry) => samePoint(entry.at, anchor))) continue;
    const rx = anchor.x - arc.c.x;
    const ry = anchor.y - arc.c.y;
    const r = Math.hypot(rx, ry);
    if (r > 0)
      candidates.push({ kind: 'tangent', u: { x: -ry / r, y: rx / r } });
  }
  const within = (u: SketchPoint) => {
    const along = dx * u.x + dy * u.y;
    const across = Math.abs(dx * u.y - dy * u.x);
    return across <= Math.abs(along) * LOCK_TOLERANCE ? along : null;
  };
  const take = (kind: SketchDirectionLockKind, u: SketchPoint) => {
    const along = within(u);
    return along === null
      ? null
      : {
          point: { x: anchor.x + u.x * along, y: anchor.y + u.y * along },
          lock: kind
        };
  };
  for (const candidate of candidates.filter(
    (entry) => entry.kind === 'tangent'
  )) {
    const locked = take('tangent', candidate.u);
    if (locked) return locked;
  }
  if (Math.abs(dy) <= Math.abs(dx) * LOCK_TOLERANCE) {
    return { point: { x: point.x, y: anchor.y }, lock: 'horizontal' };
  }
  if (Math.abs(dx) <= Math.abs(dy) * LOCK_TOLERANCE) {
    return { point: { x: anchor.x, y: point.y }, lock: 'vertical' };
  }
  for (const candidate of candidates.filter(
    (entry) => entry.kind === 'perpendicular'
  )) {
    const locked = take('perpendicular', candidate.u);
    if (locked) return locked;
  }
  return { point, lock: null };
}

/**
 * The arc tool's tangent: an arc whose start or end lands on a line's end
 * with its centre within ~5° of that line's normal takes the normal exactly,
 * by sliding the centre onto it. A centre placed on an exact snap stays
 * where it was put: the snap wins. Returns the centre to use.
 */
export function tangentArcCenter(
  center: SketchPoint,
  ends: readonly SketchPoint[],
  objects: readonly SketchInferenceObject[],
  resolve: Resolve,
  /** Snaps points were placed on: a snapped centre is never moved. */
  hints: readonly SketchSnapHint[] = []
): { center: SketchPoint; tangent: boolean } {
  if (hints.some((hint) => samePoint(hint, center))) {
    return { center, tangent: false };
  }
  for (const end of ends) {
    for (const object of objects) {
      const line = lineDirection(object.data, resolve);
      if (!line || !(samePoint(line.a, end) || samePoint(line.b, end)))
        continue;
      const n = { x: -line.u.y, y: line.u.x };
      const dx = center.x - end.x;
      const dy = center.y - end.y;
      const along = dx * n.x + dy * n.y;
      const across = Math.abs(dx * line.u.x + dy * line.u.y);
      if (along !== 0 && across <= Math.abs(along) * LOCK_TOLERANCE) {
        return {
          center: { x: end.x + n.x * along, y: end.y + n.y * along },
          tangent: true
        };
      }
    }
  }
  return { center, tangent: false };
}

const RELATION_NAMES: Record<SketchInferredRelationKind, string> = {
  coincident: 'coincident',
  midpoint: 'midpoint',
  'on-curve': 'on curve',
  origin: 'locked at origin',
  horizontal: 'horizontal',
  vertical: 'vertical',
  perpendicular: 'perpendicular',
  tangent: 'tangent'
};

/**
 * The status line that names what a drawing commit inferred, so a relation
 * is never added without a word: "Added line · inferred coincident,
 * horizontal (select a glyph and press Delete to remove one)."
 */
export function describeInferredRelations(
  label: string,
  kinds: readonly SketchInferredRelationKind[]
): string {
  if (kinds.length === 0) return `${label}.`;
  const counts = new Map<string, number>();
  for (const kind of kinds) {
    const name = RELATION_NAMES[kind];
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const names = [...counts].map(([name, count]) =>
    count > 1 ? `${name} ×${count}` : name
  );
  return `${label} · inferred ${names.join(', ')}. Select a relation glyph and press Delete to remove one.`;
}

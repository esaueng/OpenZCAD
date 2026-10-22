import type {
  SketchConstraint,
  SketchObjectData,
  SketchPointRef,
  SketchRelationGlyphKind,
  SketchRelationGlyphVisibility
} from '@openzcad/shared';
import {
  boundedArcSweepDegrees,
  resolveSplineGeometry
} from '@openzcad/geometry';
import {
  displayObjectsWithTextBudget,
  objectPolylines
} from '../objectPolyline';
import { constraintReferencesObject } from './constraints';
import { sketchPointPosition } from './dimensionAnnotations';
import { sketchObjectGrabPoint, snapTargetsForObject } from './session';

type Point = { x: number; y: number };
type Resolve = (value: number | string) => number | undefined;

export type { SketchRelationGlyphKind };

// Every symbol must be drawn by a bundled face (test/glyph-coverage.test.ts).
export const SKETCH_RELATION_GLYPHS: Record<
  SketchRelationGlyphKind,
  { symbol: string; label: string }
> = {
  horizontal: { symbol: '—', label: 'Horizontal' },
  vertical: { symbol: '|', label: 'Vertical' },
  parallel: { symbol: '∥', label: 'Parallel' },
  perpendicular: { symbol: '⊥', label: 'Perpendicular' },
  equal: { symbol: '=', label: 'Equal' },
  tangent: { symbol: '○', label: 'Tangent' },
  concentric: { symbol: '◎', label: 'Concentric' },
  coincident: { symbol: '•', label: 'Coincident' },
  midpoint: { symbol: '△', label: 'Midpoint' },
  symmetric: { symbol: '↔', label: 'Symmetric' },
  'point-on-object': { symbol: '◇', label: 'Point on curve' },
  lock: { symbol: '▲', label: 'Lock' }
};

export interface SketchRelationGlyph {
  constraintId: string;
  kind: SketchRelationGlyphKind;
  symbol: string;
  label: string;
  /** Named by a measured non-zero residual in the last solve. */
  conflicted: boolean;
  /** The relation picked from its glyph; Delete removes it. */
  selected?: boolean;
}

/** One cluster of glyphs drawn together at a plane-local anchor. */
export interface SketchRelationGlyphChip {
  key: string;
  /** On a curve (offset clear of the stroke) or on a point. */
  placement: 'object' | 'point';
  anchor: Point;
  /**
   * Plane-local unit direction the chip stands off along, away from the
   * geometry it describes: a curve's outward side, or the widest gap between
   * the curves meeting at a point. The viewer projects it every frame.
   */
  normal: Point;
  /**
   * A point chip's room either side of `normal`, in radians: half the gap
   * between the curves meeting there. Its sideways candidates stay well
   * inside it, so a chip never swings onto a curve. Absent is half a turn.
   */
  halfGap?: number;
  glyphs: SketchRelationGlyph[];
}

export interface SketchRelationGlyphOptions {
  visibility: SketchRelationGlyphVisibility;
  /** With `selected`, only relations that mention this object are drawn. */
  selectedObjectId?: string | null;
  /** The relation picked from its glyph, drawn as selected. */
  selectedConstraintId?: string | null;
  /** Glyph kinds the per-kind filter hides. */
  hiddenKinds?: ReadonlySet<SketchRelationGlyphKind>;
  conflictingConstraintIds?: ReadonlySet<string>;
  /**
   * Counts the point-to-point comparisons clustering made, for tests that
   * prove the work grows linearly (a wall clock is too noisy to).
   */
  stats?: { comparisons: number };
}

/**
 * Presentation-only layout of a sketch's relations: one glyph per relation
 * on each object or point it holds, gathered into one chip per curve and
 * per point so a corner's relations read as one cluster. Derived from
 * document geometry on every render; nothing here is persisted.
 */
export function sketchRelationGlyphs(
  objects: readonly { id: string; data: SketchObjectData }[],
  constraints: readonly SketchConstraint[],
  resolve: Resolve,
  options: SketchRelationGlyphOptions
): SketchRelationGlyphChip[] {
  if (options.visibility === 'hidden') return [];
  const selected = options.selectedObjectId ?? null;
  if (options.visibility === 'selected' && !selected) return [];
  const byId = new Map(objects.map((object) => [object.id, object.data]));
  const scalar = (value: number | string): number | undefined => {
    const result = resolve(value);
    return result !== undefined && Number.isFinite(result) ? result : undefined;
  };
  const centre = sketchCentre(objects, scalar);
  const chips = new Map<string, SketchRelationGlyphChip>();
  const place = (
    key: string,
    placement: SketchRelationGlyphChip['placement'],
    anchor: Point,
    normal: Point,
    glyph: SketchRelationGlyph
  ) => {
    let chip = chips.get(key);
    if (!chip) {
      chip = { key, placement, anchor, normal, glyphs: [] };
      chips.set(key, chip);
    }
    if (
      !chip.glyphs.some((entry) => entry.constraintId === glyph.constraintId)
    ) {
      chip.glyphs.push(glyph);
    }
  };
  const onObject = (objectId: string, glyph: SketchRelationGlyph) => {
    const placed = objectAnchor(byId.get(objectId), scalar, centre);
    if (placed) {
      place(
        `object:${objectId}`,
        'object',
        placed.anchor,
        placed.normal,
        glyph
      );
    }
  };
  // Point glyphs are clustered after every anchor is known, so a corner's
  // relations read as one chip. `through` is a curve that passes through the
  // point rather than ending there (a midpoint's line, an on-curve target).
  const pointGlyphs: {
    anchor: Point;
    glyph: SketchRelationGlyph;
    through?: string;
  }[] = [];
  const onPoint = (
    ref: SketchPointRef,
    glyph: SketchRelationGlyph,
    through?: string
  ) => {
    const anchor = sketchPointPosition(
      byId.get(ref.objectId),
      ref.point,
      scalar
    );
    if (anchor) pointGlyphs.push({ anchor, glyph, through });
  };

  for (const constraint of constraints) {
    if (constraint.origin === 'promotion-structure') continue;
    const data = constraint.data;
    if (
      data.constraintKind === 'distance' ||
      data.constraintKind === 'radius' ||
      data.constraintKind === 'angle'
    ) {
      continue;
    }
    if (
      options.visibility === 'selected' &&
      !constraintReferencesObject(data, selected!)
    ) {
      continue;
    }
    if (options.hiddenKinds?.has(data.constraintKind)) continue;
    const constraintId = String(constraint.constraintId);
    const glyph: SketchRelationGlyph = {
      constraintId,
      kind: data.constraintKind,
      ...SKETCH_RELATION_GLYPHS[data.constraintKind],
      conflicted: options.conflictingConstraintIds?.has(constraintId) ?? false,
      ...(options.selectedConstraintId === constraintId
        ? { selected: true }
        : {})
    };
    switch (data.constraintKind) {
      case 'horizontal':
      case 'vertical':
        onObject(data.objectId, glyph);
        break;
      case 'parallel':
      case 'perpendicular':
      case 'equal':
      case 'tangent':
      case 'concentric':
        onObject(data.a, glyph);
        onObject(data.b, glyph);
        break;
      case 'coincident':
        // Both ends: before a Solve, or after a refused one, they can differ.
        onPoint(data.a, glyph);
        onPoint(data.b, glyph);
        break;
      case 'midpoint':
        onPoint(data.point, glyph, data.line);
        break;
      case 'point-on-object':
        onPoint(data.point, glyph, data.objectId);
        break;
      case 'lock':
        onPoint(data.point, glyph);
        break;
      case 'symmetric':
        onPoint(data.a, glyph);
        onPoint(data.b, glyph);
        onObject(data.axis, glyph);
        break;
    }
  }
  // Every curve end joins the clustering as a probe, so a point chip knows
  // which way each curve meeting there leaves it, related or not. With no
  // point chip there is nothing for them to orient.
  const probes: { anchor: Point; direction: Point }[] = [];
  if (pointGlyphs.length > 0) {
    for (const object of objects) {
      for (const end of curveEnds(object.data, scalar)) probes.push(end);
    }
  }
  const clusters = clusterPoints(options.stats, [
    ...pointGlyphs.map(({ anchor }) => anchor),
    ...probes.map(({ anchor }) => anchor)
  ]);
  const directions = new Map<number, Point[]>();
  const leaving = (cluster: number) => {
    let list = directions.get(cluster);
    if (!list) {
      list = [];
      directions.set(cluster, list);
    }
    return list;
  };
  probes.forEach(({ direction }, index) => {
    leaving(clusters[pointGlyphs.length + index]!).push(direction);
  });
  pointGlyphs.forEach(({ anchor, through }, index) => {
    if (!through) return;
    const tangent = tangentThrough(byId.get(through), anchor, scalar);
    if (!tangent) return;
    const list = leaving(clusters[index]!);
    list.push(tangent, { x: -tangent.x, y: -tangent.y });
  });
  pointGlyphs.forEach(({ anchor, glyph }, index) => {
    const cluster = clusters[index]!;
    const key = `point:${cluster}`;
    const fresh = !chips.has(key);
    const gap = widestGapOf(directions.get(cluster) ?? []);
    place(key, 'point', anchor, gap.normal, glyph);
    if (fresh) chips.get(key)!.halfGap = gap.halfGap;
  });
  return orderedChips([...chips.values()]);
}

/**
 * Every drawn sketch curve as plane-local segments [x1, y1, x2, y2, …], from
 * the same polylines the sketch view draws. Relation glyphs keep clear of
 * them: a glyph is a button, and one over any curve, related or not, would
 * take that curve's picks. Text counts too: it is picked by its outline
 * loops, so they are kept clear like any curve, under the same outline
 * budget the sketch view draws them with (`textBudgetError`, as there). An
 * object that does not resolve contributes nothing.
 */
export function sketchRelationStrokes(
  objects: readonly { data: SketchObjectData }[],
  resolve: Resolve,
  textBudgetError: string | null = null
): Float64Array {
  const strict = (value: unknown): number => {
    const result = resolve(value as number | string);
    if (result === undefined || !Number.isFinite(result)) {
      throw new Error('unresolved');
    }
    return result;
  };
  const segments: number[] = [];
  for (const { data } of displayObjectsWithTextBudget(
    [...objects],
    textBudgetError
  )) {
    let polylines: ReturnType<typeof objectPolylines>;
    try {
      polylines = objectPolylines(data, strict);
    } catch {
      continue;
    }
    for (const { points, closed } of polylines) {
      const last = closed ? points.length : points.length - 1;
      for (let index = 0; index < last; index += 1) {
        const a = points[index]!;
        const b = points[(index + 1) % points.length]!;
        segments.push(a.x, a.y, b.x, b.y);
      }
    }
  }
  return Float64Array.from(segments);
}

/**
 * Every pickable sketch point as plane-local pairs [x, y, …]: the sketch
 * origin, each object's endpoint and centre snap targets (line, arc and
 * elliptical-arc ends, a fit spline's every point, shape corners, centres,
 * a text origin; the same list the snapping offers) and its grab point (the
 * move handle). Relation glyphs keep clear of them too: a glyph over one
 * would take the pick or snap meant for it. Midpoints and quadrants are left
 * out: they lie on the drawn curve, which glyphs already keep clear of.
 */
export function sketchRelationKeepOuts(
  objects: readonly { data: SketchObjectData }[],
  resolve: Resolve
): Float64Array {
  const strict = (value: unknown): number => {
    const result = resolve(value as number | string);
    if (result === undefined || !Number.isFinite(result)) {
      throw new Error('unresolved');
    }
    return result;
  };
  const points: number[] = [0, 0];
  for (const { data } of objects) {
    const from = points.length;
    const add = (x: number, y: number) => {
      for (let at = from; at < points.length; at += 2) {
        if (points[at] === x && points[at + 1] === y) return;
      }
      points.push(x, y);
    };
    try {
      for (const target of snapTargetsForObject(data, strict)) {
        if (target.kind === 'endpoint' || target.kind === 'center') {
          add(target.x, target.y);
        }
      }
    } catch {
      // An object that does not resolve offers no snap targets either.
    }
    const grab = sketchObjectGrabPoint(data, strict);
    if (grab) add(grab.x, grab.y);
  }
  return Float64Array.from(points);
}

/**
 * The anchor order: the order chips claim screen space in. A chip holding
 * the selected relation goes first, so it is never the one crowded out; then
 * point chips, since a corner has the least room and the most to say; curve
 * chips fill in around them. Within a placement the order is by position, so it is
 * stable across renders and independent of constraint order.
 */
function orderedChips(
  chips: SketchRelationGlyphChip[]
): SketchRelationGlyphChip[] {
  const selected = (chip: SketchRelationGlyphChip) =>
    chip.glyphs.some((glyph) => glyph.selected) ? 0 : 1;
  return chips.sort(
    (a, b) =>
      selected(a) - selected(b) ||
      (a.placement === b.placement ? 0 : a.placement === 'point' ? -1 : 1) ||
      a.anchor.x - b.anchor.x ||
      a.anchor.y - b.anchor.y ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
}

/** Standoff for a point with nothing known around it: down and to the right. */
const DEFAULT_POINT_NORMAL: Point = { x: Math.SQRT1_2, y: -Math.SQRT1_2 };

/**
 * The bisector of the widest angular gap between the directions curves
 * leave a point in: opposite a lone line's end, outside a corner, and to
 * one side of a line passing straight through.
 */
export function widestGap(directions: readonly Point[]): Point {
  return widestGapOf(directions).normal;
}

/** {@link widestGap}'s bisector, with half the gap's width in radians. */
export function widestGapOf(directions: readonly Point[]): {
  normal: Point;
  halfGap: number;
} {
  const angles = directions
    .filter(({ x, y }) => Math.hypot(x, y) > 1e-12)
    .map(({ x, y }) => Math.atan2(y, x))
    .sort((a, b) => a - b);
  if (angles.length === 0) {
    return { normal: DEFAULT_POINT_NORMAL, halfGap: Math.PI };
  }
  let bestGap = -1;
  let bestStart = 0;
  for (let index = 0; index < angles.length; index += 1) {
    const start = angles[index]!;
    const end =
      index + 1 < angles.length ? angles[index + 1]! : angles[0]! + 2 * Math.PI;
    // Ties keep the first gap, so a straight line's standoff side is stable.
    if (end - start > bestGap + 1e-9) {
      bestGap = end - start;
      bestStart = start;
    }
  }
  const angle = bestStart + bestGap / 2;
  return {
    normal: { x: Math.cos(angle), y: Math.sin(angle) },
    halfGap: bestGap / 2
  };
}

/** Each line and arc end, with the unit direction the curve leaves it in. */
function curveEnds(
  data: SketchObjectData,
  scalar: (value: number | string) => number | undefined
): { anchor: Point; direction: Point }[] {
  if (data.objectKind === 'line') {
    const start = sketchPointPosition(data, 'start', scalar);
    const end = sketchPointPosition(data, 'end', scalar);
    if (!start || !end) return [];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (!(length > 0)) return [];
    const ux = (end.x - start.x) / length;
    const uy = (end.y - start.y) / length;
    return [
      { anchor: start, direction: { x: ux, y: uy } },
      { anchor: end, direction: { x: -ux, y: -uy } }
    ];
  }
  if (data.objectKind === 'spline') {
    // An open spline leaves each end along its end tangent. The curve is
    // clamped, so that is its first (last) control leg: for a fit spline,
    // the controls the fit solved, not the next point it passes through.
    if (data.closed === true || data.points.length < 2) return [];
    let controls: readonly Point[];
    try {
      controls = resolveSplineGeometry(data, (value) => {
        const result = scalar(value);
        if (result === undefined) throw new Error('unresolved');
        return result;
      }).controls;
    } catch {
      return [];
    }
    const ends: { anchor: Point; direction: Point }[] = [];
    const leave = (from: number, step: number) => {
      const a = controls[from];
      if (!a) return;
      // The first control apart from the end: coincident controls give no
      // direction.
      for (let at = from + step; at >= 0 && at < controls.length; at += step) {
        const b = controls[at]!;
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (length > 1e-12) {
          ends.push({
            anchor: { x: a.x, y: a.y },
            direction: { x: (b.x - a.x) / length, y: (b.y - a.y) / length }
          });
          return;
        }
      }
    };
    leave(0, 1);
    leave(controls.length - 1, -1);
    return ends;
  }
  if (data.objectKind !== 'arc') return [];
  const start = sketchPointPosition(data, 'start', scalar);
  const end = sketchPointPosition(data, 'end', scalar);
  const startDeg = scalar(data.startAngleDeg);
  const endDeg = scalar(data.endAngleDeg);
  if (!start || !end || startDeg === undefined || endDeg === undefined) {
    return [];
  }
  // Arcs run counter-clockwise from start to end: the tangent leaving the
  // start is the radius turned +90°, the one leaving the end turned −90°.
  const a = (startDeg * Math.PI) / 180;
  const b = (endDeg * Math.PI) / 180;
  return [
    { anchor: start, direction: { x: -Math.sin(a), y: Math.cos(a) } },
    { anchor: end, direction: { x: Math.sin(b), y: -Math.cos(b) } }
  ];
}

/** A curve's unit tangent at a point on (or near) it. */
function tangentThrough(
  data: SketchObjectData | undefined,
  at: Point,
  scalar: (value: number | string) => number | undefined
): Point | null {
  if (!data) return null;
  if (data.objectKind === 'line') {
    const ends = curveEnds(data, scalar);
    return ends[0]?.direction ?? null;
  }
  if (data.objectKind === 'ellipse') {
    // Point on curve accepts an ellipse: its tangent at the point's
    // parameter, from the point in the ellipse's own frame.
    const cx = scalar(data.centerX);
    const cy = scalar(data.centerY);
    const rx = scalar(data.radiusX);
    const ry = scalar(data.radiusY);
    const rotation = scalar(data.rotationDeg);
    if (
      cx === undefined ||
      cy === undefined ||
      rx === undefined ||
      ry === undefined ||
      rotation === undefined ||
      !(rx > 0) ||
      !(ry > 0)
    ) {
      return null;
    }
    const radians = (rotation * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const lx = (at.x - cx) * cos + (at.y - cy) * sin;
    const ly = -(at.x - cx) * sin + (at.y - cy) * cos;
    const t = Math.atan2(ly / ry, lx / rx);
    const tx = -rx * Math.sin(t);
    const ty = ry * Math.cos(t);
    const length = Math.hypot(tx, ty);
    if (!(length > 0)) return null;
    return {
      x: (tx * cos - ty * sin) / length,
      y: (tx * sin + ty * cos) / length
    };
  }
  if (data.objectKind !== 'circle' && data.objectKind !== 'arc') return null;
  const cx = scalar(data.centerX);
  const cy = scalar(data.centerY);
  if (cx === undefined || cy === undefined) return null;
  const length = Math.hypot(at.x - cx, at.y - cy);
  if (!(length > 0)) return null;
  return { x: -(at.y - cy) / length, y: (at.x - cx) / length };
}

/**
 * Two anchors closer than this are one point. A solve leaves coincident
 * points far closer, and distinct points this close are one spot on screen.
 * It depends only on the points themselves, never on the sketch's extent, so
 * a large or far-offset sketch does not merge separate points. The relative
 * term is a few hundred units in the last place of the coordinate, enough
 * for the rounding a solve leaves far from the plane origin and no more: at
 * 1e12 it is about 0.06, so points half a unit apart stay apart there.
 */
const SAME_POINT_ULPS = 256 * Number.EPSILON;

function samePointTolerance(point: Point): number {
  return (
    1e-6 + SAME_POINT_ULPS * Math.max(Math.abs(point.x), Math.abs(point.y))
  );
}

/**
 * Cluster id per anchor, by proximity. Each anchor is bucketed on a grid at
 * its own tolerance's scale (a power of two at or above it), so one far-off
 * point does not coarsen the buckets for every other, and each bucket holds a
 * bounded handful of distinct points. Two points that match have tolerances
 * within a factor of 1 ± 6e-14 of each other (each grows with its own
 * coordinates, and they differ by at most the tolerance), so their scales are
 * at most one level apart: a point is matched against the levels beside its
 * own, over enough neighbouring cells to cover the reach, and two coincident
 * points are never split across a cell boundary. That is O(n) for any layout.
 */
function clusterPoints(
  stats: { comparisons: number } | undefined,
  points: readonly Point[]
): number[] {
  const ids = new Array<number>(points.length);
  const grid = new Map<
    string,
    { point: Point; tolerance: number; id: number }[]
  >();
  let next = 0;
  points.forEach((point, index) => {
    const tolerance = samePointTolerance(point);
    const level = Math.ceil(Math.log2(tolerance));
    let id: number | undefined;
    for (let other = level - 1; other <= level + 1; other += 1) {
      const cell = 2 ** other;
      // The widest reach to a representative at that level, in its cells.
      const span = Math.ceil(Math.max(tolerance, cell) / cell);
      const cx = Math.floor(point.x / cell);
      const cy = Math.floor(point.y / cell);
      for (let dx = -span; dx <= span; dx += 1) {
        for (let dy = -span; dy <= span; dy += 1) {
          for (const candidate of grid.get(`${other},${cx + dx},${cy + dy}`) ??
            []) {
            if (stats) stats.comparisons += 1;
            const reach = Math.max(tolerance, candidate.tolerance);
            if (
              Math.abs(point.x - candidate.point.x) <= reach &&
              Math.abs(point.y - candidate.point.y) <= reach &&
              (id === undefined || candidate.id < id)
            ) {
              id = candidate.id;
            }
          }
        }
      }
    }
    if (id === undefined) {
      id = next;
      next += 1;
      const cell = 2 ** level;
      const key = `${level},${Math.floor(point.x / cell)},${Math.floor(point.y / cell)}`;
      const bucket = grid.get(key);
      const representative = { point, tolerance, id };
      if (bucket) bucket.push(representative);
      else grid.set(key, [representative]);
    }
    ids[index] = id;
  });
  return ids;
}

/**
 * An ellipse's own relations sit at parameter 45° (an elliptical arc's
 * mid-sweep), standing off along its outward normal there, like a circle's.
 */
function ellipseAnchor(
  data: Extract<SketchObjectData, { objectKind: 'ellipse' }>,
  scalar: (value: number | string) => number | undefined
): { anchor: Point; normal: Point } | null {
  const cx = scalar(data.centerX);
  const cy = scalar(data.centerY);
  const rx = scalar(data.radiusX);
  const ry = scalar(data.radiusY);
  const rotation = scalar(data.rotationDeg);
  if (
    cx === undefined ||
    cy === undefined ||
    rx === undefined ||
    ry === undefined ||
    rotation === undefined ||
    !(rx > 0) ||
    !(ry > 0)
  ) {
    return null;
  }
  let paramDeg = 45;
  if (data.startParamDeg !== undefined && data.endParamDeg !== undefined) {
    const start = scalar(data.startParamDeg);
    const end = scalar(data.endParamDeg);
    if (start === undefined || end === undefined) return null;
    try {
      paramDeg = start + boundedArcSweepDegrees(start, end) / 2;
    } catch {
      return null;
    }
  }
  const t = (paramDeg * Math.PI) / 180;
  const r = (rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const lx = rx * Math.cos(t);
  const ly = ry * Math.sin(t);
  // The outward normal in the ellipse's frame is the gradient (x/rx², y/ry²).
  const gx = Math.cos(t) / rx;
  const gy = Math.sin(t) / ry;
  const length = Math.hypot(gx, gy);
  return {
    anchor: { x: cx + lx * cos - ly * sin, y: cy + lx * sin + ly * cos },
    normal: {
      x: (gx * cos - gy * sin) / length,
      y: (gx * sin + gy * cos) / length
    }
  };
}

/** The middle of the sketch's line and circle extent, or null when empty. */
function sketchCentre(
  objects: readonly { data: SketchObjectData }[],
  scalar: (value: number | string) => number | undefined
): Point | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number, reach = 0) => {
    minX = Math.min(minX, x - reach);
    minY = Math.min(minY, y - reach);
    maxX = Math.max(maxX, x + reach);
    maxY = Math.max(maxY, y + reach);
  };
  for (const { data } of objects) {
    if (data.objectKind === 'line') {
      for (const end of curveEnds(data, scalar))
        grow(end.anchor.x, end.anchor.y);
    } else if (data.objectKind === 'circle' || data.objectKind === 'arc') {
      const cx = scalar(data.centerX);
      const cy = scalar(data.centerY);
      const radius = scalar(data.radius);
      if (cx !== undefined && cy !== undefined && radius !== undefined) {
        grow(cx, cy, Math.abs(radius));
      }
    }
  }
  return Number.isFinite(minX)
    ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
    : null;
}

/**
 * Where a curve's own relations sit — a line's middle, a circle's 45°, an
 * arc's mid-sweep — and the side they stand off to: a circle's or arc's
 * outside, and a line's side away from the sketch's centre, so a closed
 * profile's chips sit outside it. A line through the centre takes its upper
 * side (its right side when vertical).
 */
function objectAnchor(
  data: SketchObjectData | undefined,
  scalar: (value: number | string) => number | undefined,
  centre: Point | null
): { anchor: Point; normal: Point } | null {
  if (!data) return null;
  if (data.objectKind === 'line') {
    const x1 = scalar(data.x1);
    const y1 = scalar(data.y1);
    const x2 = scalar(data.x2);
    const y2 = scalar(data.y2);
    if (
      x1 === undefined ||
      y1 === undefined ||
      x2 === undefined ||
      y2 === undefined
    ) {
      return null;
    }
    const length = Math.hypot(x2 - x1, y2 - y1);
    let normal: Point =
      length > 0
        ? { x: -(y2 - y1) / length, y: (x2 - x1) / length }
        : { x: 0, y: 1 };
    const anchor = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
    const away = centre
      ? normal.x * (anchor.x - centre.x) + normal.y * (anchor.y - centre.y)
      : 0;
    const tolerance = 1e-9 * Math.max(1, length);
    if (
      away < -tolerance ||
      (Math.abs(away) <= tolerance &&
        (normal.y < -1e-9 || (Math.abs(normal.y) <= 1e-9 && normal.x < 0)))
    ) {
      normal = { x: -normal.x, y: -normal.y };
    }
    return { anchor, normal };
  }
  if (data.objectKind === 'ellipse') return ellipseAnchor(data, scalar);
  if (data.objectKind !== 'circle' && data.objectKind !== 'arc') return null;
  const cx = scalar(data.centerX);
  const cy = scalar(data.centerY);
  const radius = scalar(data.radius);
  if (cx === undefined || cy === undefined || radius === undefined) return null;
  let angleDeg = 45;
  if (data.objectKind === 'arc') {
    const start = scalar(data.startAngleDeg);
    const end = scalar(data.endAngleDeg);
    if (start === undefined || end === undefined) return null;
    try {
      angleDeg = start + boundedArcSweepDegrees(start, end) / 2;
    } catch {
      return null;
    }
  }
  const radians = (angleDeg * Math.PI) / 180;
  const normal = { x: Math.cos(radians), y: Math.sin(radians) };
  return {
    anchor: { x: cx + radius * normal.x, y: cy + radius * normal.y },
    normal
  };
}

import {
  DRAWING_VIEW_FRAMES,
  drawingPaperPerModelUnit,
  projectToView,
  type DrawingAnnotationId,
  type DrawingViewId,
  type DrawingSheet,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingEdgeRef,
  type DrawingPointAnchor,
  type DrawingView,
  type EdgeTopology,
  type GeometryBodyRepresentation,
  type UnitSystem
} from '@openzcad/shared';
import { resolveEdge, topologyResolutionMessage } from '../topologyResolution';
import {
  sheetSafeText,
  textWidthMm,
  viewPageTransform,
  type ComposedView,
  type SheetStroke,
  type SheetText
} from './sheetPage';

/**
 * D02 annotation geometry: from a stored annotation to what it measures in
 * its view, and from that to strokes and text on the paper.
 *
 * Values come from the model every time — exact edge vertices and published
 * circle data projected into the view's plane — never from anything the
 * sheet stored. A reference that does not resolve to exactly one edge, or
 * an edge the view can no longer measure (a circle now seen edge-on, two
 * edges now parallel), makes the annotation broken with a reason; nothing
 * is ever measured from a substitute.
 */

type SourceBody = BodyRepresentation | GeometryBodyRepresentation;
export type AnnotationBodies = Readonly<Record<string, SourceBody | undefined>>;

export type AnnotationBreak =
  | 'body-missing'
  | 'not-in-view'
  | 'not-found'
  | 'ambiguous'
  | 'closed-edge'
  | 'not-circular'
  | 'edge-on'
  | 'not-straight'
  | 'parallel'
  | 'degenerate'
  | 'foreshortened'
  | 'leader-hidden';

type UV = [number, number];

export type ResolvedAnnotation =
  | {
      kind: 'linear';
      /** Unit measuring direction in the view plane. */
      axis: UV;
      from: UV;
      to: UV;
      value: number;
      label: string;
    }
  | {
      kind: 'radius' | 'diameter';
      center: UV;
      radius: number;
      value: number;
      label: string;
    }
  | {
      kind: 'angle';
      vertex: UV;
      /** Each edge's near and far end, far end last. */
      rays: [[UV, UV], [UV, UV]];
      value: number;
      label: string;
    }
  | {
      kind: 'note';
      label: string;
      /** The leader edge's projected polyline, flat `[u, v, …]`. */
      leader?: number[];
    };

export type AnnotationResolution =
  | { ok: true; resolved: ResolvedAnnotation }
  | { ok: false; reason: AnnotationBreak; message: string };

export function annotationBreakMessage(reason: AnnotationBreak): string {
  switch (reason) {
    case 'body-missing':
    case 'not-found':
    case 'ambiguous':
      return topologyResolutionMessage(reason);
    case 'not-in-view':
      return 'The body this measured is no longer drawn in this view.';
    case 'closed-edge':
      return 'The edge this measured from is now a closed loop with no ends.';
    case 'not-circular':
      return 'The edge this measured is no longer a circle.';
    case 'edge-on':
      return 'The view now sees this geometry edge-on, so it cannot be measured here.';
    case 'not-straight':
      return 'An edge this measured is no longer straight.';
    case 'parallel':
      return 'The two edges are now parallel in this view, so they make no angle.';
    case 'degenerate':
      return 'The two points this measured now coincide in this view.';
    case 'leader-hidden':
      return 'The view no longer draws any of the edge this note points at.';
    case 'foreshortened':
      return 'This view does not see what this measures true size (it slopes into the view, or the view is isometric); dimension it where it lies parallel to the view.';
  }
}

/** Default decimal places per document unit, trailing zeros trimmed. */
const LENGTH_DECIMALS: Readonly<Record<UnitSystem, number>> = {
  mm: 2,
  cm: 3,
  m: 4,
  inch: 3
};
const ANGLE_DECIMALS = 1;

/** Fixed decimals with trailing zeros trimmed; never "-0". */
export function formatDrawingNumber(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
  return /^-0(\.0*)?$/.test(trimmed) ? '0' : trimmed;
}

export function defaultDimensionDecimals(
  kind: Exclude<DrawingAnnotation['kind'], 'note'>,
  units: UnitSystem
): number {
  return kind === 'angle' ? ANGLE_DECIMALS : LENGTH_DECIMALS[units];
}

function failure(reason: AnnotationBreak): AnnotationResolution {
  return { ok: false, reason, message: annotationBreakMessage(reason) };
}

type EdgeLookup =
  { ok: true; edge: EdgeTopology } | { ok: false; reason: AnnotationBreak };

function lookupEdge(
  ref: DrawingEdgeRef,
  view: DrawingView,
  bodies: AnnotationBodies
): EdgeLookup {
  const body = bodies[ref.bodyId];
  if (!body || body.consumed) return { ok: false, reason: 'body-missing' };
  if (!view.bodyIds.includes(ref.bodyId))
    return { ok: false, reason: 'not-in-view' };
  const found = resolveEdge(body, ref);
  return found.ok
    ? { ok: true, edge: found.entry }
    : { ok: false, reason: found.reason };
}

function projectPoint(view: DrawingView, p: ArrayLike<number>, at: number) {
  return projectToView(DRAWING_VIEW_FRAMES[view.orientation], {
    x: p[at]!,
    y: p[at + 1]!,
    z: p[at + 2]!
  });
}

/** An edge is closed when the kernel names one vertex at both ends. */
function isClosed(edge: EdgeTopology): boolean {
  if (edge.vertexIds) return edge.vertexIds[0] === edge.vertexIds[1];
  const p = edge.points;
  const n = p.length;
  return (
    n >= 6 &&
    Math.hypot(p[0]! - p[n - 3]!, p[1]! - p[n - 2]!, p[2]! - p[n - 1]!) < 1e-9
  );
}

/**
 * An open edge's two ends in the view's page order: the end further left
 * first, or the lower one when they are level, then the nearer one.
 */
export function edgeEndsInPageOrder(
  view: DrawingView,
  edge: EdgeTopology
): [UV, UV] | null {
  const ends = edgeEndsWithDepth(view, edge);
  return ends ? [ends[0].uv, ends[1].uv] : null;
}

interface ViewPoint {
  uv: UV;
  /** Distance into the view along its direction, in model units. */
  depth: number;
}

/** {@link edgeEndsInPageOrder}, keeping each end's depth. */
function edgeEndsWithDepth(
  view: DrawingView,
  edge: EdgeTopology
): [ViewPoint, ViewPoint] | null {
  const p = edge.points;
  if (p.length < 6 || isClosed(edge)) return null;
  const a = projectPoint(view, p, 0);
  const b = projectPoint(view, p, p.length - 3);
  const tolerance = 1e-9 * Math.max(1, Math.abs(a.u), Math.abs(b.u));
  const level = (x: number, y: number) =>
    Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  const aFirst =
    Math.abs(a.u - b.u) > tolerance
      ? a.u < b.u
      : !level(a.v, b.v)
        ? a.v < b.v
        : a.depth <= b.depth;
  const ua: ViewPoint = { uv: [a.u, a.v], depth: a.depth };
  const ub: ViewPoint = { uv: [b.u, b.v], depth: b.depth };
  return aFirst ? [ua, ub] : [ub, ua];
}

/**
 * Whether two points lie in one plane parallel to the view, so the span
 * between them is drawn true length. `span` is their projected distance.
 */
function parallelToView(a: ViewPoint, b: ViewPoint, span: number): boolean {
  return Math.abs(b.depth - a.depth) <= 1e-6 * Math.max(1, span);
}

/** A circle's centre and radius when the view sees it face-on. */
function faceOnCircle(
  view: DrawingView,
  edge: EdgeTopology
):
  | { ok: true; center: UV; depth: number; radius: number }
  | { ok: false; reason: AnnotationBreak } {
  const circle = edge.curve?.circle;
  if (!circle) return { ok: false, reason: 'not-circular' };
  const direction = DRAWING_VIEW_FRAMES[view.orientation].direction;
  const facing =
    circle.axis.x * direction.x +
    circle.axis.y * direction.y +
    circle.axis.z * direction.z;
  if (Math.abs(Math.abs(facing) - 1) > 1e-6)
    return { ok: false, reason: 'edge-on' };
  const c = projectToView(DRAWING_VIEW_FRAMES[view.orientation], circle.center);
  return {
    ok: true,
    center: [c.u, c.v],
    depth: c.depth,
    radius: circle.radius
  };
}

function pointOf(
  view: DrawingView,
  edge: EdgeTopology,
  anchor: DrawingPointAnchor
): { ok: true; point: ViewPoint } | { ok: false; reason: AnnotationBreak } {
  if (anchor === 'center') {
    const circle = faceOnCircle(view, edge);
    return circle.ok
      ? { ok: true, point: { uv: circle.center, depth: circle.depth } }
      : circle;
  }
  const ends = edgeEndsWithDepth(view, edge);
  if (!ends) return { ok: false, reason: 'closed-edge' };
  return { ok: true, point: anchor === 'first' ? ends[0] : ends[1] };
}

function projectedPolyline(view: DrawingView, edge: EdgeTopology): number[] {
  const out: number[] = [];
  for (let i = 0; i + 2 < edge.points.length; i += 3) {
    const { u, v } = projectPoint(view, edge.points, i);
    out.push(u, v);
  }
  return out;
}

/** A straight edge's projected ends, or why it cannot serve as a ray. */
function straightEnds(
  view: DrawingView,
  edge: EdgeTopology
): { ok: true; ends: [UV, UV] } | { ok: false; reason: AnnotationBreak } {
  if (edge.curve?.type !== 'LINE') return { ok: false, reason: 'not-straight' };
  const ends = edgeEndsWithDepth(view, edge);
  if (!ends) return { ok: false, reason: 'not-straight' };
  const [a, b] = ends;
  const length = Math.hypot(b.uv[0] - a.uv[0], b.uv[1] - a.uv[1]);
  if (length < 1e-9) return { ok: false, reason: 'edge-on' };
  // An edge sloping into the view draws shorter than it is, and the angle
  // it makes on the page is not the part's.
  if (!parallelToView(a, b, length))
    return { ok: false, reason: 'foreshortened' };
  return { ok: true, ends: [a.uv, b.uv] };
}

/**
 * What `annotation` measures in `view` of the current model, or why it no
 * longer can. A note without a view needs no model at all.
 */
export function resolveDrawingAnnotation(
  annotation: DrawingAnnotation,
  view: DrawingView | undefined,
  bodies: AnnotationBodies,
  units: UnitSystem
): AnnotationResolution {
  if (annotation.kind === 'note') {
    const label = annotation.text;
    if (!annotation.leader || !view)
      return { ok: true, resolved: { kind: 'note', label } };
    const found = lookupEdge(annotation.leader, view, bodies);
    if (!found.ok) return failure(found.reason);
    return {
      ok: true,
      resolved: {
        kind: 'note',
        label,
        leader: projectedPolyline(view, found.edge)
      }
    };
  }
  if (!view) return failure('not-in-view');
  // An isometric projection shortens every length by a direction-dependent
  // factor, so a span or angle read off it is not the part's. A circle seen
  // face-on there is true size and may still be dimensioned.
  if (
    view.orientation === 'iso' &&
    (annotation.kind === 'linear' || annotation.kind === 'angle')
  )
    return failure('foreshortened');
  const decimals =
    annotation.decimals ?? defaultDimensionDecimals(annotation.kind, units);
  switch (annotation.kind) {
    case 'linear': {
      const fromEdge = lookupEdge(annotation.from.edge, view, bodies);
      if (!fromEdge.ok) return failure(fromEdge.reason);
      const toEdge = lookupEdge(annotation.to.edge, view, bodies);
      if (!toEdge.ok) return failure(toEdge.reason);
      const from = pointOf(view, fromEdge.edge, annotation.from.anchor);
      if (!from.ok) return failure(from.reason);
      const to = pointOf(view, toEdge.edge, annotation.to.anchor);
      if (!to.ok) return failure(to.reason);
      const du = to.point.uv[0] - from.point.uv[0];
      const dv = to.point.uv[1] - from.point.uv[1];
      let axis: UV;
      // Horizontal and vertical spans are distances along a model axis in
      // a principal view, true whatever the depths. An aligned span is the
      // points' true distance only when they lie in one plane parallel to
      // the view.
      if (annotation.direction === 'horizontal') axis = [1, 0];
      else if (annotation.direction === 'vertical') axis = [0, 1];
      else {
        const length = Math.hypot(du, dv);
        if (length < 1e-9) return failure('degenerate');
        if (!parallelToView(from.point, to.point, length))
          return failure('foreshortened');
        axis = [du / length, dv / length];
      }
      const value = Math.abs(du * axis[0] + dv * axis[1]);
      return {
        ok: true,
        resolved: {
          kind: 'linear',
          axis,
          from: from.point.uv,
          to: to.point.uv,
          value,
          label: formatDrawingNumber(value, decimals)
        }
      };
    }
    case 'radius':
    case 'diameter': {
      const found = lookupEdge(annotation.edge, view, bodies);
      if (!found.ok) return failure(found.reason);
      const circle = faceOnCircle(view, found.edge);
      if (!circle.ok) return failure(circle.reason);
      const value =
        annotation.kind === 'radius' ? circle.radius : 2 * circle.radius;
      return {
        ok: true,
        resolved: {
          kind: annotation.kind,
          center: circle.center,
          radius: circle.radius,
          value,
          // WinAnsi has no diameter sign; Ø (U+00D8) is the usual stand-in.
          label: `${annotation.kind === 'radius' ? 'R' : 'Ø'}${formatDrawingNumber(value, decimals)}`
        }
      };
    }
    case 'angle': {
      const rays: [UV, UV][] = [];
      for (const ref of annotation.edges) {
        const found = lookupEdge(ref, view, bodies);
        if (!found.ok) return failure(found.reason);
        const straight = straightEnds(view, found.edge);
        if (!straight.ok) return failure(straight.reason);
        rays.push(straight.ends);
      }
      const [[p1, q1], [p2, q2]] = rays as [[UV, UV], [UV, UV]];
      const e1: UV = [q1[0] - p1[0], q1[1] - p1[1]];
      const e2: UV = [q2[0] - p2[0], q2[1] - p2[1]];
      const cross = e1[0] * e2[1] - e1[1] * e2[0];
      if (Math.abs(cross) <= 1e-9 * Math.hypot(...e1) * Math.hypot(...e2))
        return failure('parallel');
      // Where the two lines meet; each ray runs from there to its edge's
      // further end.
      const t = ((p2[0] - p1[0]) * e2[1] - (p2[1] - p1[1]) * e2[0]) / cross;
      const vertex: UV = [p1[0] + t * e1[0], p1[1] + t * e1[1]];
      const ordered = rays.map(([a, b]) => {
        const da = Math.hypot(a[0] - vertex[0], a[1] - vertex[1]);
        const db = Math.hypot(b[0] - vertex[0], b[1] - vertex[1]);
        return da <= db ? ([a, b] as [UV, UV]) : ([b, a] as [UV, UV]);
      }) as [[UV, UV], [UV, UV]];
      const d = ordered.map(([, far]) => {
        const length = Math.hypot(far[0] - vertex[0], far[1] - vertex[1]);
        return [
          (far[0] - vertex[0]) / length,
          (far[1] - vertex[1]) / length
        ] as UV;
      });
      const cos = Math.min(
        1,
        Math.max(-1, d[0]![0] * d[1]![0] + d[0]![1] * d[1]![1])
      );
      const value = (Math.acos(cos) * 180) / Math.PI;
      return {
        ok: true,
        resolved: {
          kind: 'angle',
          vertex,
          rays: ordered,
          value,
          label: `${formatDrawingNumber(value, decimals)}°`
        }
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Layout on the paper

/** Dimension text height, arrowheads and gaps, in paper millimetres. */
export const ANNOTATION_TEXT_MM = 3;
const ARROW_LENGTH_MM = 3;
const ARROW_HALF_WIDTH_MM = 0.5;
/** Gap between the part and an extension line, and its run past the dimension line. */
const EXTENSION_GAP_MM = 1;
const EXTENSION_OVERSHOOT_MM = 2;
/** Text sits this far off its dimension line. */
const TEXT_LIFT_MM = 1;

export interface AnnotationBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnnotationLayout {
  strokes: SheetStroke[];
  texts: SheetText[];
  /** Where the annotation's text sits, for picking and selection. */
  box: AnnotationBox;
}

type XY = [number, number];

function arrow(tip: XY, direction: XY): SheetStroke {
  const [dx, dy] = direction;
  const bx = tip[0] - dx * ARROW_LENGTH_MM;
  const by = tip[1] - dy * ARROW_LENGTH_MM;
  return {
    kind: 'dimension',
    filled: true,
    closed: true,
    points: [
      tip[0],
      tip[1],
      bx - dy * ARROW_HALF_WIDTH_MM,
      by + dx * ARROW_HALF_WIDTH_MM,
      bx + dy * ARROW_HALF_WIDTH_MM,
      by - dx * ARROW_HALF_WIDTH_MM
    ]
  };
}

function line(a: XY, b: XY): SheetStroke {
  return { kind: 'dimension', points: [a[0], a[1], b[0], b[1]] };
}

/**
 * Text centred on `at` along `angleDeg`, its baseline `TEXT_LIFT_MM` above
 * (on the text's own up side), and the box it covers.
 */
function placedText(
  text: string,
  at: XY,
  angleDeg: number,
  align: 'start' | 'middle' | 'end' = 'middle'
): { text: SheetText; box: AnnotationBox } {
  const safe = sheetSafeText(text);
  const width = textWidthMm(safe, ANNOTATION_TEXT_MM);
  const radians = (angleDeg * Math.PI) / 180;
  const along: XY = [Math.cos(radians), Math.sin(radians)];
  const up: XY = [-along[1], along[0]];
  const baseline: XY = [
    at[0] + up[0] * TEXT_LIFT_MM,
    at[1] + up[1] * TEXT_LIFT_MM
  ];
  const shift = align === 'middle' ? -width / 2 : align === 'end' ? -width : 0;
  const corners: XY[] = [0, width].flatMap((s) =>
    [0, ANNOTATION_TEXT_MM].map(
      (h) =>
        [
          baseline[0] + along[0] * (s + shift) + up[0] * h,
          baseline[1] + along[1] * (s + shift) + up[1] * h
        ] as XY
    )
  );
  const xs = corners.map((corner) => corner[0]);
  const ys = corners.map((corner) => corner[1]);
  const pad = 0.8;
  return {
    text: {
      x: baseline[0],
      y: baseline[1],
      sizeMm: ANNOTATION_TEXT_MM,
      text: safe,
      ...(align !== 'start' ? { align } : {}),
      ...(angleDeg !== 0 ? { angleDeg } : {})
    },
    box: {
      x: Math.min(...xs) - pad,
      y: Math.min(...ys) - pad,
      width: Math.max(...xs) - Math.min(...xs) + 2 * pad,
      height: Math.max(...ys) - Math.min(...ys) + 2 * pad
    }
  };
}

/** Readable text angle for a line along `direction`: in (−90°, 90°]. */
function readableAngle(direction: XY): number {
  let angle = (Math.atan2(direction[1], direction[0]) * 180) / Math.PI;
  if (angle > 90 + 1e-9) angle -= 180;
  else if (angle <= -90 + 1e-9) angle += 180;
  return Math.abs(angle) < 1e-9 ? 0 : angle;
}

function linearLayout(
  resolved: Extract<ResolvedAnnotation, { kind: 'linear' }>,
  toPage: (u: number, v: number) => XY,
  anchor: XY
): AnnotationLayout {
  const a = toPage(...resolved.from);
  const b = toPage(...resolved.to);
  const d: XY = resolved.axis;
  const n: XY = [-d[1], d[0]];
  const dot = (p: XY, q: XY) => p[0] * q[0] + p[1] * q[1];
  const offset = dot(anchor, n);
  const foot = (p: XY): XY => {
    const shift = offset - dot(p, n);
    return [p[0] + n[0] * shift, p[1] + n[1] * shift];
  };
  const fa = foot(a);
  const fb = foot(b);
  const strokes: SheetStroke[] = [];
  for (const [p, f] of [
    [a, fa],
    [b, fb]
  ] as const) {
    const run = offset - dot(p, n);
    if (Math.abs(run) <= EXTENSION_GAP_MM) continue;
    const s = Math.sign(run);
    strokes.push(
      line(
        [
          p[0] + n[0] * s * EXTENSION_GAP_MM,
          p[1] + n[1] * s * EXTENSION_GAP_MM
        ],
        [
          f[0] + n[0] * s * EXTENSION_OVERSHOOT_MM,
          f[1] + n[1] * s * EXTENSION_OVERSHOOT_MM
        ]
      )
    );
  }
  // Along the dimension line: `low` and `high` are the two feet.
  const [low, high] = dot(fa, d) <= dot(fb, d) ? [fa, fb] : [fb, fa];
  const span = dot(high, d) - dot(low, d);
  const label = placedText(resolved.label, [0, 0], readableAngle(d));
  const textWidth = textWidthMm(label.text.text, ANNOTATION_TEXT_MM);
  // The text sits mid-span unless the placement is beyond either end; the
  // dimension line then runs out under it.
  const along = dot(anchor, d);
  const inside = along >= dot(low, d) && along <= dot(high, d);
  const centre: XY = inside
    ? [(low[0] + high[0]) / 2, (low[1] + high[1]) / 2]
    : [
        low[0] + d[0] * (along - dot(low, d)),
        low[1] + d[1] * (along - dot(low, d))
      ];
  const arrowsInside = span >= 2 * ARROW_LENGTH_MM + 1;
  const reach = arrowsInside ? 0 : ARROW_LENGTH_MM + 2;
  const start = Math.min(
    dot(low, d) - reach,
    inside ? Infinity : along - textWidth / 2
  );
  const end = Math.max(
    dot(high, d) + reach,
    inside ? -Infinity : along + textWidth / 2
  );
  const at = (t: number): XY => [
    low[0] + d[0] * (t - dot(low, d)),
    low[1] + d[1] * (t - dot(low, d))
  ];
  strokes.push(line(at(start), at(end)));
  const minus: XY = [-d[0], -d[1]];
  strokes.push(
    arrow(low, arrowsInside ? minus : d),
    arrow(high, arrowsInside ? d : minus)
  );
  const placed = placedText(resolved.label, centre, readableAngle(d));
  return { strokes, texts: [placed.text], box: placed.box };
}

function radialLayout(
  resolved: Extract<ResolvedAnnotation, { kind: 'radius' | 'diameter' }>,
  toPage: (u: number, v: number) => XY,
  k: number,
  anchor: XY
): AnnotationLayout {
  const c = toPage(...resolved.center);
  const r = resolved.radius * k;
  const reach = Math.hypot(anchor[0] - c[0], anchor[1] - c[1]);
  const u: XY =
    reach > 1e-9
      ? [(anchor[0] - c[0]) / reach, (anchor[1] - c[1]) / reach]
      : [1, 0];
  const rim: XY = [c[0] + u[0] * r, c[1] + u[1] * r];
  const out = Math.max(r, reach);
  const end: XY = [c[0] + u[0] * out, c[1] + u[1] * out];
  const strokes: SheetStroke[] = [];
  if (resolved.kind === 'diameter') {
    const opposite: XY = [c[0] - u[0] * r, c[1] - u[1] * r];
    strokes.push(
      line(opposite, end),
      arrow(rim, u),
      arrow(opposite, [-u[0], -u[1]])
    );
  } else {
    strokes.push(line(c, end), arrow(rim, u));
  }
  // A small centre mark.
  const mark = 1.5;
  strokes.push(
    line([c[0] - mark, c[1]], [c[0] + mark, c[1]]),
    line([c[0], c[1] - mark], [c[0], c[1] + mark])
  );
  const right = u[0] >= 0;
  const placed = placedText(
    resolved.label,
    [end[0] + (right ? 1 : -1), end[1]],
    0,
    right ? 'start' : 'end'
  );
  return { strokes, texts: [placed.text], box: placed.box };
}

function angleLayout(
  resolved: Extract<ResolvedAnnotation, { kind: 'angle' }>,
  toPage: (u: number, v: number) => XY,
  anchor: XY
): AnnotationLayout {
  const v = toPage(...resolved.vertex);
  const rays = resolved.rays.map(
    ([near, far]) => [toPage(...near), toPage(...far)] as [XY, XY]
  );
  const dirs = rays.map(([, far]) => {
    const length = Math.hypot(far[0] - v[0], far[1] - v[1]);
    return [(far[0] - v[0]) / length, (far[1] - v[1]) / length] as XY;
  }) as [XY, XY];
  const radius = Math.max(3, Math.hypot(anchor[0] - v[0], anchor[1] - v[1]));
  const a1 = Math.atan2(dirs[0][1], dirs[0][0]);
  let sweep = Math.atan2(dirs[1][1], dirs[1][0]) - a1;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep < -Math.PI) sweep += 2 * Math.PI;
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 60)));
  const points: number[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = a1 + (sweep * i) / steps;
    points.push(
      v[0] + Math.cos(angle) * radius,
      v[1] + Math.sin(angle) * radius
    );
  }
  const strokes: SheetStroke[] = [{ kind: 'dimension', points }];
  const s = Math.sign(sweep) || 1;
  const tangent = (angle: number, sense: number): XY => [
    -Math.sin(angle) * sense,
    Math.cos(angle) * sense
  ];
  const a2 = a1 + sweep;
  strokes.push(
    arrow(
      [v[0] + Math.cos(a1) * radius, v[1] + Math.sin(a1) * radius],
      tangent(a1, -s)
    ),
    arrow(
      [v[0] + Math.cos(a2) * radius, v[1] + Math.sin(a2) * radius],
      tangent(a2, s)
    )
  );
  // Extension lines where the arc lies beyond an edge's far end or short of
  // its near end.
  rays.forEach(([near, far], index) => {
    const d = dirs[index]!;
    const nearDistance = Math.hypot(near[0] - v[0], near[1] - v[1]);
    const farDistance = Math.hypot(far[0] - v[0], far[1] - v[1]);
    const point = (t: number): XY => [v[0] + d[0] * t, v[1] + d[1] * t];
    if (radius > farDistance + EXTENSION_GAP_MM)
      strokes.push(
        line(
          point(farDistance + EXTENSION_GAP_MM),
          point(radius + EXTENSION_OVERSHOOT_MM)
        )
      );
    else if (radius < nearDistance - EXTENSION_GAP_MM)
      strokes.push(
        line(
          point(nearDistance - EXTENSION_GAP_MM),
          point(Math.max(0, radius - EXTENSION_OVERSHOOT_MM))
        )
      );
  });
  const mid = a1 + sweep / 2;
  const reach = radius + 2;
  const placed = placedText(
    resolved.label,
    [
      v[0] + Math.cos(mid) * reach,
      v[1] + Math.sin(mid) * reach - ANNOTATION_TEXT_MM / 2 - 1
    ],
    0
  );
  return { strokes, texts: [placed.text], box: placed.box };
}

function nearestOnPolyline(points: XY[], to: XY): XY | null {
  let best: XY | null = null;
  let bestDistance = Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[Math.min(i + 1, points.length - 1)]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared > 0
        ? Math.min(
            1,
            Math.max(
              0,
              ((to[0] - a[0]) * dx + (to[1] - a[1]) * dy) / lengthSquared
            )
          )
        : 0;
    const p: XY = [a[0] + dx * t, a[1] + dy * t];
    const distance = Math.hypot(p[0] - to[0], p[1] - to[1]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = p;
    }
  }
  return best;
}

/** How far a drawn line may stray from the edge it was drawn from, in mm. */
const DRAWN_COINCIDENCE_MM = 0.05;

/**
 * The parts of an edge's paper polyline the view draws: each drawn segment
 * lying on the edge. Drawn runs are the edge's own projection split where
 * it is occluded, so their segments sit on it to rounding.
 */
function drawnPieces(polyline: XY[], drawn: readonly XY[][]): XY[][] {
  const onEdge = (p: XY) => {
    const nearest = nearestOnPolyline(polyline, p);
    return (
      nearest !== null &&
      Math.hypot(nearest[0] - p[0], nearest[1] - p[1]) <= DRAWN_COINCIDENCE_MM
    );
  };
  const pieces: XY[][] = [];
  for (const run of drawn)
    for (let i = 0; i + 1 < run.length; i += 1)
      if (onEdge(run[i]!) && onEdge(run[i + 1]!))
        pieces.push([run[i]!, run[i + 1]!]);
  return pieces;
}

function nearestOnPieces(pieces: readonly XY[][], to: XY): XY | null {
  let best: XY | null = null;
  let bestDistance = Infinity;
  for (const piece of pieces) {
    const point = nearestOnPolyline(piece, to);
    if (!point) continue;
    const distance = Math.hypot(point[0] - to[0], point[1] - to[1]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  return best;
}

function noteLayout(
  resolved: Extract<ResolvedAnnotation, { kind: 'note' }>,
  toPage: ((u: number, v: number) => XY) | null,
  anchor: XY,
  drawn: readonly XY[][] | undefined
): AnnotationLayout {
  const placed = placedText(
    resolved.label,
    [anchor[0], anchor[1] - TEXT_LIFT_MM],
    0,
    'start'
  );
  const strokes: SheetStroke[] = [];
  if (resolved.leader && toPage) {
    const polyline: XY[] = [];
    for (let i = 0; i + 1 < resolved.leader.length; i += 2)
      polyline.push(toPage(resolved.leader[i]!, resolved.leader[i + 1]!));
    // The tip lands only on what the view draws of the edge: a partly
    // hidden edge, with hidden lines off, is pointed at where it shows.
    const pieces = drawn ? drawnPieces(polyline, drawn) : [polyline];
    const box = placed.box;
    const middle: XY = [box.x + box.width / 2, box.y + box.height / 2];
    const rough = nearestOnPieces(pieces, middle);
    if (rough) {
      // From the side of the text facing the edge, to the nearest point of
      // the edge from there.
      const from: XY = [
        rough[0] < middle[0] ? box.x : box.x + box.width,
        middle[1]
      ];
      const tip = nearestOnPieces(pieces, from) ?? rough;
      const length = Math.hypot(tip[0] - from[0], tip[1] - from[1]);
      if (length > ARROW_LENGTH_MM) {
        strokes.push(
          line(from, tip),
          arrow(tip, [(tip[0] - from[0]) / length, (tip[1] - from[1]) / length])
        );
      }
    }
  }
  return { strokes, texts: [placed.text], box: placed.box };
}

/**
 * The strokes and text of one resolved annotation. `toPage` maps the view's
 * (u, v) to paper millimetres (null for a note on the paper), `k` is paper
 * millimetres per model unit, and `anchor` the annotation's placement on
 * the paper.
 */
export function layoutAnnotation(
  resolved: ResolvedAnnotation,
  toPage: ((u: number, v: number) => XY) | null,
  k: number,
  anchor: XY,
  /** The view's drawn lines on the paper, for a leader's tip. */
  drawn?: readonly XY[][]
): AnnotationLayout {
  if (resolved.kind === 'note')
    return noteLayout(resolved, toPage, anchor, drawn);
  if (!toPage) throw new Error('A dimension needs its view.');
  switch (resolved.kind) {
    case 'linear':
      return linearLayout(resolved, toPage, anchor);
    case 'radius':
    case 'diameter':
      return radialLayout(resolved, toPage, k, anchor);
    case 'angle':
      return angleLayout(resolved, toPage, anchor);
  }
}

/** Where an annotation's placement is on the paper. */
export function annotationAnchor(
  annotation: DrawingAnnotation,
  view: Pick<DrawingView, 'centerMm'> | undefined
): XY {
  return view
    ? [
        view.centerMm.x + annotation.placementMm.x,
        view.centerMm.y + annotation.placementMm.y
      ]
    : [annotation.placementMm.x, annotation.placementMm.y];
}

/**
 * The lines each drawn view shows, on the paper: its visible runs, and its
 * hidden runs when it draws them. A pick must land on one of these, and a
 * leader must end on one, so an edge the view does not show is neither
 * picked through a face nor pointed at.
 */
export function drawnLines(
  sheet: Pick<DrawingSheet, 'scale'>,
  views: readonly ComposedView[],
  units: UnitSystem
): Map<DrawingViewId, XY[][]> {
  const out = new Map<DrawingViewId, XY[][]>();
  for (const { view, projection } of views) {
    if (!projection.bounds) continue;
    const toPage = viewPageTransform(view, projection.bounds, sheet, units);
    const lines: XY[][] = [];
    for (const run of view.hiddenLines
      ? [...projection.visible, ...projection.hidden]
      : projection.visible) {
      const line: XY[] = [];
      for (let i = 0; i + 1 < run.length; i += 2)
        line.push(toPage(run[i]!, run[i + 1]!));
      lines.push(line);
    }
    out.set(view.viewId, lines);
  }
  return out;
}

/** Every annotation of a sheet resolved against the current model. */
export function resolveSheetAnnotations(
  sheet: DrawingSheet,
  bodies: AnnotationBodies,
  units: UnitSystem
): Map<DrawingAnnotationId, AnnotationResolution> {
  const views = new Map(sheet.views.map((view) => [view.viewId, view]));
  return new Map(
    (sheet.annotations ?? []).map((annotation) => [
      annotation.annotationId,
      resolveDrawingAnnotation(
        annotation,
        annotation.viewId ? views.get(annotation.viewId) : undefined,
        bodies,
        units
      )
    ])
  );
}

/**
 * `resolutions` with every note marked broken whose leader edge its drawn
 * view no longer shows at all (occluded after an Update, with hidden lines
 * off): the leader is the note's intent, and quietly dropping it would hand
 * off a plain note instead. Views not yet drawn are left alone.
 */
export function markHiddenLeaders(
  sheet: DrawingSheet,
  resolutions: ReadonlyMap<DrawingAnnotationId, AnnotationResolution>,
  views: readonly ComposedView[],
  units: UnitSystem
): Map<DrawingAnnotationId, AnnotationResolution> {
  const out = new Map(resolutions);
  const leaders = (sheet.annotations ?? []).filter(
    (annotation) => annotation.kind === 'note' && annotation.leader
  );
  if (leaders.length === 0) return out;
  const lines = drawnLines(sheet, views, units);
  const drawn = new Map(views.map((entry) => [entry.view.viewId, entry]));
  for (const annotation of leaders) {
    const resolution = out.get(annotation.annotationId);
    const entry = annotation.viewId ? drawn.get(annotation.viewId) : undefined;
    if (
      !resolution?.ok ||
      resolution.resolved.kind !== 'note' ||
      !resolution.resolved.leader ||
      !entry?.projection.bounds
    )
      continue;
    const toPage = viewPageTransform(
      entry.view,
      entry.projection.bounds,
      sheet,
      units
    );
    const polyline: XY[] = [];
    const leader = resolution.resolved.leader;
    for (let i = 0; i + 1 < leader.length; i += 2)
      polyline.push(toPage(leader[i]!, leader[i + 1]!));
    if (drawnPieces(polyline, lines.get(entry.view.viewId) ?? []).length === 0)
      out.set(annotation.annotationId, failure('leader-hidden'));
  }
  return out;
}

/**
 * The sheet's annotations laid out on its page, for the preview and both
 * exports. An annotation of a view not yet drawn (`views` holds the drawn
 * ones), or one that is broken, is left out; the workspace marks broken
 * ones itself and export refuses while any is.
 */
export function composeSheetAnnotations(
  sheet: DrawingSheet,
  views: readonly ComposedView[],
  resolutions: ReadonlyMap<DrawingAnnotationId, AnnotationResolution>,
  units: UnitSystem
): {
  strokes: SheetStroke[];
  texts: SheetText[];
  boxes: Map<DrawingAnnotationId, AnnotationBox>;
} {
  const strokes: SheetStroke[] = [];
  const texts: SheetText[] = [];
  const boxes = new Map<DrawingAnnotationId, AnnotationBox>();
  const drawn = new Map(views.map((entry) => [entry.view.viewId, entry]));
  const k = drawingPaperPerModelUnit(sheet.scale, units);
  const linesByView = (sheet.annotations ?? []).some(
    (annotation) => annotation.kind === 'note' && annotation.leader
  )
    ? drawnLines(sheet, views, units)
    : null;
  for (const annotation of sheet.annotations ?? []) {
    const resolution = resolutions.get(annotation.annotationId);
    if (!resolution?.ok) continue;
    let toPage: ((u: number, v: number) => XY) | null = null;
    let view: DrawingView | undefined;
    if (annotation.viewId) {
      const entry = drawn.get(annotation.viewId);
      if (!entry?.projection.bounds) continue;
      view = entry.view;
      toPage = viewPageTransform(view, entry.projection.bounds, sheet, units);
    }
    const layout = layoutAnnotation(
      resolution.resolved,
      toPage,
      k,
      annotationAnchor(annotation, view),
      view ? linesByView?.get(view.viewId) : undefined
    );
    strokes.push(...layout.strokes);
    texts.push(...layout.texts);
    boxes.set(annotation.annotationId, layout.box);
  }
  return { strokes, texts, boxes };
}

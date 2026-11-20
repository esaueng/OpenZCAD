import {
  drawingViewFrame,
  drawingEdgeRefError,
  drawingFaceRefError,
  projectToView,
  type BodyId,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingDistanceTarget,
  type DrawingEdgeRef,
  type DrawingExtremeSide,
  type DrawingFaceRef,
  type DrawingPointAnchor,
  type DrawingPointRef,
  type DrawingSheet,
  type DrawingView,
  type DrawingViewId,
  type EdgeTopology,
  type FaceTopology,
  type UnitSystem,
  type Vector3
} from '@openzcad/shared';
import { resolveEdge, resolveFace } from '../topologyResolution';
import {
  annotationBody,
  dimensionPointInView,
  drawnCoincidence,
  drawnLines,
  edgeEndsInPageOrder,
  referenceTrust,
  resolveDrawingAnnotation,
  type SheetBom,
  type AnnotationBodies,
  type HoleCalloutLookup,
  type MarkLookup
} from './annotations';
import {
  clipPolylineToCircle,
  viewClipCircle,
  viewPageTransform,
  viewPaperPerModelUnit,
  type ComposedView
} from './sheetPage';
import { add, cross, dot, norm, scale, sub } from './surfaceSharps';

export { drawnLines };

/**
 * D02 picking: which model edge is under a point of the sheet, and how a
 * run of picks becomes an annotation. Pure, so the canvas and the tests
 * share one rule. Only edges of drawn views are offered, and only an edge
 * whose stored reference resolves back to exactly that edge: a pick that
 * could later bind to a twin is refused up front.
 */

type XY = [number, number];

export interface PickableEdge {
  view: DrawingView;
  bodyId: BodyId;
  edge: EdgeTopology;
  /** The edge's polyline on the paper, in millimetres. */
  page: XY[];
  /** Each polyline point's distance into the view, in model units. */
  depths: number[];
  /** How far a drawn line of this view may lie from it, in paper mm. */
  coincidenceMm: number;
  /** The view's (u, v) to paper millimetres. */
  toPage?: (u: number, v: number) => XY;
}

/**
 * D06: a face whose outline the view draws as straight lines — a plane seen
 * edge-on, or a cylinder or cone seen side-on, whose sides are silhouettes
 * and no model edge. A virtual sharp and a chamfer are picked by these.
 */
export interface PickableFace {
  view: DrawingView;
  bodyId: BodyId;
  face: FaceTopology;
  /** The outline's straight runs on the paper, in millimetres. */
  lines: [XY, XY][];
  toPage: (u: number, v: number) => XY;
}

/** Every physical edge of every drawn view, placed on the paper. */
export function pickableEdges(
  sheet: Pick<DrawingSheet, 'scale'>,
  views: readonly ComposedView[],
  bodies: AnnotationBodies,
  units: UnitSystem
): PickableEdge[] {
  const out: PickableEdge[] = [];
  for (const { view, projection } of views) {
    if (!projection.bounds) continue;
    const toPage = viewPageTransform(view, projection.bounds, sheet, units);
    const frame = drawingViewFrame(view);
    const k = viewPaperPerModelUnit(view, sheet, units);
    const coincidenceMm = drawnCoincidence(bodies, view.bodyIds, k) * k;
    for (const bodyId of view.bodyIds) {
      const body = annotationBody(bodies, view, bodyId);
      if (!body?.topology || body.consumed) continue;
      for (const edge of body.topology.edges) {
        if (edge.displayRole === 'seam' || edge.points.length < 6) continue;
        const page: XY[] = [];
        const depths: number[] = [];
        for (let i = 0; i + 2 < edge.points.length; i += 3) {
          const projected = projectToView(frame, {
            x: edge.points[i]!,
            y: edge.points[i + 1]!,
            z: edge.points[i + 2]!
          });
          page.push(toPage(projected.u, projected.v));
          depths.push(projected.depth);
        }
        // A detail offers only what lies inside its circle (D03, v78).
        const clip = viewClipCircle(view, units);
        if (
          clip &&
          !page.some(
            ([x, y]) =>
              Math.hypot(x - clip.center[0], y - clip.center[1]) <= clip.radius
          ) &&
          clipPolylineToCircle(page, clip).length === 0
        )
          continue;
        out.push({ view, bodyId, edge, page, depths, coincidenceMm, toPage });
      }
    }
  }
  return out;
}

/** Faces seen as straight outlines in each drawn view, on the paper. */
export function pickableFaces(
  sheet: Pick<DrawingSheet, 'scale'>,
  views: readonly ComposedView[],
  bodies: AnnotationBodies,
  units: UnitSystem
): PickableFace[] {
  const out: PickableFace[] = [];
  for (const { view, projection } of views) {
    if (!projection.bounds || view.orientation === 'iso') continue;
    const toPage = viewPageTransform(view, projection.bounds, sheet, units);
    const frame = drawingViewFrame(view);
    const page = (point: Vector3): XY => {
      const p = projectToView(frame, point);
      return toPage(p.u, p.v);
    };
    for (const bodyId of view.bodyIds) {
      const body = bodies[bodyId];
      if (!body?.topology || body.consumed) continue;
      const { faces, edges } = body.topology;
      for (const face of faces) {
        const lines = faceOutline(face, edges, frame.direction, page);
        if (lines.length > 0) out.push({ view, bodyId, face, lines, toPage });
      }
    }
  }
  return out;
}

/** Every point of the edges bounding `face`. */
function boundaryPoints(
  face: FaceTopology,
  edges: readonly EdgeTopology[]
): Vector3[] {
  const points: Vector3[] = [];
  for (const edge of edges) {
    if (!edge.adjacentFaceHashes?.includes(face.hash)) continue;
    const p = edge.points;
    for (let i = 0; i + 2 < p.length; i += 3)
      points.push({ x: p[i]!, y: p[i + 1]!, z: p[i + 2]! });
  }
  return points;
}

/** The straight runs a face's outline draws in a view looking along `look`. */
function faceOutline(
  face: FaceTopology,
  edges: readonly EdgeTopology[],
  look: Vector3,
  page: (point: Vector3) => XY
): [XY, XY][] {
  const g = face.geometry;
  if (!g) return [];
  const type = g.surfaceType.toLowerCase();
  const square = (direction: Vector3) =>
    Math.abs(dot(direction, look)) <= 1e-6 * Math.max(1, norm(direction));
  if (type.includes('plane')) {
    if (!g.normal || !square(g.normal)) return [];
    // Edge-on: its boundary lies on one line across the page.
    const along = cross(look, g.normal);
    const points = boundaryPoints(face, edges);
    if (points.length < 2) return [];
    const ts = points.map((point) => dot(point, along));
    const low = points[ts.indexOf(Math.min(...ts))]!;
    const high = points[ts.indexOf(Math.max(...ts))]!;
    return [[page(low), page(high)]];
  }
  let axis: Vector3 | null = null;
  let origin: Vector3 | null = null;
  let radiusAt: ((t: number) => number) | null = null;
  if (
    type.includes('cylind') &&
    g.radius !== undefined &&
    g.axisStart &&
    g.axisEnd
  ) {
    const span = sub(g.axisEnd, g.axisStart);
    const length = norm(span);
    if (length < 1e-12) return [];
    axis = scale(span, 1 / length);
    origin = g.axisStart;
    const radius = g.radius;
    radiusAt = () => radius;
  } else if (
    type.includes('cone') &&
    g.apex &&
    g.axis &&
    g.halfAngle !== undefined
  ) {
    axis = scale(g.axis, 1 / norm(g.axis));
    origin = g.apex;
    const slope = Math.tan(g.halfAngle);
    radiusAt = (t) => Math.abs(t) * slope;
  }
  if (!axis || !origin || !radiusAt || !square(axis)) return [];
  const points = boundaryPoints(face, edges);
  if (points.length < 2) return [];
  const ts = points.map((point) => dot(sub(point, origin), axis));
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  if (t1 - t0 <= 1e-9) return [];
  const outward = cross(look, axis);
  return [1, -1].map(
    (sign) =>
      [t0, t1].map((t) =>
        page(
          add(
            add(origin, scale(axis, t)),
            scale(outward, (sign * radiusAt(t)) / norm(outward))
          )
        )
      ) as [XY, XY]
  );
}

/**
 * The face whose outline is nearest `point` within `tolerance` paper
 * millimetres, where the view draws a line, or null.
 */
export function hitFace(
  faces: readonly PickableFace[],
  point: XY,
  tolerance: number,
  /** Every line each view draws, silhouettes included. */
  outlines?: ReadonlyMap<DrawingViewId, XY[][]>
): PickableFace | null {
  let best: PickableFace | null = null;
  let bestDistance = Infinity;
  for (const entry of faces) {
    const distance = Math.min(
      ...entry.lines.map(([a, b]) => distanceToSegment(point, a, b))
    );
    if (distance > tolerance || distance >= bestDistance - 1e-6) continue;
    if (outlines) {
      const drawn = (outlines.get(entry.view.viewId) ?? []).some((line) =>
        line.some(
          (a, i) =>
            i + 1 < line.length &&
            distanceToSegment(point, a, line[i + 1]!) <= tolerance
        )
      );
      if (!drawn) continue;
    }
    best = entry;
    bestDistance = distance;
  }
  return best;
}

/**
 * Every line each drawn view shows, on the paper, its curved faces'
 * silhouettes included: a face is picked by its drawn outline.
 */
export function drawnOutlines(
  sheet: Pick<DrawingSheet, 'scale'>,
  views: readonly ComposedView[],
  units: UnitSystem
): Map<DrawingViewId, XY[][]> {
  const out = new Map<DrawingViewId, XY[][]>();
  for (const { view, projection } of views) {
    if (!projection.bounds) continue;
    const toPage = viewPageTransform(view, projection.bounds, sheet, units);
    // A detail (v78) draws, and so offers, only what lies inside its circle.
    const clip = viewClipCircle(view, units);
    const lines: XY[][] = [];
    for (const run of view.hiddenLines
      ? [...projection.visible, ...projection.hidden]
      : projection.visible) {
      const line: XY[] = [];
      for (let i = 0; i + 1 < run.length; i += 2)
        line.push(toPage(run[i]!, run[i + 1]!));
      if (clip) lines.push(...clipPolylineToCircle(line, clip));
      else lines.push(line);
    }
    out.set(view.viewId, lines);
  }
  return out;
}

function distanceToSegment(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared > 0
      ? Math.min(
          1,
          Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared)
        )
      : 0;
  return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]);
}

/**
 * The point `along` paper millimetres from the start of a polyline,
 * clamped to its ends.
 */
function pointAtLength(page: readonly XY[], along: number): XY {
  let remaining = Math.max(0, along);
  for (let i = 0; i + 1 < page.length; i += 1) {
    const a = page[i]!;
    const b = page[i + 1]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (remaining <= length && length > 0) {
      const t = remaining / length;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    remaining -= length;
  }
  return page[page.length - 1]!;
}

/**
 * Whether the view draws `entry` itself where the click lands — not merely
 * some other line nearby. The stretch of the edge either side of the point
 * nearest the click must lie on a drawn line: where an occluded edge only
 * crosses a visible one, the stretch leaves the drawn line and the edge is
 * not offered.
 */
function drawsEdgeAt(
  entry: PickableEdge,
  point: XY,
  tolerance: number,
  drawn: ReadonlyMap<DrawingViewId, XY[][]>,
  viewEdges: readonly PickableEdge[]
): boolean {
  const lines = drawn.get(entry.view.viewId) ?? [];
  const { page } = entry;
  // Arc length to the point of the edge nearest the click.
  let best = Infinity;
  let at = 0;
  let walked = 0;
  for (let i = 0; i + 1 < page.length; i += 1) {
    const a = page[i]!;
    const b = page[i + 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    const t =
      length > 0
        ? Math.min(
            1,
            Math.max(
              0,
              ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) /
                (length * length)
            )
          )
        : 0;
    const distance = Math.hypot(
      a[0] + dx * t - point[0],
      a[1] + dy * t - point[1]
    );
    if (distance < best) {
      best = distance;
      at = walked + t * length;
    }
    walked += length;
  }
  // Each sample must sit on a drawn segment this edge owns: one it lies on
  // at least as closely as any other edge of the view (nearer the viewer
  // when they coincide). A neighbouring edge's run within tolerance is not
  // this edge drawn.
  return [at - tolerance, at, at + tolerance].every((along) => {
    const sample = pointAtLength(page, along);
    for (const line of lines)
      for (let i = 0; i + 1 < line.length; i += 1) {
        const a = line[i]!;
        const b = line[i + 1]!;
        if (distanceToSegment(sample, a, b) > entry.coincidenceMm) continue;
        if (segmentOwner(a, b, viewEdges, entry.coincidenceMm) === entry)
          return true;
      }
    return false;
  });
}

/**
 * The edge of `edges` a drawn segment belongs to: the one it strays from
 * least (worst of its ends and middle), the nearer one to the viewer when
 * two coincide within a tenth of `coincidenceMm`; null when none lies
 * within it.
 */
function segmentOwner(
  a: XY,
  b: XY,
  edges: readonly PickableEdge[],
  coincidenceMm: number
): PickableEdge | null {
  const middle: XY = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const coincide = 0.1 * coincidenceMm;
  let owner: PickableEdge | null = null;
  let ownerStray = Infinity;
  let ownerDepth = Infinity;
  for (const edge of edges) {
    const stray = Math.max(
      nearestOnEdge(edge, a).distance,
      nearestOnEdge(edge, b).distance,
      nearestOnEdge(edge, middle).distance
    );
    if (stray > coincidenceMm) continue;
    const depth = nearestOnEdge(edge, middle).depth;
    if (
      stray < ownerStray - coincide ||
      (Math.abs(stray - ownerStray) <= coincide && depth < ownerDepth)
    ) {
      owner = edge;
      ownerStray = stray;
      ownerDepth = depth;
    }
  }
  return owner;
}

/**
 * How far `point` is from an edge on the paper, and the edge's depth into
 * the view at its point nearest `point` — interpolated there, not the
 * edge's nearest anywhere, so a sloped edge whose far end is close to the
 * viewer does not win a tie it is behind at the click.
 */
function nearestOnEdge(
  entry: PickableEdge,
  point: XY
): { distance: number; depth: number } {
  const { page, depths } = entry;
  let distance = Infinity;
  let depth = Infinity;
  for (let i = 0; i + 1 < page.length; i += 1) {
    const a = page[i]!;
    const b = page[i + 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared > 0
        ? Math.min(
            1,
            Math.max(
              0,
              ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared
            )
          )
        : 0;
    const d = Math.hypot(a[0] + dx * t - point[0], a[1] + dy * t - point[1]);
    if (d < distance) {
      distance = d;
      depth = depths[i]! + (depths[i + 1]! - depths[i]!) * t;
    }
  }
  return { distance, depth };
}

/**
 * The edge nearest `point` within `tolerance` paper millimetres, or null.
 * Edges that lie on the same line in the view (a box's front and back top
 * edges, seen from the front) tie, and the one nearest the viewer wins: it
 * is the one the view shows.
 */
export function hitEdge(
  edges: readonly PickableEdge[],
  point: XY,
  tolerance: number,
  /** When given, the click must also lie on a line its view draws. */
  drawn?: ReadonlyMap<DrawingViewId, XY[][]>
): PickableEdge | null {
  let best: PickableEdge | null = null;
  let bestDistance = Infinity;
  let bestDepth = Infinity;
  for (const entry of edges) {
    const { distance, depth } = nearestOnEdge(entry, point);
    if (distance > tolerance) continue;
    if (
      drawn &&
      !drawsEdgeAt(
        entry,
        point,
        tolerance,
        drawn,
        edges.filter((other) => other.view.viewId === entry.view.viewId)
      )
    )
      continue;
    const tie = Math.abs(distance - bestDistance) <= 1e-6;
    if (
      distance < bestDistance - 1e-6 ||
      (tie && best !== null && depth < bestDepth)
    ) {
      bestDistance = distance;
      bestDepth = depth;
      best = entry;
    }
  }
  return best;
}

export type AnnotationToolKind =
  | 'horizontal'
  | 'vertical'
  | 'aligned'
  /** v75: a distance square to a line, or between circles' sides. */
  | 'distance'
  | 'radius'
  | 'diameter'
  | 'angle'
  /** v82: an arc's included angle, and the angle at a point between two. */
  | 'arc-angle'
  | 'three-point-angle'
  | 'chamfer'
  | 'note'
  /** v73 geometry annotations. */
  | 'center-mark'
  | 'intersection-mark'
  | 'centerline'
  | 'circle-centerline'
  /** v80: a part's item number, and the assembly's parts list. */
  | 'balloon'
  | 'parts-list'
  /** M01: a view's bores in a table, each tagged in the view. */
  | 'hole-table'
  /** v92: one of the project's pictures, placed on the paper. */
  | 'image'
  /** v98 (D07): a datum feature symbol and a feature control frame. */
  | 'datum-feature'
  | 'feature-control-frame'
  /** v105 (D07): the sheet's general-tolerance block, on the paper. */
  | 'general-tolerance';

/** v73: tools that mark geometry, made as soon as their picks are in. */
export const GEOMETRY_TOOL_KINDS: readonly AnnotationToolKind[] = [
  'center-mark',
  'intersection-mark',
  'centerline',
  'circle-centerline'
];

export function isGeometryTool(kind: AnnotationToolKind): boolean {
  return GEOMETRY_TOOL_KINDS.includes(kind);
}

export const ANNOTATION_TOOL_LABELS: Readonly<
  Record<AnnotationToolKind, string>
> = {
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  aligned: 'Aligned',
  distance: 'Distance',
  radius: 'Radius',
  diameter: 'Diameter',
  angle: 'Angle',
  'arc-angle': 'Arc angle',
  'three-point-angle': '3-point angle',
  chamfer: 'Chamfer',
  note: 'Note',
  'center-mark': 'Centre mark',
  'intersection-mark': 'Intersection mark',
  centerline: 'Centreline',
  'circle-centerline': 'Circular centreline',
  balloon: 'Balloon',
  'parts-list': 'Parts list',
  'hole-table': 'Hole table',
  image: 'Image',
  'datum-feature': 'Datum feature',
  'feature-control-frame': 'Feature control frame',
  'general-tolerance': 'General tolerances'
};

/** v98: the tools that point at an edge or attach to a dimension. */
export function isToleranceTool(kind: AnnotationToolKind): boolean {
  return kind === 'datum-feature' || kind === 'feature-control-frame';
}

/** v92: how wide a newly placed sheet image prints, paper mm. */
export const DEFAULT_DRAWING_IMAGE_WIDTH_MM = 40;

/** What each tool asks for next, by how many picks it has. */
export function annotationToolHint(tool: AnnotationTool): string {
  const label = ANNOTATION_TOOL_LABELS[tool.kind];
  if (pickedEnough(tool))
    return tool.repairId
      ? `${label}: done.`
      : isToleranceTool(tool.kind)
        ? tool.hostId && tool.kind === 'feature-control-frame'
          ? `${label}: click anywhere to place it under its dimension.`
          : `${label}: click where it goes.`
        : `${label}: click where the ${tool.kind === 'note' ? 'note' : 'dimension'} goes.`;
  switch (tool.kind) {
    case 'horizontal':
    case 'vertical':
    case 'aligned':
      if (tool.faces.length === 1)
        return `${label} dimension: pick the second face; the point is where the two would meet (their virtual sharp).`;
      return tool.points.length === 0
        ? `${label} dimension: pick a straight edge, or an edge end, circle or rim for its first point; or a face outline for a virtual sharp.`
        : `${label} dimension: pick the second point (an edge end, circle or rim, or a face outline).`;
    case 'radius':
    case 'diameter':
      return `${label}: pick a circle or arc seen face-on.`;
    case 'angle':
      return tool.edges.length === 0
        ? 'Angle: pick the first straight edge.'
        : 'Angle: pick the second straight edge.';
    case 'arc-angle':
      return 'Arc angle: pick an arc seen face-on.';
    case 'three-point-angle':
      return tool.points.length === 0
        ? '3-point angle: pick the vertex (an edge end, circle or mark).'
        : `3-point angle: pick the ${tool.points.length === 1 ? 'first' : 'second'} arm’s point (an edge end, circle or mark).`;
    case 'chamfer':
      return 'Chamfer: pick the chamfer’s outline, seen side-on or edge-on.';
    case 'note':
      return 'Note: pick an edge for its leader, or click empty paper to place it.';
    case 'distance':
      return `Distance: pick ${(tool.targets ?? []).length === 0 ? 'what it measures from' : 'what it measures to'}: a straight edge or centreline (away from its ends), a circle, an edge end or a mark.`;
    case 'center-mark':
      return 'Centre mark: pick a circle or arc seen face-on.';
    case 'intersection-mark':
      return tool.edges.length === 0
        ? 'Intersection mark: pick the first straight edge.'
        : 'Intersection mark: pick the second straight edge; the mark sits where their lines cross.';
    case 'centerline':
      return tool.edges.length === 1
        ? 'Centreline: pick the second straight edge, parallel to the first; the line runs midway between them.'
        : tool.points.length === 1
          ? 'Centreline: pick the second point (an edge end, circle or mark).'
          : 'Centreline: pick a point (an edge end, circle or mark), or a straight edge to run midway between two.';
    case 'circle-centerline':
      return `Circular centreline: pick point ${tool.points.length + 1} of 3 (an edge end, circle or mark).`;
    case 'balloon':
      return 'Balloon: pick an edge of an assembly part for its leader.';
    case 'parts-list':
      return 'Parts list: click where its top-left corner goes.';
    case 'hole-table':
      return tool.viewId
        ? 'Hole table: click where its top-left corner goes.'
        : 'Hole table: click the view whose holes it lists, one that looks down them.';
    case 'image':
      return 'Image: click where its centre goes.';
    case 'datum-feature':
      return 'Datum feature: pick the edge of the datum surface, or a size dimension (or its frame) to attach it to.';
    case 'feature-control-frame':
      return 'Feature control frame: pick the edge of the toleranced surface, or a size dimension to put the frame under.';
    case 'general-tolerance':
      return 'General tolerances: click where the block’s top-left corner goes.';
  }
}

export interface AnnotationTool {
  kind: AnnotationToolKind;
  /** The view every pick so far was made in. */
  viewId?: DrawingViewId;
  points: DrawingPointRef[];
  edges: DrawingEdgeRef[];
  /**
   * D06: faces picked so far — a chamfer's face, or the first of two whose
   * virtual sharp is a linear dimension's next point.
   */
  faces: DrawingFaceRef[];
  /** v75: a distance dimension's picks so far. */
  targets?: DrawingDistanceTarget[];
  /** A note's free placement, once clicked on empty paper. */
  placed?: { x: number; y: number };
  /** Re-picking the references of this broken annotation. */
  repairId?: DrawingAnnotationId;
  /** v92: the reference image an Image tool places. */
  pictureId?: string;
  /**
   * v98: the dimension (or, for a datum symbol, the frame) picked to attach
   * to, instead of an edge.
   */
  hostId?: DrawingAnnotationId;
  /**
   * What the view drew when the tool was pinned to it (see
   * {@link drawingViewSignature}); picks are only good while it holds.
   */
  viewSignature?: string;
}

/**
 * The view settings that decide which edges it draws: its direction, its
 * bodies and whether it shows hidden lines. A pick made under one set is
 * not a pick of what the view draws under another.
 */
export function drawingViewSignature(
  view: Pick<DrawingView, 'orientation' | 'hiddenLines' | 'bodyIds' | 'section'>
): string {
  // A section's cut is what it draws too: moving the plane ends a tool.
  const cut = view.section ? `|section:${view.section.depth}` : '';
  return `${view.orientation}|${view.hiddenLines}|${[...view.bodyIds].sort().join(',')}${cut}`;
}

export function startAnnotationTool(
  kind: AnnotationToolKind,
  repairId?: DrawingAnnotationId,
  /** A re-pick stays in the view its annotation belongs to. */
  viewId?: DrawingViewId
): AnnotationTool {
  return {
    kind,
    points: [],
    edges: [],
    faces: [],
    ...(repairId ? { repairId } : {}),
    ...(viewId ? { viewId } : {})
  };
}

/** Whether the tool has every reference it needs. */
export function pickedEnough(tool: AnnotationTool): boolean {
  switch (tool.kind) {
    case 'horizontal':
    case 'vertical':
    case 'aligned':
      return tool.points.length === 2;
    case 'radius':
    case 'diameter':
      return tool.edges.length === 1;
    case 'angle':
      return tool.edges.length === 2;
    case 'arc-angle':
      return tool.edges.length === 1;
    case 'three-point-angle':
      return tool.points.length === 3;
    case 'chamfer':
      return tool.faces.length === 1;
    case 'note':
      return tool.edges.length === 1 || tool.placed !== undefined;
    case 'distance':
      return (tool.targets ?? []).length === 2;
    case 'center-mark':
      return tool.edges.length === 1;
    case 'intersection-mark':
      return tool.edges.length === 2;
    case 'centerline':
      return tool.points.length === 2 || tool.edges.length === 2;
    case 'circle-centerline':
      return tool.points.length === 3;
    case 'balloon':
      return tool.edges.length === 1;
    case 'parts-list':
    case 'image':
    case 'general-tolerance':
      return tool.placed !== undefined;
    case 'hole-table':
      return tool.viewId !== undefined && tool.placed !== undefined;
    case 'datum-feature':
    case 'feature-control-frame':
      return tool.edges.length === 1 || tool.hostId !== undefined;
  }
}

/**
 * The stored reference for a picked edge, or null when it would not
 * resolve back to this edge alone (two edges share its identity).
 */
export function edgeRefFor(
  bodies: AnnotationBodies,
  bodyId: BodyId,
  edge: EdgeTopology,
  /** The view picked in; a section view resolves against its cut body. */
  view?: Pick<DrawingView, 'viewId' | 'section'>
): DrawingEdgeRef | null {
  // Only a reference the document can hold, for this very hash and with a
  // witness that fingerprints to it, is stored; otherwise the pick is kept
  // hash-only rather than refused (a deep boolean chain grows lineage
  // names past what a stored reference may carry).
  const full: DrawingEdgeRef = {
    bodyId,
    hash: edge.hash,
    ...(edge.reference ? { reference: edge.reference } : {})
  };
  const ref: DrawingEdgeRef =
    edge.reference &&
    edge.reference.currentHash === edge.hash &&
    referenceTrust({ reference: edge.reference }) === 'trusted' &&
    drawingEdgeRefError(full) === null
      ? full
      : { bodyId, hash: edge.hash };
  const found = resolveEdge(annotationBody(bodies, view, bodyId), ref);
  return found.ok && found.entry === edge ? ref : null;
}

/** {@link edgeRefFor} for a picked face. */
export function faceRefFor(
  bodies: AnnotationBodies,
  bodyId: BodyId,
  face: FaceTopology
): DrawingFaceRef | null {
  const full: DrawingFaceRef = {
    bodyId,
    hash: face.hash,
    ...(face.reference ? { reference: face.reference } : {})
  };
  const ref: DrawingFaceRef =
    face.reference &&
    face.reference.currentHash === face.hash &&
    referenceTrust({ reference: face.reference }) === 'trusted' &&
    drawingFaceRefError(full) === null
      ? full
      : { bodyId, hash: face.hash };
  const found = resolveFace(bodies[bodyId], ref);
  return found.ok && found.entry === face ? ref : null;
}

/**
 * The side of an extreme point nearer the click: both sides resolved, the
 * one whose point lands nearer `click` on the paper. Null when neither does.
 */
function nearerSide(
  view: DrawingView,
  make: (side: DrawingExtremeSide) => DrawingPointRef,
  direction: 'horizontal' | 'vertical',
  toPage: (u: number, v: number) => XY,
  bodies: AnnotationBodies,
  click: XY
): DrawingPointRef | null {
  let best: DrawingPointRef | null = null;
  let bestDistance = Infinity;
  for (const side of ['low', 'high'] as const) {
    const point = make(side);
    const at = dimensionPointInView(view, point, bodies, direction);
    if (!at) continue;
    const [x, y] = toPage(at.uv[0], at.uv[1]);
    const distance = Math.hypot(x - click[0], y - click[1]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  return best;
}

function isFaceOnCircle(view: DrawingView, edge: EdgeTopology): boolean {
  const circle = edge.curve?.circle;
  if (!circle) return false;
  const d = drawingViewFrame(view).direction;
  return (
    Math.abs(
      Math.abs(
        circle.axis.x * d.x + circle.axis.y * d.y + circle.axis.z * d.z
      ) - 1
    ) <= 1e-6
  );
}

export type PickResult =
  { ok: true; tool: AnnotationTool } | { ok: false; message: string };

/**
 * One click of a tool: `hit` is the edge under the pointer (null on empty
 * paper), `point` the click in paper millimetres, and `viewAt` the view
 * whose box holds it, if any.
 */
export function applyAnnotationPick(
  tool: AnnotationTool,
  hit: PickableEdge | null,
  point: XY,
  viewAt: DrawingView | null,
  bodies: AnnotationBodies,
  /** The face outline under the pointer, for virtual sharps and chamfers. */
  faceHit: PickableFace | null = null,
  /** v73: a centre or intersection mark under the pointer. */
  markHit: {
    annotationId: DrawingAnnotationId;
    viewId: DrawingViewId;
    /** v75: a straight centreline, which only Distance measures to. */
    centerline?: boolean;
  } | null = null
): PickResult {
  if (pickedEnough(tool)) return { ok: true, tool };
  // M01: a hole table first takes its view, then its place.
  if (tool.kind === 'hole-table') {
    if (tool.viewId)
      return {
        ok: true,
        tool: { ...tool, placed: { x: point[0], y: point[1] } }
      };
    return viewAt
      ? { ok: true, tool: { ...tool, viewId: viewAt.viewId } }
      : {
          ok: false,
          message: 'Click inside a view to list the holes it looks down.'
        };
  }
  // A parts list (and, v92, an image) sits on the paper: any click places it.
  if (
    tool.kind === 'parts-list' ||
    tool.kind === 'image' ||
    tool.kind === 'general-tolerance'
  )
    return {
      ok: true,
      tool: { ...tool, placed: { x: point[0], y: point[1] } }
    };
  if (markHit && tool.kind === 'distance') {
    if (tool.viewId && markHit.viewId !== tool.viewId)
      return {
        ok: false,
        message: tool.repairId
          ? 'Re-pick in the view this annotation belongs to.'
          : 'Pick in the same view as the first pick.'
      };
    const target: DrawingDistanceTarget = markHit.centerline
      ? { centerline: markHit.annotationId }
      : { point: { anchor: 'mark', annotationId: markHit.annotationId } };
    return {
      ok: true,
      tool: {
        ...tool,
        viewId: markHit.viewId,
        targets: [...(tool.targets ?? []), target]
      }
    };
  }
  // Only Distance measures to a centreline.
  if (markHit?.centerline) markHit = null;
  // A mark is a point: the linear tools and the centrelines take it.
  if (
    markHit &&
    (tool.kind === 'horizontal' ||
      tool.kind === 'vertical' ||
      tool.kind === 'aligned' ||
      tool.kind === 'three-point-angle' ||
      ((tool.kind === 'centerline' || tool.kind === 'circle-centerline') &&
        tool.edges.length === 0)) &&
    tool.faces.length === 0
  ) {
    if (tool.viewId && markHit.viewId !== tool.viewId)
      return {
        ok: false,
        message: tool.repairId
          ? 'Re-pick in the view this annotation belongs to.'
          : 'Pick in the same view as the first pick.'
      };
    return {
      ok: true,
      tool: {
        ...tool,
        viewId: markHit.viewId,
        points: [
          ...tool.points,
          { anchor: 'mark', annotationId: markHit.annotationId }
        ]
      }
    };
  }
  const linear =
    tool.kind === 'horizontal' ||
    tool.kind === 'vertical' ||
    tool.kind === 'aligned';
  // A face completes a virtual sharp, and is a chamfer's only pick; an edge
  // otherwise wins over the face outline it may lie on.
  if (
    faceHit &&
    (tool.kind === 'chamfer' || (linear && (tool.faces.length === 1 || !hit)))
  )
    return applyFacePick(tool, faceHit, point, bodies);
  if (tool.kind === 'chamfer')
    return {
      ok: false,
      message:
        'Pick a chamfer’s outline: a cone seen side-on or a plane edge-on.'
    };
  if (linear && tool.faces.length === 1)
    return {
      ok: false,
      message: 'Pick a second face’s outline for the virtual sharp.'
    };
  if (!hit) {
    if (tool.kind === 'note' && !tool.repairId)
      return {
        ok: true,
        tool: {
          ...tool,
          placed: { x: point[0], y: point[1] },
          ...(viewAt ? { viewId: viewAt.viewId } : {})
        }
      };
    return { ok: false, message: 'Pick an edge of a drawn view.' };
  }
  if (tool.viewId && hit.view.viewId !== tool.viewId)
    return {
      ok: false,
      message: tool.repairId
        ? 'Re-pick in the view this annotation belongs to.'
        : 'Pick in the same view as the first pick.'
    };
  const ref = edgeRefFor(bodies, hit.bodyId, hit.edge, hit.view);
  if (!ref)
    return {
      ok: false,
      message:
        'That edge cannot be told apart from another one in the model. Pick a different edge.'
    };
  const view = hit.view;
  if (
    view.orientation === 'iso' &&
    tool.kind !== 'note' &&
    tool.kind !== 'radius' &&
    tool.kind !== 'diameter' &&
    tool.kind !== 'center-mark' &&
    tool.kind !== 'arc-angle' &&
    tool.kind !== 'balloon' &&
    !isToleranceTool(tool.kind)
  )
    return {
      ok: false,
      message:
        'The isometric view foreshortens lengths and angles. Dimension a principal view instead.'
    };
  const next = { ...tool, viewId: view.viewId };
  switch (tool.kind) {
    case 'distance': {
      const targets = tool.targets ?? [];
      const ends = edgeEndsInPageOrder(view, hit.edge);
      let target: DrawingDistanceTarget;
      if (!ends) {
        if (!isFaceOnCircle(view, hit.edge))
          return {
            ok: false,
            message:
              'Pick a straight edge, a circle seen face-on, an edge end or a mark.'
          };
        target = { circle: ref };
      } else {
        const first = hit.page[0]!;
        const last = hit.page[hit.page.length - 1]!;
        const length = Math.hypot(last[0] - first[0], last[1] - first[1]);
        const toFirst = Math.hypot(point[0] - first[0], point[1] - first[1]);
        const toLast = Math.hypot(point[0] - last[0], point[1] - last[1]);
        if (
          hit.edge.curve?.type === 'LINE' &&
          Math.min(toFirst, toLast) > 0.25 * length
        )
          target = { line: ref };
        else {
          // The polyline runs the kernel's way; its start is the page's
          // `first` end when it lies there.
          const start = projectToView(drawingViewFrame(view), {
            x: hit.edge.points[0]!,
            y: hit.edge.points[1]!,
            z: hit.edge.points[2]!
          });
          const startIsFirst =
            Math.hypot(start.u - ends[0][0], start.v - ends[0][1]) <=
            Math.hypot(start.u - ends[1][0], start.v - ends[1][1]);
          const nearStart = toFirst <= toLast;
          target = {
            point: {
              edge: ref,
              anchor: nearStart === startIsFirst ? 'first' : 'second'
            }
          };
        }
      }
      return { ok: true, tool: { ...next, targets: [...targets, target] } };
    }
    case 'horizontal':
    case 'vertical':
    case 'aligned': {
      const ends = edgeEndsInPageOrder(view, hit.edge);
      if (!ends) {
        if (!isFaceOnCircle(view, hit.edge)) {
          // A rim seen side-on: its silhouette end nearer the click.
          if (!hit.edge.curve?.circle)
            return {
              ok: false,
              message: 'Pick an edge end, a straight edge, a circle or a rim.'
            };
          if (tool.kind === 'aligned')
            return {
              ok: false,
              message:
                'A rim’s silhouette is measured horizontally or vertically. Use the Horizontal or Vertical tool.'
            };
          const silhouette =
            hit.toPage &&
            nearerSide(
              view,
              (side) => ({ edge: ref, anchor: 'silhouette', side }),
              tool.kind,
              hit.toPage,
              bodies,
              point
            );
          if (!silhouette)
            return { ok: false, message: 'That rim does not measure here.' };
          return {
            ok: true,
            tool: { ...next, points: [...tool.points, silhouette] }
          };
        }
        return {
          ok: true,
          tool: {
            ...next,
            points: [...tool.points, { edge: ref, anchor: 'center' }]
          }
        };
      }
      // `ends` are in page order; the polyline runs the kernel's way, so
      // match its start to one of them.
      const start = projectToView(drawingViewFrame(view), {
        x: hit.edge.points[0]!,
        y: hit.edge.points[1]!,
        z: hit.edge.points[2]!
      });
      const startIsFirst =
        Math.hypot(start.u - ends[0][0], start.v - ends[0][1]) <=
        Math.hypot(start.u - ends[1][0], start.v - ends[1][1]);
      const first = hit.page[0]!;
      const last = hit.page[hit.page.length - 1]!;
      const pageEnds: [XY, XY] = startIsFirst ? [first, last] : [last, first];
      const toFirst = Math.hypot(
        point[0] - pageEnds[0][0],
        point[1] - pageEnds[0][1]
      );
      const toSecond = Math.hypot(
        point[0] - pageEnds[1][0],
        point[1] - pageEnds[1][1]
      );
      const length = Math.hypot(
        pageEnds[1][0] - pageEnds[0][0],
        pageEnds[1][1] - pageEnds[0][1]
      );
      // A straight edge picked away from its ends is dimensioned whole.
      if (
        tool.points.length === 0 &&
        hit.edge.curve?.type === 'LINE' &&
        Math.min(toFirst, toSecond) > 0.25 * length
      )
        return {
          ok: true,
          tool: {
            ...next,
            points: [
              { edge: ref, anchor: 'first' },
              { edge: ref, anchor: 'second' }
            ]
          }
        };
      const anchor: DrawingPointAnchor =
        toFirst <= toSecond ? 'first' : 'second';
      return {
        ok: true,
        tool: { ...next, points: [...tool.points, { edge: ref, anchor }] }
      };
    }
    case 'radius':
    case 'diameter':
      if (!isFaceOnCircle(view, hit.edge))
        return {
          ok: false,
          message: 'Pick a circle or arc this view sees face-on.'
        };
      return { ok: true, tool: { ...next, edges: [ref] } };
    case 'angle':
      if (
        hit.edge.curve?.type !== 'LINE' ||
        !edgeEndsInPageOrder(view, hit.edge)
      )
        return { ok: false, message: 'Pick a straight edge.' };
      return { ok: true, tool: { ...next, edges: [...tool.edges, ref] } };
    case 'arc-angle':
      if (
        !isFaceOnCircle(view, hit.edge) ||
        !edgeEndsInPageOrder(view, hit.edge)
      )
        return {
          ok: false,
          message: 'Pick an arc (not a whole circle) this view sees face-on.'
        };
      return { ok: true, tool: { ...next, edges: [ref] } };
    case 'note':
    case 'balloon':
    case 'datum-feature':
    case 'feature-control-frame':
      return { ok: true, tool: { ...next, edges: [ref] } };
    case 'center-mark':
      if (!isFaceOnCircle(view, hit.edge))
        return {
          ok: false,
          message: 'Pick a circle or arc this view sees face-on.'
        };
      return { ok: true, tool: { ...next, edges: [ref] } };
    case 'intersection-mark':
      if (
        hit.edge.curve?.type !== 'LINE' ||
        !edgeEndsInPageOrder(view, hit.edge)
      )
        return { ok: false, message: 'Pick a straight edge.' };
      if (
        tool.edges.some(
          (edge) => edge.hash === ref.hash && edge.bodyId === ref.bodyId
        )
      )
        return {
          ok: false,
          message: 'Pick a different edge for the second one.'
        };
      return { ok: true, tool: { ...next, edges: [...tool.edges, ref] } };
    case 'centerline':
    case 'circle-centerline':
    case 'three-point-angle': {
      const ends = edgeEndsInPageOrder(view, hit.edge);
      // A straight edge picked away from its ends is a line (two make a
      // centreline midway between them); otherwise the pick is its nearer
      // end, or a face-on circle's centre.
      if (
        ends &&
        hit.edge.curve?.type === 'LINE' &&
        tool.kind === 'centerline' &&
        tool.points.length === 0
      ) {
        const page = hit.page;
        const first = page[0]!;
        const last = page[page.length - 1]!;
        const length = Math.hypot(last[0] - first[0], last[1] - first[1]);
        const away =
          Math.min(
            Math.hypot(point[0] - first[0], point[1] - first[1]),
            Math.hypot(point[0] - last[0], point[1] - last[1])
          ) >
          0.25 * length;
        if (away || tool.edges.length === 1) {
          if (
            tool.edges.some(
              (edge) => edge.hash === ref.hash && edge.bodyId === ref.bodyId
            )
          )
            return {
              ok: false,
              message: 'Pick a different edge for the second one.'
            };
          return { ok: true, tool: { ...next, edges: [...tool.edges, ref] } };
        }
      }
      if (tool.edges.length > 0)
        return {
          ok: false,
          message: 'Pick a second straight edge, parallel to the first.'
        };
      if (!ends) {
        if (!isFaceOnCircle(view, hit.edge))
          return {
            ok: false,
            message: 'Pick an edge end, a circle seen face-on, or a mark.'
          };
        return {
          ok: true,
          tool: {
            ...next,
            points: [...tool.points, { edge: ref, anchor: 'center' }]
          }
        };
      }
      const start = projectToView(drawingViewFrame(view), {
        x: hit.edge.points[0]!,
        y: hit.edge.points[1]!,
        z: hit.edge.points[2]!
      });
      const startIsFirst =
        Math.hypot(start.u - ends[0][0], start.v - ends[0][1]) <=
        Math.hypot(start.u - ends[1][0], start.v - ends[1][1]);
      const firstPage = hit.page[0]!;
      const lastPage = hit.page[hit.page.length - 1]!;
      const [pageFirst, pageSecond] = startIsFirst
        ? [firstPage, lastPage]
        : [lastPage, firstPage];
      const anchor: DrawingPointAnchor =
        Math.hypot(point[0] - pageFirst[0], point[1] - pageFirst[1]) <=
        Math.hypot(point[0] - pageSecond[0], point[1] - pageSecond[1])
          ? 'first'
          : 'second';
      return {
        ok: true,
        tool: { ...next, points: [...tool.points, { edge: ref, anchor }] }
      };
    }
  }
}

/** A face pick: a chamfer, or one of a virtual sharp's two faces. */
function applyFacePick(
  tool: AnnotationTool,
  hit: PickableFace,
  point: XY,
  bodies: AnnotationBodies
): PickResult {
  if (tool.viewId && hit.view.viewId !== tool.viewId)
    return {
      ok: false,
      message: tool.repairId
        ? 'Re-pick in the view this annotation belongs to.'
        : 'Pick in the same view as the first pick.'
    };
  const ref = faceRefFor(bodies, hit.bodyId, hit.face);
  if (!ref)
    return {
      ok: false,
      message:
        'That face cannot be told apart from another one in the model. Pick a different face.'
    };
  const next = { ...tool, viewId: hit.view.viewId };
  if (tool.kind === 'chamfer')
    return { ok: true, tool: { ...next, faces: [ref] } };
  if (tool.kind !== 'horizontal' && tool.kind !== 'vertical')
    return {
      ok: false,
      message:
        'A virtual sharp is measured horizontally or vertically. Use the Horizontal or Vertical tool.'
    };
  const first = tool.faces[0];
  if (!first) return { ok: true, tool: { ...next, faces: [ref] } };
  if (first.bodyId === ref.bodyId && first.hash === ref.hash)
    return { ok: false, message: 'Pick a different face for the second one.' };
  const sharp = nearerSide(
    hit.view,
    (side) => ({ faces: [first, ref], anchor: 'virtual-sharp', side }),
    tool.kind,
    hit.toPage,
    bodies,
    point
  );
  if (!sharp)
    return {
      ok: false,
      message:
        'These two faces have no virtual sharp this view can show. Pick coaxial turned faces, or one and a face square to their axis.'
    };
  return {
    ok: true,
    tool: { ...next, faces: [], points: [...tool.points, sharp] }
  };
}

/**
 * The annotation a finished tool makes, with its text at `placementMm`
 * (relative to the view's centre, or on the paper for a free note). Null
 * while the tool still needs picks.
 */
export function draftAnnotation(
  tool: AnnotationTool,
  annotationId: DrawingAnnotationId,
  placementMm: { x: number; y: number },
  text = 'NOTE',
  /** v80: the assembly component a balloon's edge belongs to. */
  componentId?: string,
  /**
   * v98: a new datum symbol's letter and a new frame's tolerance amount
   * (in the sheet's printed units); the Properties panel edits the rest.
   */
  tolerancing: { letter: string; amount: number } = { letter: 'A', amount: 0.1 }
): DrawingAnnotation | null {
  if (!pickedEnough(tool)) return null;
  const base = { annotationId, placementMm };
  switch (tool.kind) {
    case 'horizontal':
    case 'vertical':
    case 'aligned':
      return {
        ...base,
        kind: 'linear',
        viewId: tool.viewId!,
        direction: tool.kind,
        from: tool.points[0]!,
        to: tool.points[1]!
      };
    case 'radius':
    case 'diameter':
      return {
        ...base,
        kind: tool.kind,
        viewId: tool.viewId!,
        edge: tool.edges[0]!
      };
    case 'angle':
      return {
        ...base,
        kind: 'angle',
        viewId: tool.viewId!,
        edges: [tool.edges[0]!, tool.edges[1]!]
      };
    case 'arc-angle':
      return {
        ...base,
        kind: 'arc-angle',
        viewId: tool.viewId!,
        edge: tool.edges[0]!
      };
    case 'three-point-angle':
      return {
        ...base,
        kind: 'three-point-angle',
        viewId: tool.viewId!,
        vertex: tool.points[0]!,
        from: tool.points[1]!,
        to: tool.points[2]!
      };
    case 'chamfer':
      return {
        ...base,
        kind: 'chamfer',
        viewId: tool.viewId!,
        face: tool.faces[0]!
      };
    case 'note':
      return {
        ...base,
        kind: 'note',
        text,
        ...(tool.viewId ? { viewId: tool.viewId } : {}),
        ...(tool.edges[0] ? { leader: tool.edges[0] } : {})
      };
    case 'distance':
      return {
        ...base,
        kind: 'distance',
        viewId: tool.viewId!,
        from: tool.targets![0]!,
        to: tool.targets![1]!
      };
    case 'center-mark':
      return {
        ...base,
        kind: 'center-mark',
        viewId: tool.viewId!,
        edge: tool.edges[0]!
      };
    case 'intersection-mark':
      return {
        ...base,
        kind: 'intersection-mark',
        viewId: tool.viewId!,
        edges: [tool.edges[0]!, tool.edges[1]!]
      };
    case 'centerline':
      return tool.edges.length === 2
        ? {
            ...base,
            kind: 'centerline',
            viewId: tool.viewId!,
            mode: 'lines',
            edges: [tool.edges[0]!, tool.edges[1]!]
          }
        : {
            ...base,
            kind: 'centerline',
            viewId: tool.viewId!,
            mode: 'points',
            from: tool.points[0]!,
            to: tool.points[1]!
          };
    case 'circle-centerline':
      return {
        ...base,
        kind: 'centerline',
        viewId: tool.viewId!,
        mode: 'circle',
        through: [tool.points[0]!, tool.points[1]!, tool.points[2]!]
      };
    case 'balloon':
      return componentId
        ? {
            ...base,
            kind: 'balloon',
            viewId: tool.viewId!,
            leader: tool.edges[0]!,
            componentId
          }
        : null;
    case 'parts-list':
      return { ...base, kind: 'bom-table' };
    case 'hole-table':
      return { ...base, kind: 'hole-table', viewId: tool.viewId! };
    case 'general-tolerance':
      // ISO 2768-m, the usual default; Properties chooses another.
      return {
        ...base,
        kind: 'general-tolerance',
        scheme: 'iso-2768',
        linearClass: 'm'
      };
    case 'image':
      return tool.pictureId
        ? {
            ...base,
            kind: 'image',
            referenceImageId: tool.pictureId,
            widthMm: DEFAULT_DRAWING_IMAGE_WIDTH_MM
          }
        : null;
    case 'datum-feature':
    case 'feature-control-frame': {
      const target = tool.hostId
        ? { attachedTo: tool.hostId }
        : { leader: tool.edges[0]! };
      // A new frame states flatness, which needs no datum, so it is valid
      // as placed; Properties chooses the characteristic and datums.
      return tool.kind === 'datum-feature'
        ? {
            ...base,
            kind: 'datum-feature',
            viewId: tool.viewId!,
            ...target,
            letter: tolerancing.letter
          }
        : {
            ...base,
            kind: 'feature-control-frame',
            viewId: tool.viewId!,
            ...target,
            characteristic: 'flatness',
            amount: tolerancing.amount
          };
    }
  }
}

/**
 * v98: the first datum letter the drawing does not use yet: A, B, C, …
 * (skipping I, O and Q), then AA, AB, ….
 */
export function nextDatumLetter(used: Iterable<string>): string {
  const taken = new Set(used);
  const singles = [...'ABCDEFGHJKLMNPRSTUVWXYZ'];
  for (const letter of singles) if (!taken.has(letter)) return letter;
  for (const first of singles)
    for (const second of singles)
      if (!taken.has(first + second)) return first + second;
  return 'A';
}

/**
 * `previous` with the references a re-pick chose, its placement, text and
 * format kept. Null when the tool does not match its kind.
 */
export function repairedAnnotation(
  previous: DrawingAnnotation,
  tool: AnnotationTool,
  /**
   * v80: for a balloon, the part its re-picked edge belongs to (see
   * `balloonComponent`); the balloon then names that part. Absent keeps
   * the part it named, which a resolution refuses on another part's edge.
   */
  componentId?: string
): DrawingAnnotation | null {
  if (!pickedEnough(tool) || tool.viewId !== previous.viewId) return null;
  const draft = draftAnnotation(
    tool,
    previous.annotationId,
    previous.placementMm,
    undefined,
    // A balloon re-picked names the part of its new edge (v80).
    previous.kind === 'balloon'
      ? (componentId ?? previous.componentId)
      : undefined
  );
  if (!draft || draft.kind !== previous.kind) return null;
  if (previous.kind === 'note' && draft.kind === 'note')
    return { ...previous, ...(draft.leader ? { leader: draft.leader } : {}) };
  // v98: a re-pick changes only what it points at or hangs from.
  if (
    (previous.kind === 'datum-feature' && draft.kind === 'datum-feature') ||
    (previous.kind === 'feature-control-frame' &&
      draft.kind === 'feature-control-frame')
  ) {
    const { leader: _leader, attachedTo: _host, ...kept } = previous;
    return {
      ...kept,
      ...(draft.attachedTo !== undefined
        ? { attachedTo: draft.attachedTo }
        : { leader: draft.leader! })
    };
  }
  // A re-pick keeps the format (decimals, count, Ø, reference, and v68's
  // tolerance, prefix and suffix) but makes the
  // dimension the person's own: it no longer carries generated provenance.
  const format = previous as unknown as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const key of [
    'decimals',
    'count',
    'diameter',
    'reference',
    'tolerance',
    'prefix',
    'suffix',
    'extent'
  ])
    if (format[key] !== undefined) kept[key] = format[key];
  // A circle's side means nothing once the re-picked targets hold no circle.
  if (
    draft.kind === 'distance' &&
    ![draft.from, draft.to].some((target) => 'circle' in target)
  )
    delete kept.extent;
  return { ...draft, ...kept };
}

/** Which annotation tool re-picks `annotation`'s references. */
export function repairToolKind(
  annotation: DrawingAnnotation
): AnnotationToolKind {
  if (annotation.kind === 'centerline')
    return annotation.mode === 'circle' ? 'circle-centerline' : 'centerline';
  if (annotation.kind === 'bom-table') return 'parts-list';
  return annotation.kind === 'linear' ? annotation.direction : annotation.kind;
}

/** A refusal for a finished tool whose annotation would not measure. */
export function draftRefusal(
  annotation: DrawingAnnotation,
  view: DrawingView | undefined,
  bodies: AnnotationBodies,
  units: UnitSystem,
  /** v73: the sheet's annotations, for points that marks mark. */
  marks?: MarkLookup,
  /** v80: the assembly's BOM, for parts lists and balloons. */
  bom?: SheetBom,
  /** M01: the holes' callouts, which a hole table lists (review). */
  holes?: HoleCalloutLookup
): string | null {
  // v92: an image measures nothing; its picture was chosen from the
  // project's own, so there is nothing to refuse.
  if (annotation.kind === 'image') return null;
  const resolution = resolveDrawingAnnotation(
    annotation,
    view,
    bodies,
    units,
    holes,
    undefined,
    marks,
    bom
  );
  return resolution.ok ? null : resolution.message;
}

import {
  DRAWING_VIEW_FRAMES,
  projectToView,
  type BodyId,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingEdgeRef,
  type DrawingPointAnchor,
  type DrawingPointRef,
  type DrawingSheet,
  type DrawingView,
  type DrawingViewId,
  type EdgeTopology,
  type UnitSystem
} from '@openzcad/shared';
import { resolveEdge } from '../topologyResolution';
import {
  edgeEndsInPageOrder,
  resolveDrawingAnnotation,
  type AnnotationBodies
} from './annotations';
import { viewPageTransform, type ComposedView } from './sheetPage';

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
    const frame = DRAWING_VIEW_FRAMES[view.orientation];
    for (const bodyId of view.bodyIds) {
      const body = bodies[bodyId];
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
        out.push({ view, bodyId, edge, page, depths });
      }
    }
  }
  return out;
}

/**
 * The lines each drawn view shows, on the paper: its visible runs, and its
 * hidden runs when it draws them. A pick must land on one of these, so an
 * edge the view does not show cannot be picked through a face.
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

function distanceToPolylines(point: XY, lines: readonly XY[][]): number {
  let distance = Infinity;
  for (const line of lines)
    for (let i = 0; i + 1 < line.length; i += 1)
      distance = Math.min(
        distance,
        distanceToSegment(point, line[i]!, line[i + 1]!)
      );
  return distance;
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

/** How far a drawn line may stray from the edge it was drawn from, in mm. */
const DRAWN_COINCIDENCE_MM = 0.05;

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
  drawn: ReadonlyMap<DrawingViewId, XY[][]>
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
  return [at - tolerance, at, at + tolerance].every(
    (along) =>
      distanceToPolylines(pointAtLength(page, along), lines) <=
      DRAWN_COINCIDENCE_MM
  );
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
    if (drawn && !drawsEdgeAt(entry, point, tolerance, drawn)) continue;
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
  | 'radius'
  | 'diameter'
  | 'angle'
  | 'note';

export const ANNOTATION_TOOL_LABELS: Readonly<
  Record<AnnotationToolKind, string>
> = {
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  aligned: 'Aligned',
  radius: 'Radius',
  diameter: 'Diameter',
  angle: 'Angle',
  note: 'Note'
};

/** What each tool asks for next, by how many picks it has. */
export function annotationToolHint(tool: AnnotationTool): string {
  const label = ANNOTATION_TOOL_LABELS[tool.kind];
  if (pickedEnough(tool))
    return tool.repairId
      ? `${label}: done.`
      : `${label}: click where the ${tool.kind === 'note' ? 'note' : 'dimension'} goes.`;
  switch (tool.kind) {
    case 'horizontal':
    case 'vertical':
    case 'aligned':
      return tool.points.length === 0
        ? `${label} dimension: pick a straight edge, or an edge end or circle for its first point.`
        : `${label} dimension: pick the second point (an edge end or a circle).`;
    case 'radius':
    case 'diameter':
      return `${label}: pick a circle or arc seen face-on.`;
    case 'angle':
      return tool.edges.length === 0
        ? 'Angle: pick the first straight edge.'
        : 'Angle: pick the second straight edge.';
    case 'note':
      return 'Note: pick an edge for its leader, or click empty paper to place it.';
  }
}

export interface AnnotationTool {
  kind: AnnotationToolKind;
  /** The view every pick so far was made in. */
  viewId?: DrawingViewId;
  points: DrawingPointRef[];
  edges: DrawingEdgeRef[];
  /** A note's free placement, once clicked on empty paper. */
  placed?: { x: number; y: number };
  /** Re-picking the references of this broken annotation. */
  repairId?: DrawingAnnotationId;
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
  view: Pick<DrawingView, 'orientation' | 'hiddenLines' | 'bodyIds'>
): string {
  return `${view.orientation}|${view.hiddenLines}|${[...view.bodyIds].sort().join(',')}`;
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
    case 'note':
      return tool.edges.length === 1 || tool.placed !== undefined;
  }
}

/**
 * The stored reference for a picked edge, or null when it would not
 * resolve back to this edge alone (two edges share its identity).
 */
export function edgeRefFor(
  bodies: AnnotationBodies,
  bodyId: BodyId,
  edge: EdgeTopology
): DrawingEdgeRef | null {
  // A reference written for another hash would be refused on save; keep
  // the pick hash-only then rather than store a contradiction.
  const ref: DrawingEdgeRef = {
    bodyId,
    hash: edge.hash,
    ...(edge.reference && edge.reference.currentHash === edge.hash
      ? { reference: edge.reference }
      : {})
  };
  const found = resolveEdge(bodies[bodyId], ref);
  return found.ok && found.entry === edge ? ref : null;
}

function isFaceOnCircle(view: DrawingView, edge: EdgeTopology): boolean {
  const circle = edge.curve?.circle;
  if (!circle) return false;
  const d = DRAWING_VIEW_FRAMES[view.orientation].direction;
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
  bodies: AnnotationBodies
): PickResult {
  if (pickedEnough(tool)) return { ok: true, tool };
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
  const ref = edgeRefFor(bodies, hit.bodyId, hit.edge);
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
    tool.kind !== 'diameter'
  )
    return {
      ok: false,
      message:
        'The isometric view foreshortens lengths and angles. Dimension a principal view instead.'
    };
  const next = { ...tool, viewId: view.viewId };
  switch (tool.kind) {
    case 'horizontal':
    case 'vertical':
    case 'aligned': {
      const ends = edgeEndsInPageOrder(view, hit.edge);
      if (!ends) {
        if (!isFaceOnCircle(view, hit.edge))
          return {
            ok: false,
            message:
              'Pick an edge end, a straight edge or a circle seen face-on.'
          };
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
      const start = projectToView(DRAWING_VIEW_FRAMES[view.orientation], {
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
    case 'note':
      return { ok: true, tool: { ...next, edges: [ref] } };
  }
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
  text = 'NOTE'
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
    case 'note':
      return {
        ...base,
        kind: 'note',
        text,
        ...(tool.viewId ? { viewId: tool.viewId } : {}),
        ...(tool.edges[0] ? { leader: tool.edges[0] } : {})
      };
  }
}

/**
 * `previous` with the references a re-pick chose, its placement, text and
 * format kept. Null when the tool does not match its kind.
 */
export function repairedAnnotation(
  previous: DrawingAnnotation,
  tool: AnnotationTool
): DrawingAnnotation | null {
  if (!pickedEnough(tool) || tool.viewId !== previous.viewId) return null;
  const draft = draftAnnotation(
    tool,
    previous.annotationId,
    previous.placementMm
  );
  if (!draft || draft.kind !== previous.kind) return null;
  if (previous.kind === 'note' && draft.kind === 'note')
    return { ...previous, ...(draft.leader ? { leader: draft.leader } : {}) };
  if (
    'decimals' in previous &&
    previous.decimals !== undefined &&
    draft.kind !== 'note'
  )
    return { ...draft, decimals: previous.decimals };
  return draft;
}

/** Which annotation tool re-picks `annotation`'s references. */
export function repairToolKind(
  annotation: DrawingAnnotation
): AnnotationToolKind {
  return annotation.kind === 'linear' ? annotation.direction : annotation.kind;
}

/** A refusal for a finished tool whose annotation would not measure. */
export function draftRefusal(
  annotation: DrawingAnnotation,
  view: DrawingView | undefined,
  bodies: AnnotationBodies,
  units: UnitSystem
): string | null {
  const resolution = resolveDrawingAnnotation(annotation, view, bodies, units);
  return resolution.ok ? null : resolution.message;
}

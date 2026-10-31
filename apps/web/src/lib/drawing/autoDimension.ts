import {
  DRAWING_VIEW_FRAMES,
  MAX_DRAWING_ANNOTATIONS,
  createDrawingAnnotationId,
  drawingPaperMm,
  drawingPaperPerModelUnit,
  drawingAnnotationBodyId,
  projectToView,
  type BodyId,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingAnnotationProvenance,
  type DrawingEdgeRef,
  type DrawingPointRef,
  type DrawingSheet,
  type DrawingView,
  type DrawingViewId,
  type EdgeTopology,
  type FaceTopology,
  type UnitSystem,
  type Vector3
} from '@openzcad/shared';
import {
  annotationAnchor,
  dimensionPointInView,
  drawingPointInView,
  drawnCoincidence,
  layoutAnnotation,
  markHiddenLeaders,
  resolveDrawingAnnotation,
  resolveSheetAnnotations,
  type AnnotationBodies,
  type AnnotationBox,
  type AnnotationLayout,
  type ResolvedAnnotation
} from './annotations';
import { edgeRefFor, faceRefFor } from './annotationPicking';
import {
  axisOf,
  blendLabel,
  boltLabel,
  chamferLabel,
  circleInGroup,
  readDimensionState,
  same,
  sizeLabel,
  type AuditAxis,
  type Position,
  type SizeGroup
} from './dimensionAudit';
import { readChamfer } from './surfaceSharps';
import {
  SHEET_MARGIN_MM,
  titleBlockBox,
  viewPageBox,
  viewPageTransform,
  type ComposedView
} from './sheetPage';

/**
 * D06 slice C: the Auto-dimension command. From the checker's own reading
 * of the part (see dimensionAudit.ts) it adds exactly the dimensions the
 * sheet is missing, with no assistant involved:
 *
 * - every size group no dimension states gets one radius or diameter, on a
 *   circle the view sees face-on;
 * - along each model axis, every group of positions not yet linked to the
 *   datum (the group holding the lowest position) gets one linear
 *   dimension to it, from the lowest position where an edge marks it, so
 *   the set is baseline-dimensioned and can close no chain.
 *
 * Each goes in the view that sees it true size and visible, preferring the
 * view that already holds most of the body's dimensions, and never the
 * isometric one. It measures only edges whose identity no other edge
 * shares, as a pick would. Linear dimensions are stacked outside their
 * view, shortest nearest the part, so their extension lines cross no other
 * dimension; nothing overlaps text, other views or the title block, and
 * all of it stays on the paper. Existing dimensions are kept and count.
 *
 * Slice D adds what a turned part needs: one chamfer dimension per chamfer
 * group, on a face that reads its size, with its count ("2× 4 × 45°"); one
 * radius per revolved-blend group off a torus seen side-on ("3× R4"); and
 * spans ending on virtual points — a step chamfer's corner or virtual
 * sharp — where no edge lies. Each carries provenance naming what it
 * states, and on an import one read from raw geometry says so.
 *
 * What the checker cannot state yet, and anything that finds no edge or no
 * room, is skipped and reported. See
 * docs/plans/drawing-auto-dimensioning-plan.md.
 */

type XY = [number, number];
type DrawingFaceRefOrNull = ReturnType<typeof faceRefFor>;

export interface AutoDimensionSkip {
  bodyId: string;
  message: string;
}

export interface AutoDimensionPlan {
  /** The dimensions to add, in the order they are added. */
  annotations: DrawingAnnotation[];
  /** What it leaves for the user, worded for the report. */
  skipped: AutoDimensionSkip[];
  /** How many of `annotations` measure edges their view draws hidden. */
  onHiddenLines: number;
}

/** A point a linear dimension may end on, in one view. */
interface Anchor {
  /** The edge it lies on; absent on a virtual point. */
  edge?: EdgeTopology;
  point: DrawingPointRef;
  /** A rim's silhouette (v48) is a point of one page direction only. */
  direction?: 'horizontal' | 'vertical';
  model: Vector3;
  uv: XY;
  depth: number;
  visible: boolean;
}

interface ViewContext {
  view: DrawingView;
  toPage: (u: number, v: number) => XY;
  /** The view's outline on the paper. */
  box: AnnotationBox;
  /** Physical edges the view draws visible, in (u, v), with their extents. */
  visibleRuns: { points: XY[]; min: XY; max: XY }[];
  /** How far a drawn line may lie from its edge, in model units. */
  tolerance: number;
}

/** A dimension chosen but not yet placed. */
interface Planned {
  bodyId: string;
  context: ViewContext;
  annotation: DrawingAnnotation;
  visible: boolean;
  /** What it states, for a report when it finds no room. */
  what: string;
  /** On an import: what it states is raw geometry, not a feature. */
  basis?: 'geometry';
  /**
   * For a size: every circle that could state it, best first. Placement
   * takes the first whose leader clears the rest of the sheet.
   */
  options?: Pick<Planned, 'context' | 'annotation' | 'visible'>[];
}

/** What a placed annotation occupies on the paper. */
export interface Footprint {
  box: AnnotationBox;
  lines: [XY, XY][];
  /**
   * Which of `lines` are dimension lines or leaders, which no other line
   * may run along; the rest are extension lines, which stacked baseline
   * dimensions share.
   */
  measuring: ReadonlySet<[XY, XY]>;
  /**
   * Arrow tips, and a radius or diameter's centre: where another
   * dimension's lines may meet this one's.
   */
  feet: XY[];
}

/** First row off the view outline, and the pitch between rows, in mm. */
const FIRST_ROW_MM = 10;
const ROW_PITCH_MM = 8;
/** A radius or diameter's text clears its view by this much, in mm. */
const LEADER_CLEAR_MM = 6;

const AXES: readonly AuditAxis[] = ['x', 'y', 'z'];

export function planAutoDimensions(
  sheet: DrawingSheet,
  views: readonly ComposedView[],
  bodies: AnnotationBodies,
  units: UnitSystem,
  createId: () => DrawingAnnotationId = createDrawingAnnotationId
): AutoDimensionPlan {
  const state = readDimensionState(sheet, bodies, units);
  const skipped: AutoDimensionSkip[] = state.audit.unmeasurable.map(
    (finding) => ({ ...finding })
  );
  // v48 Ø pitch spans are the check's, and a person's, but not placed here
  // yet.
  for (const [bodyId, body] of state.bodies) {
    for (const circle of body.requirements.boltCircles)
      if (!body.statedBoltCircles.has(circle))
        skipped.push({
          bodyId,
          message: `${boltLabel(circle, units)}: Auto-dimension does not place pitch diameters yet; add a Ø span between two opposite holes' centres.`
        });
  }
  const k = drawingPaperPerModelUnit(sheet.scale, units);

  const contexts: ViewContext[] = [];
  for (const { view, projection } of views) {
    if (!projection.bounds) continue;
    const runs = projection.edgeRuns ?? projection;
    contexts.push({
      view,
      toPage: viewPageTransform(view, projection.bounds, sheet, units),
      box: viewPageBox(view, projection.bounds, sheet, units),
      visibleRuns: runs.visible.map((run) => {
        const points: XY[] = [];
        const min: XY = [Infinity, Infinity];
        const max: XY = [-Infinity, -Infinity];
        for (let i = 0; i + 1 < run.length; i += 2) {
          points.push([run[i]!, run[i + 1]!]);
          min[0] = Math.min(min[0], run[i]!);
          min[1] = Math.min(min[1], run[i + 1]!);
          max[0] = Math.max(max[0], run[i]!);
          max[1] = Math.max(max[1], run[i + 1]!);
        }
        return { points, min, max };
      }),
      tolerance: drawnCoincidence(bodies, view.bodyIds, k)
    });
  }
  // Views that measure true size: every principal view, never the
  // isometric one. Not a section (D03) yet either: its cut body's edges are
  // not the model's these dimensions are read from (D06 slice F).
  const measuring = contexts.filter(
    (context) =>
      context.view.orientation !== 'iso' && context.view.section === undefined
  );

  // Dimensions per view and body, existing ones included: a feature's
  // dimension goes where most of its body's others already are.
  const held = new Map<string, number>();
  const holdKey = (viewId: DrawingViewId, bodyId: string) =>
    `${viewId}|${bodyId}`;
  for (const annotation of sheet.annotations ?? []) {
    if (annotation.kind === 'note' || !annotation.viewId) continue;
    const bodyId = drawingAnnotationBodyId(annotation);
    if (!bodyId) continue;
    const key = holdKey(annotation.viewId, bodyId);
    held.set(key, (held.get(key) ?? 0) + 1);
  }
  const holding = (context: ViewContext, bodyId: string) =>
    held.get(holdKey(context.view.viewId, bodyId)) ?? 0;

  const refs = new Map<EdgeTopology, DrawingEdgeRef | null>();
  const refOf = (bodyId: string, edge: EdgeTopology) => {
    if (!refs.has(edge))
      refs.set(edge, edgeRefFor(bodies, bodyId as BodyId, edge));
    return refs.get(edge)!;
  };

  const faceRefs = new Map<FaceTopology, DrawingFaceRefOrNull>();
  const faceRefOf = (bodyId: string, face: FaceTopology) => {
    if (!faceRefs.has(face))
      faceRefs.set(face, faceRefFor(bodies, bodyId as BodyId, face));
    return faceRefs.get(face)!;
  };
  /** The point a position's virtual mark names, if it has one. */
  const virtualPoint = (
    bodyId: string,
    position: Position
  ): DrawingPointRef | null => {
    const mark = position.mark;
    if (!mark) return null;
    if (mark.kind === 'corner') {
      const face = faceRefOf(bodyId, mark.face);
      const like = faceRefOf(bodyId, mark.like);
      return face && like
        ? { anchor: 'chamfer-corner', face, like, side: 'high' }
        : null;
    }
    const a = faceRefOf(bodyId, mark.faces[0]);
    const b = faceRefOf(bodyId, mark.faces[1]);
    return a && b
      ? { anchor: 'virtual-sharp', faces: [a, b], side: 'high' }
      : null;
  };

  const anchorCache = new Map<string, Anchor[]>();
  const anchorsOf = (context: ViewContext, bodyId: string): Anchor[] => {
    const key = holdKey(context.view.viewId, bodyId);
    const cached = anchorCache.get(key);
    if (cached) return cached;
    const out: Anchor[] = [];
    const body = bodies[bodyId];
    for (const edge of body?.topology?.edges ?? []) {
      if (edge.displayRole === 'seam' || edge.points.length < 6) continue;
      const ref = refOf(bodyId, edge);
      if (!ref) continue;
      const edgeShown = edgeVisible(context, edge);
      for (const anchor of ['first', 'second', 'center'] as const) {
        if (anchor === 'center' && !edge.curve?.circle) continue;
        const point = drawingPointInView(context.view, edge, anchor);
        if (!point) continue;
        out.push({
          edge,
          point: { edge: ref, anchor },
          model: point.model,
          uv: point.uv,
          depth: point.depth,
          visible:
            edgeShown && (anchor === 'center' || onRuns(context, point.uv))
        });
      }
      // A rim seen side-on draws as a line with no ends of its own: its
      // silhouette end marks where it lies along the page.
      if (edge.curve?.circle && isClosed(edge))
        for (const direction of ['horizontal', 'vertical'] as const) {
          const point: DrawingPointRef = {
            edge: ref,
            anchor: 'silhouette',
            side: 'high'
          };
          const at = dimensionPointInView(
            context.view,
            point,
            bodies,
            direction
          );
          if (!at) continue;
          out.push({
            edge,
            point,
            direction,
            model: at.model,
            uv: at.uv,
            depth: at.depth,
            visible: edgeShown && onRuns(context, at.uv)
          });
        }
    }
    // Virtual points (v48/v49) where no edge lies: a step chamfer's corner
    // or its virtual sharp. Drawn with extension lines to the point, so
    // nothing hidden is measured.
    const positions = state.bodies.get(bodyId)?.requirements.positions;
    for (const axis of AXES)
      for (const position of positions?.[axis] ?? []) {
        const point = virtualPoint(bodyId, position);
        if (!point) continue;
        for (const direction of ['horizontal', 'vertical'] as const) {
          const at = dimensionPointInView(
            context.view,
            point,
            bodies,
            direction
          );
          if (!at || !same(at.model[axis], position.value)) continue;
          out.push({
            point,
            direction,
            model: at.model,
            uv: at.uv,
            depth: at.depth,
            visible: true
          });
        }
      }
    // Visible first, then nearest the viewer: the edge the view shows.
    out.sort(
      (a, b) => Number(b.visible) - Number(a.visible) || a.depth - b.depth
    );
    anchorCache.set(key, out);
    return out;
  };

  const planned: Planned[] = [];
  const plan = (entry: Planned) => {
    const imported = bodies[entry.bodyId]?.source === 'imported-step';
    const provenance: DrawingAnnotationProvenance = {
      generated: true,
      requirement: entry.what.slice(0, 200),
      ...(imported && entry.basis === 'geometry'
        ? { basis: 'geometry' as const }
        : {})
    };
    const stamp = (annotation: DrawingAnnotation) =>
      ({ ...annotation, provenance }) as DrawingAnnotation;
    entry = {
      ...entry,
      annotation: stamp(entry.annotation),
      ...(entry.options
        ? {
            options: entry.options.map((option) => ({
              ...option,
              annotation: stamp(option.annotation)
            }))
          }
        : {})
    };
    planned.push(entry);
    const key = holdKey(entry.context.view.viewId, entry.bodyId);
    held.set(key, (held.get(key) ?? 0) + 1);
  };

  /** Best first: visible, then where the body's other dimensions are. */
  const sortOptions = (
    options: NonNullable<Planned['options']>,
    bodyId: string
  ) => {
    const score = (option: NonNullable<Planned['options']>[number]) =>
      (option.visible ? 1000 : 0) + 10 * holding(option.context, bodyId);
    // Stable: equals keep the sheet's view order and the kernel's order.
    options.sort((a, b) => score(b) - score(a));
  };

  for (const [bodyId, body] of state.bodies) {
    const { requirements, links, statedSizes } = body;
    // Sizes: one radius or diameter per group, on a circle seen face-on.
    for (const group of requirements.sizes) {
      if (statedSizes.has(group)) continue;
      const label = sizeLabel(group, units);
      // The checker already reports a group no view looks along.
      if (
        state.audit.unmeasurable.some(
          (f) => f.bodyId === bodyId && f.message.startsWith(`${label}:`)
        )
      )
        continue;
      const circles = circleOptions(
        measuring,
        bodyId,
        bodies[bodyId]?.topology?.edges ?? [],
        group,
        refOf,
        holding
      );
      if (circles.length === 0) {
        skipped.push({
          bodyId,
          message: `${label}: no circle of it can be told apart from another edge.`
        });
        continue;
      }
      const annotationId = createId();
      const options = circles.map((circle) => ({
        context: circle.context,
        visible: circle.visible,
        annotation: {
          annotationId,
          kind: group.blend ? ('radius' as const) : ('diameter' as const),
          viewId: circle.context.view.viewId,
          edge: circle.ref,
          ...(group.axes.length > 1 ? { count: group.axes.length } : {}),
          placementMm: { x: 0, y: 0 }
        }
      }));
      plan({ bodyId, what: label, ...options[0]!, options });
    }
    // Chamfers: one per group, with its count, on a face that reads the
    // group's size (an end chamfer, not a step sized like it), side-on.
    const edgesOf = bodies[bodyId]?.topology?.edges ?? [];
    const facesOf = bodies[bodyId]?.topology?.faces ?? [];
    for (const group of requirements.chamfers) {
      if (body.statedChamfers.has(group)) continue;
      const label = chamferLabel(group, units);
      if (
        state.audit.unmeasurable.some(
          (f) => f.bodyId === bodyId && f.message.startsWith(`${label}:`)
        )
      )
        continue;
      const annotationId = createId();
      const options: NonNullable<Planned['options']> = [];
      for (const face of group.faces) {
        const reading = readChamfer(face, facesOf, edgesOf);
        if (!reading.ok || !same(reading.size, group.size)) continue;
        const ref = faceRefOf(bodyId, face);
        if (!ref || reading.kind !== 'cone') continue;
        for (const context of sideOn(measuring, bodyId, reading.axis))
          options.push({
            context,
            visible: faceShown(context, face, edgesOf),
            annotation: {
              annotationId,
              kind: 'chamfer',
              viewId: context.view.viewId,
              face: ref,
              ...(group.faces.length > 1 ? { count: group.faces.length } : {}),
              placementMm: { x: 0, y: 0 }
            }
          });
      }
      if (options.length === 0) {
        skipped.push({
          bodyId,
          message: `${label}: no view sees a face of it side-on that can be told apart from another.`
        });
        continue;
      }
      sortOptions(options, bodyId);
      plan({ bodyId, what: label, ...options[0]!, options });
    }
    // Revolved blends: one radius per group, with its count, off a torus's
    // tube seen side-on, on either side of its axis.
    for (const group of requirements.blends) {
      if (body.statedBlends.has(group)) continue;
      const label = blendLabel(group, units);
      if (
        state.audit.unmeasurable.some(
          (f) => f.bodyId === bodyId && f.message.startsWith(`${label}:`)
        )
      )
        continue;
      const annotationId = createId();
      const options: NonNullable<Planned['options']> = [];
      group.faces.forEach((face, index) => {
        const ref = faceRefOf(bodyId, face);
        if (!ref) return;
        for (const context of sideOn(measuring, bodyId, group.axes[index]!))
          for (const side of ['high', 'low'] as const)
            options.push({
              context,
              visible: faceShown(context, face, edgesOf),
              annotation: {
                annotationId,
                kind: 'radius',
                viewId: context.view.viewId,
                face: ref,
                side,
                ...(group.faces.length > 1
                  ? { count: group.faces.length }
                  : {}),
                placementMm: { x: 0, y: 0 }
              }
            });
      });
      if (options.length === 0) {
        skipped.push({
          bodyId,
          message: `${label}: no view sees a face of it side-on that can be told apart from another.`
        });
        continue;
      }
      sortOptions(options, bodyId);
      plan({ bodyId, what: label, ...options[0]!, options });
    }
    // Positions: each group not linked to the datum gets one dimension to it.
    for (const axis of AXES) {
      const positions = requirements.positions[axis];
      if (positions.length < 2) continue;
      const graph = links[axis];
      const order = positions
        .map((position, index) => ({ position, index }))
        .sort((p, q) => p.position.value - q.position.value);
      const datum = graph.find(order[0]!.index);
      const datumValues = order
        .filter(({ index }) => graph.find(index) === datum)
        .map(({ position }) => position.value);
      const seen = new Set([datum]);
      for (const { position, index } of order) {
        const root = graph.find(index);
        if (seen.has(root)) continue;
        seen.add(root);
        const targetValues = order
          .filter((entry) => graph.find(entry.index) === root)
          .map((entry) => entry.position.value);
        const what = `${axis.toUpperCase()}: ${position.label} from ${order[0]!.position.label}`;
        // The checker's "can't dimension yet" already covers this one.
        if (
          state.audit.unmeasurable.some(
            (finding) =>
              finding.bodyId === bodyId &&
              finding.message.startsWith(
                `${axis.toUpperCase()}: nothing locates ${position.label} `
              )
          )
        )
          continue;
        const best = bestSpan(
          measuring,
          bodyId,
          axis,
          datumValues,
          targetValues,
          anchorsOf,
          holding
        );
        if (!best) {
          skipped.push({
            bodyId,
            message: `${what}: no one view shows an edge at both ends.`
          });
          continue;
        }
        const basisAt = (value: number) =>
          positions.find((known) => same(known.value, value))?.basis;
        plan({
          bodyId,
          context: best.context,
          visible: best.from.visible && best.to.visible,
          what,
          ...(basisAt(best.from.model[axis]) === 'geometry' ||
          basisAt(best.to.model[axis]) === 'geometry'
            ? { basis: 'geometry' as const }
            : {}),
          annotation: {
            annotationId: createId(),
            kind: 'linear',
            viewId: best.context.view.viewId,
            direction: best.direction,
            from: best.from.point,
            to: best.to.point,
            placementMm: { x: 0, y: 0 }
          }
        });
      }
    }
  }

  const placed = placeAll(sheet, views, contexts, planned, bodies, units, k);
  for (const entry of placed.unplaced)
    skipped.push({
      bodyId: entry.bodyId,
      message: `${entry.what}: no room for it on the paper.`
    });
  // A sheet holds at most MAX_DRAWING_ANNOTATIONS; what does not fit is
  // left out whole rather than stored past the document's limit.
  const room = Math.max(
    0,
    MAX_DRAWING_ANNOTATIONS - (sheet.annotations?.length ?? 0)
  );
  const kept = placed.annotations.slice(0, room);
  for (const entry of placed.annotations.slice(room))
    skipped.push({
      bodyId: entry.bodyId,
      message: `${entry.what}: the sheet already holds ${MAX_DRAWING_ANNOTATIONS} annotations.`
    });
  return {
    annotations: kept.map((entry) => entry.annotation),
    skipped,
    onHiddenLines: kept.filter((entry) => !entry.visible).length
  };
}

/**
 * The circles that could state `group`, best first by decision 5: visible,
 * in the view holding most of the body's other dimensions, a whole circle
 * over an arc.
 */
function circleOptions(
  measuring: readonly ViewContext[],
  bodyId: string,
  edges: readonly EdgeTopology[],
  group: SizeGroup,
  refOf: (bodyId: string, edge: EdgeTopology) => DrawingEdgeRef | null,
  holding: (context: ViewContext, bodyId: string) => number
): { context: ViewContext; ref: DrawingEdgeRef; visible: boolean }[] {
  const out: {
    context: ViewContext;
    ref: DrawingEdgeRef;
    visible: boolean;
    score: number;
  }[] = [];
  for (const context of measuring) {
    if (!context.view.bodyIds.includes(bodyId as BodyId)) continue;
    const direction = DRAWING_VIEW_FRAMES[context.view.orientation].direction;
    for (const edge of edges) {
      const circle = edge.curve?.circle;
      if (!circle || edge.displayRole === 'seam') continue;
      if (
        Math.abs(
          Math.abs(
            circle.axis.x * direction.x +
              circle.axis.y * direction.y +
              circle.axis.z * direction.z
          ) - 1
        ) > 1e-6 ||
        !circleInGroup(group, circle)
      )
        continue;
      const ref = refOf(bodyId, edge);
      if (!ref) continue;
      const visible = edgeVisible(context, edge);
      out.push({
        context,
        ref,
        visible,
        score:
          (visible ? 1000 : 0) +
          10 * holding(context, bodyId) +
          (isClosed(edge) ? 1 : 0)
      });
    }
  }
  // Stable: equals keep the sheet's view order and the kernel's edge order.
  return out.sort((a, b) => b.score - a.score);
}

/** The linear dimension that links the datum group to a target group. */
function bestSpan(
  measuring: readonly ViewContext[],
  bodyId: string,
  axis: AuditAxis,
  datumValues: readonly number[],
  targetValues: readonly number[],
  anchorsOf: (context: ViewContext, bodyId: string) => Anchor[],
  holding: (context: ViewContext, bodyId: string) => number
): {
  context: ViewContext;
  direction: 'horizontal' | 'vertical';
  from: Anchor;
  to: Anchor;
} | null {
  const lowest = Math.min(...datumValues);
  let best: {
    context: ViewContext;
    direction: 'horizontal' | 'vertical';
    from: Anchor;
    to: Anchor;
    score: number;
  } | null = null;
  for (const context of measuring) {
    if (!context.view.bodyIds.includes(bodyId as BodyId)) continue;
    const frame = DRAWING_VIEW_FRAMES[context.view.orientation];
    const direction =
      axisOf(frame.x) === axis
        ? 'horizontal'
        : axisOf(frame.up) === axis
          ? 'vertical'
          : null;
    if (!direction) continue;
    const anchors = anchorsOf(context, bodyId);
    // The best anchor at each value: anchors are sorted best first.
    const firstAt = (values: readonly number[]) =>
      values.flatMap((value) => {
        const found = anchors.find(
          (anchor) =>
            (!anchor.direction || anchor.direction === direction) &&
            same(anchor.model[axis], value)
        );
        return found ? [{ value, anchor: found }] : [];
      });
    const froms = firstAt(datumValues);
    const tos = firstAt(targetValues);
    for (const from of froms)
      for (const to of tos) {
        const score =
          1000 * (Number(from.anchor.visible) + Number(to.anchor.visible)) +
          100 * Number(same(from.value, lowest)) +
          10 * holding(context, bodyId) +
          Number(
            from.anchor.edge !== undefined &&
              from.anchor.edge === to.anchor.edge
          );
        if (!best || score > best.score)
          best = {
            context,
            direction,
            from: from.anchor,
            to: to.anchor,
            score
          };
      }
  }
  return best;
}

/** The measuring views that see a surface of revolution about `axis` side-on. */
function sideOn(
  measuring: readonly ViewContext[],
  bodyId: string,
  axis: Vector3
): ViewContext[] {
  return measuring.filter((context) => {
    if (!context.view.bodyIds.includes(bodyId as BodyId)) return false;
    const d = DRAWING_VIEW_FRAMES[context.view.orientation].direction;
    return Math.abs(axis.x * d.x + axis.y * d.y + axis.z * d.z) <= 1e-6;
  });
}

/** Whether the view draws visible any edge bounding `face`. */
function faceShown(
  context: ViewContext,
  face: FaceTopology,
  edges: readonly EdgeTopology[]
): boolean {
  return edges.some(
    (edge) =>
      edge.displayRole !== 'seam' &&
      (edge.adjacentFaceHashes ?? []).includes(face.hash) &&
      edgeVisible(context, edge)
  );
}

function isClosed(edge: EdgeTopology): boolean {
  if (edge.vertexIds) return edge.vertexIds[0] === edge.vertexIds[1];
  const p = edge.points;
  const n = p.length;
  return (
    n >= 6 &&
    Math.hypot(p[0]! - p[n - 3]!, p[1]! - p[n - 2]!, p[2]! - p[n - 1]!) < 1e-9
  );
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

/** Whether `uv` lies on a line the view draws visible. */
function onRuns(context: ViewContext, uv: XY): boolean {
  const t = context.tolerance;
  for (const { points, min, max } of context.visibleRuns) {
    if (
      uv[0] < min[0] - t ||
      uv[0] > max[0] + t ||
      uv[1] < min[1] - t ||
      uv[1] > max[1] + t
    )
      continue;
    for (let i = 0; i + 1 < points.length; i += 1)
      if (distanceToSegment(uv, points[i]!, points[i + 1]!) <= t) return true;
  }
  return false;
}

/** Whether the view draws most of `edge` visible. */
function edgeVisible(context: ViewContext, edge: EdgeTopology): boolean {
  const frame = DRAWING_VIEW_FRAMES[context.view.orientation];
  const count = edge.points.length / 3;
  const samples = Math.min(9, count);
  let shown = 0;
  for (let s = 0; s < samples; s += 1) {
    const i = 3 * Math.round((s * (count - 1)) / Math.max(1, samples - 1));
    const { u, v } = projectToView(frame, {
      x: edge.points[i]!,
      y: edge.points[i + 1]!,
      z: edge.points[i + 2]!
    });
    if (onRuns(context, [u, v])) shown += 1;
  }
  return 2 * shown >= samples;
}

// ---------------------------------------------------------------------------
// Placement

interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const rectOf = (box: AnnotationBox, grow = 0): Rect => ({
  minX: box.x - grow,
  minY: box.y - grow,
  maxX: box.x + box.width + grow,
  maxY: box.y + box.height + grow
});

function rectsOverlap(a: Rect, b: Rect): boolean {
  return (
    a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY
  );
}

function rectInside(inner: Rect, outer: Rect): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY &&
    inner.maxY <= outer.maxY
  );
}

/** Liang–Barsky: whether a segment passes through a rectangle's inside. */
function segmentHitsRect([a, b]: [XY, XY], rect: Rect): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number) => {
    if (Math.abs(p) < 1e-12) return q > 0;
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    return t0 < t1;
  };
  return (
    clip(-dx, a[0] - rect.minX) &&
    clip(dx, rect.maxX - a[0]) &&
    clip(-dy, a[1] - rect.minY) &&
    clip(dy, rect.maxY - a[1]) &&
    t1 - t0 > 1e-9
  );
}

/** Where two segments cross inside both, or null (touching or parallel). */
function crossing([p, q]: [XY, XY], [r, s]: [XY, XY]): XY | null {
  const d1: XY = [q[0] - p[0], q[1] - p[1]];
  const d2: XY = [s[0] - r[0], s[1] - r[1]];
  const cross = d1[0] * d2[1] - d1[1] * d2[0];
  const scale = Math.hypot(...d1) * Math.hypot(...d2);
  if (Math.abs(cross) <= 1e-9 * scale) return null;
  const t = ((r[0] - p[0]) * d2[1] - (r[1] - p[1]) * d2[0]) / cross;
  const u = ((r[0] - p[0]) * d1[1] - (r[1] - p[1]) * d1[0]) / cross;
  const eps = 1e-6;
  if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;
  return [p[0] + d1[0] * t, p[1] + d1[1] * t];
}

/** Where shared extension lines may meet another dimension, in mm. */
const FOOT_MM = 0.5;

/**
 * What a laid-out annotation occupies. A radius or diameter's centre mark
 * sits on the part, where an extension line to the same centre starts, so
 * it is left out.
 */
export function annotationFootprint(
  layout: AnnotationLayout,
  resolved: ResolvedAnnotation,
  toPage: ((u: number, v: number) => XY) | null
): Footprint {
  const lines: [XY, XY][] = [];
  const measuring = new Set<[XY, XY]>();
  const feet: XY[] = [];
  const centre =
    toPage && (resolved.kind === 'radius' || resolved.kind === 'diameter')
      ? toPage(...resolved.center)
      : null;
  const open = layout.strokes.filter((stroke) => !stroke.closed);
  for (const stroke of layout.strokes)
    if (stroke.closed) feet.push([stroke.points[0]!, stroke.points[1]!]);
  // Diameters of concentric circles all pass through their centre.
  if (centre) feet.push(centre);
  open.forEach((stroke, index) => {
    // A linear dimension draws its extension lines, then its dimension
    // line; an angle its arc first; anything else is one leader.
    const isMeasuring =
      resolved.kind === 'linear'
        ? index === open.length - 1
        : resolved.kind === 'angle'
          ? index === 0
          : true;
    const p = stroke.points;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const line: [XY, XY] = [
        [p[i]!, p[i + 1]!],
        [p[i + 2]!, p[i + 3]!]
      ];
      if (
        centre &&
        Math.hypot(
          (line[0][0] + line[1][0]) / 2 - centre[0],
          (line[0][1] + line[1][1]) / 2 - centre[1]
        ) < 1e-6
      )
        continue;
      lines.push(line);
      if (isMeasuring) measuring.add(line);
    }
  });
  return { box: layout.box, lines, measuring, feet };
}

/** Whether two segments run along one line for more than a hair. */
function runAlong([p, q]: [XY, XY], [r, s]: [XY, XY]): boolean {
  const d: XY = [q[0] - p[0], q[1] - p[1]];
  const length = Math.hypot(...d);
  if (length < 1e-9) return false;
  const unit: XY = [d[0] / length, d[1] / length];
  const off = (point: XY) =>
    Math.abs((point[0] - p[0]) * unit[1] - (point[1] - p[1]) * unit[0]);
  if (off(r) > 0.3 || off(s) > 0.3) return false;
  const along = (point: XY) =>
    (point[0] - p[0]) * unit[0] + (point[1] - p[1]) * unit[1];
  const [lo, hi] = [along(r), along(s)].sort((x, y) => x - y) as [
    number,
    number
  ];
  return Math.min(length, hi) - Math.max(0, lo) > 0.5;
}

/**
 * How two footprints clash: text over text, a line through text, a
 * dimension line or leader running along another line, or lines crossing
 * anywhere but at a dimension's foot (where a shared baseline extension
 * line meets the dimensions stacked on it). Null when clear.
 */
export function footprintClash(
  a: Footprint,
  b: Footprint
): 'text' | 'line-through-text' | 'crossing' | 'collinear' | null {
  const boxA = rectOf(a.box);
  const boxB = rectOf(b.box);
  if (rectsOverlap(boxA, boxB)) return 'text';
  if (
    a.lines.some((line) => segmentHitsRect(line, boxB)) ||
    b.lines.some((line) => segmentHitsRect(line, boxA))
  )
    return 'line-through-text';
  const feet = [...a.feet, ...b.feet];
  for (const la of a.lines)
    for (const lb of b.lines) {
      if ((a.measuring.has(la) || b.measuring.has(lb)) && runAlong(la, lb))
        return 'collinear';
      const at = crossing(la, lb);
      if (
        at &&
        !feet.some(
          (foot) => Math.hypot(foot[0] - at[0], foot[1] - at[1]) <= FOOT_MM
        )
      )
        return 'crossing';
    }
  return null;
}

function placeAll(
  sheet: DrawingSheet,
  views: readonly ComposedView[],
  contexts: readonly ViewContext[],
  planned: readonly Planned[],
  bodies: AnnotationBodies,
  units: UnitSystem,
  k: number
): { annotations: Planned[]; unplaced: Planned[] } {
  const paper = drawingPaperMm(sheet.paper);
  const bounds: Rect = {
    minX: SHEET_MARGIN_MM,
    minY: SHEET_MARGIN_MM,
    maxX: paper.width - SHEET_MARGIN_MM,
    maxY: paper.height - SHEET_MARGIN_MM
  };
  const title = rectOf(titleBlockBox(sheet));
  const byView = new Map(
    contexts.map((context) => [context.view.viewId, context])
  );

  // Everything already on the sheet is in the way.
  const taken: Footprint[] = [];
  const resolutions = markHiddenLeaders(
    sheet,
    resolveSheetAnnotations(sheet, bodies, units),
    views,
    units,
    bodies
  );
  for (const annotation of sheet.annotations ?? []) {
    const resolution = resolutions.get(annotation.annotationId);
    if (!resolution?.ok) continue;
    const context = annotation.viewId
      ? byView.get(annotation.viewId)
      : undefined;
    if (annotation.viewId && !context) continue;
    const layout = layoutAnnotation(
      resolution.resolved,
      context?.toPage ?? null,
      k,
      annotationAnchor(annotation, context?.view)
    );
    taken.push(
      annotationFootprint(layout, resolution.resolved, context?.toPage ?? null)
    );
  }

  /** Whether a candidate fits: on the paper and clear of all else. */
  const fits = (
    print: Footprint,
    own: ViewContext,
    linear: boolean
  ): boolean => {
    const box = rectOf(print.box);
    if (!rectInside(box, bounds) || rectsOverlap(box, title)) return false;
    for (const line of print.lines)
      for (const end of line)
        if (
          end[0] < bounds.minX ||
          end[0] > bounds.maxX ||
          end[1] < bounds.minY ||
          end[1] > bounds.maxY
        )
          return false;
    if (print.lines.some((line) => segmentHitsRect(line, title))) return false;
    for (const context of contexts) {
      const outline = rectOf(context.box, 1);
      if (context === own) {
        if (linear && rectsOverlap(box, outline)) return false;
        continue;
      }
      if (
        rectsOverlap(box, outline) ||
        print.lines.some((line) => segmentHitsRect(line, outline))
      )
        return false;
    }
    return taken.every((other) => footprintClash(print, other) === null);
  };

  const round = (value: number) => Math.round(value * 10) / 10;
  const placedAt = (entry: Planned, page: XY): DrawingAnnotation => ({
    ...entry.annotation,
    placementMm: {
      x: round(page[0] - entry.context.view.centerMm.x),
      y: round(page[1] - entry.context.view.centerMm.y)
    }
  });
  const layoutOf = (entry: Planned, annotation: DrawingAnnotation) => {
    const resolution = resolveDrawingAnnotation(
      annotation,
      entry.context.view,
      bodies,
      units
    );
    if (!resolution.ok || resolution.resolved.kind === 'note') return null;
    const layout = layoutAnnotation(
      resolution.resolved,
      entry.context.toPage,
      k,
      annotationAnchor(annotation, entry.context.view)
    );
    return {
      resolved: resolution.resolved,
      print: annotationFootprint(
        layout,
        resolution.resolved,
        entry.context.toPage
      )
    };
  };

  const annotations: Planned[] = [];
  const unplaced: Planned[] = [];
  const accept = (
    entry: Planned,
    annotation: DrawingAnnotation,
    print: Footprint
  ) => {
    taken.push(print);
    annotations.push({ ...entry, annotation });
  };

  // Linear dimensions first, view by view, shortest first: each takes the
  // nearest row off the outline where it clashes with nothing, so a longer
  // one sharing its datum stacks outside it.
  const linears = planned
    .map((entry) => {
      const resolution = resolveDrawingAnnotation(
        entry.annotation,
        entry.context.view,
        bodies,
        units
      );
      if (!resolution.ok || resolution.resolved.kind !== 'linear') return null;
      const a = entry.context.toPage(...resolution.resolved.from);
      const b = entry.context.toPage(...resolution.resolved.to);
      const horizontal = resolution.resolved.axis[0] !== 0;
      return {
        entry,
        a,
        b,
        horizontal,
        span: horizontal ? Math.abs(b[0] - a[0]) : Math.abs(b[1] - a[1])
      };
    })
    .filter((entry) => entry !== null);
  const order = new Map(contexts.map((context, index) => [context, index]));
  linears.sort(
    (p, q) =>
      order.get(p.entry.context)! - order.get(q.entry.context)! ||
      p.span - q.span
  );
  for (const { entry, a, b, horizontal } of linears) {
    const box = entry.context.box;
    const middle = horizontal
      ? (a[1] + b[1]) / 2 >= box.y + box.height / 2
      : (a[0] + b[0]) / 2 >= box.x + box.width / 2;
    // The side nearer the points it measures first, then the other.
    let done = false;
    for (const far of [middle, !middle]) {
      for (let row = 0; !done; row += 1) {
        const offset = FIRST_ROW_MM + row * ROW_PITCH_MM;
        const page: XY = horizontal
          ? [
              (a[0] + b[0]) / 2,
              far ? box.y + box.height + offset : box.y - offset
            ]
          : [
              far ? box.x + box.width + offset : box.x - offset,
              (a[1] + b[1]) / 2
            ];
        if (
          page[0] < bounds.minX ||
          page[0] > bounds.maxX ||
          page[1] < bounds.minY ||
          page[1] > bounds.maxY
        )
          break;
        const annotation = placedAt(entry, page);
        const laid = layoutOf(entry, annotation);
        if (!laid) break;
        if (fits(laid.print, entry.context, true)) {
          accept(entry, annotation, laid.print);
          done = true;
        }
      }
      if (done) break;
    }
    if (!done) unplaced.push(entry);
  }

  /**
   * A radius, diameter or chamfer's best placement: text out of its view on
   * a leader that clears everything (`clear`), else anywhere it fits. A
   * chamfer's leader starts at the middle of one of its drawn sides.
   */
  const placeRadial = (
    entry: Planned
  ): {
    annotation: DrawingAnnotation;
    print: Footprint;
    clear: boolean;
  } | null => {
    const first = layoutOf(entry, entry.annotation);
    if (!first) return null;
    const resolved = first.resolved;
    const toPage = entry.context.toPage;
    const origins: { c: XY; r: number; aim?: XY }[] = [];
    if (resolved.kind === 'radius' || resolved.kind === 'diameter') {
      const c = toPage(...resolved.center);
      let aim: XY | undefined;
      if (resolved.arc && resolved.arc.length >= 4) {
        // A blend's arc: point at its middle, where the arrow can land.
        const middle = Math.floor(resolved.arc.length / 4) * 2;
        const m = toPage(resolved.arc[middle]!, resolved.arc[middle + 1]!);
        const length = Math.hypot(m[0] - c[0], m[1] - c[1]);
        if (length > 1e-9)
          aim = [(m[0] - c[0]) / length, (m[1] - c[1]) / length];
      }
      origins.push({ c, r: resolved.radius * k, ...(aim ? { aim } : {}) });
    } else if (resolved.kind === 'chamfer') {
      for (const [a, b] of resolved.segments) {
        const p = toPage(...a);
        const q = toPage(...b);
        origins.push({ c: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], r: 0 });
      }
    } else return null;
    const box = entry.context.box;
    const outline = rectOf(box);
    const centre: XY = [box.x + box.width / 2, box.y + box.height / 2];
    /** How far along `u` from `c` the view outline ends. */
    const exit = (c: XY, u: XY) => {
      let t = Infinity;
      if (u[0] > 1e-9) t = Math.min(t, (outline.maxX - c[0]) / u[0]);
      if (u[0] < -1e-9) t = Math.min(t, (outline.minX - c[0]) / u[0]);
      if (u[1] > 1e-9) t = Math.min(t, (outline.maxY - c[1]) / u[1]);
      if (u[1] < -1e-9) t = Math.min(t, (outline.minY - c[1]) / u[1]);
      return Math.max(0, t);
    };
    let fallback: { annotation: DrawingAnnotation; print: Footprint } | null =
      null;
    for (const { c, r, aim } of origins) {
      const outward =
        Math.hypot(c[0] - centre[0], c[1] - centre[1]) > 1e-6
          ? [c[0] - centre[0], c[1] - centre[1]]
          : [1, 1];
      const directions: XY[] = Array.from({ length: 8 }, (_, index) => {
        const angle = Math.PI / 4 + (index * Math.PI) / 4;
        return [Math.cos(angle), Math.sin(angle)] as XY;
      }).sort(
        (u, v) =>
          v[0] * outward[0]! +
          v[1] * outward[1]! -
          (u[0] * outward[0]! + u[1] * outward[1]!)
      );
      if (aim) directions.unshift(aim);
      const reaches = (u: XY) => [
        r + 5,
        ...[0, 8, 18, 30].map((extra) => exit(c, u) + LEADER_CLEAR_MM + extra)
      ];
      for (let step = 0; step < 5; step += 1)
        for (const u of directions) {
          const reach = reaches(u)[step]!;
          if (reach < r + 3) continue;
          const annotation = placedAt(entry, [
            c[0] + u[0] * reach,
            c[1] + u[1] * reach
          ]);
          const laid = layoutOf(entry, annotation);
          if (!laid || !fits(laid.print, entry.context, false)) continue;
          if (!rectsOverlap(rectOf(laid.print.box), outline))
            return { annotation, print: laid.print, clear: true };
          fallback ??= { annotation, print: laid.print };
        }
    }
    return fallback && { ...fallback, clear: false };
  };
  // Then each radius or diameter: the first of its circles that takes a
  // clear leader, or else the best one where it fits at all.
  for (const entry of planned) {
    if (entry.annotation.kind === 'linear') continue;
    let pick: {
      entry: Planned;
      annotation: DrawingAnnotation;
      print: Footprint;
    } | null = null;
    for (const option of entry.options ?? [entry]) {
      const candidate = { ...entry, ...option };
      const placed = placeRadial(candidate);
      if (!placed) continue;
      if (placed.clear) {
        pick = { entry: candidate, ...placed };
        break;
      }
      pick ??= { entry: candidate, ...placed };
    }
    if (pick) accept(pick.entry, pick.annotation, pick.print);
    else unplaced.push(entry);
  }
  // Back in the order they were planned: sizes, then positions by axis.
  const rank = new Map(
    planned.map((entry, index) => [entry.annotation.annotationId, index])
  );
  annotations.sort(
    (p, q) =>
      rank.get(p.annotation.annotationId)! -
      rank.get(q.annotation.annotationId)!
  );
  return { annotations, unplaced };
}

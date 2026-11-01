import {
  DRAWING_VIEW_FRAMES,
  DRAWING_VIEW_LABELS,
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
  sectionBodyKey,
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
  slopeLabel,
  viewEdges,
  type AuditAxis,
  type ChamferGroup,
  type Position,
  type SizeGroup,
  type SlopeGroup
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
 * A section view (D03) measures its cut body's edges, so a feature inside
 * the part — a bore's floor, an internal step — is dimensioned there, on
 * the visible cut, rather than on hidden lines (slice F). When no view
 * shows such a feature visible, the plan asks for a section through it; it
 * never adds one itself.
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
  /**
   * The features it could place only on hidden lines, which a section
   * through the part would dimension on visible ones, worded for the
   * report ("Add a section … to dimension …"), or null when there are none.
   */
  sectionAdvice: string | null;
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
  /** Every line the view draws, silhouettes and hidden lines too, on the paper. */
  drawn: [XY, XY][];
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
  /** The feature it locates or sizes, for asking for a section. */
  subject: string;
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
/**
 * Inside placement: how far a span's end must lie within its view to count
 * as a feature there, the step between dimension-line offsets tried and how
 * many each way, and how close a dimension line may run beside a drawn
 * one, in mm.
 */
const INSIDE_EDGE_MM = 1;
const INSIDE_PITCH_MM = 1;
const HUG_MM = 3;
/** A span shorter than this keeps its dimension outside the view, in mm. */
const INSIDE_MIN_SPAN_MM = 8;
/**
 * How far an inside dimension's line and text keep from other dimensions'
 * lines and text at least, and the open space beyond which more counts no
 * further, in mm.
 */
const INSIDE_SPACING_MM = 4;
/** How far an inside dimension's text and line keep off drawn lines, in mm. */
const INSIDE_DRAWING_MM = 2.5;
const INSIDE_ROOM_MM = 6;
/**
 * How much farther than the nearest an angle's edges may meet the slope
 * and still be offered, in model units: copies of one corner at the
 * slope's other end, never an edge across the part.
 */
const ANGLE_REACH_SLACK = 1e-6;
/** Arc radii an angle dimension tries from its vertex, nearest first, in mm. */
const ANGLE_RADII_MM = [10, 14, 18, 24, 30, 38] as const;
/** Leader lengths past the feature tried before leaving the view, in mm. */
const NEAR_REACH_MM = [5, 8, 12] as const;

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
      tolerance: drawnCoincidence(bodies, view.bodyIds, k),
      drawn: pageSegments(
        [...projection.visible, ...projection.hidden],
        viewPageTransform(view, projection.bounds, sheet, units)
      )
    });
  }
  // Views that measure true size: every principal view and section, never
  // the isometric one.
  const measuring = contexts.filter(
    (context) => context.view.orientation !== 'iso'
  );
  /** What a view measures of a body: a section's cut edges, else the model's. */
  const edgesOf = (context: ViewContext, bodyId: string) =>
    viewEdges(bodies, context.view, bodyId);

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

  // By edge: a section's cut edges are their own objects, resolved against
  // the cut body of the view that draws them.
  const refs = new Map<EdgeTopology, DrawingEdgeRef | null>();
  const refOf = (context: ViewContext, bodyId: string, edge: EdgeTopology) => {
    if (!refs.has(edge))
      refs.set(edge, edgeRefFor(bodies, bodyId as BodyId, edge, context.view));
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
    for (const edge of edgesOf(context, bodyId)) {
      if (edge.displayRole === 'seam' || edge.points.length < 6) continue;
      const ref = refOf(context, bodyId, edge);
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
    const positions = context.view.section
      ? undefined
      : state.bodies.get(bodyId)?.requirements.positions;
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
    // Counterbored holes (v50): one callout states the hole, its bore, the
    // bore's depth and a blind hole's, on the hole's circle face-on with the
    // bore's rim around it. Either size already stated keeps them apart.
    const calledOut = new Set<SizeGroup>();
    for (const group of requirements.counterbores) {
      if (statedSizes.has(group.hole) || statedSizes.has(group.bore)) continue;
      const annotationId = createId();
      const options = circleOptions(
        measuring,
        bodyId,
        edgesOf,
        group.hole,
        refOf,
        holding
      ).flatMap((circle) => {
        const hole = circle.edge.curve!.circle!;
        // The bore's rim about this hole, nearest the viewer first.
        const rims = edgesOf(circle.context, bodyId)
          .filter((edge) => {
            const rim = edge.curve?.circle;
            return (
              rim !== undefined &&
              edge.displayRole !== 'seam' &&
              circleInGroup(
                {
                  ...group.bore,
                  axes: [{ point: hole.center, direction: hole.axis }]
                },
                rim
              )
            );
          })
          .sort(
            (a, b) =>
              Number(edgeVisible(circle.context, b)) -
              Number(edgeVisible(circle.context, a))
          );
        for (const rim of rims) {
          const bore = refOf(circle.context, bodyId, rim);
          if (bore)
            return [
              {
                context: circle.context,
                visible: circle.visible,
                annotation: {
                  annotationId,
                  kind: 'diameter' as const,
                  viewId: circle.context.view.viewId,
                  edge: circle.ref,
                  counterbore: bore,
                  ...(group.hole.axes.length > 1
                    ? { count: group.hole.axes.length }
                    : {}),
                  placementMm: { x: 0, y: 0 }
                }
              }
            ];
        }
        return [];
      });
      if (options.length === 0) continue;
      const what = `${sizeLabel(group.hole, units)} counterbored ${sizeLabel(group.bore, units)}`;
      plan({ bodyId, what, subject: what, ...options[0]!, options });
      calledOut.add(group.hole);
      calledOut.add(group.bore);
      // Its depths are the callout's: no span asks for them again.
      for (const copy of group.instances) {
        const graph = links[copy.along];
        const index = (value: number) =>
          requirements.positions[copy.along].findIndex((known) =>
            same(known.value, value)
          );
        const spans: [number, number][] = [[copy.opening, copy.floor]];
        if (!copy.through) spans.push([copy.floor, copy.end]);
        for (const [from, to] of spans) {
          const a = index(from);
          const b = index(to);
          if (a >= 0 && b >= 0 && graph.find(a) !== graph.find(b))
            graph.link(a, b, annotationId);
        }
      }
    }
    // Countersunk holes (v51): one callout states the hole and its cone,
    // and a blind hole's depth, on the hole's circle with the cone's outer
    // rim around it. Either already stated keeps them apart.
    const calledOutChamfers = new Set<ChamferGroup>();
    for (const group of requirements.countersinks) {
      if (statedSizes.has(group.hole) || body.statedChamfers.has(group.chamfer))
        continue;
      const annotationId = createId();
      const cones = new Set(group.chamfer.faces.map((face) => face.hash));
      const options = circleOptions(
        measuring,
        bodyId,
        edgesOf,
        group.hole,
        refOf,
        holding
      ).flatMap((circle) => {
        const hole = circle.edge.curve!.circle!;
        // The widest circle of a cone of the group about this hole.
        const rims = edgesOf(circle.context, bodyId)
          .filter((edge) => {
            const rim = edge.curve?.circle;
            return (
              rim !== undefined &&
              edge.displayRole !== 'seam' &&
              (edge.adjacentFaceHashes ?? []).some((hash) => cones.has(hash)) &&
              circleInGroup(
                {
                  radius: rim.radius,
                  blend: false,
                  axes: [{ point: hole.center, direction: hole.axis }]
                },
                rim
              ) &&
              rim.radius > hole.radius
            );
          })
          .sort(
            (a, b) =>
              b.curve!.circle!.radius - a.curve!.circle!.radius ||
              Number(edgeVisible(circle.context, b)) -
                Number(edgeVisible(circle.context, a))
          );
        for (const rim of rims) {
          const ref = refOf(circle.context, bodyId, rim);
          if (ref)
            return [
              {
                context: circle.context,
                visible: circle.visible,
                annotation: {
                  annotationId,
                  kind: 'diameter' as const,
                  viewId: circle.context.view.viewId,
                  edge: circle.ref,
                  countersink: ref,
                  ...(group.hole.axes.length > 1
                    ? { count: group.hole.axes.length }
                    : {}),
                  placementMm: { x: 0, y: 0 }
                }
              }
            ];
        }
        return [];
      });
      if (options.length === 0) continue;
      const what = `${sizeLabel(group.hole, units)} countersunk`;
      plan({ bodyId, what, subject: what, ...options[0]!, options });
      calledOut.add(group.hole);
      calledOutChamfers.add(group.chamfer);
      for (const copy of group.instances) {
        if (copy.through) continue;
        const graph = links[copy.along];
        const index = (value: number) =>
          requirements.positions[copy.along].findIndex((known) =>
            same(known.value, value)
          );
        const a = index(copy.opening);
        const b = index(copy.end);
        if (a >= 0 && b >= 0 && graph.find(a) !== graph.find(b))
          graph.link(a, b, annotationId);
      }
    }
    // Sizes: one radius or diameter per group, on a circle seen face-on.
    for (const group of requirements.sizes) {
      if (statedSizes.has(group) || calledOut.has(group)) continue;
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
        edgesOf,
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
      plan({ bodyId, what: label, subject: label, ...options[0]!, options });
    }
    // Chamfers: one per group, with its count, on a face that reads the
    // group's size (an end chamfer, not a step sized like it), side-on.
    const bodyEdges = bodies[bodyId]?.topology?.edges ?? [];
    const bodyFaces = bodies[bodyId]?.topology?.faces ?? [];
    for (const group of requirements.chamfers) {
      if (body.statedChamfers.has(group) || calledOutChamfers.has(group))
        continue;
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
        const reading = readChamfer(face, bodyFaces, bodyEdges);
        if (!reading.ok || !same(reading.size, group.size)) continue;
        const ref = faceRefOf(bodyId, face);
        if (!ref || reading.kind !== 'cone') continue;
        for (const context of sideOn(measuring, bodyId, reading.axis))
          options.push({
            context,
            visible: faceShown(context, face, bodyEdges),
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
      plan({ bodyId, what: label, subject: label, ...options[0]!, options });
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
              visible: faceShown(context, face, bodyEdges),
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
      plan({ bodyId, what: label, subject: label, ...options[0]!, options });
    }
    // Slopes: one angle per plane, in a view along it, between an edge of
    // the slope and the axis-aligned edge it meets (through a blend, at the
    // virtual sharp the two lines make).
    for (const group of requirements.slopes) {
      if (body.statedSlopes.has(group)) continue;
      const label = slopeLabel(group, units);
      if (
        state.audit.unmeasurable.some(
          (f) => f.bodyId === bodyId && f.message.startsWith(`${label}:`)
        )
      )
        continue;
      const annotationId = createId();
      const options = angleOptions(
        measuring,
        bodyId,
        group,
        edgesOf,
        refOf
      ).flatMap((option) =>
        // The outside angle first (v51): the axis edge's ray turned onto its
        // extension, so a 135° corner reads 45° off the part; then inside.
        ([1, undefined] as const).map((outside) => ({
          context: option.context,
          visible: option.visible,
          annotation: {
            annotationId,
            kind: 'angle' as const,
            viewId: option.context.view.viewId,
            edges: option.edges,
            ...(outside !== undefined ? { outside } : {}),
            placementMm: { x: 0, y: 0 }
          }
        }))
      );
      if (options.length === 0) {
        skipped.push({
          bodyId,
          message: `${label}: no view along it shows an edge of it and an edge along an axis that can be told apart from others.`
        });
        continue;
      }
      sortOptions(options, bodyId);
      plan({ bodyId, what: label, subject: label, ...options[0]!, options });
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
          subject: position.label,
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
  const inside = kept
    .filter((entry) => !entry.visible)
    .map((entry) => entry.subject);
  return {
    annotations: kept.map((entry) => entry.annotation),
    skipped,
    onHiddenLines: kept.filter((entry) => !entry.visible).length,
    sectionAdvice: sectionAdvice(
      inside,
      // Sections the kernel cut from the tessellation: no edges to measure.
      sheet.views.flatMap((view) =>
        view.section &&
        view.bodyIds.some(
          (id) =>
            bodies[sectionBodyKey(view.viewId, id)] !== undefined &&
            viewEdges(bodies, view, id).length === 0
        )
          ? [`${view.section.label}-${view.section.label}`]
          : []
      )
    )
  };
}

/** "Add a section to dimension a, b and 2 more." */
function sectionAdvice(
  subjects: readonly string[],
  approximate: readonly string[]
): string | null {
  const unique = [...new Set(subjects)];
  if (unique.length === 0) return null;
  const named = unique.slice(0, unique.length > 3 ? 2 : 3);
  const rest = unique.length - named.length;
  const list =
    rest > 0
      ? `${named.join(', ')} and ${rest} more`
      : named.length > 1
        ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`
        : named[0]!;
  const advice = `Add a section through the part to dimension ${list} on visible lines.`;
  return approximate.length > 0
    ? `${advice} Section ${approximate.join(' and ')} was cut from the tessellation, so its edges cannot carry dimensions.`
    : advice;
}

/**
 * The circles that could state `group`, best first by decision 5: visible,
 * in the view holding most of the body's other dimensions, a whole circle
 * over an arc.
 */
function circleOptions(
  measuring: readonly ViewContext[],
  bodyId: string,
  edgesOf: (context: ViewContext, bodyId: string) => readonly EdgeTopology[],
  group: SizeGroup,
  refOf: (
    context: ViewContext,
    bodyId: string,
    edge: EdgeTopology
  ) => DrawingEdgeRef | null,
  holding: (context: ViewContext, bodyId: string) => number
): {
  context: ViewContext;
  edge: EdgeTopology;
  ref: DrawingEdgeRef;
  visible: boolean;
}[] {
  const out: {
    context: ViewContext;
    edge: EdgeTopology;
    ref: DrawingEdgeRef;
    visible: boolean;
    score: number;
  }[] = [];
  for (const context of measuring) {
    if (!context.view.bodyIds.includes(bodyId as BodyId)) continue;
    const direction = DRAWING_VIEW_FRAMES[context.view.orientation].direction;
    for (const edge of edgesOf(context, bodyId)) {
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
      const ref = refOf(context, bodyId, edge);
      if (!ref) continue;
      const visible = edgeVisible(context, edge);
      out.push({
        context,
        edge,
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

/**
 * The angle dimensions that could state `group`, best first: in each view
 * looking along the slope, an edge of it paired with the straight edge
 * along a model axis whose line meets it nearest its own end, both
 * visible before either hidden.
 */
function angleOptions(
  measuring: readonly ViewContext[],
  bodyId: string,
  group: SlopeGroup,
  edgesOf: (context: ViewContext, bodyId: string) => readonly EdgeTopology[],
  refOf: (
    context: ViewContext,
    bodyId: string,
    edge: EdgeTopology
  ) => DrawingEdgeRef | null
): {
  context: ViewContext;
  edges: [DrawingEdgeRef, DrawingEdgeRef];
  visible: boolean;
}[] {
  const out: {
    context: ViewContext;
    edges: [DrawingEdgeRef, DrawingEdgeRef];
    visible: boolean;
    reach: number;
    score: number;
  }[] = [];
  const at = AXES.indexOf(group.along);
  const ends = (edge: EdgeTopology): [Vector3, Vector3] => {
    const p = edge.points;
    const n = p.length;
    return [
      { x: p[0]!, y: p[1]!, z: p[2]! },
      { x: p[n - 3]!, y: p[n - 2]!, z: p[n - 1]! }
    ];
  };
  /** Straight, and square to the slope's axis: drawn true in the view. */
  const inPlane = (edge: EdgeTopology) =>
    edge.displayRole !== 'seam' &&
    !edge.curve?.circle &&
    edge.points.length >= 6 &&
    same(edge.points[at]!, edge.points[edge.points.length - 3 + at]!);
  const faces = new Set(group.faces.map((face) => face.hash));
  for (const context of measuring) {
    if (
      context.view.section ||
      !context.view.bodyIds.includes(bodyId as BodyId) ||
      axisOf(DRAWING_VIEW_FRAMES[context.view.orientation].direction) !==
        group.along
    )
      continue;
    const edges = edgesOf(context, bodyId).filter(inPlane);
    const slopeEdges = edges.filter((edge) =>
      (edge.adjacentFaceHashes ?? []).some((hash) => faces.has(hash))
    );
    const axisEdges = edges.filter((edge) => {
      const [a, b] = ends(edge);
      const axis = axisOf({ x: b.x - a.x, y: b.y - a.y, z: b.z - a.z });
      return axis !== null && axis !== group.along;
    });
    for (const slope of slopeEdges) {
      const slopeRef = refOf(context, bodyId, slope);
      if (!slopeRef) continue;
      const [s0, s1] = ends(slope);
      const d: Vector3 = { x: s1.x - s0.x, y: s1.y - s0.y, z: s1.z - s0.z };
      for (const other of axisEdges) {
        // Lying in the same plane square to the slope's axis.
        if (!same(other.points[at]!, slope.points[at]!)) continue;
        const [o0, o1] = ends(other);
        const e: Vector3 = { x: o1.x - o0.x, y: o1.y - o0.y, z: o1.z - o0.z };
        // Where the two lines meet, in the plane of the view.
        const [p, q] = AXES.filter((axis) => axis !== group.along) as [
          AuditAxis,
          AuditAxis
        ];
        const cross = d[p] * e[q] - d[q] * e[p];
        if (Math.abs(cross) < 1e-12) continue;
        const t = ((o0[p] - s0[p]) * e[q] - (o0[q] - s0[q]) * e[p]) / cross;
        const meet = { [p]: s0[p] + t * d[p], [q]: s0[q] + t * d[q] } as Record<
          AuditAxis,
          number
        >;
        const gap = (point: Vector3) =>
          Math.hypot(point[p] - meet[p], point[q] - meet[q]);
        const reach = Math.min(gap(s0), gap(s1)) + Math.min(gap(o0), gap(o1));
        const otherRef = refOf(context, bodyId, other);
        if (!otherRef) continue;
        const visible =
          edgeVisible(context, slope) && edgeVisible(context, other);
        out.push({
          context,
          edges: [slopeRef, otherRef],
          visible,
          reach,
          score: (visible ? 1e6 : 0) - reach
        });
      }
    }
  }
  // Only edges that meet the slope (at its corner, or through a blend at
  // the virtual sharp): any farther pairs lines that cross off the part.
  const nearest = Math.min(...out.map((option) => option.reach));
  return out
    .filter((option) => option.reach <= nearest + ANGLE_REACH_SLACK)
    .sort((a, b) => b.score - a.score);
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
    // A section draws a cut body: its faces are not the ones named here.
    if (
      context.view.section !== undefined ||
      !context.view.bodyIds.includes(bodyId as BodyId)
    )
      return false;
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

function pageSegments(
  runs: readonly ArrayLike<number>[],
  toPage: (u: number, v: number) => XY
): [XY, XY][] {
  const out: [XY, XY][] = [];
  for (const run of runs) {
    let previous: XY | null = null;
    for (let i = 0; i + 1 < run.length; i += 2) {
      const point = toPage(run[i]!, run[i + 1]!);
      if (previous) out.push([previous, point]);
      previous = point;
    }
  }
  return out;
}

/** How far placed text keeps off other text and dimension lines, in mm. */
const TEXT_AIR_MM = 1;

/** How far text keeps off the drawing, and a leader's crossing off its foot, in mm. */
const DRAWING_CLEAR_MM = 0.8;

/**
 * Whether a footprint inside its view stays off the drawing: its text
 * touches no drawn line, and its leader or dimension line crosses one only
 * at its own foot (the arrow on the feature, or a centre). Extension lines
 * may cross the part, as they do from a hole's centre.
 */
function clearOfDrawing(print: Footprint, context: ViewContext): boolean {
  const text = rectOf(print.box, DRAWING_CLEAR_MM);
  const reach: Rect = { ...text };
  for (const line of print.measuring)
    for (const [x, y] of line) {
      reach.minX = Math.min(reach.minX, x);
      reach.minY = Math.min(reach.minY, y);
      reach.maxX = Math.max(reach.maxX, x);
      reach.maxY = Math.max(reach.maxY, y);
    }
  for (const segment of context.drawn) {
    const [[ax, ay], [bx, by]] = segment;
    if (
      Math.max(ax, bx) < reach.minX ||
      Math.min(ax, bx) > reach.maxX ||
      Math.max(ay, by) < reach.minY ||
      Math.min(ay, by) > reach.maxY
    )
      continue;
    if (segmentHitsRect(segment, text)) return false;
    for (const line of print.measuring) {
      const at = crossing(line, segment) ?? touching(line, segment);
      if (
        at &&
        !print.feet.some(
          (foot) =>
            Math.hypot(foot[0] - at[0], foot[1] - at[1]) <= DRAWING_CLEAR_MM
        )
      )
        return false;
    }
  }
  return true;
}

/**
 * Whether a dimension line runs alongside a drawn line closer than
 * {@link HUG_MM}, where it would read as part of the outline.
 */
function huggingDrawing(print: Footprint, context: ViewContext): boolean {
  for (const line of print.measuring) {
    const [p, q] = line;
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (length < 1e-9) continue;
    const unit: XY = [(q[0] - p[0]) / length, (q[1] - p[1]) / length];
    for (const [r, t] of context.drawn) {
      const dx = t[0] - r[0];
      const dy = t[1] - r[1];
      const other = Math.hypot(dx, dy);
      if (other < 1e-9 || Math.abs(unit[0] * dy - unit[1] * dx) > 0.05 * other)
        continue;
      const off = Math.abs((r[0] - p[0]) * unit[1] - (r[1] - p[1]) * unit[0]);
      if (off >= HUG_MM) continue;
      const s0 = (r[0] - p[0]) * unit[0] + (r[1] - p[1]) * unit[1];
      const s1 = (t[0] - p[0]) * unit[0] + (t[1] - p[1]) * unit[1];
      if (
        Math.min(length, Math.max(s0, s1)) - Math.max(0, Math.min(s0, s1)) >
        0.5
      )
        return true;
    }
  }
  return false;
}

/** Within about 30° of each other. */
function nearlyParallel([p, q]: [XY, XY], [r, s]: [XY, XY]): boolean {
  const a: XY = [q[0] - p[0], q[1] - p[1]];
  const b: XY = [s[0] - r[0], s[1] - r[1]];
  const scale = Math.hypot(...a) * Math.hypot(...b);
  return scale > 1e-12 && Math.abs(a[0] * b[1] - a[1] * b[0]) <= 0.5 * scale;
}

function segmentDistance([p, q]: [XY, XY], [r, s]: [XY, XY]): number {
  if (crossing([p, q], [r, s])) return 0;
  return Math.min(
    distanceToSegment(p, r, s),
    distanceToSegment(q, r, s),
    distanceToSegment(r, p, q),
    distanceToSegment(s, p, q)
  );
}

/** Distance from a segment to a rectangle (0 when it enters it). */
function rectDistance(line: [XY, XY], rect: Rect): number {
  if (segmentHitsRect(line, rect)) return 0;
  const corners: XY[] = [
    [rect.minX, rect.minY],
    [rect.maxX, rect.minY],
    [rect.maxX, rect.maxY],
    [rect.minX, rect.maxY]
  ];
  return Math.min(
    ...corners.map((corner, i) =>
      segmentDistance(line, [corner, corners[(i + 1) % 4]!])
    )
  );
}

/**
 * The open space round a dimension placed inside its view: the least
 * distance from its dimension line (away from its arrows) and its text to
 * a drawn line, and, apart, to another dimension's lines or text.
 */
function openness(
  print: Footprint,
  context: ViewContext,
  others: readonly Footprint[]
): { drawing: number; dimensions: number } {
  const text = rectOf(print.box);
  // Its dimension line short of the arrows, which sit on the features.
  const trimmed = [...print.measuring].flatMap(([p, q]): [XY, XY][] => {
    const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const cut = 1.5;
    if (length <= 2 * cut) return [];
    const u: XY = [(q[0] - p[0]) / length, (q[1] - p[1]) / length];
    return [
      [
        [p[0] + u[0] * cut, p[1] + u[1] * cut],
        [q[0] - u[0] * cut, q[1] - u[1] * cut]
      ]
    ];
  });
  let drawing = Infinity;
  for (const segment of context.drawn) {
    drawing = Math.min(drawing, rectDistance(segment, text));
    // Lines across it end it at its features; only those beside it crowd it.
    for (const line of trimmed)
      if (nearlyParallel(line, segment))
        drawing = Math.min(drawing, segmentDistance(line, segment));
    if (drawing <= 0) return { drawing: 0, dimensions: 0 };
  }
  let dimensions = Infinity;
  for (const other of others) {
    const box = rectOf(other.box);
    for (const line of trimmed)
      dimensions = Math.min(dimensions, rectDistance(line, box));
    for (const line of other.lines) {
      dimensions = Math.min(dimensions, rectDistance(line, text));
      if (other.measuring.has(line))
        for (const mine of trimmed)
          dimensions = Math.min(dimensions, segmentDistance(mine, line));
    }
  }
  return { drawing, dimensions };
}

/**
 * A footprint less the parts of its extension lines that lie along a line
 * the view draws (one run out along the face it measures): drawn over the
 * outline they add no mark of their own, so they block nothing the outline
 * itself would not.
 */
export function withoutCoincidentExtensions(
  print: Footprint,
  drawn: readonly [XY, XY][]
): Footprint {
  let changed = false;
  const lines: [XY, XY][] = [];
  for (const line of print.lines) {
    if (print.measuring.has(line)) {
      lines.push(line);
      continue;
    }
    const pieces = uncovered(line, drawn);
    if (pieces.length !== 1 || pieces[0] !== line) changed = true;
    lines.push(...pieces);
  }
  return changed ? { ...print, lines } : print;
}

/** The parts of `line` no drawn segment runs along (within 0.2 mm). */
function uncovered(line: [XY, XY], drawn: readonly [XY, XY][]): [XY, XY][] {
  const [p, q] = line;
  const length = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (length < 1e-9) return [line];
  const unit: XY = [(q[0] - p[0]) / length, (q[1] - p[1]) / length];
  const covered: [number, number][] = [];
  for (const [r, t] of drawn) {
    const off = (point: XY) =>
      Math.abs((point[0] - p[0]) * unit[1] - (point[1] - p[1]) * unit[0]);
    if (off(r) > 0.2 || off(t) > 0.2) continue;
    const along = (point: XY) =>
      (point[0] - p[0]) * unit[0] + (point[1] - p[1]) * unit[1];
    const lo = Math.max(0, Math.min(along(r), along(t)));
    const hi = Math.min(length, Math.max(along(r), along(t)));
    if (hi - lo > 1e-6) covered.push([lo, hi]);
  }
  if (covered.length === 0) return [line];
  covered.sort((x, y) => x[0] - y[0]);
  const at = (d: number): XY => [p[0] + unit[0] * d, p[1] + unit[1] * d];
  const out: [XY, XY][] = [];
  let from = 0;
  for (const [lo, hi] of covered) {
    if (lo - from > 0.5) out.push([at(from), at(lo)]);
    from = Math.max(from, hi);
  }
  if (length - from > 0.5) out.push([at(from), at(length)]);
  return out;
}

/** Where `line` ends on `segment` (a crossing `crossing` leaves out), or null. */
function touching(line: [XY, XY], segment: [XY, XY]): XY | null {
  for (const end of line)
    if (distanceToSegment(end, segment[0], segment[1]) <= 1e-6) return end;
  return null;
}

/**
 * The editor's view name under each outside view (left aligned, below its
 * outline), at the size it shows at 100 %: never on the sheet's exports,
 * but a dimension over it reads badly while editing.
 */
const VIEW_LABEL_GAP_MM = 3;
const VIEW_LABEL_SIZE_MM = 4;
function viewLabelRect(view: DrawingView, box: AnnotationBox): Rect | null {
  if (view.section) return null;
  const name = DRAWING_VIEW_LABELS[view.orientation];
  return {
    minX: box.x - 0.5,
    maxX: box.x + 0.62 * VIEW_LABEL_SIZE_MM * name.length + 0.5,
    minY: box.y - VIEW_LABEL_GAP_MM - VIEW_LABEL_SIZE_MM - 1.2,
    maxY: box.y - VIEW_LABEL_GAP_MM + 0.5
  };
}

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
 * dimension line or leader running along another line, or a dimension line
 * or leader crossed anywhere but at a dimension's foot (where a shared
 * baseline extension line meets the dimensions stacked on it). Extension
 * lines crossing each other is no clash. Null when clear.
 */
export function footprintClash(
  a: Footprint,
  b: Footprint,
  /** Let a dimension line or leader cross an extension line, as a last resort. */
  crossExtensions = false
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
      const measures = a.measuring.has(la) || b.measuring.has(lb);
      if (measures && runAlong(la, lb)) return 'collinear';
      // Extension lines may cross each other, as on any drawing; a
      // dimension line or leader is never crossed.
      if (!measures) continue;
      if (crossExtensions && !(a.measuring.has(la) && b.measuring.has(lb)))
        continue;
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
  const labels = contexts.flatMap((context) => {
    const rect = viewLabelRect(context.view, context.box);
    return rect ? [rect] : [];
  });
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
    const print = annotationFootprint(
      layout,
      resolution.resolved,
      context?.toPage ?? null
    );
    taken.push(
      context ? withoutCoincidentExtensions(print, context.drawn) : print
    );
  }

  /** Whether a candidate fits: on the paper and clear of all else. */
  const fits = (
    print: Footprint,
    own: ViewContext,
    linear: boolean,
    air = true
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
    // Text only: the names are the editor's, and a line under one is fine.
    if (labels.some((label) => rectsOverlap(box, label))) return false;
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
    // Text keeps a little air from other text and dimension lines, not
    // merely off them (extension lines may pass close).
    const margin = rectOf(print.box, TEXT_AIR_MM);
    return taken.every(
      (other) =>
        footprintClash(print, other, !air) === null &&
        (!air ||
          (!rectsOverlap(margin, rectOf(other.box)) &&
            ![...other.measuring].some((line) =>
              segmentHitsRect(line, margin)
            )))
    );
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
    taken.push(withoutCoincidentExtensions(print, entry.context.drawn));
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
  /**
   * A linear dimension placed inside its view, as a draftsman dimensions a
   * hole or an inner face where it is: only a span that ends inside the
   * view along the axis it measures (an overall size stays outside), with
   * its dimension line through open space off every drawn line but at its
   * own arrows, and its text off the drawing. Line offsets nearest the
   * feature are tried first, the text mid-span and then past either end.
   */
  const placeInside = (
    entry: Planned,
    a: XY,
    b: XY,
    horizontal: boolean
  ): { annotation: DrawingAnnotation; print: Footprint } | null => {
    if (entry.context.view.section) return null;
    const box = entry.context.box;
    const along = horizontal ? 0 : 1;
    const across = horizontal ? 1 : 0;
    const lo = horizontal ? box.x : box.y;
    const hi = lo + (horizontal ? box.width : box.height);
    const interior = (p: XY) =>
      p[along] > lo + INSIDE_EDGE_MM && p[along] < hi - INSIDE_EDGE_MM;
    if (!interior(a) && !interior(b)) return null;
    const low = Math.min(a[along], b[along]);
    const high = Math.max(a[along], b[along]);
    // Too short to carry its text and arrows between features: outside.
    if (high - low < INSIDE_MIN_SPAN_MM) return null;
    const crossLo = horizontal ? box.y : box.x;
    const crossHi = crossLo + (horizontal ? box.height : box.width);
    const feature = interior(b) ? b : a;
    const texts = [
      (low + high) / 2,
      ...[4, 7].flatMap((gap) => [low - gap, high + gap])
    ];
    // Every offset across the view; the most open space wins, then the
    // nearest the feature, then text mid-span.
    let best: {
      annotation: DrawingAnnotation;
      print: Footprint;
      score: number;
    } | null = null;
    for (
      let at = crossLo + INSIDE_EDGE_MM;
      at < crossHi - INSIDE_EDGE_MM;
      at += INSIDE_PITCH_MM
    )
      texts.forEach((text, index) => {
        const page: XY = horizontal ? [text, at] : [at, text];
        const annotation = placedAt(entry, page);
        const laid = layoutOf(entry, annotation);
        if (!laid) return;
        if (
          // Inside means its text too: never hung out past the outline.
          !rectInside(rectOf(laid.print.box), rectOf(box)) ||
          !fits(laid.print, entry.context, false) ||
          !clearOfDrawing(laid.print, entry.context) ||
          huggingDrawing(laid.print, entry.context)
        )
          return;
        const { drawing, dimensions } = openness(
          laid.print,
          entry.context,
          taken
        );
        if (drawing < INSIDE_DRAWING_MM || dimensions < INSIDE_SPACING_MM)
          return;
        const room = Math.min(drawing, dimensions);
        const score =
          10 * Math.min(room, INSIDE_ROOM_MM) -
          Math.abs(at - feature[across]) / 4 -
          (index === 0 ? 0 : 6);
        if (!best || score > best.score)
          best = { annotation, print: laid.print, score };
      });
    if (best) {
      const { annotation, print } = best;
      return { annotation, print };
    }
    return null;
  };

  const placeLinears = () => {
    for (const { entry, a, b, horizontal } of linears) {
      const box = entry.context.box;
      const middle = horizontal
        ? (a[1] + b[1]) / 2 >= box.y + box.height / 2
        : (a[0] + b[0]) / 2 >= box.x + box.width / 2;
      // Beside the feature it locates, inside the view, when it ends on one;
      // then out past the outline, the side nearer the points it measures
      // first.
      let done = false;
      const inside = placeInside(entry, a, b, horizontal);
      if (inside) {
        accept(entry, inside.annotation, inside.print);
        done = true;
      }
      for (const far of done ? [] : [middle, !middle]) {
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
  };

  /**
   * A radius, diameter or chamfer's best placement: text out of its view on
   * a leader that clears everything (`clear`), else anywhere it fits. A
   * chamfer's leader starts at the middle of one of its drawn sides.
   */
  /**
   * An angle's arc, at the radius from its vertex that first fits clear of
   * the drawing (its text lies on the arc's middle), else the nearest that
   * fits at all.
   */
  const placeAngle = (
    entry: Planned,
    resolved: Extract<ResolvedAnnotation, { kind: 'angle' }>
  ): {
    annotation: DrawingAnnotation;
    print: Footprint;
    clear: boolean;
  } | null => {
    const vertex = entry.context.toPage(...resolved.vertex);
    // Within both edges first, so the arc ends on them and needs no
    // extension lines; then out past the shorter.
    const shortest = Math.min(
      ...resolved.rays.map(([, far]) => {
        const p = entry.context.toPage(...far);
        return Math.hypot(p[0] - vertex[0], p[1] - vertex[1]);
      })
    );
    const radii = [
      ...[0.5, 0.75].map((share) => share * shortest).filter((r) => r >= 6),
      ...ANGLE_RADII_MM
    ];
    let fallback: { annotation: DrawingAnnotation; print: Footprint } | null =
      null;
    for (const air of [true, false])
      for (const radius of radii) {
        const annotation = placedAt(entry, [vertex[0] + radius, vertex[1]]);
        const laid = layoutOf(entry, annotation);
        if (!laid || !fits(laid.print, entry.context, false, air)) continue;
        if (clearOfDrawing(laid.print, entry.context))
          return { annotation, print: laid.print, clear: true };
        fallback ??= { annotation, print: laid.print };
      }
    return fallback && { ...fallback, clear: false };
  };

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
    if (resolved.kind === 'angle') return placeAngle(entry, resolved);
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
    // With air round its text first; boxed in by dimensions, without it
    // and with its leader free to cross an extension line.
    for (const air of [true, false])
      for (const { c, r, aim } of origins) {
        const outward =
          Math.hypot(c[0] - centre[0], c[1] - centre[1]) > 1e-6
            ? [c[0] - centre[0], c[1] - centre[1]]
            : [1, 1];
        const directions: XY[] = Array.from({ length: 16 }, (_, index) => {
          const angle = Math.PI / 4 + (index * Math.PI) / 8;
          return [Math.cos(angle), Math.sin(angle)] as XY;
        }).sort(
          (u, v) =>
            v[0] * outward[0]! +
            v[1] * outward[1]! -
            (u[0] * outward[0]! + u[1] * outward[1]!)
        );
        if (aim) directions.unshift(aim);
        // Near the feature first, as a draftsman would: a short leader into
        // open space in or beside the view, its text off every drawn line.
        // Only then out past the view's outline, farther each step.
        const reaches = (u: XY) => [
          ...NEAR_REACH_MM.map((extra) => r + extra),
          ...[0, 8, 18, 30].map((extra) => exit(c, u) + LEADER_CLEAR_MM + extra)
        ];
        const steps = NEAR_REACH_MM.length + 4;
        for (let step = 0; step < steps; step += 1)
          for (const u of directions) {
            const reach = reaches(u)[step]!;
            if (reach < r + 3) continue;
            const near = step < NEAR_REACH_MM.length;
            if (!near && reach < r + NEAR_REACH_MM.at(-1)!) continue;
            const annotation = placedAt(entry, [
              c[0] + u[0] * reach,
              c[1] + u[1] * reach
            ]);
            const laid = layoutOf(entry, annotation);
            if (!laid || !fits(laid.print, entry.context, false, air)) continue;
            const inside = rectsOverlap(rectOf(laid.print.box), outline);
            if (!inside || clearOfDrawing(laid.print, entry.context))
              return { annotation, print: laid.print, clear: true };
            fallback ??= { annotation, print: laid.print };
          }
      }
    return fallback && { ...fallback, clear: false };
  };
  // Each radius, diameter, chamfer or angle: the first of its options that
  // takes a clear placement, or else the best one where it fits at all.
  const placeOthers = (angles: boolean) => {
    for (const entry of planned) {
      if (
        entry.annotation.kind === 'linear' ||
        (entry.annotation.kind === 'angle') !== angles
      )
        continue;
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
  };
  // Angles first: an arc has one vertex and few radii to try, where a span
  // has rows and open space to move into. Then spans, shortest first, then
  // leaders, which go wherever is left.
  placeOthers(true);
  placeLinears();
  placeOthers(false);
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

import {
  drawingSpecEdgeRefs,
  isDrawingOperation,
  type CadDigestDrawing,
  type CadDigestDrawingEdge,
  type CadDigestDrawingView,
  type CadPatchProposal
} from '@openzcad/ai-contracts';
import {
  DRAWING_VIEW_FRAMES,
  drawingAnnotationEdges,
  drawingPaperMm,
  drawingPaperPerModelUnit,
  formatDrawingScale,
  projectToView,
  type BodyId,
  type DrawingAnnotationId,
  type DrawingEdgeRef,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingView,
  type EdgeTopology,
  type UnitSystem
} from '@openzcad/shared';
import { edgeRefFor } from './annotationPicking';
import {
  edgeEndsInPageOrder,
  resolveSheetAnnotations,
  type AnnotationBodies,
  type AnnotationResolution
} from './annotations';
import type { ComposedView } from './sheetPage';

/**
 * D06 slice E: what the assistant is told about the Draw sheet the user is
 * on, and the check its proposal must pass before it is shown.
 *
 * Every edge a drawn view can measure is listed under a short ref
 * ("v1:e4"): views in sheet order, then each view's bodies in order, then
 * the body's edges in topology order, smooth seams and edges whose
 * identity two edges share left out. The same model gives the same refs,
 * so a follow-up turn names what the last one did. Coordinates are paper
 * millimetres from the view's centre, which is where a placement is
 * measured from too.
 */

/** The Draw sheet on screen, as the workspace hands it to the assistant. */
export interface DrawingAssistantSource {
  sheetId: DrawingSheetId;
  /** Every view drawn from the model the sheet is fenced to. */
  ready: boolean;
  /** The bodies the drawing on screen measures. */
  bodies: AnnotationBodies;
  units: UnitSystem;
  /** Built on first read: listing every edge is not free. */
  digest: () => CadDigestDrawing;
}

/** Per view: a box's front view lists 12, a turned part a few dozen. */
const MAX_EDGES_PER_VIEW = 160;
const MAX_EDGES_PER_SHEET = 480;

type XY = [number, number];

const roundMm = (value: number) => Math.round(value * 100) / 100;
const roundModel = (value: number) => Number(value.toFixed(4));

function curveOf(edge: EdgeTopology, closed: boolean) {
  const type = edge.curve?.type;
  if (type === 'LINE') return 'line' as const;
  if (edge.curve?.circle) return closed ? ('circle' as const) : ('arc' as const);
  return 'other' as const;
}

function faceOn(view: DrawingView, edge: EdgeTopology): boolean {
  const circle = edge.curve?.circle;
  if (!circle) return false;
  const d = DRAWING_VIEW_FRAMES[view.orientation].direction;
  return (
    Math.abs(
      Math.abs(circle.axis.x * d.x + circle.axis.y * d.y + circle.axis.z * d.z) -
        1
    ) <= 1e-6
  );
}

export function edgeDigestRef(viewIndex: number, edgeIndex: number): string {
  return `v${viewIndex + 1}:e${edgeIndex + 1}`;
}

interface ListedEdge {
  ref: string;
  bodyId: BodyId;
  edge: EdgeTopology;
}

/** Each drawn view's listed edges, by view id. */
function listedEdges(
  views: readonly ComposedView[],
  sheet: DrawingSheet,
  bodies: AnnotationBodies
): Map<string, { edges: ListedEdge[]; complete: boolean }> {
  const out = new Map<string, { edges: ListedEdge[]; complete: boolean }>();
  let budget = MAX_EDGES_PER_SHEET;
  for (const { view } of views) {
    const viewIndex = sheet.views.findIndex(
      (entry) => entry.viewId === view.viewId
    );
    const edges: ListedEdge[] = [];
    let complete = true;
    for (const bodyId of view.bodyIds) {
      const body = bodies[bodyId];
      if (!body?.topology || body.consumed) continue;
      for (const edge of body.topology.edges) {
        if (edge.displayRole === 'seam' || edge.points.length < 6) continue;
        // Only an edge a stored reference resolves back to, as a pick is.
        if (edgeRefFor(bodies, bodyId, edge) === null) continue;
        if (edges.length >= MAX_EDGES_PER_VIEW || budget <= 0) {
          complete = false;
          break;
        }
        budget -= 1;
        edges.push({
          ref: edgeDigestRef(viewIndex, edges.length),
          bodyId,
          edge
        });
      }
    }
    out.set(view.viewId, { edges, complete });
  }
  return out;
}

/**
 * The sheet as the assistant reads it. `views` are its drawn views; a
 * sheet not drawn from the current model is listed without edges and with
 * `ready: false`, and nothing may be added to it.
 */
export function drawingAssistantDigest(input: {
  sheet: DrawingSheet;
  views: readonly ComposedView[];
  bodies: AnnotationBodies;
  units: UnitSystem;
  ready: boolean;
  resolutions?: ReadonlyMap<DrawingAnnotationId, AnnotationResolution>;
}): CadDigestDrawing {
  const { sheet, bodies, units, ready } = input;
  const k = drawingPaperPerModelUnit(sheet.scale, units);
  const drawn = ready ? input.views : [];
  const listed = listedEdges(drawn, sheet, bodies);
  const views: CadDigestDrawingView[] = sheet.views.map((view) => {
    const composed = drawn.find((entry) => entry.view.viewId === view.viewId);
    const bounds = composed?.projection.bounds ?? null;
    const cu = bounds ? (bounds.minU + bounds.maxU) / 2 : 0;
    const cv = bounds ? (bounds.minV + bounds.maxV) / 2 : 0;
    const page = (u: number, v: number): XY => [
      roundMm((u - cu) * k),
      roundMm((v - cv) * k)
    ];
    const entry = listed.get(view.viewId);
    const edges: CadDigestDrawingEdge[] = (entry?.edges ?? []).map(
      ({ ref, bodyId, edge }) => {
        const ends = edgeEndsInPageOrder(view, edge);
        const circle = edge.curve?.circle;
        const center = circle
          ? projectToView(DRAWING_VIEW_FRAMES[view.orientation], circle.center)
          : null;
        return {
          ref,
          bodyId,
          hash: edge.hash,
          curve: curveOf(edge, ends === null),
          length: roundModel(edge.length ?? 0),
          ...(ends ? { ends: [page(...ends[0]), page(...ends[1])] } : {}),
          ...(circle && center
            ? {
                center: page(center.u, center.v),
                radius: roundModel(circle.radius),
                faceOn: faceOn(view, edge)
              }
            : {})
        };
      }
    );
    return {
      viewId: view.viewId,
      orientation: view.orientation,
      parentViewId: view.parentViewId ?? null,
      centerMm: { x: roundMm(view.centerMm.x), y: roundMm(view.centerMm.y) },
      widthMm: bounds ? roundMm((bounds.maxU - bounds.minU) * k) : 0,
      heightMm: bounds ? roundMm((bounds.maxV - bounds.minV) * k) : 0,
      bodyIds: [...view.bodyIds],
      edgeInventoryComplete: ready && entry !== undefined && entry.complete,
      edges
    };
  });
  const refOf = new Map<string, string>();
  for (const [viewId, entry] of listed)
    for (const { ref, bodyId, edge } of entry.edges)
      refOf.set(`${viewId}|${bodyId}|${edge.hash}`, ref);
  const resolutions =
    input.resolutions ??
    (ready
      ? resolveSheetAnnotations(sheet, bodies, units)
      : new Map<DrawingAnnotationId, AnnotationResolution>());
  return {
    sheetId: sheet.sheetId,
    name: sheet.name,
    units,
    scale: formatDrawingScale(sheet.scale),
    paperMm: drawingPaperMm(sheet.paper),
    ready,
    views,
    annotations: (sheet.annotations ?? []).map((annotation) => {
      const resolution = resolutions.get(annotation.annotationId);
      const viewId = annotation.viewId ?? null;
      return {
        annotationId: annotation.annotationId,
        kind: annotation.kind,
        viewId,
        edgeRefs: drawingAnnotationEdges(annotation).flatMap((edge) => {
          const ref = refOf.get(`${viewId}|${edge.bodyId}|${edge.hash}`);
          return ref ? [ref] : [];
        }),
        value:
          resolution?.ok && 'value' in resolution.resolved
            ? roundModel(resolution.resolved.value)
            : null,
        label: resolution?.ok ? resolution.resolved.label : null,
        broken: resolution
          ? resolution.ok
            ? null
            : resolution.message
          : ready
            ? null
            : 'The sheet is not drawn from the current model.'
      };
    })
  };
}

/**
 * The proposal with each grounded edge given the stored reference a pick of
 * it would get (its lineage, when the kernel proved one). An edge that no
 * longer resolves to exactly one edge of the model is refused.
 */
export function groundDrawingProposal(
  proposal: CadPatchProposal,
  bodies: AnnotationBodies
): CadPatchProposal {
  return {
    ...proposal,
    operations: proposal.operations.map((operation) => {
      if (operation.kind !== 'add_drawing_annotations') return operation;
      const edges: Record<string, DrawingEdgeRef> = {};
      for (const spec of operation.annotations)
        for (const ref of drawingSpecEdgeRefs(spec)) {
          const stated = operation.edges?.[ref];
          const body = stated ? bodies[stated.bodyId] : undefined;
          const edge = body?.topology?.edges.find(
            (entry) => entry.hash === stated!.hash
          );
          const grounded =
            stated && edge ? edgeRefFor(bodies, stated.bodyId, edge) : null;
          if (!grounded)
            throw new Error(
              `Edge ${ref} is no longer one edge of the drawn model. Ask again.`
            );
          edges[ref] = grounded;
        }
      return { ...operation, edges };
    })
  };
}

/** Whether a proposal edits a drawing sheet rather than the model. */
export function isDrawingProposal(proposal: CadPatchProposal): boolean {
  return (
    proposal.operations.length > 0 &&
    proposal.operations.every(isDrawingOperation)
  );
}

/**
 * Why the proposed sheet cannot be shown, or an empty list: every
 * annotation the proposal adds must resolve against the drawn model.
 */
export function drawingProposalProblems(input: {
  before: DrawingSheet;
  after: DrawingSheet;
  bodies: AnnotationBodies;
  units: UnitSystem;
}): string[] {
  const existing = new Set(
    (input.before.annotations ?? []).map((entry) => entry.annotationId)
  );
  const resolutions = resolveSheetAnnotations(
    input.after,
    input.bodies,
    input.units
  );
  const problems: string[] = [];
  (input.after.annotations ?? [])
    .filter((annotation) => !existing.has(annotation.annotationId))
    .forEach((annotation, index) => {
      const resolution = resolutions.get(annotation.annotationId);
      if (resolution && !resolution.ok)
        problems.push(
          `Proposed annotation ${index + 1} (${annotation.kind}): ${resolution.message}`
        );
    });
  return problems;
}

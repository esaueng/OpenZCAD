import type { BodyId, Brand, EdgeTopologyReferenceV5 } from './index';
import type { DrawingViewId } from './drawings';

/**
 * D02 drawing annotations (schema v31): dimensions and notes placed on a
 * sheet. Like the sheet itself they store intent only — which model edges a
 * dimension measures and where its text sits — never a value. Every value
 * is read from the current model each time the sheet is drawn, and only
 * when the sheet's fence says the model is the one it was last drawn from,
 * so a dimension follows the same explicit Update as the views.
 *
 * An edge is held the way a stored measurement holds one: its ADR-013
 * lineage name first, then its ADR-011 hash. A reference that no longer
 * resolves to exactly one edge leaves the annotation where it is, marked
 * broken, until someone re-picks or deletes it; nothing ever rebinds to a
 * nearby edge.
 */

export type DrawingAnnotationId = Brand<string, 'DrawingAnnotationId'>;

export const DRAWING_ANNOTATION_ID_PREFIX = 'dann_';

export function createDrawingAnnotationId(): DrawingAnnotationId {
  return `${DRAWING_ANNOTATION_ID_PREFIX}${crypto.randomUUID()}` as DrawingAnnotationId;
}

/** One model edge, resolved by lineage, then by hash. */
export interface DrawingEdgeRef {
  bodyId: BodyId;
  /** ADR-011 fingerprint when the edge was picked. */
  hash: number;
  /** ADR-013 persistent reference, when the kernel proved one. */
  reference?: EdgeTopologyReferenceV5;
}

/**
 * A point on an edge. `first` and `second` are an open edge's two ends in
 * the view's page order — the end further left, or lower when the two are
 * level, is `first` — so the choice does not depend on which way the kernel
 * happens to run the edge. `center` is a circular edge's centre.
 */
export type DrawingPointAnchor = 'first' | 'second' | 'center';

export interface DrawingPointRef {
  edge: DrawingEdgeRef;
  anchor: DrawingPointAnchor;
}

/**
 * Which way a two-point dimension measures in its view: along the page
 * (`horizontal`), up it (`vertical`), or along the line through both points
 * (`aligned`).
 */
export type DrawingLinearDirection = 'horizontal' | 'vertical' | 'aligned';

interface DrawingAnnotationBase {
  annotationId: DrawingAnnotationId;
  /**
   * Where the annotation's text sits, in paper millimetres (y up): relative
   * to its view's centre when it belongs to a view, so moving the view
   * carries it along, and from the paper's corner when it does not.
   */
  placementMm: { x: number; y: number };
}

interface DrawingDimensionBase extends DrawingAnnotationBase {
  viewId: DrawingViewId;
  /** Decimal places shown, trailing zeros trimmed; absent uses the units' default. */
  decimals?: number;
}

export interface DrawingLinearDimension extends DrawingDimensionBase {
  kind: 'linear';
  direction: DrawingLinearDirection;
  from: DrawingPointRef;
  to: DrawingPointRef;
}

export interface DrawingRadialDimension extends DrawingDimensionBase {
  kind: 'radius' | 'diameter';
  /** A circular edge seen face-on in the view. */
  edge: DrawingEdgeRef;
}

export interface DrawingAngleDimension extends DrawingDimensionBase {
  kind: 'angle';
  /** Two straight edges; the angle is the one between their far ends. */
  edges: [DrawingEdgeRef, DrawingEdgeRef];
}

export interface DrawingNote extends DrawingAnnotationBase {
  kind: 'note';
  text: string;
  /** The view the note belongs to; absent for a note placed on the paper. */
  viewId?: DrawingViewId;
  /** An edge of that view the note's leader arrow points at. */
  leader?: DrawingEdgeRef;
}

export type DrawingDimension =
  DrawingLinearDimension | DrawingRadialDimension | DrawingAngleDimension;

export type DrawingAnnotation = DrawingDimension | DrawingNote;

export type DrawingAnnotationKind = DrawingAnnotation['kind'];

export const MAX_DRAWING_ANNOTATIONS = 500;
export const MAX_DRAWING_NOTE_LENGTH = 200;
export const MAX_DRAWING_DIMENSION_DECIMALS = 6;
/** Placement bound, in paper millimetres. */
const MAX_PLACEMENT_MM = 10_000;
/** A stored edge reference's witness is small; this bounds a hostile one. */
const MAX_REFERENCE_JSON_LENGTH = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isShortText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function edgeReferenceError(value: unknown): string | null {
  if (!isRecord(value) || value.kind !== 'edge')
    return 'is not an edge reference';
  if (
    !isShortText(value.producingFeatureId, 128) ||
    !isShortText(value.lineageName, 256) ||
    typeof value.currentHash !== 'number' ||
    !Number.isFinite(value.currentHash) ||
    value.witnessVersion !== 1 ||
    !isRecord(value.witness)
  )
    return 'has a malformed edge reference';
  if (JSON.stringify(value).length > MAX_REFERENCE_JSON_LENGTH)
    return 'has an oversized edge reference';
  return null;
}

function edgeRefError(value: unknown): string | null {
  if (!isRecord(value)) return 'names no edge';
  if (!isShortText(value.bodyId, 128)) return 'names no body';
  if (typeof value.hash !== 'number' || !Number.isFinite(value.hash))
    return 'has an invalid edge hash';
  if (value.reference !== undefined) return edgeReferenceError(value.reference);
  return null;
}

function pointRefError(value: unknown): string | null {
  if (!isRecord(value)) return 'names no point';
  if (
    value.anchor !== 'first' &&
    value.anchor !== 'second' &&
    value.anchor !== 'center'
  )
    return 'has an unknown point anchor';
  return edgeRefError(value.edge);
}

/**
 * Why `value` is not a valid annotation of a sheet whose views are
 * `viewIds`, or null. Shape only: the edges may be gone from the model.
 */
export function drawingAnnotationError(
  value: unknown,
  viewIds: ReadonlySet<string>,
  where: string
): string | null {
  if (!isRecord(value)) return `${where} is not an annotation record.`;
  if (
    typeof value.annotationId !== 'string' ||
    !value.annotationId.startsWith(DRAWING_ANNOTATION_ID_PREFIX) ||
    value.annotationId.length > 64
  )
    return `${where} has an invalid id.`;
  const placement = value.placementMm;
  if (
    !isRecord(placement) ||
    ![placement.x, placement.y].every(
      (coordinate) =>
        typeof coordinate === 'number' &&
        Number.isFinite(coordinate) &&
        Math.abs(coordinate) <= MAX_PLACEMENT_MM
    )
  )
    return `${where} has an invalid placement.`;
  if (value.viewId !== undefined && !viewIds.has(value.viewId as string))
    return `${where} belongs to a view that is not on its sheet.`;
  const fail = (error: string | null) =>
    error === null ? null : `${where} ${error}.`;
  if (value.kind === 'note') {
    if (
      typeof value.text !== 'string' ||
      value.text.trim().length === 0 ||
      value.text.length > MAX_DRAWING_NOTE_LENGTH
    )
      return `${where} needs text of at most ${MAX_DRAWING_NOTE_LENGTH} characters.`;
    if (value.leader !== undefined) {
      if (value.viewId === undefined)
        return `${where} has a leader but belongs to no view.`;
      return fail(edgeRefError(value.leader));
    }
    return null;
  }
  if (value.viewId === undefined)
    return `${where} is a dimension that belongs to no view.`;
  if (
    value.decimals !== undefined &&
    !(
      Number.isSafeInteger(value.decimals) &&
      (value.decimals as number) >= 0 &&
      (value.decimals as number) <= MAX_DRAWING_DIMENSION_DECIMALS
    )
  )
    return `${where} shows from 0 to ${MAX_DRAWING_DIMENSION_DECIMALS} decimals.`;
  switch (value.kind) {
    case 'linear':
      if (
        value.direction !== 'horizontal' &&
        value.direction !== 'vertical' &&
        value.direction !== 'aligned'
      )
        return `${where} has an unknown direction.`;
      return fail(pointRefError(value.from) ?? pointRefError(value.to));
    case 'radius':
    case 'diameter':
      return fail(edgeRefError(value.edge));
    case 'angle':
      if (!Array.isArray(value.edges) || value.edges.length !== 2)
        return `${where} must name two edges.`;
      return fail(edgeRefError(value.edges[0]) ?? edgeRefError(value.edges[1]));
    default:
      return `${where} has an unknown kind.`;
  }
}

/** Every edge an annotation refers to. */
export function drawingAnnotationEdges(
  annotation: DrawingAnnotation
): DrawingEdgeRef[] {
  switch (annotation.kind) {
    case 'linear':
      return [annotation.from.edge, annotation.to.edge];
    case 'radius':
    case 'diameter':
      return [annotation.edge];
    case 'angle':
      return [...annotation.edges];
    case 'note':
      return annotation.leader ? [annotation.leader] : [];
  }
}

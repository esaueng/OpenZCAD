import type {
  BodyId,
  Brand,
  EdgeTopologyReferenceV5,
  FaceTopologyReferenceV5
} from './index';
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
 *
 * D06 slice B (schema v48) adds what a turned or chamfered part needs and
 * D02 could not say: a circular edge's silhouette extreme and two faces'
 * virtual sharp as dimension points, a chamfer dimension (`size × angle`),
 * a count (`4×`) on radial and chamfer dimensions, a Ø prefix on a linear
 * span, reference dimensions shown in brackets, and provenance for an
 * annotation the auto-dimensioner placed. All are additive and absent on
 * every older annotation; faces are held like edges, by lineage then hash.
 *
 * D06 slice D (schema v49) adds what a history-less turned import needs:
 * the corner a step chamfer cuts, sized like a sibling chamfer, as a
 * dimension point; a radius on a revolved blend's face seen side-on; and
 * provenance marking a dimension placed from raw geometry rather than a
 * recognized feature.
 *
 * Schema v50 adds a counterbored hole's callout: a diameter that also names
 * the counterbore's rim, read as one "Ø THRU, CBORE Ø × depth DEEP" note.
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

/** One model face, resolved by lineage, then by hash (schema v48). */
export interface DrawingFaceRef {
  bodyId: BodyId;
  /** ADR-011 fingerprint when the face was picked. */
  hash: number;
  /** ADR-013 persistent reference, when the kernel proved one. */
  reference?: FaceTopologyReferenceV5;
}

/**
 * A point on an edge. `first` and `second` are an open edge's two ends in
 * the view's page order — the end further left, or lower when the two are
 * level, is `first` — so the choice does not depend on which way the kernel
 * happens to run the edge. `center` is a circular edge's centre.
 */
export type DrawingPointAnchor = 'first' | 'second' | 'center';

/**
 * Which extreme of a curve a horizontal or vertical dimension measures to:
 * the one lower along its measuring direction on the page (further left, or
 * further down) or the higher one.
 */
export type DrawingExtremeSide = 'low' | 'high';

/** A D02 point: an open edge's end, or a circle's centre. */
export interface DrawingEdgePointRef {
  edge: DrawingEdgeRef;
  anchor: DrawingPointAnchor;
}

/**
 * v48: a circular edge's extreme along the dimension's measuring direction.
 * A turned part's rims are closed circles with no ends, and seen side-on
 * they draw as lines whose ends are the part's silhouette: this is how its
 * height and its side-view diameter are dimensioned.
 */
export interface DrawingSilhouettePointRef {
  edge: DrawingEdgeRef;
  anchor: 'silhouette';
  side: DrawingExtremeSide;
}

/**
 * v48: where two faces' underlying surfaces meet, though the part rounds or
 * chamfers that corner away — a chamfer's virtual sharp with the body. Two
 * coaxial surfaces of revolution, or one and a plane square to their axis,
 * meet in a circle, measured at its extreme on `side`; two planes meet in a
 * line, which the view must see end-on as a point.
 */
export interface DrawingVirtualSharpRef {
  faces: [DrawingFaceRef, DrawingFaceRef];
  anchor: 'virtual-sharp';
  side: DrawingExtremeSide;
}

/**
 * v49: the sharp corner a chamfer between two diameters cuts away, when it
 * is the same chamfer as `like` (one of equal angle on the same diameter,
 * cut at an end face): from its virtual sharp with the larger diameter,
 * `like`'s size along the axis, away from that diameter. A shoulder
 * chamfer running into a neck has no end face of its own, so this is where
 * the body it was cut from ended — the foot's 29 to the shoulder. Measured
 * at the larger diameter's extreme on `side`, like a rim.
 */
export interface DrawingChamferCornerRef {
  face: DrawingFaceRef;
  like: DrawingFaceRef;
  anchor: 'chamfer-corner';
  side: DrawingExtremeSide;
}

export type DrawingPointRef =
  | DrawingEdgePointRef
  | DrawingSilhouettePointRef
  | DrawingVirtualSharpRef
  | DrawingChamferCornerRef;

/**
 * Which way a two-point dimension measures in its view: along the page
 * (`horizontal`), up it (`vertical`), or along the line through both points
 * (`aligned`).
 */
export type DrawingLinearDirection = 'horizontal' | 'vertical' | 'aligned';

/**
 * v48: an annotation the auto-dimensioner placed, and the requirement it
 * states, so a rerun replaces its own and leaves a person's alone. Absent
 * means a person placed it.
 */
export interface DrawingAnnotationProvenance {
  generated: true;
  /** The checker's key for the requirement this states. */
  requirement: string;
  /**
   * v49: read from raw geometry, not a recognized feature — on an import
   * with no history, a face no feature explains. Absent means a feature.
   */
  basis?: 'geometry';
}

interface DrawingAnnotationBase {
  annotationId: DrawingAnnotationId;
  /**
   * Where the annotation's text sits, in paper millimetres (y up): relative
   * to its view's centre when it belongs to a view, so moving the view
   * carries it along, and from the paper's corner when it does not.
   */
  placementMm: { x: number; y: number };
  provenance?: DrawingAnnotationProvenance;
}

interface DrawingDimensionBase extends DrawingAnnotationBase {
  viewId: DrawingViewId;
  /** Decimal places shown, trailing zeros trimmed; absent uses the units' default. */
  decimals?: number;
  /**
   * v48: a reference dimension, shown in brackets: a value stated for
   * information although others already fix it. Absent is a dimension.
   */
  reference?: true;
}

export interface DrawingLinearDimension extends DrawingDimensionBase {
  kind: 'linear';
  direction: DrawingLinearDirection;
  from: DrawingPointRef;
  to: DrawingPointRef;
  /** v48: a span across a cylinder seen side-on, labelled Ø. */
  diameter?: true;
}

export interface DrawingRadialDimension extends DrawingDimensionBase {
  kind: 'radius' | 'diameter';
  /** A circular edge seen face-on in the view. */
  edge: DrawingEdgeRef;
  /** v48: how many like features this states, shown "4×". */
  count?: number;
  /**
   * v50: a counterbored hole's callout on a diameter. This is the
   * counterbore's rim, coaxial with `edge` and larger; the callout reads the
   * counterbore's Ø and depth, and the hole's depth or THRU, from the model
   * each time it is drawn ("2× Ø5 THRU, CBORE Ø8 × 1.5 DEEP").
   */
  counterbore?: DrawingEdgeRef;
}

/**
 * v49: a revolved blend's radius, read from its torus face seen side-on,
 * where it draws as two arcs of its tube; `side` picks the one at the
 * axis's extreme on that side across the page. No edge states it: the
 * blend's boundary circles are its tangent lines, not its radius.
 */
export interface DrawingBlendRadiusDimension extends DrawingDimensionBase {
  kind: 'radius';
  face: DrawingFaceRef;
  side: DrawingExtremeSide;
  count?: number;
}

/**
 * v48: a chamfer stated as `size × angle`. The face is a cone about the
 * part's axis or a plane, seen side-on or edge-on in the view. Its two ends
 * are its virtual sharps with the faces either side (through any blend), so
 * a blended chamfer reads the same as a sharp one: on a cone the size is
 * its length along the axis and the angle its half-angle; on a plane the
 * size is its leg along the neighbour it makes the smaller angle with, and
 * the angle is that one.
 */
export interface DrawingChamferDimension extends DrawingDimensionBase {
  kind: 'chamfer';
  face: DrawingFaceRef;
  count?: number;
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
  | DrawingLinearDimension
  | DrawingRadialDimension
  | DrawingBlendRadiusDimension
  | DrawingAngleDimension
  | DrawingChamferDimension;

export type DrawingAnnotation = DrawingDimension | DrawingNote;

export type DrawingAnnotationKind = DrawingAnnotation['kind'];

export const MAX_DRAWING_ANNOTATIONS = 500;
export const MAX_DRAWING_NOTE_LENGTH = 200;
export const MAX_DRAWING_DIMENSION_DECIMALS = 6;
/** A count is at least two like features; the bound keeps it a label. */
export const MAX_DRAWING_DIMENSION_COUNT = 999;
const MAX_REQUIREMENT_LENGTH = 200;
/** Placement bound, in paper millimetres. */
const MAX_PLACEMENT_MM = 10_000;
/** A stored edge reference's witness is small; this bounds a hostile one. */
/**
 * A stored edge reference's whole size, lineage name included. The kernel
 * names an edge that survives booleans by prefixing its source's name, so
 * names have no length of their own to bound; this budget does it once. A
 * reference over it is stored hash-only instead (see `drawingEdgeRefError`).
 */
const MAX_REFERENCE_JSON_LENGTH = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isShortText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/** ADR-011 fingerprints are positive safe integers. */
function isTopologyHash(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isQuantizedPoint(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((coordinate) => Number.isSafeInteger(coordinate))
  );
}

/** Lexicographic order of two quantized points. */
function comparePoints(left: number[], right: number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Whether `value` is a canonical `EdgeWitnessV1`: the shape and every rule
 * the kernel adapter's witness inspection calls invalid (a non-empty curve
 * type, a non-negative quantized length, quantized points, open endpoints
 * in lexicographic order, a non-zero sign-canonical closed axis). Its hash
 * is checked where the fingerprint lives, when the annotation resolves.
 */
function isEdgeWitness(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.curveType !== 'string' ||
    value.curveType.trim().length === 0 ||
    value.curveType.length > 64 ||
    !Number.isSafeInteger(value.length) ||
    (value.length as number) < 0
  )
    return false;
  if (value.closed === false)
    return (
      Array.isArray(value.endpoints) &&
      value.endpoints.length === 2 &&
      value.endpoints.every(isQuantizedPoint) &&
      isQuantizedPoint(value.midpoint) &&
      comparePoints(
        value.endpoints[0] as number[],
        value.endpoints[1] as number[]
      ) <= 0
    );
  if (value.closed === true) {
    if (!isQuantizedPoint(value.center)) return false;
    if (value.axis === null) return true;
    if (!isQuantizedPoint(value.axis)) return false;
    const first = (value.axis as number[]).find((component) => component !== 0);
    return first !== undefined && first > 0;
  }
  return false;
}

const CLOSURES: readonly unknown[] = ['open', 'closed', 'unknown'];

/**
 * Whether `value` is a well-formed `FaceWitnessV1`: a non-empty surface
 * type, a non-negative quantized perimeter, a quantized centroid or null,
 * one of the analytic carrier terms, and a closure per direction. Its hash
 * is checked when the annotation resolves, as an edge witness's is.
 */
function isFaceWitness(value: unknown): boolean {
  if (
    !isRecord(value) ||
    typeof value.surfaceType !== 'string' ||
    value.surfaceType.trim().length === 0 ||
    value.surfaceType.length > 64 ||
    !Number.isSafeInteger(value.perimeter) ||
    (value.perimeter as number) < 0 ||
    (value.centroid !== null && !isQuantizedPoint(value.centroid)) ||
    !isRecord(value.closure) ||
    !CLOSURES.includes(value.closure.u) ||
    !CLOSURES.includes(value.closure.v)
  )
    return false;
  const analytic = value.analytic;
  if (!isRecord(analytic)) return false;
  switch (analytic.kind) {
    case 'none':
      return true;
    case 'plane':
      return (
        isQuantizedPoint(analytic.normal) &&
        Number.isSafeInteger(analytic.offset)
      );
    case 'cylinder':
      return (
        isQuantizedPoint(analytic.axis) &&
        isQuantizedPoint(analytic.axisFoot) &&
        Number.isSafeInteger(analytic.radius) &&
        (analytic.radius as number) >= 0
      );
    default:
      return false;
  }
}

function topologyReferenceError(
  value: unknown,
  hash: number,
  kind: 'edge' | 'face'
): string | null {
  if (!isRecord(value) || value.kind !== kind)
    return `is not ${kind === 'edge' ? 'an edge' : 'a face'} reference`;
  if (
    !isShortText(value.producingFeatureId, 128) ||
    typeof value.lineageName !== 'string' ||
    value.lineageName.length === 0 ||
    !isTopologyHash(value.currentHash) ||
    value.witnessVersion !== 1 ||
    !(kind === 'edge' ? isEdgeWitness : isFaceWitness)(value.witness)
  )
    return `has a malformed ${kind} reference`;
  if (JSON.stringify(value).length > MAX_REFERENCE_JSON_LENGTH)
    return `has an oversized ${kind} reference`;
  // The reference names the edge the hash fingerprints; one that disagrees
  // would resolve by its lineage to some other edge.
  if (value.currentHash !== hash)
    return `has ${kind === 'edge' ? 'an edge' : 'a face'} reference that contradicts its hash`;
  return null;
}

/**
 * Why `ref` would be refused in a stored annotation, or null. A picker uses
 * it to keep a pick hash-only rather than write a reference the document
 * cannot hold.
 */
export function drawingEdgeRefError(ref: DrawingEdgeRef): string | null {
  return edgeRefError(ref);
}

/** {@link drawingEdgeRefError} for a picked face. */
export function drawingFaceRefError(ref: DrawingFaceRef): string | null {
  return topologyRefError(ref, 'face');
}

function edgeRefError(value: unknown): string | null {
  return topologyRefError(value, 'edge');
}

function topologyRefError(
  value: unknown,
  kind: 'edge' | 'face'
): string | null {
  if (!isRecord(value)) return `names no ${kind}`;
  if (!isShortText(value.bodyId, 128)) return 'names no body';
  if (!isTopologyHash(value.hash)) return `has an invalid ${kind} hash`;
  if (value.reference !== undefined)
    return topologyReferenceError(value.reference, value.hash, kind);
  return null;
}

function pointRefError(value: unknown): string | null {
  if (!isRecord(value)) return 'names no point';
  switch (value.anchor) {
    case 'first':
    case 'second':
    case 'center':
      if ('side' in value) return 'has a side on a point that takes none';
      return edgeRefError(value.edge);
    case 'silhouette':
      if (value.side !== 'low' && value.side !== 'high')
        return 'has an unknown extreme side';
      return edgeRefError(value.edge);
    case 'virtual-sharp': {
      if (value.side !== 'low' && value.side !== 'high')
        return 'has an unknown extreme side';
      const faces = value.faces;
      if (!Array.isArray(faces) || faces.length !== 2)
        return 'needs two faces for a virtual sharp';
      const error =
        topologyRefError(faces[0], 'face') ??
        topologyRefError(faces[1], 'face');
      if (error) return error;
      const [a, b] = faces as DrawingFaceRef[];
      if (a!.bodyId === b!.bodyId && a!.hash === b!.hash)
        return 'needs two different faces for a virtual sharp';
      return null;
    }
    case 'chamfer-corner': {
      if (value.side !== 'low' && value.side !== 'high')
        return 'has an unknown extreme side';
      const error =
        topologyRefError(value.face, 'face') ??
        topologyRefError(value.like, 'face');
      if (error) return error;
      const face = value.face as DrawingFaceRef;
      const like = value.like as DrawingFaceRef;
      if (face.bodyId !== like.bodyId)
        return 'sizes a chamfer corner like a chamfer on another body';
      if (face.hash === like.hash) return 'sizes a chamfer corner like itself';
      return null;
    }
    default:
      return 'has an unknown point anchor';
  }
}

/** Absent, or the literal `true`: a stored `false` would not be byte-stable. */
function isFlag(value: unknown): boolean {
  return value === undefined || value === true;
}

function countError(value: unknown, kind: unknown, where: string) {
  if (value === undefined) return null;
  if (kind !== 'radius' && kind !== 'diameter' && kind !== 'chamfer')
    return `${where} has a count, which only radius, diameter and chamfer dimensions take.`;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 2 ||
    (value as number) > MAX_DRAWING_DIMENSION_COUNT
  )
    return `${where} counts from 2 to ${MAX_DRAWING_DIMENSION_COUNT} features.`;
  return null;
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
  if (value.provenance !== undefined) {
    const provenance = value.provenance;
    if (
      !isRecord(provenance) ||
      provenance.generated !== true ||
      !isShortText(provenance.requirement, MAX_REQUIREMENT_LENGTH) ||
      (provenance.basis !== undefined && provenance.basis !== 'geometry') ||
      Object.keys(provenance).length !==
        (provenance.basis === undefined ? 2 : 3)
    )
      return `${where} has malformed provenance.`;
  }
  if (value.kind !== 'linear' && value.diameter !== undefined)
    return `${where} has a Ø prefix, which only a linear dimension takes.`;
  const counted = countError(value.count, value.kind, where);
  if (counted) return counted;
  if (value.kind === 'note') {
    if (value.reference !== undefined)
      return `${where} is a note, which cannot be a reference dimension.`;
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
  if (!isFlag(value.reference))
    return `${where} marks a reference dimension with anything but true.`;
  if (!isFlag(value.diameter))
    return `${where} marks a Ø prefix with anything but true.`;
  switch (value.kind) {
    case 'linear':
      if (
        value.direction !== 'horizontal' &&
        value.direction !== 'vertical' &&
        value.direction !== 'aligned'
      )
        return `${where} has an unknown direction.`;
      {
        const error = pointRefError(value.from) ?? pointRefError(value.to);
        if (error) return fail(error);
      }
      // An extreme is lowest or highest along a page direction; an aligned
      // span has none until both its points are known.
      if (
        value.direction === 'aligned' &&
        [value.from, value.to].some(
          (point) =>
            (point as DrawingPointRef).anchor === 'silhouette' ||
            (point as DrawingPointRef).anchor === 'virtual-sharp' ||
            (point as DrawingPointRef).anchor === 'chamfer-corner'
        )
      )
        return `${where} measures to an extreme, which only a horizontal or vertical dimension can.`;
      return null;
    case 'radius':
    case 'diameter':
      if (value.counterbore !== undefined) {
        if (value.kind !== 'diameter')
          return `${where} names a counterbore, which only a diameter callout states.`;
        if (value.face !== undefined || value.side !== undefined)
          return `${where} names a counterbore on a blend face.`;
        const error = edgeRefError(value.counterbore);
        if (error) return fail(error);
      }
      if (value.face !== undefined || value.side !== undefined) {
        if (value.kind !== 'radius')
          return `${where} is a diameter of a blend face, which only a radius states.`;
        if (value.edge !== undefined)
          return `${where} names both an edge and a blend face.`;
        if (value.side !== 'low' && value.side !== 'high')
          return `${where} has an unknown extreme side.`;
        return fail(topologyRefError(value.face, 'face'));
      }
      return fail(edgeRefError(value.edge));
    case 'angle':
      if (!Array.isArray(value.edges) || value.edges.length !== 2)
        return `${where} must name two edges.`;
      return fail(edgeRefError(value.edges[0]) ?? edgeRefError(value.edges[1]));
    case 'chamfer':
      return fail(topologyRefError(value.face, 'face'));
    default:
      return `${where} has an unknown kind.`;
  }
}

function pointReferences(
  point: DrawingPointRef
): (DrawingEdgeRef | DrawingFaceRef)[] {
  if ('faces' in point) return [...point.faces];
  if ('like' in point) return [point.face, point.like];
  return [point.edge];
}

/** Every edge an annotation refers to; faces (a virtual sharp's, a chamfer's, a blend's) are not. */
export function drawingAnnotationEdges(
  annotation: DrawingAnnotation
): DrawingEdgeRef[] {
  switch (annotation.kind) {
    case 'linear':
      return [annotation.from, annotation.to].flatMap((point) =>
        'edge' in point ? [point.edge] : []
      );
    case 'chamfer':
      return [];
    case 'radius':
    case 'diameter':
      return 'face' in annotation
        ? []
        : [
            annotation.edge,
            ...(annotation.counterbore ? [annotation.counterbore] : [])
          ];
    default:
      return drawingAnnotationReferences(annotation) as DrawingEdgeRef[];
  }
}

/** The body an annotation measures (its first reference's), if any. */
export function drawingAnnotationBodyId(
  annotation: DrawingAnnotation
): BodyId | null {
  return drawingAnnotationReferences(annotation)[0]?.bodyId ?? null;
}

/** Every edge and face an annotation refers to, each body-scoped. */
export function drawingAnnotationReferences(
  annotation: DrawingAnnotation
): (DrawingEdgeRef | DrawingFaceRef)[] {
  switch (annotation.kind) {
    case 'linear':
      return [
        ...pointReferences(annotation.from),
        ...pointReferences(annotation.to)
      ];
    case 'radius':
    case 'diameter':
      return 'face' in annotation
        ? [annotation.face]
        : [
            annotation.edge,
            ...(annotation.counterbore ? [annotation.counterbore] : [])
          ];
    case 'angle':
      return [...annotation.edges];
    case 'chamfer':
      return [annotation.face];
    case 'note':
      return annotation.leader ? [annotation.leader] : [];
  }
}

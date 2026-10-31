import {
  drawingEdgeRefError,
  MAX_DRAWING_DIMENSION_DECIMALS,
  MAX_DRAWING_NOTE_LENGTH,
  type DrawingEdgeRef,
  type DrawingLinearDirection,
  type DrawingPointAnchor,
  type DrawingViewOrientation
} from '@openzcad/shared';

/**
 * D06 slice E: the assistant proposes dimensions and notes on one drawing
 * sheet. It never names a model edge itself: every edge comes from the
 * sheet's digest (`CadDigestDrawing`), where the app lists what each drawn
 * view can measure under a short `ref` ("v1:e4"). Digest validation
 * replaces each ref with the edge it names, so a proposal can only ever
 * measure something the app offered.
 *
 * The assistant does not decide whether a set is complete or redundant:
 * the app's dimension check does, and a proposal is shown only once every
 * annotation resolves and that check passes. A deterministic generator
 * (D06 slice C) will hand the assistant candidates to choose from; until
 * it lands the assistant picks edges from the digest directly.
 */

export type CadDrawingAnnotationKind =
  'linear' | 'radius' | 'diameter' | 'angle' | 'note';

export interface CadDrawingPointSpec {
  /** A digest edge `ref` of the annotation's view. */
  edgeRef: string;
  anchor: DrawingPointAnchor;
}

/**
 * One annotation as the assistant authors it. Strict structured output
 * needs every field present, so the ones a kind does not use are null.
 */
export interface CadDrawingAnnotationSpec {
  annotationKind: CadDrawingAnnotationKind;
  /** The view it belongs to; null only for a note placed on the paper. */
  viewId: string | null;
  /** Linear only. */
  direction: DrawingLinearDirection | null;
  /** Linear only: the two measured points. */
  from: CadDrawingPointSpec | null;
  to: CadDrawingPointSpec | null;
  /**
   * Digest edge refs of the view: one circle for a radius or diameter, two
   * straight edges for an angle, at most one leader edge for a note, none
   * for a linear dimension.
   */
  edgeRefs: string[];
  /** Note only. */
  text: string | null;
  /** Where the text sits, paper mm (y up) from the view's centre. */
  placementMm: { x: number; y: number };
  /** Decimal places shown; null uses the units' default. */
  decimals: number | null;
}

export interface CadAddDrawingAnnotationsOperation {
  kind: 'add_drawing_annotations';
  sheetId: string;
  annotations: CadDrawingAnnotationSpec[];
  /**
   * Each edge ref the annotations use, as the model edge it names. Filled by
   * digest validation, never authored: the schema does not offer it.
   */
  edges?: Record<string, DrawingEdgeRef>;
}

export interface CadRemoveDrawingAnnotationsOperation {
  kind: 'remove_drawing_annotations';
  sheetId: string;
  annotationIds: string[];
}

export type CadDrawingOperation =
  CadAddDrawingAnnotationsOperation | CadRemoveDrawingAnnotationsOperation;

export const DRAWING_OPERATION_KINDS: ReadonlySet<string> = new Set([
  'add_drawing_annotations',
  'remove_drawing_annotations'
]);

export function isDrawingOperation(operation: {
  kind: string;
}): operation is CadDrawingOperation {
  return DRAWING_OPERATION_KINDS.has(operation.kind);
}

/** Bounds one proposal's annotations; a full sheet holds 500. */
export const MAX_PROPOSED_DRAWING_ANNOTATIONS = 80;

type XY = [number, number];

/** One model edge a drawn view can measure. */
export interface CadDigestDrawingEdge {
  /** Stable for this view and model: what a proposal names. */
  ref: string;
  bodyId: string;
  hash: number;
  curve: 'line' | 'circle' | 'arc' | 'other';
  /** Model units. */
  length: number;
  /**
   * An open edge's ends in the view's page order — `first` is the one
   * further left, or lower when level — in paper mm from the view centre.
   */
  ends?: [XY, XY];
  /** A circle or arc's centre on the paper, mm from the view centre. */
  center?: XY;
  /** A circle or arc's radius, model units. */
  radius?: number;
  /** True when the view sees the circle true shape, so it can be sized. */
  faceOn?: boolean;
}

export interface CadDigestDrawingView {
  viewId: string;
  orientation: DrawingViewOrientation;
  /** The base view this one is projected from, if any. */
  parentViewId: string | null;
  centerMm: { x: number; y: number };
  /** The view's drawn footprint, paper mm. */
  widthMm: number;
  heightMm: number;
  bodyIds: string[];
  /** False when `edges` hit the context budget: never read it as "all". */
  edgeInventoryComplete: boolean;
  edges: CadDigestDrawingEdge[];
}

export interface CadDigestDrawingAnnotation {
  annotationId: string;
  kind: CadDrawingAnnotationKind;
  viewId: string | null;
  /** The digest refs it measures, when its edges are in the view's list. */
  edgeRefs: string[];
  /** The value it shows now (model units or degrees), or null when broken. */
  value: number | null;
  label: string | null;
  /** Why it does not resolve, or null. */
  broken: string | null;
}

/** One finding of the app's dimension check. */
export interface CadDigestDrawingFinding {
  message: string;
  annotationId?: string;
}

export interface CadDigestDrawingAudit {
  missing: CadDigestDrawingFinding[];
  redundant: CadDigestDrawingFinding[];
  unmeasurable: CadDigestDrawingFinding[];
  stated: number;
  required: number;
}

/** The Draw sheet the user is on, when they are on one. */
export interface CadDigestDrawing {
  sheetId: string;
  name: string;
  units: string;
  scale: string;
  paperMm: { width: number; height: number };
  /**
   * True when the sheet is drawn from the current model. Annotations are
   * proposed only on a ready sheet: the edges below are what it measures.
   */
  ready: boolean;
  views: CadDigestDrawingView[];
  annotations: CadDigestDrawingAnnotation[];
  /** The app's dimension check of the sheet as it is, when it can read it. */
  audit?: CadDigestDrawingAudit;
}

const nullableString = {
  anyOf: [{ type: 'string' }, { type: 'null' }]
} as const;

const drawingPointSchema = {
  anyOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        edgeRef: {
          type: 'string',
          description: 'A `ref` from this view in digest.drawing.views[].edges.'
        },
        anchor: { type: 'string', enum: ['first', 'second', 'center'] }
      },
      required: ['edgeRef', 'anchor']
    },
    { type: 'null' }
  ]
} as const;

export const DRAWING_OPERATION_SCHEMAS = [
  {
    type: 'object',
    additionalProperties: false,
    description:
      'Add dimensions or notes to the Draw sheet in digest.drawing. Every edgeRef must be a `ref` listed for that view; never invent one. Fields a kind does not use are null.',
    properties: {
      kind: { type: 'string', const: 'add_drawing_annotations' },
      sheetId: { type: 'string' },
      annotations: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_PROPOSED_DRAWING_ANNOTATIONS,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            annotationKind: {
              type: 'string',
              enum: ['linear', 'radius', 'diameter', 'angle', 'note']
            },
            viewId: nullableString,
            direction: {
              anyOf: [
                { type: 'string', enum: ['horizontal', 'vertical', 'aligned'] },
                { type: 'null' }
              ]
            },
            from: drawingPointSchema,
            to: drawingPointSchema,
            edgeRefs: { type: 'array', maxItems: 2, items: { type: 'string' } },
            text: nullableString,
            placementMm: {
              type: 'object',
              additionalProperties: false,
              description:
                "Where the annotation's text sits, in paper mm (y up) from its view's centre; from the paper's corner for a note on no view. Keep it clear of the view's footprint.",
              properties: { x: { type: 'number' }, y: { type: 'number' } },
              required: ['x', 'y']
            },
            decimals: {
              anyOf: [
                {
                  type: 'integer',
                  minimum: 0,
                  maximum: MAX_DRAWING_DIMENSION_DECIMALS
                },
                { type: 'null' }
              ]
            }
          },
          required: [
            'annotationKind',
            'viewId',
            'direction',
            'from',
            'to',
            'edgeRefs',
            'text',
            'placementMm',
            'decimals'
          ]
        }
      }
    },
    required: ['kind', 'sheetId', 'annotations']
  },
  {
    type: 'object',
    additionalProperties: false,
    description:
      'Remove annotations from the Draw sheet in digest.drawing, by annotationId from digest.drawing.annotations.',
    properties: {
      kind: { type: 'string', const: 'remove_drawing_annotations' },
      sheetId: { type: 'string' },
      annotationIds: {
        type: 'array',
        minItems: 1,
        maxItems: 500,
        items: { type: 'string' }
      }
    },
    required: ['kind', 'sheetId', 'annotationIds']
  }
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRef(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function pointSpecError(value: unknown): boolean {
  return !(
    isRecord(value) &&
    isRef(value.edgeRef) &&
    (value.anchor === 'first' ||
      value.anchor === 'second' ||
      value.anchor === 'center')
  );
}

/** The edge refs a spec uses, in order. */
export function drawingSpecEdgeRefs(spec: CadDrawingAnnotationSpec): string[] {
  return spec.annotationKind === 'linear'
    ? [spec.from!.edgeRef, spec.to!.edgeRef]
    : [...spec.edgeRefs];
}

function specError(value: unknown, where: string): string | null {
  if (!isRecord(value)) return `${where} is not an object.`;
  const kind = value.annotationKind;
  if (
    kind !== 'linear' &&
    kind !== 'radius' &&
    kind !== 'diameter' &&
    kind !== 'angle' &&
    kind !== 'note'
  )
    return `${where} has an unknown annotationKind.`;
  if (value.viewId !== null && !isRef(value.viewId))
    return `${where} has an invalid viewId.`;
  if (kind !== 'note' && value.viewId === null)
    return `${where} is a dimension that names no view.`;
  if (!Array.isArray(value.edgeRefs) || !value.edgeRefs.every(isRef))
    return `${where} has invalid edgeRefs.`;
  const placement = value.placementMm;
  if (
    !isRecord(placement) ||
    ![placement.x, placement.y].every(
      (coordinate) =>
        typeof coordinate === 'number' && Number.isFinite(coordinate)
    )
  )
    return `${where} has an invalid placementMm.`;
  if (
    value.decimals !== null &&
    !(
      Number.isSafeInteger(value.decimals) &&
      (value.decimals as number) >= 0 &&
      (value.decimals as number) <= MAX_DRAWING_DIMENSION_DECIMALS
    )
  )
    return `${where} shows from 0 to ${MAX_DRAWING_DIMENSION_DECIMALS} decimals.`;
  const refs = value.edgeRefs.length;
  const linearFields =
    value.direction !== null || value.from !== null || value.to !== null;
  if (kind === 'linear') {
    if (
      value.direction !== 'horizontal' &&
      value.direction !== 'vertical' &&
      value.direction !== 'aligned'
    )
      return `${where} needs a direction.`;
    if (pointSpecError(value.from) || pointSpecError(value.to))
      return `${where} needs two points.`;
    if (refs !== 0) return `${where} names its edges in from and to.`;
  } else if (linearFields)
    return `${where} sets direction, from or to, which only a linear dimension uses.`;
  if ((kind === 'radius' || kind === 'diameter') && refs !== 1)
    return `${where} needs exactly one circular edge.`;
  if (kind === 'angle' && refs !== 2)
    return `${where} needs exactly two straight edges.`;
  if (kind === 'note') {
    if (
      typeof value.text !== 'string' ||
      value.text.trim().length === 0 ||
      value.text.length > MAX_DRAWING_NOTE_LENGTH
    )
      return `${where} needs text of at most ${MAX_DRAWING_NOTE_LENGTH} characters.`;
    if (refs > 1) return `${where} has at most one leader edge.`;
    if (refs === 1 && value.viewId === null)
      return `${where} has a leader but belongs to no view.`;
    if (value.decimals !== null) return `${where} is a note with decimals.`;
  } else if (value.text !== null)
    return `${where} sets text, which only a note uses.`;
  return null;
}

/** Shape-checks a drawing operation the way `parseCadPatchProposal` does. */
export function parseDrawingOperation(operation: Record<string, unknown>) {
  if (!isRef(operation.sheetId))
    throw new Error(`Invalid ${String(operation.kind)} operation.`);
  if (operation.kind === 'remove_drawing_annotations') {
    if (
      !Array.isArray(operation.annotationIds) ||
      operation.annotationIds.length === 0 ||
      operation.annotationIds.length > 500 ||
      !operation.annotationIds.every(isRef) ||
      new Set(operation.annotationIds).size !== operation.annotationIds.length
    )
      throw new Error('Invalid remove_drawing_annotations operation.');
    return;
  }
  const annotations = operation.annotations;
  if (
    !Array.isArray(annotations) ||
    annotations.length === 0 ||
    annotations.length > MAX_PROPOSED_DRAWING_ANNOTATIONS
  )
    throw new Error('Invalid add_drawing_annotations operation.');
  annotations.forEach((spec, index) => {
    const error = specError(spec, `Proposed annotation ${index + 1}`);
    if (error) throw new Error(error);
  });
  if (operation.edges !== undefined) {
    if (!isRecord(operation.edges))
      throw new Error('add_drawing_annotations has invalid edges.');
    for (const spec of annotations as CadDrawingAnnotationSpec[])
      for (const ref of drawingSpecEdgeRefs(spec)) {
        const edge = operation.edges[ref];
        if (!isRecord(edge) || drawingEdgeRefError(edge as never) !== null)
          throw new Error(
            `add_drawing_annotations does not ground edge ${ref}.`
          );
      }
  }
}

function digestEdge(
  view: CadDigestDrawingView,
  ref: string,
  where: string
): CadDigestDrawingEdge {
  const edge = view.edges.find((entry) => entry.ref === ref);
  if (!edge)
    throw new Error(
      `${where} names edge ${ref}, which view ${view.viewId} does not list. Use only refs from digest.drawing.`
    );
  return edge;
}

function isCircular(edge: CadDigestDrawingEdge) {
  return edge.curve === 'circle' || edge.curve === 'arc';
}

/**
 * Checks a drawing operation against the sheet the app supplied, and
 * returns it grounded: each edge ref replaced by the model edge it names.
 */
export function validateDrawingOperation(
  operation: CadDrawingOperation,
  drawing: CadDigestDrawing | undefined
): CadDrawingOperation {
  if (!drawing)
    throw new Error(
      'Drawing annotations can be proposed only from the Draw workspace, on a sheet.'
    );
  if (operation.sheetId !== drawing.sheetId)
    throw new Error(
      `Sheet ${operation.sheetId} is not the sheet in digest.drawing.`
    );
  if (operation.kind === 'remove_drawing_annotations') {
    const known = new Set(
      drawing.annotations.map((entry) => entry.annotationId)
    );
    const unknown = operation.annotationIds.find((id) => !known.has(id));
    if (unknown) throw new Error(`Annotation ${unknown} is not on the sheet.`);
    return operation;
  }
  if (!drawing.ready)
    throw new Error(
      'The sheet is not drawn from the current model. Update it before adding dimensions.'
    );
  const views = new Map(drawing.views.map((view) => [view.viewId, view]));
  const edges: Record<string, DrawingEdgeRef> = {};
  operation.annotations.forEach((spec, index) => {
    const where = `Proposed annotation ${index + 1}`;
    if (spec.viewId === null) return;
    const view = views.get(spec.viewId);
    if (!view)
      throw new Error(`${where} names view ${spec.viewId}, not on the sheet.`);
    const check = (
      ref: string,
      ok: (edge: CadDigestDrawingEdge) => boolean,
      need: string
    ) => {
      const edge = digestEdge(view, ref, where);
      if (!ok(edge)) throw new Error(`${where}: edge ${ref} ${need}.`);
      edges[ref] = { bodyId: edge.bodyId, hash: edge.hash } as DrawingEdgeRef;
    };
    switch (spec.annotationKind) {
      case 'linear':
        for (const point of [spec.from!, spec.to!])
          check(
            point.edgeRef,
            (edge) =>
              point.anchor === 'center'
                ? isCircular(edge) && edge.faceOn === true
                : edge.ends !== undefined,
            point.anchor === 'center'
              ? 'has no centre here: anchor "center" needs a circle or arc the view sees true shape'
              : 'is closed: anchor "first"/"second" needs an open edge'
          );
        break;
      case 'radius':
      case 'diameter':
        check(
          spec.edgeRefs[0]!,
          (edge) => isCircular(edge) && edge.faceOn === true,
          'is not a circle this view sees true shape'
        );
        break;
      case 'angle':
        for (const ref of spec.edgeRefs)
          check(ref, (edge) => edge.curve === 'line', 'is not straight');
        break;
      case 'note':
        for (const ref of spec.edgeRefs) check(ref, () => true, '');
        break;
    }
  });
  if (operation.edges) {
    // A proposal grounded earlier (the Worker's check, or a reload) must
    // still name the same edges; the app may have added their lineage.
    for (const [ref, edge] of Object.entries(edges)) {
      const stated = operation.edges[ref];
      if (!stated || stated.bodyId !== edge.bodyId || stated.hash !== edge.hash)
        throw new Error(
          `add_drawing_annotations grounds edge ${ref} differently from the digest.`
        );
    }
    return operation;
  }
  return { ...operation, edges };
}

export function describeDrawingOperation(operation: CadDrawingOperation) {
  if (operation.kind === 'remove_drawing_annotations') {
    const count = operation.annotationIds.length;
    return `Remove ${count} annotation${count === 1 ? '' : 's'} from the sheet`;
  }
  const dimensions = operation.annotations.filter(
    (spec) => spec.annotationKind !== 'note'
  ).length;
  const notes = operation.annotations.length - dimensions;
  const parts = [
    dimensions > 0
      ? `${dimensions} dimension${dimensions === 1 ? '' : 's'}`
      : null,
    notes > 0 ? `${notes} note${notes === 1 ? '' : 's'}` : null
  ].filter(Boolean);
  return `Add ${parts.join(' and ')} to the sheet`;
}

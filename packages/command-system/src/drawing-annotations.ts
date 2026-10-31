import {
  drawingSpecEdgeRefs,
  type CadDrawingAnnotationSpec,
  type CadDrawingOperation
} from '@openzcad/ai-contracts';
import { findDrawingSheet } from '@openzcad/document-core';
import {
  createDrawingAnnotationId,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingEdgeRef,
  type DrawingSheetId,
  type DrawingViewId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * D06 slice E: a proposal's sheet edits as the drawing-annotation commands a
 * person's picks make. Every edge must already be grounded by digest
 * validation (`operation.edges`); an ungrounded ref is refused rather than
 * looked up, since nothing here can see the drawing it came from.
 */
export function drawingAnnotationsForSpecs(
  specs: readonly CadDrawingAnnotationSpec[],
  edges: Readonly<Record<string, DrawingEdgeRef>> | undefined,
  newId: () => DrawingAnnotationId = createDrawingAnnotationId
): DrawingAnnotation[] {
  const edge = (ref: string): DrawingEdgeRef => {
    const grounded = edges?.[ref];
    if (!grounded)
      throw new Error(
        `Drawing edge ${ref} was not checked against the sheet; ask again from Draw.`
      );
    return structuredClone(grounded);
  };
  return specs.map((spec): DrawingAnnotation => {
    drawingSpecEdgeRefs(spec).forEach(edge);
    const base = {
      annotationId: newId(),
      placementMm: { x: spec.placementMm.x, y: spec.placementMm.y }
    };
    const decimals = spec.decimals === null ? {} : { decimals: spec.decimals };
    const viewId = spec.viewId as DrawingViewId;
    switch (spec.annotationKind) {
      case 'linear':
        return {
          ...base,
          ...decimals,
          kind: 'linear',
          viewId,
          direction: spec.direction!,
          from: { edge: edge(spec.from!.edgeRef), anchor: spec.from!.anchor },
          to: { edge: edge(spec.to!.edgeRef), anchor: spec.to!.anchor }
        };
      case 'radius':
      case 'diameter':
        return {
          ...base,
          ...decimals,
          kind: spec.annotationKind,
          viewId,
          edge: edge(spec.edgeRefs[0]!)
        };
      case 'angle':
        return {
          ...base,
          ...decimals,
          kind: 'angle',
          viewId,
          edges: [edge(spec.edgeRefs[0]!), edge(spec.edgeRefs[1]!)]
        };
      case 'note':
        return {
          ...base,
          kind: 'note',
          text: spec.text!,
          ...(spec.viewId === null ? {} : { viewId }),
          ...(spec.edgeRefs[0] ? { leader: edge(spec.edgeRefs[0]) } : {})
        };
    }
  });
}

export type DrawingCommandInput =
  | {
      kind: 'add';
      sheetId: DrawingSheetId;
      annotation: DrawingAnnotation;
    }
  | {
      kind: 'delete';
      sheetId: DrawingSheetId;
      annotationId: DrawingAnnotationId;
    };

/** The sheet edits of a drawing-only proposal, in order. */
export function drawingCommandInputs(
  document: ProjectDocument,
  operations: readonly CadDrawingOperation[],
  newId?: () => DrawingAnnotationId
): DrawingCommandInput[] {
  return operations.flatMap((operation): DrawingCommandInput[] => {
    const sheetId = operation.sheetId as DrawingSheetId;
    if (!findDrawingSheet(document, sheetId))
      throw new Error(`Drawing sheet ${operation.sheetId} not found.`);
    return operation.kind === 'remove_drawing_annotations'
      ? operation.annotationIds.map((annotationId) => ({
          kind: 'delete' as const,
          sheetId,
          annotationId: annotationId as DrawingAnnotationId
        }))
      : drawingAnnotationsForSpecs(
          operation.annotations,
          operation.edges,
          newId
        ).map((annotation) => ({ kind: 'add' as const, sheetId, annotation }));
  });
}

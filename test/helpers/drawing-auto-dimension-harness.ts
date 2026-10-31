import { expect } from 'vitest';
import {
  drawingPaperMm,
  drawingPaperPerModelUnit,
  type BodyRepresentation,
  type DrawingAnnotationId,
  type DrawingSheet
} from '@openzcad/shared';
import {
  annotationAnchor,
  layoutAnnotation,
  resolveDrawingAnnotation,
  resolveSheetAnnotations
} from '../../apps/web/src/lib/drawing/annotations';
import {
  annotationFootprint,
  footprintClash,
  planAutoDimensions
} from '../../apps/web/src/lib/drawing/autoDimension';
import { auditDrawingDimensions } from '../../apps/web/src/lib/drawing/dimensionAudit';
import { projectView } from '../../apps/web/src/lib/drawing/projectView';
import {
  SHEET_MARGIN_MM,
  titleBlockBox,
  viewPageBox,
  viewPageTransform,
  type ComposedView
} from '../../apps/web/src/lib/drawing/sheetPage';
import { projectionBodyInput } from '../../apps/web/src/lib/drawing/sheetSources';

/**
 * D06 Auto-dimension harness: draw a sheet's views, plan and apply, re-check,
 * and assert the placed set is clear on the paper. Shared by the history
 * corpus and the history-less import tests.
 */

export function drawnViews(
  sheet: DrawingSheet,
  bodies: Record<string, BodyRepresentation>
): ComposedView[] {
  return sheet.views.map((view) => ({
    view,
    projection: projectView({
      orientation: view.orientation,
      hiddenLines: view.hiddenLines,
      bodies: view.bodyIds.map((bodyId) =>
        projectionBodyInput(bodies[bodyId]!)!
      )
    })
  }));
}

/** Deterministic ids, so a plan reads the same each run. */
export function counter() {
  let next = 0;
  return () => `dann_auto${(next += 1)}` as DrawingAnnotationId;
}

/**
 * Plans, applies and re-checks: the plan must leave nothing the checker
 * calls missing or repeated, and every dimension it adds must measure.
 */
export function autoDimension(
  sheet: DrawingSheet,
  bodies: Record<string, BodyRepresentation>
) {
  const views = drawnViews(sheet, bodies);
  const before = auditDrawingDimensions(sheet, bodies, 'mm');
  const plan = planAutoDimensions(sheet, views, bodies, 'mm', counter());
  const after: DrawingSheet = {
    ...sheet,
    annotations: [...(sheet.annotations ?? []), ...plan.annotations]
  };
  const audit = auditDrawingDimensions(after, bodies, 'mm');
  for (const [annotationId, resolution] of resolveSheetAnnotations(
    after,
    bodies,
    'mm'
  ))
    expect(resolution, annotationId).toMatchObject({ ok: true });
  return { views, before, plan, after, audit };
}

/** Every pair of annotations on `sheet` clear of each other, on the paper. */
export function expectClearLayout(
  sheet: DrawingSheet,
  views: readonly ComposedView[],
  bodies: Record<string, BodyRepresentation>
) {
  const k = drawingPaperPerModelUnit(sheet.scale, 'mm');
  const paper = drawingPaperMm(sheet.paper);
  const title = titleBlockBox(sheet);
  const byId = new Map(views.map((entry) => [entry.view.viewId, entry]));
  const outlines = views.map((entry) => ({
    viewId: entry.view.viewId,
    box: viewPageBox(entry.view, entry.projection.bounds!, sheet, 'mm')
  }));
  const overlaps = (
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number }
  ) =>
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height;
  const prints = (sheet.annotations ?? []).map((annotation) => {
    const entry = byId.get(annotation.viewId!)!;
    const toPage = viewPageTransform(
      entry.view,
      entry.projection.bounds!,
      sheet,
      'mm'
    );
    const resolution = resolveDrawingAnnotation(
      annotation,
      entry.view,
      bodies,
      'mm'
    );
    if (!resolution.ok) throw new Error(resolution.message);
    const layout = layoutAnnotation(
      resolution.resolved,
      toPage,
      k,
      annotationAnchor(annotation, entry.view)
    );
    const print = annotationFootprint(layout, resolution.resolved, toPage);
    // On the paper, off the title block, clear of every other view, and a
    // linear dimension's text clear of its own.
    const { box } = print;
    expect(box.x).toBeGreaterThanOrEqual(SHEET_MARGIN_MM);
    expect(box.y).toBeGreaterThanOrEqual(SHEET_MARGIN_MM);
    expect(box.x + box.width).toBeLessThanOrEqual(
      paper.width - SHEET_MARGIN_MM
    );
    expect(box.y + box.height).toBeLessThanOrEqual(
      paper.height - SHEET_MARGIN_MM
    );
    expect(overlaps(box, title)).toBe(false);
    for (const outline of outlines)
      if (outline.viewId !== annotation.viewId || annotation.kind === 'linear')
        expect(overlaps(box, outline.box), annotation.annotationId).toBe(false);
    return { id: annotation.annotationId, print };
  });
  for (let i = 0; i < prints.length; i += 1)
    for (let j = i + 1; j < prints.length; j += 1)
      expect(
        footprintClash(prints[i]!.print, prints[j]!.print),
        `${prints[i]!.id} × ${prints[j]!.id}`
      ).toBeNull();
}

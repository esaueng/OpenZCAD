import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  drawingPaperMm,
  drawingPaperPerModelUnit,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingLinearDimension,
  type DrawingSheet
} from '@openzcad/shared';
import {
  annotationAnchor,
  layoutAnnotation,
  resolveDrawingAnnotation,
  resolveSheetAnnotations
} from '../apps/web/src/lib/drawing/annotations';
import {
  annotationFootprint,
  footprintClash,
  planAutoDimensions
} from '../apps/web/src/lib/drawing/autoDimension';
import { auditDrawingDimensions } from '../apps/web/src/lib/drawing/dimensionAudit';
import { projectView } from '../apps/web/src/lib/drawing/projectView';
import {
  SHEET_MARGIN_MM,
  titleBlockBox,
  viewPageBox,
  viewPageTransform,
  type ComposedView
} from '../apps/web/src/lib/drawing/sheetPage';
import { projectionBodyInput } from '../apps/web/src/lib/drawing/sheetSources';
import {
  boxOperations,
  buildPart,
  flangeOperations,
  footOperations,
  frontId,
  plateOperations,
  roundedOperations,
  sheetOf,
  stepOperations
} from './helpers/drawing-dimension-fixtures';

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

function drawnViews(
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
function counter() {
  let next = 0;
  return () => `dann_auto${(next += 1)}` as DrawingAnnotationId;
}

/**
 * Plans, applies and re-checks: the plan must leave nothing the checker
 * calls missing or repeated, and every dimension it adds must measure.
 */
function autoDimension(
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
function expectClearLayout(
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

const kinds = (annotations: readonly DrawingAnnotation[]) =>
  annotations.map((annotation) =>
    annotation.kind === 'linear' ? annotation.direction : annotation.kind
  );

describe('D06 Auto-dimension: the corpus', () => {
  it('dimensions a plain box with three spans, from its lowest faces', async () => {
    const { bodies, bodyId } = await buildPart(adapter, boxOperations());
    const { before, plan, audit, after, views } = autoDimension(
      sheetOf(bodyId),
      bodies
    );
    expect(before.missing).toHaveLength(3);
    expect(plan.annotations).toHaveLength(3);
    expect(kinds(plan.annotations).sort()).toEqual([
      'horizontal',
      'vertical',
      'vertical'
    ]);
    expect(plan.skipped).toEqual([]);
    expect(plan.onHiddenLines).toBe(0);
    expect(audit).toMatchObject({ missing: [], redundant: [], stated: 3 });
    expectClearLayout(after, views, bodies);
  });

  it('baselines a stepped part from its datum, with no closed chain', async () => {
    const { bodies, bodyId } = await buildPart(adapter, stepOperations());
    const { plan, audit, after, views } = autoDimension(
      sheetOf(bodyId),
      bodies
    );
    expect(plan.annotations).toHaveLength(5);
    expect(audit).toMatchObject({ missing: [], redundant: [], stated: 5 });
    expect(audit.unchecked).toEqual([]);
    expectClearLayout(after, views, bodies);
  });

  it('states a 2 × 2 hole pattern by one diameter and baseline positions', async () => {
    const { bodies, bodyId } = await buildPart(
      adapter,
      plateOperations([
        [10, 6],
        [30, 6],
        [10, 14],
        [30, 14]
      ])
    );
    const { plan, audit, after, views } = autoDimension(
      sheetOf(bodyId),
      bodies
    );
    expect(kinds(plan.annotations).filter((k) => k === 'diameter')).toEqual([
      'diameter'
    ]);
    // X: hole columns and the far face; Z: hole rows and the top; Y: depth.
    expect(plan.annotations).toHaveLength(1 + 3 + 3 + 1);
    expect(audit).toMatchObject({ missing: [], redundant: [] });
    // The holes are dimensioned where they are seen as circles, visible.
    const diameter = plan.annotations.find((a) => a.kind === 'diameter')!;
    expect(diameter.viewId).toBe(frontId);
    expect(plan.onHiddenLines).toBe(0);
    expectClearLayout(after, views, bodies);
  });

  it('leaves a bolt circle pitch to the report and dimensions the rest', async () => {
    const { bodies, bodyId } = await buildPart(adapter, flangeOperations());
    const { plan, audit, after, views } = autoDimension(
      sheetOf(bodyId),
      bodies
    );
    // Since v48 a Ø span between opposite holes states the pitch; the
    // generator leaves that one to the person and says so.
    expect(audit).toMatchObject({ redundant: [] });
    expect(audit.missing.map((entry) => entry.message)).toEqual([
      'Ø20 pitch diameter of the 4× Ø3 bolt circle.'
    ]);
    expect(plan.skipped.map((entry) => entry.message)).toEqual([
      "Ø20 pitch diameter of the 4× Ø3 bolt circle: Auto-dimension does not place pitch diameters yet; add a Ø span between two opposite holes' centres."
    ]);
    expectClearLayout(after, views, bodies);
  });

  it('gives a rounded corner its radius and never a tangent position', async () => {
    const { bodies, bodyId } = await buildPart(adapter, roundedOperations());
    const { plan, audit, after, views } = autoDimension(
      sheetOf(bodyId),
      bodies
    );
    expect(kinds(plan.annotations)).toContain('radius');
    expect(audit).toMatchObject({ missing: [], redundant: [] });
    expect(audit.unchecked).toEqual([]);
    expectClearLayout(after, views, bodies);
  });

  it('dimensions the turned foot along its axis, and says what it skips', async () => {
    const { bodies, bodyId } = await buildPart(adapter, footOperations());
    const { before, plan, audit, after, views } = autoDimension(
      sheetOf(bodyId),
      bodies
    );
    // Three diameters face-on from above, and (v48) the two heights off
    // the rims' silhouettes in the front view.
    expect(kinds(plan.annotations)).toEqual([
      'diameter',
      'diameter',
      'diameter',
      'vertical',
      'vertical'
    ]);
    const spans = plan.annotations.filter(
      (a): a is DrawingLinearDimension => a.kind === 'linear'
    );
    expect(spans.every((a) => a.viewId === frontId)).toBe(true);
    expect(spans.flatMap((a) => [a.from.anchor, a.to.anchor])).toEqual([
      'silhouette',
      'silhouette',
      'silhouette',
      'silhouette'
    ]);
    const chamfers = [
      '4 × 45° chamfer: Auto-dimension does not place chamfer dimensions yet; add it with the Chamfer tool.',
      '3.5 × 45° chamfer: Auto-dimension does not place chamfer dimensions yet; add it with the Chamfer tool.'
    ];
    expect(plan.skipped.map((entry) => entry.message)).toEqual([
      ...before.unmeasurable.map((entry) => entry.message),
      ...chamfers
    ]);
    expect(audit.redundant).toEqual([]);
    expect(audit.missing.map((entry) => entry.message)).toEqual([
      '4 × 45° chamfer.',
      '3.5 × 45° chamfer.'
    ]);
    expectClearLayout(after, views, bodies);
  });
});

describe('D06 Auto-dimension: rules', () => {
  it('keeps the user’s dimensions, adds only what is missing, and is idempotent', async () => {
    const { bodies, bodyId } = await buildPart(adapter, stepOperations());
    const first = autoDimension(sheetOf(bodyId), bodies);
    // The user keeps one of them (moved), and removes the rest.
    const kept = {
      ...first.plan.annotations[0]!,
      annotationId: 'dann_user' as DrawingAnnotationId
    };
    const second = autoDimension(sheetOf(bodyId, [kept]), bodies);
    expect(second.after.annotations![0]).toEqual(kept);
    expect(second.plan.annotations).toHaveLength(
      first.plan.annotations.length - 1
    );
    expect(second.audit).toMatchObject({ missing: [], redundant: [] });
    // Run again on the finished sheet: nothing left to add.
    const again = planAutoDimensions(
      second.after,
      second.views,
      bodies,
      'mm',
      counter()
    );
    expect(again.annotations).toEqual([]);
  });

  it('never deletes a repeated user dimension, and adds nothing that repeats it', async () => {
    const { bodies, bodyId } = await buildPart(adapter, boxOperations());
    const first = autoDimension(sheetOf(bodyId), bodies);
    const width = first.plan.annotations.find(
      (a) => a.kind === 'linear' && a.direction === 'horizontal'
    )!;
    const twice = [
      { ...width, annotationId: 'dann_w1' as DrawingAnnotationId },
      {
        ...width,
        annotationId: 'dann_w2' as DrawingAnnotationId,
        placementMm: { x: width.placementMm.x, y: width.placementMm.y - 10 }
      }
    ];
    const { after, audit } = autoDimension(sheetOf(bodyId, twice), bodies);
    expect(after.annotations!.slice(0, 2)).toEqual(twice);
    expect(audit.missing).toEqual([]);
    expect(audit.redundant.map((entry) => entry.annotationId)).toEqual([
      'dann_w2'
    ]);
  });

  it('never dimensions the isometric view', async () => {
    const { bodies, bodyId } = await buildPart(adapter, plateOperations());
    const sheet = sheetOf(bodyId, [], ['front', 'top', 'iso']);
    const { plan, audit } = autoDimension(sheet, bodies);
    const iso = sheet.views.find((view) => view.orientation === 'iso')!;
    expect(plan.annotations.length).toBeGreaterThan(0);
    expect(plan.annotations.some((a) => a.viewId === iso.viewId)).toBe(false);
    expect(audit).toMatchObject({ missing: [], redundant: [] });
  });

  it('measures only edges whose identity no other edge shares', async () => {
    const { bodies, bodyId } = await buildPart(
      adapter,
      plateOperations([
        [10, 6],
        [30, 6],
        [10, 14],
        [30, 14]
      ])
    );
    const { plan } = autoDimension(sheetOf(bodyId), bodies);
    const body = bodies[bodyId]!;
    const hashes = new Map<number, number>();
    for (const edge of body.topology!.edges)
      hashes.set(edge.hash, (hashes.get(edge.hash) ?? 0) + 1);
    for (const annotation of plan.annotations) {
      const refs =
        annotation.kind === 'linear'
          ? [annotation.from, annotation.to].flatMap((point) =>
              'edge' in point ? [point.edge] : []
            )
          : annotation.kind === 'diameter' || annotation.kind === 'radius'
            ? [annotation.edge]
            : [];
      for (const ref of refs) expect(hashes.get(ref.hash)).toBe(1);
    }
  });

  it('skips with a reason when the sheet has no view that shows an axis', async () => {
    const { bodies, bodyId } = await buildPart(adapter, boxOperations());
    // Front only: Y is never seen true size.
    const sheet = sheetOf(bodyId, [], ['front']);
    const { plan, audit } = autoDimension(sheet, bodies);
    expect(plan.annotations).toHaveLength(2);
    expect(plan.skipped.map((entry) => entry.message)).toEqual([
      expect.stringMatching(/^Y: .*add a view that shows Y\.$/)
    ]);
    expect(audit.missing).toEqual([]);
  });

  it('stacks spans shortest nearest the part', async () => {
    const { bodies, bodyId } = await buildPart(adapter, stepOperations());
    const { plan, after, views } = autoDimension(sheetOf(bodyId), bodies);
    const front = views.find((entry) => entry.view.viewId === frontId)!;
    const toPage = viewPageTransform(
      front.view,
      front.projection.bounds!,
      after,
      'mm'
    );
    const outline = viewPageBox(
      front.view,
      front.projection.bounds!,
      after,
      'mm'
    );
    const vertical = plan.annotations.flatMap((annotation) => {
      if (
        annotation.viewId !== frontId ||
        annotation.kind !== 'linear' ||
        annotation.direction !== 'vertical'
      )
        return [];
      const resolution = resolveDrawingAnnotation(
        annotation,
        front.view,
        bodies,
        'mm'
      );
      if (!resolution.ok || resolution.resolved.kind !== 'linear') return [];
      const x = front.view.centerMm.x + annotation.placementMm.x;
      return [
        {
          value: resolution.resolved.value,
          distance: Math.min(
            Math.abs(x - outline.x),
            Math.abs(x - (outline.x + outline.width))
          ),
          page: toPage(...resolution.resolved.from)
        }
      ];
    });
    expect(vertical.map((entry) => entry.value).sort()).toEqual([10, 20]);
    const [short, long] = [...vertical].sort((p, q) => p.value - q.value);
    expect(short!.distance).toBeLessThan(long!.distance);
  });
});

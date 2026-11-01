import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  drawingPaperPerModelUnit,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingLinearDimension
} from '@openzcad/shared';
import {
  annotationAnchor,
  layoutAnnotation,
  resolveDrawingAnnotation
} from '../apps/web/src/lib/drawing/annotations';
import { planAutoDimensions } from '../apps/web/src/lib/drawing/autoDimension';
import {
  viewPageBox,
  viewPageTransform
} from '../apps/web/src/lib/drawing/sheetPage';
import {
  boxOperations,
  buildPart,
  countersunkPlate,
  flangeOperations,
  footOperations,
  frontId,
  plateOperations,
  roundedOperations,
  sheetOf,
  slopedOperations,
  stepOperations,
  topId
} from './helpers/drawing-dimension-fixtures';
import {
  autoDimension,
  counter,
  expectClearLayout
} from './helpers/drawing-auto-dimension-harness';

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

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

  it('states a slope by its angle and one corner, and derives the rest', async () => {
    const { bodies, bodyId } = await buildPart(adapter, slopedOperations());
    const { before, plan, audit, after, views } = autoDimension(
      sheetOf(bodyId),
      bodies
    );
    expect(before.missing.map((entry) => entry.message)).toContain(
      '45° slope to X.'
    );
    expect(kinds(plan.annotations)).toContain('angle');
    const angle = plan.annotations.find((a) => a.kind === 'angle')!;
    expect(angle.viewId).toBe(frontId);
    const resolved = resolveDrawingAnnotation(
      angle,
      views.find((v) => v.view.viewId === frontId)!.view,
      bodies,
      'mm'
    );
    // Its edges meet at the slope's corner with the top face, 135° inside;
    // v51 states it outside, on the top face's extension, as 45°.
    expect(angle).toMatchObject({ kind: 'angle', outside: 1 });
    expect(resolved.ok && resolved.resolved.kind).toBe('angle');
    if (resolved.ok && resolved.resolved.kind === 'angle')
      expect(resolved.resolved.value).toBeCloseTo(45, 6);
    expect(plan.skipped).toEqual([]);
    expect(audit).toMatchObject({
      missing: [],
      redundant: [],
      unmeasurable: [],
      unchecked: []
    });
    expect(audit.stated).toBe(audit.required);
    expectClearLayout(after, views, bodies);
  });

  it('calls out countersunk holes in one note, not a diameter and a chamfer', async () => {
    const { bodies, bodyId } = await countersunkPlate(adapter);
    const { before, plan, audit, after, views } = autoDimension(
      sheetOf(bodyId, [], ['top', 'front']),
      bodies
    );
    expect(before.missing.map((entry) => entry.message)).toEqual(
      expect.arrayContaining(['2× Ø6 diameter.', '2× 3 × 45° chamfer.'])
    );
    const callouts = plan.annotations.filter(
      (annotation) =>
        annotation.kind === 'diameter' && annotation.countersink !== undefined
    );
    expect(callouts).toHaveLength(1);
    expect(kinds(plan.annotations)).not.toContain('chamfer');
    const top = views.find((v) => v.view.viewId === topId)!.view;
    expect(
      resolveDrawingAnnotation(callouts[0]!, top, bodies, 'mm')
    ).toMatchObject({
      ok: true,
      resolved: { label: '2× Ø6 THRU, CSK Ø12 × 90°' }
    });
    expect(plan.skipped).toEqual([]);
    expect(audit).toMatchObject({
      missing: [],
      redundant: [],
      unmeasurable: [],
      unchecked: []
    });
    expect(audit.stated).toBe(audit.required);
    expectClearLayout(after, views, bodies);
  });

  it('dimensions the turned foot completely: diameters, chamfer, blends and heights', async () => {
    const { bodies, bodyId } = await buildPart(adapter, footOperations());
    const { plan, audit, after, views } = autoDimension(
      sheetOf(bodyId),
      bodies
    );
    // Three diameters face-on from above; in the front view (v49) the
    // counted chamfer and blend radius, and (v48) the heights off the
    // rims' silhouettes, the 29 to the shoulder chamfer's corner.
    expect(kinds(plan.annotations)).toEqual([
      'diameter',
      'diameter',
      'diameter',
      'chamfer',
      'radius',
      'vertical',
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
      'chamfer-corner',
      'silhouette',
      'silhouette'
    ]);
    expect(plan.skipped).toEqual([]);
    expect(audit).toMatchObject({
      missing: [],
      redundant: [],
      unmeasurable: [],
      unchecked: [],
      stated: 8,
      required: 8
    });
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
          : (annotation.kind === 'diameter' || annotation.kind === 'radius') &&
              'edge' in annotation
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

  it('locates a hole inside its view, beside it, and keeps overall sizes outside', async () => {
    const { bodies, bodyId } = await buildPart(adapter, plateOperations());
    const { plan, after, views, audit } = autoDimension(
      sheetOf(bodyId),
      bodies
    );
    expect(audit).toMatchObject({ missing: [], redundant: [] });
    const k = drawingPaperPerModelUnit(after.scale, 'mm');
    const placed = plan.annotations.flatMap((annotation) => {
      if (annotation.kind !== 'linear') return [];
      const entry = views.find((v) => v.view.viewId === annotation.viewId)!;
      const toPage = viewPageTransform(
        entry.view,
        entry.projection.bounds!,
        after,
        'mm'
      );
      const outline = viewPageBox(
        entry.view,
        entry.projection.bounds!,
        after,
        'mm'
      );
      const resolution = resolveDrawingAnnotation(
        annotation,
        entry.view,
        bodies,
        'mm'
      );
      if (!resolution.ok || resolution.resolved.kind !== 'linear') return [];
      const { box } = layoutAnnotation(
        resolution.resolved,
        toPage,
        k,
        annotationAnchor(annotation, entry.view)
      );
      const ends = [resolution.resolved.from, resolution.resolved.to].map(
        (point) => toPage(...point)
      );
      const axis = annotation.direction === 'horizontal' ? 0 : 1;
      const [lo, hi] =
        axis === 0
          ? [outline.x, outline.x + outline.width]
          : [outline.y, outline.y + outline.height];
      const onOutline = (p: [number, number]) =>
        Math.abs(p[axis] - lo) < 0.01 || Math.abs(p[axis] - hi) < 0.01;
      const inside =
        box.x >= outline.x &&
        box.y >= outline.y &&
        box.x + box.width <= outline.x + outline.width &&
        box.y + box.height <= outline.y + outline.height;
      return [{ overall: ends.every(onOutline), inside }];
    });
    // The 40 and 20 envelope outside; a hole's position beside the hole.
    expect(placed.filter((p) => p.overall).every((p) => !p.inside)).toBe(true);
    expect(placed.some((p) => !p.overall && p.inside)).toBe(true);
    expectClearLayout(after, views, bodies);
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

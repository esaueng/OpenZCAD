import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  assertStorableDocument,
  createProjectDocument
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  drawingPaperPerModelUnit,
  drawingSetError,
  DRAWING_VIEW_FRAMES,
  projectToView,
  nextDrawingSectionLabel,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingView,
  type DrawingViewId
} from '@openzcad/shared';
import { projectView } from '../apps/web/src/lib/drawing/projectView';
import { projectionBodyInput } from '../apps/web/src/lib/drawing/sheetSources';
import {
  clipPolylineToCircle,
  composeSheetPage,
  viewPageBox,
  viewPageTransform
} from '../apps/web/src/lib/drawing/sheetPage';
import { sheetPageToSvg } from '../apps/web/src/lib/drawing/sheetExport';
import {
  composeSheetAnnotations,
  drawnLines,
  markHiddenLeaders,
  resolveSheetAnnotations
} from '../apps/web/src/lib/drawing/annotations';
import { drawnOutlines } from '../apps/web/src/lib/drawing/annotationPicking';
import { duplicateDrawingSheet } from '../apps/web/src/lib/drawing/sheetEdits';
import {
  defaultDetailScale,
  detailDraft,
  detailRegionFromDrag,
  detailSourceAt
} from '../apps/web/src/lib/drawing/detailTool';

/**
 * D03 detail views (schema v78): the region of a view inside a circle, at
 * its own scale, cropped to the circle, with its own hidden lines, its
 * circle and letter on the source and its caption beneath it.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const sheetId = 'dsht_det' as DrawingSheetId;
const frontId = 'dvw_front' as DrawingViewId;
const detailId = 'dvw_detail' as DrawingViewId;

async function model() {
  const document = addPrimitiveFeature(
    createProjectDocument('Detailed', toUserId('test')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 20, depth: 10 }
    }
  );
  const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
  return { document, bodies, bodyId: document.bodyOrder[0]! };
}

function front(bodyId: BodyId): DrawingView {
  return {
    viewId: frontId,
    orientation: 'front',
    bodyIds: [bodyId],
    centerMm: { x: 100, y: 150 },
    hiddenLines: false
  };
}

function sheetOf(views: DrawingView[]): DrawingSheet {
  return {
    sheetId,
    name: 'Sheet 1',
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {},
    source: { fingerprint: 'v1:test' },
    views
  };
}

function composed(
  sheet: DrawingSheet,
  bodies: Record<string, BodyRepresentation>
) {
  return sheet.views.map((entry) => ({
    view: entry,
    projection: projectView({
      orientation: entry.orientation,
      hiddenLines: entry.hiddenLines,
      bodies: entry.bodyIds.map((id) => projectionBodyInput(bodies[id]!)!)
    })
  }));
}

describe('D03 detail views (schema v78)', () => {
  it('claims v78 and validates details by name', async () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(78);
    const { bodyId } = await model();
    const detail: DrawingView = {
      ...front(bodyId),
      viewId: detailId,
      centerMm: { x: 250, y: 150 },
      detail: {
        sourceViewId: frontId,
        label: 'A',
        center: { u: 0, v: 0 },
        radius: 5,
        scale: { numerator: 4, denominator: 1 }
      }
    };
    expect(
      drawingSetError({ sheets: [sheetOf([front(bodyId), detail])] })
    ).toBeNull();
    const bad: [DrawingView[], RegExp][] = [
      [
        [
          front(bodyId),
          { ...detail, detail: { ...detail.detail!, radius: 0 } }
        ],
        /invalid detail/
      ],
      [
        [
          front(bodyId),
          { ...detail, detail: { ...detail.detail!, label: 'O1' } }
        ],
        /invalid detail/
      ],
      [
        [
          front(bodyId),
          {
            ...detail,
            detail: {
              ...detail.detail!,
              scale: { numerator: 0, denominator: 1 }
            }
          }
        ],
        /invalid detail/
      ],
      [
        [front(bodyId), { ...detail, orientation: 'top' }],
        /does not look as its source/
      ],
      [
        [front(bodyId), { ...detail, bodyIds: ['other' as BodyId] }],
        /does not look as its source/
      ],
      [[detail], /does not look as its source/],
      [
        [
          front(bodyId),
          detail,
          {
            ...detail,
            viewId: 'dvw_d2' as DrawingViewId,
            detail: { ...detail.detail!, sourceViewId: detailId, label: 'B' }
          }
        ],
        /does not look as its source/
      ],
      [
        [
          front(bodyId),
          detail,
          { ...detail, viewId: 'dvw_d2' as DrawingViewId }
        ],
        /names view A twice/
      ],
      [
        [front(bodyId), { ...detail, parentViewId: frontId }],
        /cannot be a detail and a projected/
      ]
    ];
    for (const [views, message] of bad)
      expect(drawingSetError({ sheets: [sheetOf(views)] })).toMatch(message);
    // Sections and details share one label sequence.
    expect(nextDrawingSectionLabel(sheetOf([front(bodyId), detail]))).toBe('B');
  });

  it('places a dragged circle as a detail at twice the sheet’s scale, centred on the region', async () => {
    const { bodies, bodyId } = await model();
    const sheet = sheetOf([front(bodyId)]);
    const views = composed(sheet, bodies);
    const source = detailSourceAt(sheet, views, [100, 150], 'mm')!;
    expect(source.view.viewId).toBe(frontId);
    expect(detailSourceAt(sheet, views, [5, 5], 'mm')).toBeNull();
    // From 10 mm right of the view's centre, out 6 mm: a 6 mm circle.
    const region = detailRegionFromDrag(
      sheet,
      source,
      [110, 150],
      [116, 150],
      'mm'
    )!;
    const bounds = source.projection.bounds!;
    expect(region.radius).toBeCloseTo(6, 9);
    expect(region.center.u).toBeCloseTo(
      (bounds.minU + bounds.maxU) / 2 + 10,
      6
    );
    expect(
      detailRegionFromDrag(sheet, source, [110, 150], [110.5, 150], 'mm')
    ).toBeNull();
    expect(defaultDetailScale({ numerator: 1, denominator: 1 })).toEqual({
      numerator: 2,
      denominator: 1
    });
    expect(defaultDetailScale({ numerator: 1, denominator: 5 })).toEqual({
      numerator: 1,
      denominator: 2
    });
    const draft = detailDraft(sheet, source.view, region, [260, 120]);
    expect(draft).toMatchObject({
      orientation: 'front',
      bodyIds: [bodyId],
      centerMm: { x: 260, y: 120 },
      detail: {
        sourceViewId: frontId,
        label: 'A',
        scale: { numerator: 2, denominator: 1 }
      }
    });
    // The detail's transform puts the region's centre at its own centre,
    // magnified by its scale.
    const detail = { ...draft, viewId: detailId };
    const toPage = viewPageTransform(detail, bounds, sheet, 'mm');
    const [x, y] = toPage(region.center.u + 1, region.center.v);
    expect(x).toBeCloseTo(262, 6);
    expect(y).toBeCloseTo(120, 6);
    const footprint = viewPageBox(detail, bounds, sheet, 'mm');
    expect(footprint.x).toBeCloseTo(248, 6);
    expect(footprint.y).toBeCloseTo(108, 6);
    expect(footprint.width).toBeCloseTo(24, 6);
    expect(footprint.height).toBeCloseTo(24, 6);
  });

  it('draws only what lies inside its circle, with its marks, caption and dimensions at true size', async () => {
    const { document, bodies, bodyId } = await model();
    const base = sheetOf([front(bodyId)]);
    const bounds = composed(base, bodies)[0]!.projection.bounds!;
    // Around the front view's top right corner.
    const detail: DrawingView = {
      ...front(bodyId),
      viewId: detailId,
      centerMm: { x: 280, y: 150 },
      detail: {
        sourceViewId: frontId,
        label: 'A',
        center: { u: bounds.maxU, v: bounds.maxV },
        radius: 5,
        scale: { numerator: 4, denominator: 1 }
      }
    };
    const top = bodies[bodyId]!.topology!.edges.find((edge) => {
      const p = edge.points;
      const { min, max } = bodies[bodyId]!.bbox;
      const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
      return (
        near(p[1]!, min.y) &&
        near(p[p.length - 2]!, min.y) &&
        near(p[2]!, max.z) &&
        near(p[p.length - 1]!, max.z)
      );
    })!;
    const annotations: DrawingAnnotation[] = [
      {
        annotationId: 'dann_w' as DrawingAnnotationId,
        kind: 'linear',
        viewId: detailId,
        direction: 'horizontal',
        from: { edge: { bodyId, hash: top.hash }, anchor: 'first' },
        to: { edge: { bodyId, hash: top.hash }, anchor: 'second' },
        placementMm: { x: 0, y: 15 }
      }
    ];
    const sheet = { ...sheetOf([front(bodyId), detail]), annotations };
    expect(drawingSetError({ sheets: [sheet] })).toBeNull();
    const views = composed(sheet, bodies);
    const resolutions = resolveSheetAnnotations(sheet, bodies, 'mm');
    const width = resolutions.get('dann_w' as DrawingAnnotationId)!;
    // Measured from the model: the true width, whatever the detail's scale.
    expect(width.ok && width.resolved.label).toBe('40');
    const page = composeSheetPage(
      sheet,
      views,
      { projectName: document.name, units: 'mm' },
      composeSheetAnnotations(sheet, views, resolutions, 'mm')
    );
    // The detail's visible strokes all lie within its 20 mm circle.
    const inDetail = page.strokes.filter(
      (stroke) =>
        stroke.kind === 'visible' &&
        stroke.points.every((value, index) =>
          index % 2 === 0 ? value > 200 : true
        )
    );
    expect(inDetail.length).toBeGreaterThan(0);
    for (const stroke of inDetail)
      for (let i = 0; i + 1 < stroke.points.length; i += 2)
        expect(
          Math.hypot(stroke.points[i]! - 280, stroke.points[i + 1]! - 150)
        ).toBeLessThanOrEqual(20 + 1e-6);
    // The corner sits at the circle's centre, magnified 4×: the top edge
    // runs left from it, 20 mm, to the rim.
    const lengths = inDetail.map((stroke) => {
      let total = 0;
      for (let i = 2; i + 1 < stroke.points.length; i += 2)
        total += Math.hypot(
          stroke.points[i]! - stroke.points[i - 2]!,
          stroke.points[i + 1]! - stroke.points[i - 1]!
        );
      return total;
    });
    expect(Math.max(...lengths)).toBeCloseTo(20, 6);
    const svg = sheetPageToSvg(page, sheet.name);
    expect(svg).toContain('>DETAIL A (4:1)</text>');
    // The letter beside the circle on the source view.
    expect(svg).toMatch(/font-weight="bold"[^>]*>A<\/text>/);
    // What the detail offers to pick is cut to its circle too.
    const lines = drawnLines(sheet, views, 'mm').get(detailId)!;
    for (const line of lines)
      for (const [x, y] of line)
        expect(Math.hypot(x - 280, y - 150)).toBeLessThanOrEqual(20 + 1e-6);
    expect(drawingPaperPerModelUnit(detail.detail!.scale, 'mm')).toBe(4);
  });

  it('lays out radii at the detail’s scale and keeps leaders and outlines inside its circle', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Pin', toUserId('test')),
      {
        name: 'Pin',
        primitiveKind: 'cylinder',
        dimensions: { radius: 5, height: 12 }
      }
    );
    const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
    const pinId = document.bodyOrder[0]!;
    const topId = 'dvw_top' as DrawingViewId;
    const top: DrawingView = {
      viewId: topId,
      orientation: 'top',
      bodyIds: [pinId],
      centerMm: { x: 100, y: 150 },
      hiddenLines: false
    };
    const rim = bodies[pinId]!.topology!.edges.find(
      (edge) => edge.curve?.circle
    )!;
    const centre = rim.curve!.circle!.center;
    // A 4:1 detail around the rim's right side: it crosses the circle.
    const detail: DrawingView = {
      ...top,
      viewId: detailId,
      centerMm: { x: 250, y: 150 },
      detail: {
        sourceViewId: topId,
        label: 'A',
        center: { u: centre.x + 5, v: centre.y },
        radius: 2,
        scale: { numerator: 4, denominator: 1 }
      }
    };
    const annotations: DrawingAnnotation[] = [
      {
        annotationId: 'dann_r' as DrawingAnnotationId,
        kind: 'radius',
        viewId: detailId,
        edge: { bodyId: pinId, hash: rim.hash },
        placementMm: { x: 10, y: 3 }
      },
      {
        // Placed far below the circle, where the rim continues unseen.
        annotationId: 'dann_n' as DrawingAnnotationId,
        kind: 'note',
        text: 'RIM',
        viewId: detailId,
        leader: { bodyId: pinId, hash: rim.hash },
        placementMm: { x: -30, y: -40 }
      }
    ];
    const sheet: DrawingSheet = { ...sheetOf([top, detail]), annotations };
    const views = composed(sheet, bodies);
    const resolutions = markHiddenLeaders(
      sheet,
      resolveSheetAnnotations(sheet, bodies, 'mm'),
      views,
      'mm',
      bodies
    );
    const layer = composeSheetAnnotations(sheet, views, resolutions, 'mm');
    const arrows = layer.strokes.filter((stroke) => stroke.filled);
    // The radius arrow lands on the rim drawn at 4:1: 20 mm from the
    // centre, which sits 20 mm left of the detail's middle.
    const rimCentre: [number, number] = [250 - 20, 150];
    const radiusTip = arrows
      .map((stroke) => [stroke.points[0]!, stroke.points[1]!] as const)
      .find(
        ([x, y]) =>
          Math.abs(Math.hypot(x - rimCentre[0], y - rimCentre[1]) - 20) < 1e-6
      );
    expect(radiusTip).toBeDefined();
    // The note's arrow points at the rim inside the detail's 8 mm circle.
    for (const [x, y] of arrows.map(
      (stroke) => [stroke.points[0]!, stroke.points[1]!] as const
    ))
      expect(Math.hypot(x - 250, y - 150)).toBeLessThanOrEqual(8 + 1e-6);
    // What face tools may pick on the detail lies inside its circle too.
    const outlines = drawnOutlines(sheet, views, 'mm').get(detailId)!;
    expect(outlines.length).toBeGreaterThan(0);
    for (const line of outlines)
      for (const [x, y] of line)
        expect(Math.hypot(x - 250, y - 150)).toBeLessThanOrEqual(8 + 1e-6);
  });

  it('points a leader at the part of a long edge inside the detail’s circle', async () => {
    const { bodies, bodyId } = await model();
    const view = front(bodyId);
    const frame = DRAWING_VIEW_FRAMES.front;
    // The box's bottom front edge, 40 long along the page.
    const { min } = bodies[bodyId]!.bbox;
    const bottom = bodies[bodyId]!.topology!.edges.find((edge) => {
      const p = edge.points;
      return [p.slice(0, 3), p.slice(p.length - 3)].every(
        (q) => Math.abs(q[1]! - min.y) < 1e-6 && Math.abs(q[2]! - min.z) < 1e-6
      );
    })!;
    const p = bottom.points;
    const a = projectToView(frame, { x: p[0]!, y: p[1]!, z: p[2]! });
    const b = projectToView(frame, {
      x: p[p.length - 3]!,
      y: p[p.length - 2]!,
      z: p[p.length - 1]!
    });
    // A 2:1 detail of radius 3 a quarter of the way along: the edge's
    // middle lies outside it, but a 6 mm stretch of it inside.
    const detail: DrawingView = {
      ...view,
      viewId: detailId,
      centerMm: { x: 250, y: 150 },
      detail: {
        sourceViewId: frontId,
        label: 'A',
        center: { u: a.u + (b.u - a.u) / 4, v: a.v + (b.v - a.v) / 4 },
        radius: 3,
        scale: { numerator: 2, denominator: 1 }
      }
    };
    const sheet: DrawingSheet = {
      ...sheetOf([view, detail]),
      annotations: [
        {
          annotationId: 'dann_n' as DrawingAnnotationId,
          kind: 'note',
          text: 'EDGE',
          viewId: detailId,
          leader: { bodyId, hash: bottom.hash },
          placementMm: { x: 20, y: -20 }
        }
      ]
    };
    const views = composed(sheet, bodies);
    const resolutions = markHiddenLeaders(
      sheet,
      resolveSheetAnnotations(sheet, bodies, 'mm'),
      views,
      'mm',
      bodies
    );
    const note = resolutions.get('dann_n' as DrawingAnnotationId)!;
    expect(note.ok).toBe(true);
    const layer = composeSheetAnnotations(sheet, views, resolutions, 'mm');
    const tips = layer.strokes
      .filter((stroke) => stroke.filled)
      .map((stroke) => [stroke.points[0]!, stroke.points[1]!] as const);
    expect(tips).toHaveLength(1);
    // Its arrow ends inside the detail's 6 mm circle on the paper.
    for (const [x, y] of tips)
      expect(Math.hypot(x - 250, y - 150)).toBeLessThanOrEqual(6 + 1e-6);
  });

  it('clips polylines to a circle where they cross it', () => {
    const circle = { center: [0, 0] as [number, number], radius: 1 };
    expect(
      clipPolylineToCircle(
        [
          [-2, 0],
          [2, 0]
        ],
        circle
      )
    ).toEqual([
      [
        [-1, 0],
        [1, 0]
      ]
    ]);
    expect(
      clipPolylineToCircle(
        [
          [-2, 2],
          [2, 2]
        ],
        circle
      )
    ).toEqual([]);
    // In, out and back in: two pieces.
    const pieces = clipPolylineToCircle(
      [
        [0, 0],
        [0, 3],
        [0.5, 0]
      ],
      circle
    );
    expect(pieces).toHaveLength(2);
    expect(pieces[0]).toEqual([
      [0, 0],
      [0, 1]
    ]);
  });

  it('follows its source’s bodies, goes with it, and is gated below v78', async () => {
    const { document, bodyId } = await model();
    const detail: DrawingView = {
      ...front(bodyId),
      viewId: detailId,
      centerMm: { x: 280, y: 150 },
      detail: {
        sourceViewId: frontId,
        label: 'A',
        center: { u: 0, v: 0 },
        radius: 5,
        scale: { numerator: 2, denominator: 1 }
      }
    };
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({ sheet: sheetOf([front(bodyId)]) })
    );
    manager.execute(commandFactories.addDrawingView({ sheetId, view: detail }));
    expect(() => assertStorableDocument(manager.document)).not.toThrow();
    expect(() =>
      assertStorableDocument({ ...manager.document, schemaVersion: 75 })
    ).toThrow(/Detail views require project schema v78/);
    manager.execute(
      commandFactories.updateDrawingView({
        sheetId,
        viewId: detailId,
        detail: { scale: { numerator: 5, denominator: 1 }, radius: 3 }
      })
    );
    expect(
      manager.document.drawings!.sheets[0]!.views[1]!.detail
    ).toMatchObject({
      radius: 3,
      scale: { numerator: 5, denominator: 1 },
      label: 'A'
    });
    expect(() =>
      manager.execute(
        commandFactories.updateDrawingView({
          sheetId,
          viewId: detailId,
          bodyIds: [bodyId]
        })
      )
    ).toThrow(/bodies of its source view/);
    // A duplicated sheet's detail view names the copied source.
    const sheetNow = manager.document.drawings!.sheets[0]!;
    const copy = duplicateDrawingSheet(sheetNow, [sheetNow]);
    expect(drawingSetError({ sheets: [copy] })).toBeNull();
    expect(copy.views[1]!.detail!.sourceViewId).toBe(copy.views[0]!.viewId);
    manager.execute(
      commandFactories.deleteDrawingView({ sheetId, viewId: frontId })
    );
    expect(manager.document.drawings!.sheets[0]!.views).toHaveLength(0);
    manager.undo();
    expect(manager.document.drawings!.sheets[0]!.views).toHaveLength(2);
  });
});

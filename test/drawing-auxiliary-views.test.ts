import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  assertStorableDocument,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  drawingSetError,
  drawingViewFrame,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingView,
  type DrawingViewId,
  type EdgeTopology
} from '@openzcad/shared';
import { projectView } from '../apps/web/src/lib/drawing/projectView';
import { projectionBodyInput } from '../apps/web/src/lib/drawing/sheetSources';
import {
  composeSheetPage,
  viewPageBox
} from '../apps/web/src/lib/drawing/sheetPage';
import { detailSourceAt } from '../apps/web/src/lib/drawing/detailTool';
import { sheetPageToSvg } from '../apps/web/src/lib/drawing/sheetExport';
import {
  composeSheetAnnotations,
  resolveSheetAnnotations
} from '../apps/web/src/lib/drawing/annotations';
import { pickableEdges } from '../apps/web/src/lib/drawing/annotationPicking';
import { duplicateDrawingSheet } from '../apps/web/src/lib/drawing/sheetEdits';
import {
  auxiliaryDraft,
  auxiliaryEdgeRefusal
} from '../apps/web/src/lib/drawing/auxiliaryTool';

/**
 * D03 auxiliary views (schema v81): seen square to an edge a principal view
 * draws true length, so an inclined face is drawn true size, in a frame the
 * view stores; dimensions on it read true lengths.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const sheetId = 'dsht_aux' as DrawingSheetId;
const frontId = 'dvw_front' as DrawingViewId;
const auxId = 'dvw_aux' as DrawingViewId;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** A 20 × 10 × 6 box turned 30° about Y: its faces slope in the front view. */
async function tilted() {
  let document = addPrimitiveFeature(
    createProjectDocument('Tilted', toUserId('test')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 10, depth: 6 }
    }
  );
  document = transformBody(document, {
    name: 'Turn',
    targetBodyId: document.bodyOrder[0]!,
    translation: { x: 0, y: 0, z: 0 },
    rotationDeg: { x: 0, y: 30, z: 0 }
  }).document;
  const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
  const bodyId = document.bodyOrder.at(-1)!;
  return { document, bodies, bodyId };
}

function front(bodyId: BodyId): DrawingView {
  return {
    viewId: frontId,
    orientation: 'front',
    bodyIds: [bodyId],
    centerMm: { x: 120, y: 150 },
    hiddenLines: false
  };
}

function sheetOf(
  views: DrawingView[],
  annotations: DrawingAnnotation[] = []
): DrawingSheet {
  return {
    sheetId,
    name: 'Sheet 1',
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {},
    source: { fingerprint: 'v1:test' },
    views,
    ...(annotations.length ? { annotations } : {})
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
      ...(entry.auxiliary ? { frame: drawingViewFrame(entry) } : {}),
      hiddenLines: entry.hiddenLines,
      bodies: entry.bodyIds.map((id) => projectionBodyInput(bodies[id]!)!)
    })
  }));
}

/** The 20 mm edge on the box's front face, sloping across the front view. */
function slopingEdge(body: BodyRepresentation): EdgeTopology {
  const { min } = body.bbox;
  const candidates = body.topology!.edges.filter((edge) => {
    const p = edge.points;
    const n = p.length;
    return (
      edge.curve?.type === 'LINE' &&
      near(p[1]!, min.y) &&
      near(p[n - 2]!, min.y) &&
      near(Math.hypot(p[n - 3]! - p[0]!, p[n - 1]! - p[2]!), 20)
    );
  });
  expect(candidates.length).toBe(2);
  // The upper one.
  return candidates.reduce((a, b) =>
    a.points[2]! + a.points[a.points.length - 1]! >
    b.points[2]! + b.points[b.points.length - 1]!
      ? a
      : b
  );
}

describe('D03 auxiliary views (schema v81)', () => {
  it('claims v81 and validates the frame and source by name', async () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(81);
    const { bodyId } = await tilted();
    const aux: DrawingView = {
      ...front(bodyId),
      viewId: auxId,
      centerMm: { x: 250, y: 220 },
      auxiliary: {
        sourceViewId: frontId,
        label: 'A',
        direction: { x: 0.5, y: 0, z: -Math.sqrt(3) / 2 },
        x: { x: Math.sqrt(3) / 2, y: 0, z: 0.5 }
      }
    };
    expect(
      drawingSetError({ sheets: [sheetOf([front(bodyId), aux])] })
    ).toBeNull();
    const bad: [DrawingView[], RegExp][] = [
      [
        [
          front(bodyId),
          {
            ...aux,
            auxiliary: { ...aux.auxiliary!, direction: { x: 1, y: 1, z: 0 } }
          }
        ],
        /invalid auxiliary/
      ],
      [
        [
          front(bodyId),
          {
            ...aux,
            auxiliary: {
              ...aux.auxiliary!,
              x: { x: 0.5, y: 0, z: -Math.sqrt(3) / 2 }
            }
          }
        ],
        /not square/
      ],
      // Sight along the front's own direction is no auxiliary view of it.
      [
        [
          front(bodyId),
          {
            ...aux,
            auxiliary: {
              ...aux.auxiliary!,
              direction: { x: 0, y: 1, z: 0 },
              x: { x: 1, y: 0, z: 0 }
            }
          }
        ],
        /not seen square from its source/
      ],
      [
        [front(bodyId), { ...aux, orientation: 'top' }],
        /not seen square from its source/
      ],
      [[aux], /not seen square from its source/],
      [
        [
          front(bodyId),
          { ...aux, section: { sourceViewId: frontId, label: 'B', depth: 0 } }
        ],
        /cannot be an auxiliary view and/
      ]
    ];
    for (const [views, message] of bad)
      expect(drawingSetError({ sheets: [sheetOf(views)] })).toMatch(message);
  });

  it('places a view square to a sloping edge, drawing the face true size', async () => {
    const { bodies, bodyId } = await tilted();
    const base = sheetOf([front(bodyId)]);
    const views = composed(base, bodies);
    const edges = pickableEdges(base, views, bodies, 'mm');
    const edge = slopingEdge(bodies[bodyId]!);
    const hit = edges.find((entry) => entry.edge === edge)!;
    expect(auxiliaryEdgeRefusal(hit)).toBeNull();
    // A horizontal edge is refused: a principal view already sees it.
    const level = edges.find(
      (entry) =>
        entry.edge.curve?.type === 'LINE' &&
        Math.abs(entry.page[0]![1] - entry.page[entry.page.length - 1]![1]) <
          1e-9 &&
        Math.abs(entry.page[0]![0] - entry.page[entry.page.length - 1]![0]) > 1
    );
    if (level)
      expect(auxiliaryEdgeRefusal(level)).toMatch(/horizontal or vertical/);
    // Placed up and to the side of the edge.
    const mid = hit.page[Math.floor(hit.page.length / 2)]!;
    const draft = auxiliaryDraft(base, hit, [mid[0] + 40, mid[1] + 60])!;
    expect(draft.auxiliary!.label).toBe('A');
    const aux: DrawingView = { ...draft, viewId: auxId };
    const sheet = sheetOf([front(bodyId), aux]);
    expect(drawingSetError({ sheets: [sheet] })).toBeNull();
    const frame = drawingViewFrame(aux);
    // Square to the edge and to the front's sight; page-up is the front's sight.
    const p = edge.points;
    const e = {
      x: p[p.length - 3]! - p[0]!,
      y: 0,
      z: p[p.length - 1]! - p[2]!
    };
    expect(frame.direction.x * e.x + frame.direction.z * e.z).toBeCloseTo(0, 9);
    expect(frame.up.x).toBeCloseTo(0, 9);
    expect(frame.up.y).toBeCloseTo(1, 9);
    expect(frame.up.z).toBeCloseTo(0, 9);
    // The sloping face seen square: its 20 mm edge and the 10 mm across.
    const auxProjection = composed(sheet, bodies)[1]!.projection;
    const bounds = auxProjection.bounds!;
    const { min, max } = bodies[bodyId]!.bbox;
    expect(bounds.maxU - bounds.minU).toBeCloseTo(20, 5);
    expect(bounds.maxV - bounds.minV).toBeCloseTo(max.y - min.y, 5);
    // A dimension along the edge on the auxiliary view reads its true length.
    const annotations: DrawingAnnotation[] = [
      {
        annotationId: 'dann_e' as DrawingAnnotationId,
        kind: 'linear',
        viewId: auxId,
        direction: 'aligned',
        from: { edge: { bodyId, hash: edge.hash }, anchor: 'first' },
        to: { edge: { bodyId, hash: edge.hash }, anchor: 'second' },
        placementMm: { x: 0, y: 15 }
      }
    ];
    const dimensioned = { ...sheet, annotations };
    const resolution = resolveSheetAnnotations(dimensioned, bodies, 'mm').get(
      'dann_e' as DrawingAnnotationId
    )!;
    expect(resolution.ok && resolution.resolved.label).toBe('20');
    // VIEW A beneath it, and the arrow with its letter beside the front.
    const drawnViews = composed(dimensioned, bodies);
    const page = composeSheetPage(
      dimensioned,
      drawnViews,
      { projectName: 'Tilted', units: 'mm' },
      composeSheetAnnotations(
        dimensioned,
        drawnViews,
        resolveSheetAnnotations(dimensioned, bodies, 'mm'),
        'mm'
      )
    );
    const svg = sheetPageToSvg(page, 'Sheet 1');
    expect(svg).toContain('>VIEW A</text>');
    expect(
      page.strokes.filter((stroke) => stroke.filled).length
    ).toBeGreaterThanOrEqual(3);
    // The Detail tool passes over an auxiliary view, which validation
    // refuses as a detail's source.
    const auxEntry = drawnViews[1]!;
    const auxBox = viewPageBox(
      auxEntry.view,
      auxEntry.projection.bounds!,
      dimensioned,
      'mm'
    );
    expect(
      detailSourceAt(
        dimensioned,
        drawnViews,
        [auxBox.x + auxBox.width / 2, auxBox.y + auxBox.height / 2],
        'mm'
      )?.view.viewId
    ).not.toBe(auxId);
  });

  it('follows its source’s bodies, goes with it, and is gated below v81', async () => {
    const { document, bodyId } = await tilted();
    const aux: DrawingView = {
      ...front(bodyId),
      viewId: auxId,
      centerMm: { x: 250, y: 220 },
      auxiliary: {
        sourceViewId: frontId,
        label: 'A',
        direction: { x: 0.5, y: 0, z: -Math.sqrt(3) / 2 },
        x: { x: Math.sqrt(3) / 2, y: 0, z: 0.5 }
      }
    };
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({ sheet: sheetOf([front(bodyId)]) })
    );
    manager.execute(commandFactories.addDrawingView({ sheetId, view: aux }));
    expect(() => assertStorableDocument(manager.document)).not.toThrow();
    expect(() =>
      assertStorableDocument({ ...manager.document, schemaVersion: 77 })
    ).toThrow(/Auxiliary views require project schema v81/);
    expect(() =>
      manager.execute(
        commandFactories.updateDrawingView({
          sheetId,
          viewId: auxId,
          bodyIds: [bodyId]
        })
      )
    ).toThrow(/auxiliary view draws the bodies of its source view/);
    // A duplicated sheet's auxiliary view names the copied source.
    const sheetNow = manager.document.drawings!.sheets[0]!;
    const copy = duplicateDrawingSheet(sheetNow, [sheetNow]);
    expect(drawingSetError({ sheets: [copy] })).toBeNull();
    expect(copy.views[1]!.auxiliary!.sourceViewId).toBe(copy.views[0]!.viewId);
    manager.execute(
      commandFactories.deleteDrawingView({ sheetId, viewId: frontId })
    );
    expect(manager.document.drawings!.sheets[0]!.views).toHaveLength(0);
  });
});

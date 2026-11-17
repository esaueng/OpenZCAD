import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  assertStorableDocument,
  createProjectDocument,
  normalizeDocument,
  transformBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  drawingSetError,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingEdgeRef,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingView,
  type DrawingViewId,
  type EdgeTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { projectView } from '../apps/web/src/lib/drawing/projectView';
import { projectionBodyInput } from '../apps/web/src/lib/drawing/sheetSources';
import { composeSheetPage } from '../apps/web/src/lib/drawing/sheetPage';
import { sheetPageToSvg } from '../apps/web/src/lib/drawing/sheetExport';
import {
  annotationModelReading,
  composeSheetAnnotations,
  resolveSheetAnnotations,
  sheetMarkLookup,
  type AnnotationResolution
} from '../apps/web/src/lib/drawing/annotations';

/**
 * D02 geometry annotations (schema v73): centre marks, intersection marks
 * and centrelines, read from the model each time the sheet is drawn, and
 * marks as points dimensions measure to.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const sheetId = 'dsht_cl' as DrawingSheetId;
const frontId = 'dvw_front' as DrawingViewId;
const topId = 'dvw_top' as DrawingViewId;
const id = (name: string) => `dann_${name}` as DrawingAnnotationId;
const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;
const at = { x: 0, y: 0 };

/** A box beside a Ø8 pin standing 12 tall, moved 40 along x. */
async function model() {
  let document = createProjectDocument('Marks', toUserId('test'));
  document = addPrimitiveFeature(document, {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 10, depth: 6 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Pin',
    primitiveKind: 'cylinder',
    dimensions: { radius: 4, height: 12 }
  });
  document = transformBody(document, {
    name: 'Move',
    targetBodyId: document.bodyOrder[1]!,
    translation: { x: 40, y: 0, z: 0 }
  }).document;
  const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
  const [boxId, pinId] = document.bodyOrder as [BodyId, BodyId];
  const box = bodies[boxId]!;
  const { min, max } = box.bbox;
  const straight = (match: (a: number[], b: number[]) => boolean) => {
    const found = box.topology!.edges.filter((edge) => {
      const p = edge.points;
      const a = p.slice(0, 3);
      const b = p.slice(p.length - 3);
      return match(a, b) || match(b, a);
    });
    expect(found).toHaveLength(1);
    return ref(boxId, found[0]!);
  };
  // The front view looks along +Y: these are its near edges.
  const front = (axis: 0 | 2, value: number) =>
    straight(
      (a, b) =>
        near(a[1]!, min.y) &&
        near(b[1]!, min.y) &&
        near(a[axis]!, value) &&
        near(b[axis]!, value)
    );
  const pin = bodies[pinId]!;
  const rims = pin.topology!.edges.filter((edge) => edge.curve?.circle);
  const topRim = rims.reduce((best, edge) =>
    edge.curve!.circle!.center.z > best.curve!.circle!.center.z ? edge : best
  );
  // Seen from above, the box's left edge on its top face.
  const topLeft = straight(
    (a, b) =>
      near(a[0]!, min.x) &&
      near(b[0]!, min.x) &&
      near(a[2]!, max.z) &&
      near(b[2]!, max.z)
  );
  return {
    document,
    bodies,
    boxId,
    pinId,
    box: { min, max },
    pinX: topRim.curve!.circle!.center.x,
    top: front(2, max.z),
    bottom: front(2, min.z),
    left: front(0, min.x),
    right: front(0, max.x),
    topLeft,
    rim: ref(pinId, topRim)
  };
}

function ref(bodyId: BodyId, edge: EdgeTopology): DrawingEdgeRef {
  return {
    bodyId,
    hash: edge.hash,
    ...(edge.reference ? { reference: edge.reference } : {})
  };
}

function view(
  viewId: DrawingViewId,
  orientation: DrawingView['orientation'],
  bodyIds: BodyId[],
  centerMm: { x: number; y: number }
): DrawingView {
  return { viewId, orientation, bodyIds, centerMm, hiddenLines: false };
}

function sheetOf(
  bodyIds: BodyId[],
  annotations: DrawingAnnotation[]
): DrawingSheet {
  return {
    sheetId,
    name: 'Sheet 1',
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {},
    source: { fingerprint: 'v1:test' },
    views: [
      view(frontId, 'front', bodyIds, { x: 120, y: 120 }),
      view(topId, 'top', bodyIds, { x: 120, y: 220 })
    ],
    annotations
  };
}

function resolved(
  resolutions: Map<DrawingAnnotationId, AnnotationResolution>,
  name: string
) {
  const resolution = resolutions.get(id(name))!;
  if (!resolution.ok) throw new Error(`${name}: ${resolution.message}`);
  return resolution.resolved;
}

describe('D02 geometry annotations (schema v73)', () => {
  it('claims v73 and validates marks, centrelines and mark points by name', async () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(73);
    const { boxId, top, bottom, rim } = await model();
    const mark: DrawingAnnotation = {
      annotationId: id('m'),
      kind: 'center-mark',
      viewId: topId,
      edge: rim,
      placementMm: at
    };
    const check = (annotations: unknown[]) =>
      drawingSetError({
        sheets: [sheetOf([boxId], annotations as DrawingAnnotation[])]
      });
    expect(
      check([
        mark,
        {
          annotationId: id('c'),
          kind: 'centerline',
          viewId: topId,
          mode: 'points',
          from: { anchor: 'mark', annotationId: id('m') },
          to: { edge: top, anchor: 'first' },
          placementMm: at
        }
      ])
    ).toBeNull();
    // A missing mark is broken when drawn, not refused: deleting one must
    // never make the sheet unstorable.
    expect(
      check([
        {
          annotationId: id('c'),
          kind: 'centerline',
          viewId: topId,
          mode: 'points',
          from: { anchor: 'mark', annotationId: id('gone') },
          to: { edge: top, anchor: 'first' },
          placementMm: at
        }
      ])
    ).toBeNull();
    const bad: [unknown[], RegExp][] = [
      [[{ ...mark, viewId: undefined }], /mark that belongs to no view/],
      [[{ ...mark, decimals: 2 }], /mark, which states no value/],
      [[{ ...mark, tolerance: { kind: 'basic' } }], /states no value/],
      [
        [
          {
            annotationId: id('x'),
            kind: 'intersection-mark',
            viewId: frontId,
            edges: [top, top],
            placementMm: at
          }
        ],
        /names one edge twice/
      ],
      [
        [
          {
            annotationId: id('l'),
            kind: 'centerline',
            viewId: frontId,
            mode: 'lines',
            edges: [top],
            placementMm: at
          }
        ],
        /must name two edges/
      ],
      [
        [
          {
            annotationId: id('o'),
            kind: 'centerline',
            viewId: frontId,
            mode: 'circle',
            through: [
              { edge: top, anchor: 'first' },
              { edge: top, anchor: 'second' }
            ],
            placementMm: at
          }
        ],
        /three points/
      ],
      [
        [
          {
            annotationId: id('s'),
            kind: 'centerline',
            viewId: frontId,
            mode: 'points',
            from: { edge: top, anchor: 'silhouette', side: 'low' },
            to: { edge: bottom, anchor: 'first' },
            placementMm: at
          }
        ],
        /through an extreme/
      ],
      [
        [
          {
            annotationId: id('k'),
            kind: 'centerline',
            viewId: frontId,
            mode: 'spline',
            placementMm: at
          }
        ],
        /unknown centreline mode/
      ],
      // A mark point names a mark of its own view, never a dimension.
      [
        [
          mark,
          {
            annotationId: id('d'),
            kind: 'linear',
            viewId: frontId,
            direction: 'horizontal',
            from: { anchor: 'mark', annotationId: id('m') },
            to: { edge: top, anchor: 'first' },
            placementMm: at
          }
        ],
        /not a mark on its view/
      ]
    ];
    for (const [annotations, message] of bad)
      expect(check(annotations)).toMatch(message);
  });

  it('reads marks and centrelines from the kernel bodies, and dimensions to a mark', async () => {
    const {
      bodies,
      boxId,
      pinId,
      box,
      pinX,
      top,
      bottom,
      left,
      right,
      topLeft,
      rim
    } = await model();
    const [x0, z0, x1, z1] = [box.min.x, box.min.z, box.max.x, box.max.z];
    const annotations: DrawingAnnotation[] = [
      {
        annotationId: id('mark'),
        kind: 'center-mark',
        viewId: topId,
        edge: rim,
        placementMm: at
      },
      {
        annotationId: id('corner'),
        kind: 'intersection-mark',
        viewId: frontId,
        edges: [top, right],
        placementMm: at
      },
      {
        annotationId: id('mid'),
        kind: 'centerline',
        viewId: frontId,
        mode: 'lines',
        edges: [top, bottom],
        placementMm: at
      },
      {
        annotationId: id('bolt'),
        kind: 'centerline',
        viewId: frontId,
        mode: 'circle',
        through: [
          { edge: top, anchor: 'first' },
          { edge: top, anchor: 'second' },
          { edge: bottom, anchor: 'first' }
        ],
        placementMm: at
      },
      {
        annotationId: id('axis'),
        kind: 'centerline',
        viewId: frontId,
        mode: 'points',
        from: { anchor: 'mark', annotationId: id('corner') },
        to: { edge: left, anchor: 'first' },
        placementMm: at
      },
      // From the pin's centre mark to the box's left end, along x.
      {
        annotationId: id('dim'),
        kind: 'linear',
        viewId: topId,
        direction: 'horizontal',
        from: { anchor: 'mark', annotationId: id('mark') },
        to: { edge: topLeft, anchor: 'first' },
        placementMm: { x: 0, y: 20 }
      }
    ];
    const sheet = sheetOf([boxId, pinId], annotations);
    expect(drawingSetError({ sheets: [sheet] })).toBeNull();
    const resolutions = resolveSheetAnnotations(sheet, bodies, 'mm');
    const mark = resolved(resolutions, 'mark');
    expect(mark.kind === 'center-mark' && mark.radius).toBeCloseTo(4, 9);
    expect(mark.kind === 'center-mark' && mark.center[0]).toBeCloseTo(pinX, 9);
    // The front view sees x across and z up.
    const corner = resolved(resolutions, 'corner');
    expect(corner.kind === 'intersection-mark' && corner.point).toEqual([
      expect.closeTo(x1, 9),
      expect.closeTo(z1, 9)
    ]);
    const mid = resolved(resolutions, 'mid');
    expect(mid.kind === 'centerline' && mid.segment).toEqual([
      [expect.closeTo(x0, 9), expect.closeTo((z0 + z1) / 2, 9)],
      [expect.closeTo(x1, 9), expect.closeTo((z0 + z1) / 2, 9)]
    ]);
    const bolt = resolved(resolutions, 'bolt');
    expect(bolt.kind === 'centerline' && bolt.circle?.radius).toBeCloseTo(
      Math.hypot((x1 - x0) / 2, (z1 - z0) / 2),
      9
    );
    expect(bolt.kind === 'centerline' && bolt.circle?.center).toEqual([
      expect.closeTo((x0 + x1) / 2, 9),
      expect.closeTo((z0 + z1) / 2, 9)
    ]);
    const axis = resolved(resolutions, 'axis');
    expect(axis.kind === 'centerline' && axis.segment?.[0]).toEqual([
      expect.closeTo(x1, 9),
      expect.closeTo(z1, 9)
    ]);
    const dim = resolved(resolutions, 'dim');
    expect(Math.abs(pinX - x0)).toBeGreaterThan(20);
    expect(dim.label).toBe(String(Math.round((pinX - x0) * 100) / 100));

    // Deleting the mark breaks what measured to it, by name, and nothing
    // rebinds.
    const without = {
      ...sheet,
      annotations: annotations.filter(
        (entry) => entry.annotationId !== id('mark')
      )
    };
    const broken = resolveSheetAnnotations(without, bodies, 'mm').get(
      id('dim')
    )!;
    expect(broken.ok).toBe(false);
    expect(!broken.ok && broken.reason).toBe('mark-missing');
    // Parallel edges make no crossing; crossing edges no midline.
    const refused = resolveSheetAnnotations(
      sheetOf(
        [boxId],
        [
          {
            annotationId: id('p'),
            kind: 'intersection-mark',
            viewId: frontId,
            edges: [top, bottom],
            placementMm: at
          },
          {
            annotationId: id('q'),
            kind: 'centerline',
            viewId: frontId,
            mode: 'lines',
            edges: [top, right],
            placementMm: at
          },
          {
            annotationId: id('r'),
            kind: 'centerline',
            viewId: frontId,
            mode: 'circle',
            through: [
              { edge: top, anchor: 'first' },
              { edge: top, anchor: 'second' },
              { anchor: 'mark', annotationId: id('gone') }
            ],
            placementMm: at
          }
        ]
      ),
      bodies,
      'mm'
    );
    const reason = (name: string) => {
      const entry = refused.get(id(name))!;
      return entry.ok ? 'ok' : entry.reason;
    };
    expect(reason('p')).toBe('parallel');
    expect(reason('q')).toBe('not-parallel');
    expect(reason('r')).toBe('mark-missing');
  });

  it('lets the dimension check read a dimension measured to a mark', async () => {
    const { bodies, boxId, pinId, rim, topLeft } = await model();
    const annotations: DrawingAnnotation[] = [
      {
        annotationId: id('mark'),
        kind: 'center-mark',
        viewId: topId,
        edge: rim,
        placementMm: at
      },
      {
        annotationId: id('dim'),
        kind: 'linear',
        viewId: topId,
        direction: 'horizontal',
        from: { anchor: 'mark', annotationId: id('mark') },
        to: { edge: topLeft, anchor: 'first' },
        placementMm: { x: 0, y: 20 }
      }
    ];
    const sheet = sheetOf([boxId, pinId], annotations);
    const view = sheet.views.find((entry) => entry.viewId === topId)!;
    const reading = annotationModelReading(
      annotations[1]!,
      view,
      bodies,
      'mm',
      sheetMarkLookup(sheet)
    );
    // Read as a span from the pin's mark to the box: two bodies.
    expect(reading?.kind).toBe('linear');
    expect(reading?.kind === 'linear' && reading.bodyIds).toEqual([
      pinId,
      boxId
    ]);
    // Without the sheet's marks it would read nothing.
    expect(
      annotationModelReading(annotations[1]!, view, bodies, 'mm')
    ).toBeNull();
  });

  it('marks where an edge sloping into the view crosses another, on the page', async () => {
    let document = createProjectDocument('Sloped', toUserId('test'));
    document = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 10, depth: 6 }
    });
    document = transformBody(document, {
      name: 'Turn',
      targetBodyId: document.bodyOrder[0]!,
      translation: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 30, z: 0 }
    }).document;
    const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
    const bodyId = document.bodyOrder.at(-1)!;
    const body = bodies[bodyId]!;
    // Seen from above, an x-wise edge now slopes into the view; a y-wise
    // edge at its end stays level. Their lines still cross on the page.
    const lines = body.topology!.edges.filter(
      (edge) => edge.curve?.type === 'LINE'
    );
    const len = (edge: EdgeTopology) => {
      const p = edge.points;
      const n = p.length;
      return Math.hypot(
        p[n - 3]! - p[0]!,
        p[n - 2]! - p[1]!,
        p[n - 1]! - p[2]!
      );
    };
    const sloped = lines.find(
      (edge) =>
        near(len(edge), 20) &&
        !near(edge.points[2]!, edge.points[edge.points.length - 1]!)
    )!;
    const level = lines.find((edge) => {
      const p = edge.points;
      const n = p.length;
      return (
        near(p[0]!, p[n - 3]!) &&
        near(p[2]!, p[n - 1]!) &&
        [0, n - 3].some((i) =>
          [0, sloped.points.length - 3].some(
            (j) =>
              near(p[i]!, sloped.points[j]!) &&
              near(p[i + 1]!, sloped.points[j + 1]!) &&
              near(p[i + 2]!, sloped.points[j + 2]!)
          )
        )
      );
    })!;
    expect(sloped && level).toBeTruthy();
    const sheet = sheetOf(
      [bodyId],
      [
        {
          annotationId: id('x'),
          kind: 'intersection-mark',
          viewId: topId,
          edges: [ref(bodyId, sloped), ref(bodyId, level)],
          placementMm: at
        }
      ]
    );
    const resolution = resolveSheetAnnotations(sheet, bodies, 'mm').get(
      id('x')
    )!;
    expect(resolution.ok).toBe(true);
  });

  it('draws centre lines as chain lines past the rim and exports them', async () => {
    const { document, bodies, boxId, pinId, top, bottom, rim } = await model();
    const sheet = sheetOf(
      [boxId, pinId],
      [
        {
          annotationId: id('mark'),
          kind: 'center-mark',
          viewId: topId,
          edge: rim,
          placementMm: at
        },
        {
          annotationId: id('mid'),
          kind: 'centerline',
          viewId: frontId,
          mode: 'lines',
          edges: [top, bottom],
          placementMm: at
        }
      ]
    );
    const views = sheet.views.map((entry) => ({
      view: entry,
      projection: projectView({
        orientation: entry.orientation,
        hiddenLines: entry.hiddenLines,
        bodies: entry.bodyIds.map((bodyId) =>
          projectionBodyInput(bodies[bodyId]!)!
        )
      })
    }));
    const layer = composeSheetAnnotations(
      sheet,
      views,
      resolveSheetAnnotations(sheet, bodies, 'mm'),
      'mm'
    );
    const chains = layer.strokes.filter((stroke) => stroke.kind === 'chain');
    // Two across the Ø8 rim, run 2.5 mm past it each side; one midline run
    // 2.5 mm past the box's 20 mm each end.
    const lengths = chains
      .map((stroke) =>
        Math.hypot(
          stroke.points[2]! - stroke.points[0]!,
          stroke.points[3]! - stroke.points[1]!
        )
      )
      .sort((a, b) => a - b);
    expect(lengths).toEqual([
      expect.closeTo(13, 9),
      expect.closeTo(13, 9),
      expect.closeTo(25, 9)
    ]);
    expect(layer.texts).toHaveLength(0);
    expect(layer.boxes.size).toBe(2);
    const svg = sheetPageToSvg(
      composeSheetPage(
        sheet,
        views,
        { projectName: document.name, units: 'mm' },
        layer
      ),
      sheet.name
    );
    expect(svg).toContain('<g class="chain"');
  });

  it('stores marks through one undoable command each, gated below v73', async () => {
    const { document, boxId, pinId, rim } = await model();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({ sheet: sheetOf([boxId, pinId], []) })
    );
    manager.execute(
      commandFactories.addDrawingAnnotation({
        sheetId,
        annotation: {
          annotationId: id('mark'),
          kind: 'center-mark',
          viewId: topId,
          edge: rim,
          placementMm: at
        }
      })
    );
    expect(manager.document.drawings!.sheets[0]!.annotations).toHaveLength(1);
    expect(() => assertStorableDocument(manager.document)).not.toThrow();
    const saved = normalizeDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    expect(saved.drawings).toEqual(manager.document.drawings);
    expect(() =>
      assertStorableDocument({
        ...manager.document,
        schemaVersion: 72
      })
    ).toThrow(
      /Centre marks, intersection marks and centrelines require project schema v73/
    );
    manager.undo();
    expect(manager.document.drawings!.sheets[0]!.annotations ?? []).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  assertStorableDocument,
  createProjectDocument,
  holeBody,
  holeCallout,
  normalizeDocument,
  type HoleInput
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  drawingSetError,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingViewId,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  composeSheetAnnotations,
  drawingNumberFormat,
  generalToleranceTable,
  resolveDrawingAnnotation,
  resolveSheetAnnotations
} from '../apps/web/src/lib/drawing/annotations';
import { composeSheetPage } from '../apps/web/src/lib/drawing/sheetPage';
import {
  sheetPageToDxf,
  sheetPageToPdf,
  sheetPageToSvg
} from '../apps/web/src/lib/drawing/sheetExport';
import {
  draftAnnotation,
  startAnnotationTool
} from '../apps/web/src/lib/drawing/annotationPicking';
import {
  fitDeviations,
  formatArcMinutes
} from '../apps/web/src/lib/drawing/isoTolerances';

/**
 * D07 slice B (schema v105): ISO 286 fit classes and ISO 965 / UN thread
 * classes on diameters, and the general-tolerance block (ISO 2768-1, or
 * stated per decimal place).
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const sheetId = 'dsht_fit' as DrawingSheetId;
const topId = 'dvw_top' as DrawingViewId;
const id = (name: string) => `dann_${name}` as DrawingAnnotationId;
const at = { x: 0, y: 0 };
const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;

const topView = (bodyId: BodyId) => ({
  viewId: topId,
  orientation: 'top' as const,
  bodyIds: [bodyId],
  centerMm: { x: 120, y: 150 },
  hiddenLines: false
});

function sheetOf(
  bodyId: BodyId,
  annotations: DrawingAnnotation[],
  format?: DrawingSheet['format']
): DrawingSheet {
  return {
    sheetId,
    name: 'Sheet 1',
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 1 },
    projectionAngle: 'first',
    titleBlock: {},
    source: { fingerprint: 'v1:test' },
    views: [topView(bodyId)],
    annotations,
    ...(format ? { format } : {})
  };
}

/** A Ø`diameter` pin's top rim, seen face-on from above. */
async function pin(radius: number) {
  const document = addPrimitiveFeature(
    createProjectDocument('Pin', toUserId('test')),
    {
      name: 'Pin',
      primitiveKind: 'cylinder',
      dimensions: { radius, height: 12 }
    }
  );
  const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
  const bodyId = last(document);
  const rim = bodies[bodyId]!.topology!.edges.find(
    (edge) => edge.curve?.circle && edge.curve.circle.center.z > 6
  )!;
  return {
    document,
    bodies,
    bodyId,
    edge: {
      bodyId,
      hash: rim.hash,
      ...(rim.reference ? { reference: rim.reference } : {})
    }
  };
}

function diameter(
  edge: Awaited<ReturnType<typeof pin>>['edge'],
  extra: Partial<Record<string, unknown>> = {}
): DrawingAnnotation {
  return {
    annotationId: id('d'),
    kind: 'diameter',
    viewId: topId,
    edge,
    placementMm: { x: 20, y: 20 },
    ...extra
  };
}

describe('D07 fits and general tolerances (schema v105)', () => {
  it('reads ISO 286-1 limits for the classes it states', () => {
    // [fit, nominal mm, upper, lower], against ISO 286-2's tables.
    const cases: [string, number, number, number][] = [
      ['H7', 10, 0.015, 0],
      ['g6', 10, -0.005, -0.014],
      ['h6', 10, 0, -0.009],
      ['H7', 25, 0.021, 0],
      ['k6', 25, 0.015, 0.002],
      ['m6', 25, 0.021, 0.008],
      ['n6', 25, 0.028, 0.015],
      ['p6', 25, 0.035, 0.022],
      ['f7', 50, -0.025, -0.05],
      ['F7', 15, 0.034, 0.016],
      ['G7', 25, 0.028, 0.007],
      // ±IT/2 exactly: IT7 at 18–30 mm is 21 µm, and JS7 at 6–10 mm 15.
      ['js7', 25, 0.0105, -0.0105],
      ['JS7', 10, 0.0075, -0.0075],
      ['JS6', 20, 0.0065, -0.0065],
      // k is 0 below IT4 and above IT7.
      ['k8', 25, 0.033, 0],
      // Range edges: 3 is in "up to 3", 500 in the last range.
      ['H7', 3, 0.01, 0],
      ['H7', 3.0001, 0.012, 0],
      ['H11', 500, 0.4, 0],
      ['h9', 120, 0, -0.087]
    ];
    for (const [fit, size, upper, lower] of cases) {
      const found = fitDeviations(fit, size)!;
      expect([fit, size, found.upper]).toEqual([fit, size, upper]);
      expect([fit, size, found.lower]).toEqual([fit, size, lower]);
    }
    expect(fitDeviations('H7', 500.5)).toBeNull();
    expect(fitDeviations('H7', 0)).toBeNull();
    expect(formatArcMinutes(90)).toBe("1°30'");
    expect(formatArcMinutes(30)).toBe("0°30'");
    expect(formatArcMinutes(120)).toBe('2°');
  });

  it('claims v105 and validates fits, thread classes and blocks by name', async () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(105);
    const { bodyId, edge } = await pin(5);
    const check = (annotations: unknown[]) =>
      drawingSetError({
        sheets: [sheetOf(bodyId, annotations as DrawingAnnotation[])]
      });
    const block = {
      annotationId: id('g'),
      kind: 'general-tolerance',
      scheme: 'iso-2768',
      linearClass: 'm',
      geometricClass: 'K',
      placementMm: at
    };
    const stated = {
      annotationId: id('s'),
      kind: 'general-tolerance',
      scheme: 'decimal',
      places: [
        { decimals: 1, amount: 0.1 },
        { decimals: 2, amount: 0.05 }
      ],
      angle: 0.5,
      placementMm: at
    };
    expect(
      check([
        diameter(edge, { fit: 'H7' }),
        { ...diameter(edge, { threadClass: '6H' }), annotationId: id('t') },
        block,
        stated
      ])
    ).toBeNull();
    const bad: [unknown[], RegExp][] = [
      [[diameter(edge, { fit: 'K7' })], /ISO 286 hole F, G, H or JS/],
      [[diameter(edge, { fit: 'H12' })], /grade 5 to 11/],
      [
        [diameter(edge, { fit: 'H7', tolerance: { kind: 'basic' } })],
        /both a fit and a tolerance/
      ],
      [[diameter(edge, { fit: 'H7', reference: true })], /takes no fit/],
      [
        [diameter(edge, { fit: 'H7', threadClass: '6H' })],
        /both a fit and a thread class/
      ],
      [[diameter(edge, { threadClass: '6g' })], /ISO 965 internal/],
      [
        [{ ...diameter(edge, { fit: 'H7' }), kind: 'radius' }],
        /only a diameter/
      ],
      [[{ ...block, viewId: topId }], /has no viewId/],
      [[{ ...block, linearClass: 'x' }], /other than f, m, c or v/],
      [[{ ...block, geometricClass: 'M' }], /other than H, K or L/],
      [[{ ...block, scheme: 'ansi' }], /unknown scheme/],
      [[{ ...stated, places: [] }], /one to four/],
      [
        [
          {
            ...stated,
            places: [
              { decimals: 1, amount: 0.1 },
              { decimals: 1, amount: 0.2 }
            ]
          }
        ],
        /1 decimal places twice/
      ],
      [[{ ...stated, places: [{ decimals: 1, amount: -1 }] }], /positive/],
      [[{ ...stated, angle: 90 }], /under 90°/]
    ];
    for (const [annotations, message] of bad)
      expect(check(annotations)).toMatch(message);
  });

  it('prints a fit with its limits for the size the model has now', async () => {
    const small = await pin(4);
    const view = topView(small.bodyId);
    const fitted = resolveDrawingAnnotation(
      diameter(small.edge, { fit: 'H7' }),
      view,
      small.bodies,
      'mm'
    );
    // Ø8 is in 6–10 mm: IT7 = 15 µm.
    expect(fitted.ok && fitted.resolved.label).toBe('Ø8 H7 +0.015/0');
    const shaft = resolveDrawingAnnotation(
      diameter(small.edge, { fit: 'g6' }),
      view,
      small.bodies,
      'mm'
    );
    expect(shaft.ok && shaft.resolved.label).toBe('Ø8 g6 -0.005/-0.014');
    // A bigger pin reads its own range's limits from the same class.
    const big = await pin(12.5);
    const bigger = resolveDrawingAnnotation(
      diameter(big.edge, { fit: 'g6' }),
      topView(big.bodyId),
      big.bodies,
      'mm'
    );
    expect(bigger.ok && bigger.resolved.label).toBe('Ø25 g6 -0.007/-0.020');
    // Printed in inches, the limits convert; a comma sheet writes commas.
    const inches = resolveDrawingAnnotation(
      diameter(small.edge, { fit: 'H7' }),
      view,
      small.bodies,
      'mm',
      undefined,
      drawingNumberFormat({ units: 'inch' }, 'mm')
    );
    expect(inches.ok && inches.resolved.label).toBe('Ø0.315 H7 +0.000591/0');
    const comma = resolveDrawingAnnotation(
      diameter(small.edge, { fit: 'H7' }),
      view,
      small.bodies,
      'mm',
      undefined,
      drawingNumberFormat({ decimalSeparator: 'comma' }, 'mm')
    );
    expect(comma.ok && comma.resolved.label).toBe('Ø8 H7 +0,015/0');
    // Over 500 mm the tables state nothing: broken by name.
    const huge = await pin(260);
    const out = resolveDrawingAnnotation(
      diameter(huge.edge, { fit: 'H7' }),
      topView(huge.bodyId),
      huge.bodies,
      'mm'
    );
    expect(!out.ok && out.reason).toBe('fit-out-of-range');
  });

  it('classes a tapped hole’s thread, and breaks on a plain or mismatched bore', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Plate', toUserId('test')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 40, depth: 10 }
      }
    );
    const derived = await adapter.syncDocument(document);
    const body = derived.bodyRepresentations[last(document)]!;
    const face = body.topology!.faces.find(
      (candidate) =>
        candidate.geometry?.surfaceType === 'plane' &&
        (candidate.geometry.normal?.z ?? 0) > 0.999 &&
        Math.abs(
          (candidate.geometry.centroid ?? candidate.geometry.center).z -
            body.bbox.max.z
        ) < 1e-6
    )!;
    const tap: HoleInput['standard'] = {
      system: 'iso',
      size: 'M6',
      kind: 'tap-drill'
    };
    const drill = (extra: Partial<HoleInput>) =>
      holeBody(document, {
        name: 'Hole',
        targetBodyId: last(document),
        faceHash: face.hash,
        ...(face.reference ? { faceReference: face.reference } : {}),
        style: 'simple',
        diameter: 5,
        depthMode: 'through',
        position: { u: 0, v: 0 },
        positionAnchor: 'centroid',
        standard: tap,
        ...extra
      }).document;
    const read = async (
      holed: ProjectDocument,
      extra: Record<string, unknown>
    ) => {
      const bodies = (await adapter.syncDocument(holed)).bodyRepresentations;
      const bodyId = last(holed);
      const rim = bodies[bodyId]!.topology!.edges.find(
        (edge) =>
          edge.curve?.circle &&
          Math.abs(edge.curve.circle.radius - 2.5) < 1e-6 &&
          Math.abs(edge.curve.circle.center.z - 10) < 1e-6
      )!;
      return resolveDrawingAnnotation(
        diameter(
          {
            bodyId,
            hash: rim.hash,
            ...(rim.reference ? { reference: rim.reference } : {})
          },
          extra
        ),
        topView(bodyId),
        bodies,
        'mm',
        (featureId: FeatureId) => holeCallout(holed, featureId)
      );
    };
    const tapped = drill({ tapped: { cosmetic: true } });
    const classed = await read(tapped, { threadClass: '6H' });
    expect(classed.ok && classed.resolved.label).toBe('M6×1-6H THRU');
    const inch = await read(tapped, { threadClass: '2B' });
    expect(!inch.ok && inch.reason).toBe('thread-class-mismatch');
    // A tap drill with no thread has none to class.
    const plain = await read(drill({}), { threadClass: '6H' });
    expect(!plain.ok && plain.reason).toBe('not-threaded');
    // A fit on the bore states the bore, not the callout.
    const reamed = await read(drill({}), { fit: 'H7' });
    expect(reamed.ok && reamed.resolved.label).toBe('Ø5 H7 +0.012/0');
  }, 180_000);

  it('prints the ISO 2768-1 tables and a stated block', () => {
    const iso = generalToleranceTable(
      {
        annotationId: id('g'),
        kind: 'general-tolerance',
        scheme: 'iso-2768',
        linearClass: 'v',
        geometricClass: 'L',
        placementMm: at
      },
      drawingNumberFormat(undefined, 'mm')
    );
    expect(iso.label).toBe('ISO 2768-vL');
    expect(iso.header).toEqual(['ISO 2768-vL (mm)', 'Tolerance']);
    // Class v states nothing from 0.5 to 3 mm.
    expect(iso.rows.slice(0, 2)).toEqual([
      ['over 3 to 6', '±0.5'],
      ['over 6 to 30', '±1']
    ]);
    expect(iso.rows.slice(-5)).toEqual([
      ['angles, side to 10', '±3°'],
      ['angles, side over 10 to 50', '±2°'],
      ['angles, side over 50 to 120', '±1°'],
      ['angles, side over 120 to 400', "±0°30'"],
      ['angles, side over 400', "±0°20'"]
    ]);
    const medium = generalToleranceTable(
      {
        annotationId: id('g'),
        kind: 'general-tolerance',
        scheme: 'iso-2768',
        linearClass: 'm',
        placementMm: at
      },
      drawingNumberFormat({ decimalSeparator: 'comma' }, 'mm')
    );
    expect(medium.rows[0]).toEqual(['over 0,5 to 3', '±0,1']);
    expect(medium.rows).toHaveLength(13);
    const stated = generalToleranceTable(
      {
        annotationId: id('s'),
        kind: 'general-tolerance',
        scheme: 'decimal',
        places: [
          { decimals: 3, amount: 0.005 },
          { decimals: 2, amount: 0.01 }
        ],
        angle: 0.5,
        placementMm: at
      },
      drawingNumberFormat({ units: 'inch' }, 'mm')
    );
    expect(stated.header).toEqual(['Unless stated (in)', 'Tolerance']);
    expect(stated.rows).toEqual([
      ['X.XX', '±0.01'],
      ['X.XXX', '±0.005'],
      ['Angles', '±0.5°']
    ]);
  });

  it('lays the block out on the paper and exports it', async () => {
    const { document, bodies, bodyId, edge } = await pin(4);
    const sheet = sheetOf(bodyId, [
      diameter(edge, { fit: 'H7' }),
      {
        annotationId: id('g'),
        kind: 'general-tolerance',
        scheme: 'iso-2768',
        linearClass: 'm',
        geometricClass: 'K',
        placementMm: { x: 20, y: 120 }
      }
    ]);
    const { projectView } =
      await import('../apps/web/src/lib/drawing/projectView');
    const { projectionBodyInput } =
      await import('../apps/web/src/lib/drawing/sheetSources');
    const views = sheet.views.map((entry) => ({
      view: entry,
      projection: projectView({
        orientation: entry.orientation,
        hiddenLines: entry.hiddenLines,
        bodies: entry.bodyIds.map((body) => projectionBodyInput(bodies[body]!)!)
      })
    }));
    const layer = composeSheetAnnotations(
      sheet,
      views,
      resolveSheetAnnotations(sheet, bodies, 'mm'),
      'mm'
    );
    const box = layer.boxes.get(id('g'))!;
    // Its top-left corner at the placement; a header and 13 rows of 6 mm.
    expect(box.x).toBe(20);
    expect(box.y + box.height).toBe(120);
    expect(box.height).toBe(14 * 6);
    const page = composeSheetPage(
      sheet,
      views,
      { projectName: document.name, units: 'mm' },
      layer
    );
    const svg = sheetPageToSvg(page, sheet.name);
    expect(svg).toContain('>ISO 2768-mK (mm)<');
    expect(svg).toContain('>Ø8 H7<');
    const pdf = new TextDecoder('latin1').decode(
      sheetPageToPdf(page, sheet.name)
    );
    expect(pdf).toContain('(over 0.5 to 3)');
    expect(sheetPageToDxf(page)).toContain('ISO 2768-mK (mm)');
  });

  it('drafts a block from its tool, stores it undoably, gated below v105', async () => {
    const { document, bodyId, edge } = await pin(4);
    const tool = {
      ...startAnnotationTool('general-tolerance'),
      placed: { x: 20, y: 120 }
    };
    const block = draftAnnotation(tool, id('g'), { x: 20, y: 120 });
    expect(block).toEqual({
      annotationId: id('g'),
      kind: 'general-tolerance',
      scheme: 'iso-2768',
      linearClass: 'm',
      placementMm: { x: 20, y: 120 }
    });
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({ sheet: sheetOf(bodyId, []) })
    );
    for (const annotation of [block!, diameter(edge, { fit: 'h6' })])
      manager.execute(
        commandFactories.addDrawingAnnotation({ sheetId, annotation })
      );
    expect(() => assertStorableDocument(manager.document)).not.toThrow();
    const saved = normalizeDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    expect(saved.drawings).toEqual(manager.document.drawings);
    expect(() =>
      assertStorableDocument({
        ...manager.document,
        schemaVersion: 104
      })
    ).toThrow(/Fits and general tolerances require project schema v105/);
    manager.undo();
    expect(manager.document.drawings!.sheets[0]!.annotations).toHaveLength(1);
  });
});

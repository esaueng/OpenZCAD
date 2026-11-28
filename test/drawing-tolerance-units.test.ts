import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  assertStorableDocument,
  createProjectDocument,
  normalizeDocument
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  drawingAnnotationError,
  drawingToleranceError,
  MIN_DRAWING_TOLERANCE_MM,
  pinDrawingToleranceUnits,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingDimension,
  type DrawingEdgeRef,
  type DrawingFeatureControlFrame,
  type DrawingLinearDimension,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingViewId,
  type EdgeTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { projectView } from '../apps/web/src/lib/drawing/projectView';
import { projectionBodyInput } from '../apps/web/src/lib/drawing/sheetSources';
import { composeSheetPage } from '../apps/web/src/lib/drawing/sheetPage';
import {
  sheetPageToDxf,
  sheetPageToPdf,
  sheetPageToSvg
} from '../apps/web/src/lib/drawing/sheetExport';
import {
  composeSheetAnnotations,
  drawingNumberFormat,
  formatDimension,
  formatFrameTolerance,
  MAX_CONVERTED_TOLERANCE_DECIMALS,
  resolveSheetAnnotations
} from '../apps/web/src/lib/drawing/annotations';

/**
 * D02/D07 tolerance units (schema v156, #2162, #2238): a length tolerance's
 * deviations and a feature control frame's amount state the units they are
 * in, and the sheet converts them to the units it prints in. Changing the
 * sheet's dimension units therefore never changes what a tolerance means,
 * and a tolerance stated before v156 (in the sheet's printed units) is
 * pinned to those units by the update that changes them.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const sheetId = 'dsht_tu' as DrawingSheetId;
const frontId = 'dvw_front' as DrawingViewId;
const id = (name: string) => `dann_${name}` as DrawingAnnotationId;
const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;
const viewIds = new Set<string>([frontId]);

function topEdge(body: BodyRepresentation): EdgeTopology {
  const { min, max } = body.bbox;
  const found = body.topology!.edges.filter((edge) => {
    const p = edge.points;
    const a = p.slice(0, 3);
    const b = p.slice(p.length - 3);
    return (
      near(a[1]!, min.y) &&
      near(b[1]!, min.y) &&
      near(a[2]!, max.z) &&
      near(b[2]!, max.z)
    );
  });
  expect(found).toHaveLength(1);
  return found[0]!;
}

function width(
  ref: DrawingEdgeRef,
  extra: Partial<DrawingLinearDimension> = {}
): DrawingLinearDimension {
  return {
    annotationId: id('w'),
    kind: 'linear',
    viewId: frontId,
    direction: 'horizontal',
    from: { edge: ref, anchor: 'first' },
    to: { edge: ref, anchor: 'second' },
    placementMm: { x: 0, y: 12 },
    ...extra
  };
}

function frame(
  extra: Partial<DrawingFeatureControlFrame> = {}
): DrawingFeatureControlFrame {
  return {
    annotationId: id('f'),
    kind: 'feature-control-frame',
    viewId: frontId,
    attachedTo: id('w'),
    characteristic: 'flatness',
    amount: 0.1,
    placementMm: { x: 0, y: 24 },
    ...extra
  };
}

function sheetOf(
  bodyIds: BodyId[],
  annotations: DrawingAnnotation[]
): DrawingSheet {
  return {
    sheetId,
    name: 'Sheet 1',
    paper: { size: 'ANSI-B', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {},
    source: { fingerprint: 'v1:test' },
    views: [
      {
        viewId: frontId,
        orientation: 'front',
        bodyIds,
        centerMm: { x: 120, y: 150 },
        hiddenLines: false
      }
    ],
    annotations
  };
}

async function boxModel() {
  const document = addPrimitiveFeature(
    createProjectDocument('Toleranced part', toUserId('test')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 25.4, height: 10, depth: 6 }
    }
  );
  const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
  const bodyId = document.bodyOrder[0]!;
  const edge = topEdge(bodies[bodyId]!);
  const ref: DrawingEdgeRef = {
    bodyId,
    hash: edge.hash,
    ...(edge.reference ? { reference: edge.reference } : {})
  };
  return { document, bodies, bodyId, ref };
}

/** The sheet drawn, with its labels and its three export files' text. */
function drawn(
  sheet: DrawingSheet,
  bodies: Record<string, BodyRepresentation>
) {
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
  const resolutions = resolveSheetAnnotations(sheet, bodies, 'mm');
  const label = (name: string) => {
    const resolution = resolutions.get(id(name))!;
    if (!resolution.ok) throw new Error(resolution.message);
    return resolution.resolved.label;
  };
  const page = composeSheetPage(
    sheet,
    views,
    { projectName: 'Toleranced part', units: 'mm', date: '2026-11-28' },
    composeSheetAnnotations(sheet, views, resolutions, 'mm')
  );
  return {
    width: label('w'),
    frame: label('f'),
    svg: sheetPageToSvg(page, 'Sheet 1'),
    dxf: sheetPageToDxf(page),
    pdf: new TextDecoder('latin1').decode(sheetPageToPdf(page, 'Sheet 1'))
  };
}

const sheetIn = (document: ProjectDocument) => document.drawings!.sheets[0]!;

describe('D02/D07 tolerance units (schema v156)', () => {
  it('claims v156 and validates stated units', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(156);
    expect(
      drawingToleranceError({
        kind: 'limits',
        upper: 0.02,
        lower: -0.01,
        units: 'mm'
      })
    ).toBeNull();
    expect(
      drawingToleranceError({ kind: 'symmetric', value: 0.1, units: 'inch' })
    ).toBeNull();
    expect(
      drawingToleranceError({ kind: 'symmetric', value: 0.1, units: 'ft' })
    ).toMatch(/unknown units/);
    expect(drawingToleranceError({ kind: 'basic', units: 'mm' })).toMatch(
      /basic tolerance with unknown fields/
    );
    expect(
      drawingToleranceError({
        kind: 'deviation',
        upper: 0.1,
        lower: 0,
        units: 'mm',
        extra: 1
      })
    ).toMatch(/unknown fields/);
    const ref: DrawingEdgeRef = { bodyId: 'b' as BodyId, hash: 7 };
    expect(
      drawingAnnotationError(
        width(ref, {
          tolerance: { kind: 'symmetric', value: 0.1, units: 'mm' }
        }),
        viewIds,
        'Annotation 1'
      )
    ).toBeNull();
    // An angle's tolerance is in degrees and states no units.
    const angle = {
      annotationId: id('a'),
      kind: 'angle',
      viewId: frontId,
      edges: [ref, { ...ref, hash: 8 }],
      placementMm: { x: 0, y: 0 },
      tolerance: { kind: 'symmetric', value: 0.5, units: 'mm' }
    };
    expect(drawingAnnotationError(angle, viewIds, 'Annotation 1')).toMatch(
      /measures an angle/
    );
    expect(
      drawingAnnotationError(frame({ units: 'inch' }), viewIds, 'Annotation 2')
    ).toBeNull();
    expect(
      drawingAnnotationError(
        { ...frame(), units: 'yard' },
        viewIds,
        'Annotation 2'
      )
    ).toMatch(/unknown units/);
  });

  it('prints millimetre tolerances converted on an inch sheet (#2162, #2238)', () => {
    const ref: DrawingEdgeRef = { bodyId: 'b' as BodyId, hash: 7 };
    // The issue's 7.4 mm bore, +0.02/−0.01 mm limits, at five decimals.
    const inches = drawingNumberFormat({ units: 'inch', decimals: 5 }, 'mm');
    const bore = (value: number, decimals: number) => ({
      symbol: 'Ø',
      value: value * inches.lengthFactor,
      decimals,
      kind: 'length' as const
    });
    expect(
      formatDimension(
        width(ref, {
          tolerance: { kind: 'limits', upper: 0.02, lower: -0.01, units: 'mm' }
        }),
        bore(7.4, 5),
        inches
      ).text?.stack
    ).toEqual(['0.29213', '0.29094']);
    // The retest's +0.013/−0.004 mm deviation, six decimals, comma.
    const comma = drawingNumberFormat(
      { units: 'inch', decimals: 6, decimalSeparator: 'comma' },
      'mm'
    );
    expect(
      formatDimension(
        width(ref, {
          tolerance: {
            kind: 'deviation',
            upper: 0.013,
            lower: -0.004,
            units: 'mm'
          }
        }),
        { ...bore(7.4, 6), value: 7.4 * comma.lengthFactor },
        comma
      ).text?.stack
    ).toEqual(['+0,000512', '-0,000157']);
    // A symmetric amount converts too, keeping enough digits to stay 0.1 mm.
    expect(
      formatDimension(
        width(ref, {
          tolerance: { kind: 'symmetric', value: 0.1, units: 'mm' }
        }),
        { ...bore(25.4, 3), value: 1 },
        drawingNumberFormat({ units: 'inch' }, 'mm')
      ).label
    ).toBe('Ø1 ±0.0039');
    // A frame's 0.1 mm is 0.0039 in; an exact conversion prints exactly.
    const inch = drawingNumberFormat({ units: 'inch' }, 'mm');
    const mm = drawingNumberFormat(undefined, 'mm');
    expect(formatFrameTolerance(0.1, inch, 'mm')).toBe('0.0039');
    expect(formatFrameTolerance(0.002, mm, 'inch')).toBe('0.0508');
    // Stated in the printed units, or not stated at all, nothing converts.
    expect(formatFrameTolerance(0.1, mm, 'mm')).toBe('0.1');
    expect(formatFrameTolerance(0.002, inch)).toBe('0.002');
  });

  it('pins only the unstated length tolerances and frames', () => {
    const ref: DrawingEdgeRef = { bodyId: 'b' as BodyId, hash: 7 };
    const angle = {
      annotationId: id('a'),
      kind: 'angle',
      viewId: frontId,
      edges: [ref, { ...ref, hash: 8 }],
      placementMm: { x: 0, y: 0 },
      tolerance: { kind: 'symmetric', value: 0.5 }
    } as DrawingDimension;
    const basic = width(ref, {
      annotationId: id('b'),
      tolerance: { kind: 'basic' }
    });
    const stated = width(ref, {
      annotationId: id('s'),
      tolerance: { kind: 'symmetric', value: 0.002, units: 'inch' }
    });
    const legacy = width(ref, {
      tolerance: { kind: 'limits', upper: 0.02, lower: -0.01 }
    });
    const pinned = pinDrawingToleranceUnits(
      [legacy, angle, basic, stated, frame(), frame({ units: 'inch' })],
      'mm'
    );
    expect(pinned[0]).toEqual({
      ...legacy,
      tolerance: { kind: 'limits', upper: 0.02, lower: -0.01, units: 'mm' }
    });
    expect(pinned[1]).toBe(angle);
    expect(pinned[2]).toBe(basic);
    expect(pinned[3]).toBe(stated);
    expect(pinned[4]).toEqual(frame({ units: 'mm' }));
    expect((pinned[5] as DrawingFeatureControlFrame).units).toBe('inch');
  });

  it('keeps limits and a frame physically identical through mm → in → mm, in the model and every export', async () => {
    const { document, bodies, bodyId, ref } = await boxModel();
    // Stated the way every pre-v156 sheet stores them: no units.
    const sheet = sheetOf(
      [bodyId],
      [
        width(ref, {
          tolerance: { kind: 'limits', upper: 0.02, lower: -0.01 }
        }),
        frame()
      ]
    );
    const manager = new CommandManager(document);
    manager.execute(commandFactories.addDrawingSheet({ sheet }));
    const before = drawn(sheetIn(manager.document), bodies);
    expect(before.width).toBe('25.42/25.39');
    expect(before.frame).toMatch(/\| 0\.1$/);

    // To inches: the update pins the millimetres the sheet printed in.
    manager.execute(
      commandFactories.updateDrawingSheet({
        sheetId,
        format: { units: 'inch' },
        pinToleranceUnits: 'mm'
      })
    );
    const pinned = sheetIn(manager.document).annotations!;
    expect((pinned[0] as DrawingLinearDimension).tolerance).toEqual({
      kind: 'limits',
      upper: 0.02,
      lower: -0.01,
      units: 'mm'
    });
    expect(pinned[1]).toMatchObject({ amount: 0.1, units: 'mm' });
    const inches = drawn(sheetIn(manager.document), bodies);
    // 25.4 mm +0.02/−0.01 mm, not 1 in +0.02/−0.01 in.
    expect(inches.width).toBe('1.00079/0.99961');
    expect(inches.frame).toMatch(/\| 0\.0039$/);
    for (const text of [inches.svg, inches.dxf, inches.pdf]) {
      expect(text).toContain('1.00079');
      expect(text).toContain('0.99961');
      expect(text).toContain('0.0039');
      expect(text).not.toContain('1.02');
    }
    expect(inches.svg).toContain('>Inches</text>');

    // Back to millimetres: nothing left to pin, and nothing has moved.
    manager.execute(
      commandFactories.updateDrawingSheet({ sheetId, format: null })
    );
    const after = drawn(sheetIn(manager.document), bodies);
    expect(after.width).toBe(before.width);
    expect(after.frame).toBe(before.frame);
    expect(after.svg).toBe(before.svg);
    expect(after.dxf).toBe(before.dxf);
    expect(after.pdf).toBe(before.pdf);

    // Stored, saved and replayed alike, and refused below v156.
    expect(() => assertStorableDocument(manager.document)).not.toThrow();
    const saved = normalizeDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    expect(saved.drawings).toEqual(manager.document.drawings);
    expect(
      replayCommands(document, manager.document.commandLog).drawings
    ).toEqual(manager.document.drawings);
    expect(() =>
      assertStorableDocument({ ...manager.document, schemaVersion: 155 })
    ).toThrow(/Drawing tolerance units require project schema v156/);

    // Undo restores the unpinned sheet exactly.
    manager.undo();
    manager.undo();
    expect(sheetIn(manager.document)).toEqual(sheet);
  });

  it('opens a pre-v156 document unchanged, its tolerances printed as before', async () => {
    const { document, bodies, bodyId, ref } = await boxModel();
    const legacy: ProjectDocument = {
      ...document,
      schemaVersion: 155 as ProjectDocument['schemaVersion'],
      drawings: {
        sheets: [
          sheetOf(
            [bodyId],
            [
              width(ref, {
                tolerance: { kind: 'symmetric', value: 0.005 }
              }),
              frame({ amount: 0.002 })
            ]
          )
        ]
      }
    };
    expect(() => assertStorableDocument(legacy)).not.toThrow();
    const opened = normalizeDocument(
      JSON.parse(JSON.stringify(legacy)) as ProjectDocument
    );
    expect(opened.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(opened.drawings).toEqual(legacy.drawings);
    const shown = drawn(sheetIn(opened), bodies);
    expect(shown.width).toBe('25.4 ±0.005');
    expect(shown.frame).toMatch(/\| 0\.002$/);
    // The same sheet already printed in inches keeps its inch amounts.
    const inchSheet = {
      ...sheetIn(opened),
      format: { units: 'inch' as const }
    };
    const inch = drawn(inchSheet, bodies);
    expect(inch.width).toBe('1 ±0.005');
    expect(inch.frame).toMatch(/\| 0\.002$/);
  });

  it('prints a tiny converted amount nonzero and its limits distinct', () => {
    const ref: DrawingEdgeRef = { bodyId: 'b' as BodyId, hash: 7 };
    const inch = drawingNumberFormat({ units: 'inch' }, 'mm');
    const one = { symbol: '', value: 1, decimals: 3, kind: 'length' as const };
    // 0.00001 mm, the smallest tolerances' order, is 0.00000039 in.
    const tiny = (tolerance: DrawingDimension['tolerance']) =>
      formatDimension(width(ref, { tolerance }), one, inch);
    expect(tiny({ kind: 'symmetric', value: 0.00001, units: 'mm' }).label).toBe(
      '1 ±0.00000039'
    );
    expect(
      tiny({ kind: 'limits', upper: 0.00001, lower: -0.00001, units: 'mm' })
        .text?.stack
    ).toEqual(['1.00000039', '0.99999961']);
    expect(
      tiny({ kind: 'deviation', upper: 0.00001, lower: 0, units: 'mm' }).text
        ?.stack
    ).toEqual(['+0.00000039', '0']);
    expect(formatFrameTolerance(0.00001, inch, 'mm')).toBe('0.00000039');
    // The smallest amount in the largest ratio: 0.000001 mm is 1e-9 m.
    const metres = drawingNumberFormat({ units: 'm' }, 'mm');
    expect(formatFrameTolerance(0.000001, metres, 'mm')).toBe('0.000000001');
  });

  it('prints a frame to the sheet’s decimals when converted', () => {
    const six = drawingNumberFormat({ units: 'inch', decimals: 6 }, 'mm');
    expect(formatFrameTolerance(0.1, six, 'mm')).toBe('0.003937');
    // Unconverted, a frame's amount is never padded.
    expect(formatFrameTolerance(0.1, six, 'inch')).toBe('0.1');
    expect(formatFrameTolerance(0.1, six)).toBe('0.1');
  });

  it('prints a tiny converted amount in every export', async () => {
    const { bodies, bodyId, ref } = await boxModel();
    const sheet: DrawingSheet = {
      ...sheetOf(
        [bodyId],
        [
          width(ref, {
            tolerance: {
              kind: 'limits',
              upper: 0.00001,
              lower: -0.00001,
              units: 'mm'
            }
          }),
          frame({ amount: 0.00001, units: 'mm' })
        ]
      ),
      format: { units: 'inch' }
    };
    const shown = drawn(sheet, bodies);
    expect(shown.width).toBe('1.00000039/0.99999961');
    expect(shown.frame).toMatch(/\| 0\.00000039$/);
    for (const text of [shown.svg, shown.dxf, shown.pdf]) {
      expect(text).toContain('1.00000039');
      expect(text).toContain('0.99999961');
      expect(text).toContain('0.00000039');
    }
  });

  it('pins a units change made without stating the pin, and replays and redoes it', async () => {
    const { document, bodies, bodyId, ref } = await boxModel();
    const sheet = sheetOf(
      [bodyId],
      [width(ref, { tolerance: { kind: 'symmetric', value: 0.1 } }), frame()]
    );
    const manager = new CommandManager(document);
    manager.execute(commandFactories.addDrawingSheet({ sheet }));
    manager.execute(
      commandFactories.updateDrawingSheet({
        sheetId,
        format: { units: 'inch' }
      })
    );
    const pinned = sheetIn(manager.document);
    expect(
      (pinned.annotations![0] as DrawingLinearDimension).tolerance
    ).toEqual({ kind: 'symmetric', value: 0.1, units: 'mm' });
    expect(pinned.annotations![1]).toMatchObject({ amount: 0.1, units: 'mm' });
    expect(drawn(pinned, bodies).width).toBe('1 ±0.0039');
    expect(() => assertStorableDocument(manager.document)).not.toThrow();
    expect(
      replayCommands(document, manager.document.commandLog).drawings
    ).toEqual(manager.document.drawings);

    manager.undo();
    expect(sheetIn(manager.document)).toEqual(sheet);
    manager.redo();
    expect(sheetIn(manager.document)).toEqual(pinned);
    expect(
      replayCommands(document, manager.document.commandLog).drawings
    ).toEqual(manager.document.drawings);

    // A change that keeps the printed units pins nothing.
    const decimals = new CommandManager(document);
    decimals.execute(commandFactories.addDrawingSheet({ sheet }));
    decimals.execute(
      commandFactories.updateDrawingSheet({ sheetId, format: { decimals: 4 } })
    );
    expect(sheetIn(decimals.document).annotations).toEqual(sheet.annotations);
  });

  it('replays a units switch logged before v156 exactly as it was recorded', async () => {
    const { document, bodyId, ref } = await boxModel();
    const sheet = sheetOf(
      [bodyId],
      [width(ref, { tolerance: { kind: 'symmetric', value: 0.1 } }), frame()]
    );
    const legacy: ProjectDocument = {
      ...document,
      schemaVersion: 155 as ProjectDocument['schemaVersion'],
      drawings: { sheets: [sheet] }
    };
    // As a v155 client logged it: no pin, so the amounts read as inches.
    const replayed = replayCommands(legacy, [
      ...legacy.commandLog,
      {
        kind: 'drawing.sheet.update',
        payload: { sheetId, format: { units: 'inch' } },
        replayVersion: 1,
        label: 'Change drawing properties',
        timestamp: '2026-11-01T00:00:00.000Z'
      }
    ]);
    expect(sheetIn(replayed)).toEqual({ ...sheet, format: { units: 'inch' } });
    expect(() => assertStorableDocument(replayed)).not.toThrow();
  });

  it('refuses to state tolerance units on a pre-v156 document', async () => {
    const { document, bodyId, ref } = await boxModel();
    const sheet = sheetOf(
      [bodyId],
      [width(ref, { tolerance: { kind: 'symmetric', value: 0.1 } }), frame()]
    );
    const legacy: ProjectDocument = {
      ...document,
      schemaVersion: 155 as ProjectDocument['schemaVersion'],
      drawings: { sheets: [sheet] }
    };
    const manager = new CommandManager(legacy);
    const refused = /Drawing tolerance units require project schema v156/;
    for (const command of [
      commandFactories.updateDrawingSheet({
        sheetId,
        format: { units: 'inch' },
        pinToleranceUnits: 'mm'
      }),
      commandFactories.updateDrawingSheet({
        sheetId,
        format: { units: 'inch' }
      }),
      commandFactories.updateDrawingAnnotation({
        sheetId,
        annotation: frame({ units: 'mm' })
      }),
      commandFactories.addDrawingAnnotation({
        sheetId,
        annotation: frame({ annotationId: id('g'), units: 'mm' })
      })
    ]) {
      expect(() => manager.execute(command)).toThrow(refused);
      expect(manager.document).toBe(legacy);
    }
    // A change that states nothing stays open to a v155 document.
    manager.execute(
      commandFactories.updateDrawingSheet({ sheetId, format: { decimals: 4 } })
    );
    expect(() => assertStorableDocument(manager.document)).not.toThrow();
  });

  it('prints distinct limits distinct, from the gap between them (re-check P2)', () => {
    const ref: DrawingEdgeRef = { bodyId: 'b' as BodyId, hash: 7 };
    const inch = drawingNumberFormat({ units: 'inch' }, 'mm');
    const nominal = {
      symbol: '',
      value: 1.4,
      decimals: 3,
      kind: 'length' as const
    };
    const print = (tolerance: DrawingDimension['tolerance']) =>
      formatDimension(width(ref, { tolerance }), nominal, inch).text?.stack;
    // 500.000001 and 500 mm differ by 0.000001 mm, 0.00000004 in.
    const limits = print({
      kind: 'limits',
      upper: 500.000001,
      lower: 500,
      units: 'mm'
    })!;
    expect(limits[0]).not.toBe(limits[1]);
    expect(limits).toEqual(['21.08503941', '21.08503937']);
    expect(
      print({ kind: 'deviation', upper: 500.000001, lower: 500, units: 'mm' })
    ).toEqual(['+19.68503941', '+19.68503937']);
    // Ordinary tolerances keep the decimals they had.
    expect(
      print({ kind: 'deviation', upper: 0.1, lower: -0.05, units: 'mm' })
    ).toEqual(['+0.0039', '-0.0020']);
  });

  it('prints every pair at least the floor apart distinct within the cap', () => {
    const ref: DrawingEdgeRef = { bodyId: 'b' as BodyId, hash: 7 };
    const units = ['mm', 'cm', 'm', 'inch'] as const;
    const perMm = { mm: 1, cm: 10, m: 1000, inch: 25.4 };
    for (const stored of units) {
      // The floor's gap, as the stored units state it to six decimals.
      const gap =
        Math.ceil((MIN_DRAWING_TOLERANCE_MM / perMm[stored]) * 1e6) / 1e6;
      for (const printed of units) {
        const format = drawingNumberFormat({ units: printed }, 'mm');
        for (const value of [0.001, 1.4, 987.654321])
          for (const lower of [-0.000001, 0, 0.3, 499.999999]) {
            const upper = Number((lower + gap).toFixed(6));
            for (const kind of ['limits', 'deviation'] as const) {
              const tolerance = { kind, upper, lower, units: stored };
              expect(drawingToleranceError(tolerance)).toBeNull();
              const stack = formatDimension(
                width(ref, { tolerance }),
                { symbol: '', value, decimals: 3, kind: 'length' },
                format
              ).text!.stack!;
              const what = `${kind} ${upper}/${lower} ${stored} on ${printed}`;
              expect(stack[0], what).not.toBe(stack[1]);
              // Distinct below the cap, so the cap never decides it.
              for (const text of stack)
                expect((text.split('.')[1] ?? '').length, what).toBeLessThan(
                  MAX_CONVERTED_TOLERANCE_DECIMALS
                );
            }
          }
      }
    }
  });

  it('refuses a new tolerance finer than 0.0001 mm, and keeps a stored one (re-check P2)', async () => {
    const { document, bodies, bodyId, ref } = await boxModel();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({
        sheet: { ...sheetOf([bodyId], []), format: { units: 'inch' } }
      })
    );
    const before = manager.document;
    const add = (annotation: DrawingAnnotation) =>
      commandFactories.addDrawingAnnotation({ sheetId, annotation });
    const fine = /A tolerance is at least 0\.0001 mm/;
    const apart = /Limits are at least 0\.0001 mm apart/;
    const refusals: [DrawingAnnotation, RegExp][] = [
      // 0.000000001 mm slips past the six-decimal check, not the floor.
      [
        width(ref, {
          tolerance: { kind: 'symmetric', value: 0.000000001, units: 'mm' }
        }),
        fine
      ],
      [
        width(ref, {
          tolerance: { kind: 'symmetric', value: 0.000003, units: 'inch' }
        }),
        fine
      ],
      [
        width(ref, {
          tolerance: {
            kind: 'limits',
            upper: 500.000001,
            lower: 500,
            units: 'mm'
          }
        }),
        apart
      ],
      [
        width(ref, {
          tolerance: {
            kind: 'deviation',
            upper: 0.1,
            lower: 0.00005,
            units: 'mm'
          }
        }),
        fine
      ],
      [frame({ amount: 0.00005, units: 'mm' }), fine]
    ];
    for (const [annotation, refused] of refusals) {
      expect(() => manager.execute(add(annotation))).toThrow(refused);
      expect(manager.document).toBe(before);
    }
    // At the floor in any units a tolerance is taken: 0.000004 in is
    // 0.0001016 mm, and 0.000001 m is 0.001 mm.
    manager.execute(
      add(
        width(ref, {
          tolerance: {
            kind: 'deviation',
            upper: 0.000004,
            lower: 0,
            units: 'inch'
          }
        })
      )
    );
    manager.execute(add(frame({ amount: 0.000001, units: 'm' })));
    const atFloor = drawn(sheetIn(manager.document), bodies);
    expect(atFloor.width).toBe('1 +0.000004/0');
    expect(atFloor.frame).toMatch(/\| 0\.000039$/);

    // A sheet stored before the floor opens, prints and replays unchanged.
    const legacy = sheetOf(
      [bodyId],
      [
        width(ref, {
          tolerance: {
            kind: 'limits',
            upper: 0.00001,
            lower: -0.00001,
            units: 'mm'
          }
        }),
        frame({ amount: 0.00001, units: 'mm' })
      ]
    );
    const stored = replayCommands(document, [
      ...document.commandLog,
      commandFactories.addDrawingSheet({ sheet: legacy }).serialize()
    ]);
    expect(() => assertStorableDocument(stored)).not.toThrow();
    expect(normalizeDocument(stored).drawings).toEqual(stored.drawings);
    expect(sheetIn(stored).annotations).toEqual(legacy.annotations);
    expect(drawn(sheetIn(stored), bodies).width).toBe('25.40001/25.39999');
    // Moved, or with one bound changed, its other amounts keep their
    // meaning; a new amount finer than the floor is refused.
    const kept = new CommandManager(stored);
    const [dimension, oldFrame] = sheetIn(stored).annotations! as [
      DrawingLinearDimension,
      DrawingFeatureControlFrame
    ];
    const update = (annotation: DrawingAnnotation) =>
      commandFactories.updateDrawingAnnotation({ sheetId, annotation });
    kept.execute(update({ ...dimension, placementMm: { x: 0, y: 20 } }));
    kept.execute(
      update({
        ...dimension,
        placementMm: { x: 0, y: 20 },
        tolerance: { kind: 'limits', upper: 0.1, lower: -0.00001, units: 'mm' }
      })
    );
    kept.execute(update({ ...oldFrame, characteristic: 'straightness' }));
    expect(() =>
      kept.execute(update({ ...oldFrame, amount: 0.00002 }))
    ).toThrow(fine);
    // A logged add from before the floor replays as it was recorded.
    const logged = replayCommands(document, [
      ...document.commandLog,
      commandFactories
        .addDrawingSheet({ sheet: sheetOf([bodyId], []) })
        .serialize(),
      add(
        width(ref, {
          tolerance: { kind: 'symmetric', value: 0.00001, units: 'mm' }
        })
      ).serialize()
    ]);
    expect(
      (sheetIn(logged).annotations![0] as DrawingLinearDimension).tolerance
    ).toEqual({ kind: 'symmetric', value: 0.00001, units: 'mm' });
  });
});

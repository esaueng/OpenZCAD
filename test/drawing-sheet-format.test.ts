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
  drawingSetError,
  drawingSheetFormatError,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingDimension,
  type DrawingEdgeRef,
  type DrawingLinearDimension,
  type DrawingSheet,
  type DrawingSheetFormat,
  type DrawingSheetId,
  type DrawingViewId,
  type EdgeTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { projectView } from '../apps/web/src/lib/drawing/projectView';
import { projectionBodyInput } from '../apps/web/src/lib/drawing/sheetSources';
import {
  composeSheetPage,
  titleBlockAutoDate
} from '../apps/web/src/lib/drawing/sheetPage';
import {
  sheetPageToPdf,
  sheetPageToSvg
} from '../apps/web/src/lib/drawing/sheetExport';
import {
  composeSheetAnnotations,
  drawingNumberFormat,
  formatDimension,
  resolveSheetAnnotations
} from '../apps/web/src/lib/drawing/annotations';

/**
 * D02 drawing properties (schema v70): a sheet prints its dimensions in its
 * own units, precision, angle format and decimal separator, with its own
 * print weights, and its title block fills SIZE and DATE automatically.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const sheetId = 'dsht_fmt' as DrawingSheetId;
const frontId = 'dvw_front' as DrawingViewId;
const id = (name: string) => `dann_${name}` as DrawingAnnotationId;
const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;

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

function sheetOf(
  bodyIds: BodyId[],
  annotations: DrawingAnnotation[] = [],
  format?: DrawingSheetFormat
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
    ...(annotations.length ? { annotations } : {}),
    ...(format ? { format } : {})
  };
}

async function boxModel() {
  const document = addPrimitiveFeature(
    createProjectDocument('Inch part', toUserId('test')),
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

function page(
  sheet: DrawingSheet,
  bodies: Record<string, BodyRepresentation>,
  date?: string
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
  return {
    resolutions,
    page: composeSheetPage(
      sheet,
      views,
      { projectName: 'Inch part', units: 'mm', ...(date ? { date } : {}) },
      composeSheetAnnotations(sheet, views, resolutions, 'mm')
    )
  };
}

describe('D02 drawing properties (schema v70)', () => {
  it('claims v70 and validates the properties by name', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(70);
    expect(
      drawingSheetFormatError({
        units: 'inch',
        decimals: 3,
        angleDecimals: 0,
        angleFormat: 'dms',
        decimalSeparator: 'comma',
        lineWidthsMm: { visible: 0.5, dimension: 0.18 }
      })
    ).toBeNull();
    const bad: [unknown, RegExp][] = [
      [{ font: 'x' }, /unknown drawing property "font"/],
      [{ units: 'ft' }, /unknown units/],
      [{ decimals: 7 }, /0 to 6 decimals/],
      [{ angleDecimals: -1 }, /angles to other than/],
      [{ angleFormat: 'grad' }, /unknown angle format/],
      [{ decimalSeparator: 'point' }, /unknown decimal separator/],
      [{ lineWidthsMm: { bold: 1 } }, /unknown line class "bold"/],
      [{ lineWidthsMm: { visible: 0 } }, /visible line weight outside/],
      [{ lineWidthsMm: { hidden: 3 } }, /hidden line weight outside/],
      ['mm', /not a record/]
    ];
    for (const [format, message] of bad)
      expect(drawingSheetFormatError(format)).toMatch(message);
    expect(
      drawingSetError({
        sheets: [sheetOf(['b' as BodyId], [], { decimals: 9 })]
      })
    ).toMatch(/Drawing sheet dsht_fmt shows lengths/);
  });

  it('writes numbers in the sheet’s units, precision, separator and angle format', () => {
    const ref: DrawingEdgeRef = { bodyId: 'b' as BodyId, hash: 7 };
    const mmToInch = drawingNumberFormat({ units: 'inch' }, 'mm');
    expect(mmToInch.lengthFactor).toBeCloseTo(1 / 25.4, 12);
    expect(mmToInch.lengthDecimals).toBe(3);
    const comma = drawingNumberFormat(
      { decimalSeparator: 'comma', decimals: 1 },
      'mm'
    );
    const length = (value: number) => ({
      symbol: '',
      value,
      decimals: 1,
      kind: 'length' as const
    });
    expect(formatDimension(width(ref), length(12.5), comma).label).toBe('12,5');
    expect(
      formatDimension(
        width(ref, { tolerance: { kind: 'limits', upper: 0.1, lower: -0.1 } }),
        length(12.5),
        comma
      ).text?.stack
    ).toEqual(['12,6', '12,4']);
    const dms = drawingNumberFormat({ angleFormat: 'dms' }, 'mm');
    const angle = (value: number, decimals = 0) => ({
      symbol: '',
      value,
      decimals,
      kind: 'angle' as const
    });
    const angled = (extra: Partial<DrawingLinearDimension> = {}) =>
      ({
        annotationId: id('a'),
        kind: 'angle',
        viewId: frontId,
        edges: [ref, { ...ref, hash: 8 }],
        placementMm: { x: 0, y: 0 },
        ...extra
      }) as DrawingDimension;
    expect(formatDimension(angled(), angle(30.5), dms).label).toBe(`30°30'0"`);
    // Rounded once, in seconds: no 60" carries into the label.
    expect(formatDimension(angled(), angle(29.99999), dms).label).toBe(
      `30°0'0"`
    );
    expect(formatDimension(angled(), angle(45.25, 1), dms).label).toBe(
      `45°15'0"`
    );
    expect(
      formatDimension(
        angled({ tolerance: { kind: 'deviation', upper: 0.5, lower: 0 } }),
        angle(30),
        dms
      ).text?.stack
    ).toEqual([`+0°30'0"`, '0']);
    // A tolerance finer than the seconds shown keeps the decimals it needs:
    // 0.000001° is 0.0036", never ±0°0'0".
    expect(
      formatDimension(
        angled({ tolerance: { kind: 'symmetric', value: 0.000001 } }),
        angle(30),
        dms
      ).label
    ).toBe(`30°0'0" ±0°0'0.0036"`);
    const limits = formatDimension(
      angled({
        tolerance: { kind: 'limits', upper: 0.000001, lower: -0.000001 }
      }),
      angle(30),
      dms
    ).text?.stack;
    expect(limits).toEqual([`30°0'0.0036"`, `29°59'59.9964"`]);
    // The default stays decimal degrees with a point.
    expect(
      formatDimension(
        angled(),
        angle(30.25, 2),
        drawingNumberFormat(undefined, 'mm')
      ).label
    ).toBe('30.25°');
  });

  it('dimensions a millimetre model in inches, read from the kernel body', async () => {
    const { bodies, bodyId, ref } = await boxModel();
    const inches = sheetOf(
      [bodyId],
      [width(ref, { tolerance: { kind: 'symmetric', value: 0.005 } })],
      { units: 'inch' }
    );
    const { resolutions } = page(inches, bodies);
    const resolution = resolutions.get(id('w'))!;
    if (!resolution.ok) throw new Error(resolution.message);
    expect(resolution.resolved.label).toBe('1 ±0.005');
    // The value the sheet measures stays in model units.
    expect(
      resolution.resolved.kind === 'linear' && resolution.resolved.value
    ).toBeCloseTo(25.4, 9);
    const plain = page(sheetOf([bodyId], [width(ref)]), bodies);
    const millimetres = plain.resolutions.get(id('w'))!;
    expect(millimetres.ok && millimetres.resolved.label).toBe('25.4');
  });

  it('prints its own line weights and fills SIZE, DATE and UNITS in the title block', async () => {
    const { bodies, bodyId, ref } = await boxModel();
    const plain = page(sheetOf([bodyId], [width(ref)]), bodies);
    expect(plain.page.strokeWidthsMm).toBeUndefined();
    const plainSvg = sheetPageToSvg(plain.page, 'Sheet 1');
    expect(plainSvg).toContain(
      '<g class="visible" fill="none" stroke="#000000" stroke-width="0.35"'
    );
    expect(plainSvg).toContain('>1:1 · ANSI B</text>');
    expect(plainSvg).toContain('>Millimetres</text>');

    const weighted = sheetOf([bodyId], [width(ref)], {
      units: 'inch',
      lineWidthsMm: { visible: 0.5, dimension: 0.18 }
    });
    const drawn = page(weighted, bodies, '2026-11-16');
    const svg = sheetPageToSvg(drawn.page, 'Sheet 1');
    expect(svg).toContain(
      '<g class="visible" fill="none" stroke="#000000" stroke-width="0.5"'
    );
    expect(svg).toContain(
      '<g class="dimension" fill="none" stroke="#000000" stroke-width="0.18"'
    );
    // Unset classes keep their ISO 128 weight.
    expect(svg).toContain(
      '<g class="border" fill="none" stroke="#000000" stroke-width="0.5"'
    );
    expect(svg).toContain('>Inches</text>');
    expect(svg).toContain('>2026-11-16</text>');
    const pdf = new TextDecoder('latin1').decode(
      sheetPageToPdf(drawn.page, 'Sheet 1')
    );
    expect(pdf).toContain('1.417 w');
    expect(pdf).toContain('0.51 w');
    // A typed date wins over the automatic one.
    const typed = page(
      { ...weighted, titleBlock: { date: '2026-01-02' } },
      bodies,
      '2026-11-16'
    );
    const typedSvg = sheetPageToSvg(typed.page, 'Sheet 1');
    expect(typedSvg).toContain('>2026-01-02</text>');
    expect(typedSvg).not.toContain('>2026-11-16</text>');
    expect(
      titleBlockAutoDate([
        { createdAt: '2026-03-01T10:00:00.000Z' },
        { createdAt: '2026-11-15T23:59:00.000Z' },
        { createdAt: 'not a date' }
      ])
    ).toBe('2026-11-15');
    expect(titleBlockAutoDate([])).toBeUndefined();
  });

  it('sets and clears the properties in one undoable command, gated below v70', async () => {
    const { document, bodyId } = await boxModel();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({ sheet: sheetOf([bodyId]) })
    );
    const format: DrawingSheetFormat = {
      units: 'inch',
      decimalSeparator: 'comma'
    };
    manager.execute(commandFactories.updateDrawingSheet({ sheetId, format }));
    expect(manager.document.drawings!.sheets[0]!.format).toEqual(format);
    expect(() => assertStorableDocument(manager.document)).not.toThrow();
    const saved = normalizeDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    expect(saved.drawings).toEqual(manager.document.drawings);
    expect(
      replayCommands(document, manager.document.commandLog).drawings
    ).toEqual(manager.document.drawings);
    expect(() =>
      assertStorableDocument({
        ...manager.document,
        schemaVersion: 69
      })
    ).toThrow(/Drawing properties require project schema v70/);
    manager.execute(
      commandFactories.updateDrawingSheet({ sheetId, format: null })
    );
    expect('format' in manager.document.drawings!.sheets[0]!).toBe(false);
    manager.undo();
    expect(manager.document.drawings!.sheets[0]!.format).toEqual(format);
    expect(() =>
      commandFactories
        .updateDrawingSheet({
          sheetId,
          format: { lineWidthsMm: { visible: 9 } }
        })
        .apply(manager.document)
    ).toThrow(/visible line weight outside/);
  });
});

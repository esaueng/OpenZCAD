import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  assertStorableDocument,
  createProjectDocument,
  normalizeDocument,
  setParameter
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  drawingSetError,
  drawingToleranceError,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingEdgeRef,
  type DrawingLinearDimension,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingTolerance,
  type DrawingViewId,
  type EdgeTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { projectView } from '../apps/web/src/lib/drawing/projectView';
import { projectionBodyInput } from '../apps/web/src/lib/drawing/sheetSources';
import { composeSheetPage } from '../apps/web/src/lib/drawing/sheetPage';
import {
  sheetPageToPdf,
  sheetPageToSvg
} from '../apps/web/src/lib/drawing/sheetExport';
import {
  composeSheetAnnotations,
  formatDimension,
  resolveDrawingAnnotation,
  resolveSheetAnnotations
} from '../apps/web/src/lib/drawing/annotations';
import { parseSaveProjectDocumentRequest } from '../apps/web/worker/validation';

/**
 * D02 dimension tolerances, prefixes and suffixes (schema v68): stored as
 * deviations from the measured value, never as a value, so a toleranced
 * dimension stays associative — limits follow the model through an Update.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const sheetId = 'dsht_tol' as DrawingSheetId;
const frontId = 'dvw_front' as DrawingViewId;
const id = (name: string) => `dann_${name}` as DrawingAnnotationId;

function boxDocument(width = 20): ProjectDocument {
  let document = createProjectDocument('Tolerance', toUserId('test'));
  document = setParameter(document, { name: 'w', expression: String(width) });
  return addPrimitiveFeature(document, {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 'w', height: 10, depth: 6 }
  });
}

const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;

/** The front view's near top edge of the box. */
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

function refOf(bodyId: BodyId, edge: EdgeTopology): DrawingEdgeRef {
  return {
    bodyId,
    hash: edge.hash,
    ...(edge.reference ? { reference: edge.reference } : {})
  };
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
  annotations?: DrawingAnnotation[]
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
      {
        viewId: frontId,
        orientation: 'front',
        bodyIds,
        centerMm: { x: 100, y: 120 },
        hiddenLines: false
      }
    ],
    ...(annotations ? { annotations } : {})
  };
}

async function boxModel(w = 20, from?: ProjectDocument) {
  const document = from
    ? setParameter(from, { name: 'w', expression: String(w) })
    : boxDocument(w);
  const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
  const bodyId = document.bodyOrder[0]!;
  return {
    document,
    bodies,
    bodyId,
    ref: refOf(bodyId, topEdge(bodies[bodyId]!))
  };
}

function label(
  annotation: DrawingAnnotation,
  sheet: DrawingSheet,
  bodies: Record<string, BodyRepresentation>
) {
  const resolution = resolveDrawingAnnotation(
    annotation,
    sheet.views[0],
    bodies,
    'mm'
  );
  if (!resolution.ok) throw new Error(resolution.message);
  return resolution.resolved;
}

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
  const layer = composeSheetAnnotations(
    sheet,
    views,
    resolveSheetAnnotations(sheet, bodies, 'mm'),
    'mm'
  );
  return { views, layer };
}

describe('D02 dimension tolerances (schema v68)', () => {
  it('claims v68 and validates every tolerance shape by name', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(68);
    const good: DrawingTolerance[] = [
      { kind: 'symmetric', value: 0.05 },
      { kind: 'deviation', upper: 0.1, lower: -0.05 },
      { kind: 'deviation', upper: 0, lower: -0.1 },
      { kind: 'limits', upper: 0.2, lower: 0.1 },
      { kind: 'basic' }
    ];
    for (const tolerance of good)
      expect(drawingToleranceError(tolerance)).toBeNull();
    const bad: [unknown, RegExp][] = [
      [{ kind: 'symmetric', value: 0 }, /positive/],
      [{ kind: 'symmetric', value: -1 }, /positive/],
      [{ kind: 'symmetric', value: 0.1, extra: 1 }, /unknown fields/],
      [{ kind: 'deviation', upper: -0.1, lower: 0.1 }, /not above/],
      [{ kind: 'limits', upper: 0.1, lower: 0.1 }, /not above/],
      [{ kind: 'deviation', upper: Infinity, lower: 0 }, /invalid deviation/],
      [{ kind: 'limits', upper: 1e7, lower: 0 }, /invalid deviation/],
      [{ kind: 'basic', value: 1 }, /unknown fields/],
      [{ kind: 'fit' }, /unknown tolerance kind/],
      ['±0.1', /not a record/]
    ];
    for (const [tolerance, message] of bad)
      expect(drawingToleranceError(tolerance)).toMatch(message);
  });

  it('refuses a tolerance on a reference, a note or a callout, and malformed affixes', () => {
    const ref: DrawingEdgeRef = { bodyId: 'body_x' as BodyId, hash: 7 };
    const check = (annotation: unknown) =>
      drawingSetError({
        sheets: [
          sheetOf(['body_x' as BodyId], [annotation as DrawingAnnotation])
        ]
      });
    expect(
      check(
        width(ref, {
          tolerance: { kind: 'basic' },
          prefix: '2×',
          suffix: 'TYP'
        })
      )
    ).toBeNull();
    expect(
      check(width(ref, { reference: true, tolerance: { kind: 'basic' } }))
    ).toMatch(/reference dimension, which takes no tolerance/);
    expect(
      check({
        annotationId: id('n'),
        kind: 'note',
        text: 'X',
        placementMm: { x: 0, y: 0 },
        suffix: 'TYP'
      })
    ).toMatch(/note, which takes no tolerance, prefix or suffix/);
    expect(
      check({
        annotationId: id('c'),
        kind: 'diameter',
        viewId: frontId,
        edge: ref,
        counterbore: { ...ref, hash: 8 },
        tolerance: { kind: 'basic' },
        placementMm: { x: 0, y: 0 }
      })
    ).toMatch(/callout, which takes no tolerance/);
    expect(
      check({
        annotationId: id('ch'),
        kind: 'chamfer',
        viewId: frontId,
        face: ref,
        tolerance: { kind: 'basic' },
        placementMm: { x: 0, y: 0 }
      })
    ).toMatch(/callout, which takes no tolerance/);
    for (const prefix of ['', ' 2×', 'a\nb', 'x'.repeat(41)])
      expect(check(width(ref, { prefix }))).toMatch(
        /prefix that is not one trimmed line/
      );
    expect(check(width(ref, { suffix: 'TYP ' }))).toMatch(/suffix/);
    expect(
      check(width(ref, { tolerance: { kind: 'limits', upper: 0, lower: 0 } }))
    ).toMatch(/not above its lower/);
  });

  it('writes each tolerance the way a print states it', () => {
    const ref: DrawingEdgeRef = { bodyId: 'body_x' as BodyId, hash: 7 };
    const measured = { symbol: '', value: 20, decimals: 2, unit: '' };
    const format = (extra: Partial<DrawingLinearDimension>) =>
      formatDimension(width(ref, extra), measured);
    expect(format({})).toEqual({ label: '20' });
    expect(format({ tolerance: { kind: 'symmetric', value: 0.05 } })).toEqual({
      label: '20 ±0.05'
    });
    // A tolerance finer than the dimension's decimals keeps its own.
    expect(
      format({ decimals: 1, tolerance: { kind: 'symmetric', value: 0.005 } })
        .label
    ).toBe('20 ±0.005');
    expect(
      format({ tolerance: { kind: 'deviation', upper: 0.1, lower: -0.05 } })
    ).toEqual({
      label: '20 +0.10/-0.05',
      text: { head: '', lead: '20', stack: ['+0.10', '-0.05'], tail: '' }
    });
    // No deviation reads as a bare 0, unsigned.
    expect(
      format({ tolerance: { kind: 'deviation', upper: 0, lower: -0.1 } }).text
        ?.stack
    ).toEqual(['0', '-0.10']);
    expect(
      format({
        prefix: '2×',
        suffix: 'TYP',
        tolerance: { kind: 'limits', upper: 0.1, lower: -0.05 }
      })
    ).toEqual({
      label: '2× 20.10/19.95 TYP',
      text: { head: '2× ', lead: '', stack: ['20.10', '19.95'], tail: ' TYP' }
    });
    expect(format({ tolerance: { kind: 'basic' } })).toEqual({
      label: '[20]',
      text: { head: '', lead: '20', tail: '', framed: true }
    });
    expect(format({ prefix: 'SR', suffix: 'MAX' })).toEqual({
      label: 'SR 20 MAX'
    });
    // Angles carry their degree sign on each deviation.
    expect(
      formatDimension(
        {
          annotationId: id('a'),
          kind: 'angle',
          viewId: frontId,
          edges: [ref, { ...ref, hash: 8 }],
          placementMm: { x: 0, y: 0 },
          tolerance: { kind: 'deviation', upper: 0.5, lower: -0.5 }
        },
        { symbol: '', value: 30, decimals: 1, unit: '°' }
      ).text?.stack
    ).toEqual(['+0.5°', '-0.5°']);
    // Text a callout wrote takes the prefix and suffix, never a tolerance.
    expect(
      formatDimension(width(ref, { suffix: 'TYP' }), '1 × 45°').label
    ).toBe('1 × 45° TYP');
  });

  it('reads limits from the model, so they follow a widened box after Update', async () => {
    const { document, bodies, bodyId, ref } = await boxModel(20);
    const limits = width(ref, {
      tolerance: { kind: 'limits', upper: 0.1, lower: -0.05 }
    });
    const sheet = sheetOf([bodyId], [limits]);
    expect(label(limits, sheet, bodies).label).toBe('20.10/19.95');
    const wider = await boxModel(30, document);
    expect(label(limits, sheet, wider.bodies).label).toBe('30.10/29.95');
    const widened = label(limits, sheet, wider.bodies);
    expect(widened.kind === 'linear' && widened.value).toBeCloseTo(30, 9);
  });

  it('stacks deviations, frames a basic size and exports both to PDF and SVG, byte-stable across a reload', async () => {
    const { document, bodies, bodyId, ref } = await boxModel(20);
    const annotations: DrawingAnnotation[] = [
      width(ref, {
        tolerance: { kind: 'deviation', upper: 0.1, lower: -0.05 },
        suffix: 'TYP'
      }),
      width(ref, {
        annotationId: id('basic'),
        tolerance: { kind: 'basic' },
        prefix: '4×',
        placementMm: { x: 0, y: 24 }
      })
    ];
    const sheet = sheetOf([bodyId], annotations);
    const { views, layer } = drawn(sheet, bodies);
    const lead = layer.texts.find((text) => text.text === '20')!;
    const upper = layer.texts.find((text) => text.text === '+0.10')!;
    const lower = layer.texts.find((text) => text.text === '-0.05')!;
    const tail = layer.texts.find((text) => text.text === 'TYP')!;
    // The pair is smaller than the value, upper over lower about its
    // middle, after the value and before the suffix, on one baseline row.
    expect(upper.sizeMm).toBeLessThan(lead.sizeMm);
    expect(upper.x).toBeCloseTo(lower.x, 9);
    expect(upper.y).toBeGreaterThan(lead.y);
    expect(lower.y).toBeLessThan(lead.y);
    expect(upper.x).toBeGreaterThan(lead.x);
    expect(tail.x).toBeGreaterThan(upper.x);
    expect(
      (upper.y + upper.sizeMm + lower.y) / 2 - (lead.y + lead.sizeMm / 2)
    ).toBeCloseTo(0, 9);
    // The basic size sits in a closed frame around its value.
    const framedText = layer.texts.filter((text) => text.text === '20')[1]!;
    const frames = layer.strokes.filter(
      (stroke) => stroke.closed && !stroke.filled
    );
    expect(frames).toHaveLength(1);
    const xs = frames[0]!.points.filter((_, index) => index % 2 === 0);
    const ys = frames[0]!.points.filter((_, index) => index % 2 === 1);
    expect(Math.min(...xs)).toBeLessThan(framedText.x);
    // The frame holds the value alone, not its prefix.
    const prefix = layer.texts.find((text) => text.text === '4×')!;
    expect(Math.min(...xs)).toBeGreaterThan(prefix.x);
    expect(Math.min(...ys)).toBeLessThan(framedText.y);
    expect(Math.max(...ys)).toBeGreaterThan(framedText.y + framedText.sizeMm);
    // Each annotation's box covers its whole label.
    const box = layer.boxes.get(id('w'))!;
    expect(box.x).toBeLessThan(lead.x);
    expect(box.x + box.width).toBeGreaterThan(tail.x);

    const context = { projectName: document.name, units: document.units };
    const page = composeSheetPage(sheet, views, context, layer);
    const svg = sheetPageToSvg(page, sheet.name);
    for (const text of ['+0.10', '-0.05', 'TYP'])
      expect(svg).toContain(`>${text}</text>`);
    expect(svg).toMatch(/<polygon points="[^"]+"\/>/);
    const pdf = new TextDecoder('latin1').decode(
      sheetPageToPdf(page, sheet.name)
    );
    for (const text of ['(+0.10) Tj', '(-0.05) Tj', '(TYP) Tj'])
      expect(pdf).toContain(text);

    const saved = new CommandManager(document).execute(
      commandFactories.addDrawingSheet({ sheet })
    );
    const reloaded = normalizeDocument(
      JSON.parse(JSON.stringify(saved)) as ProjectDocument
    );
    expect(reloaded.drawings).toEqual(saved.drawings);
    expect(JSON.stringify(reloaded.drawings)).not.toMatch(/"value"|"label"/);
    const again = reloaded.drawings!.sheets[0]!;
    const bodiesAgain = (await adapter.syncDocument(reloaded))
      .bodyRepresentations;
    const redrawn = drawn(again, bodiesAgain);
    expect(
      sheetPageToSvg(
        composeSheetPage(again, redrawn.views, context, redrawn.layer),
        again.name
      )
    ).toBe(svg);
  });

  it('gates the fields on a document that declares v67 or older, and stores them at the account edge', async () => {
    const { document, bodyId, ref } = await boxModel(20);
    const sheet = sheetOf([bodyId], [width(ref, { suffix: 'TYP' })]);
    const current = new CommandManager(document).execute(
      commandFactories.addDrawingSheet({ sheet })
    );
    expect(() => assertStorableDocument(current)).not.toThrow();
    const old = { ...current, schemaVersion: 67 } as unknown as ProjectDocument;
    expect(() => assertStorableDocument(old)).toThrow(
      /Dimension tolerances, prefixes and suffixes require project schema v68/
    );
    // A v67 sheet without them is still fine at v67.
    const plain = new CommandManager(document).execute(
      commandFactories.addDrawingSheet({
        sheet: sheetOf([bodyId], [width(ref)])
      })
    );
    expect(() =>
      assertStorableDocument({
        ...plain,
        schemaVersion: 67
      })
    ).not.toThrow();
    expect(() =>
      parseSaveProjectDocumentRequest(
        {
          projectId: current.projectId,
          expectedVersion: 0,
          document: JSON.parse(JSON.stringify(current)) as unknown
        },
        current.projectId
      )
    ).not.toThrow();
  });
});

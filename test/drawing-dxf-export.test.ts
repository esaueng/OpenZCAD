import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { writeDxf } from '@openzcad/io-dxf';
import {
  toUserId,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingViewId,
  type EdgeTopology
} from '@openzcad/shared';
import { projectView } from '../apps/web/src/lib/drawing/projectView';
import { projectionBodyInput } from '../apps/web/src/lib/drawing/sheetSources';
import { composeSheetPage } from '../apps/web/src/lib/drawing/sheetPage';
import {
  drawingExportFileName,
  sheetPageToDxf
} from '../apps/web/src/lib/drawing/sheetExport';
import {
  composeSheetAnnotations,
  resolveSheetAnnotations
} from '../apps/web/src/lib/drawing/annotations';
import { importDxfSketch } from '../apps/web/src/lib/dxfImport';

/**
 * D04 drawing DXF export: the composed sheet — views, hidden lines,
 * dimensions with their arrowheads, the title block — as a DXF R12 drawing
 * in paper millimetres, a layer per line kind, deterministic, and readable
 * by a DXF reader (the app's own importer among them).
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;

async function drawn() {
  const document = addPrimitiveFeature(
    createProjectDocument('Bracket', toUserId('test')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 10, depth: 6 }
    }
  );
  const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
  const bodyId = document.bodyOrder[0]!;
  const body: BodyRepresentation = bodies[bodyId]!;
  const { min, max } = body.bbox;
  const top = body.topology!.edges.find((edge: EdgeTopology) => {
    const p = edge.points;
    return (
      near(p[1]!, min.y) &&
      near(p[p.length - 2]!, min.y) &&
      near(p[2]!, max.z) &&
      near(p[p.length - 1]!, max.z)
    );
  })!;
  const frontId = 'dvw_front' as DrawingViewId;
  const annotations: DrawingAnnotation[] = [
    {
      annotationId: 'dann_w' as DrawingAnnotationId,
      kind: 'linear',
      viewId: frontId,
      direction: 'horizontal',
      from: { edge: { bodyId, hash: top.hash }, anchor: 'first' },
      to: { edge: { bodyId, hash: top.hash }, anchor: 'second' },
      placementMm: { x: 0, y: 14 }
    },
    {
      annotationId: 'dann_n' as DrawingAnnotationId,
      kind: 'note',
      text: 'BREAK EDGES Ø0.5',
      placementMm: { x: 30, y: 40 }
    }
  ];
  const sheet: DrawingSheet = {
    sheetId: 'dsht_dxf' as DrawingSheetId,
    name: 'Sheet 1',
    paper: { size: 'A4', orientation: 'landscape' },
    scale: { numerator: 2, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: { drawingNumber: 'BR-1' },
    source: { fingerprint: 'v1:test' },
    views: [
      {
        viewId: frontId,
        orientation: 'front',
        bodyIds: [bodyId],
        centerMm: { x: 90, y: 120 },
        hiddenLines: false
      },
      {
        viewId: 'dvw_iso' as DrawingViewId,
        orientation: 'iso',
        bodyIds: [bodyId],
        centerMm: { x: 200, y: 120 },
        hiddenLines: true
      }
    ],
    annotations
  };
  const views = sheet.views.map((entry) => ({
    view: entry,
    projection: projectView({
      orientation: entry.orientation,
      hiddenLines: entry.hiddenLines,
      bodies: entry.bodyIds.map((id) => projectionBodyInput(bodies[id]!)!)
    })
  }));
  const page = composeSheetPage(
    sheet,
    views,
    { projectName: document.name, units: 'mm' },
    composeSheetAnnotations(
      sheet,
      views,
      resolveSheetAnnotations(sheet, bodies, 'mm'),
      'mm'
    )
  );
  return { sheet, page };
}

/** The entity records of a DXF: type and its group pairs. */
function entities(
  dxf: string
): { type: string; groups: Map<number, string[]> }[] {
  const lines = dxf.split('\r\n');
  const start = lines.indexOf('ENTITIES');
  const out: { type: string; groups: Map<number, string[]> }[] = [];
  for (let i = start + 1; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]);
    const value = lines[i + 1]!;
    if (code === 0) {
      if (value === 'ENDSEC') break;
      out.push({ type: value, groups: new Map() });
    } else {
      const groups = out.at(-1)!.groups;
      groups.set(code, [...(groups.get(code) ?? []), value]);
    }
  }
  return out;
}

describe('D04 drawing DXF export', () => {
  it('writes the page in paper millimetres, a layer per line kind, with arrowheads and text', async () => {
    const { page } = await drawn();
    const dxf = sheetPageToDxf(page);
    expect(dxf).toContain('$INSUNITS\r\n70\r\n4\r\n');
    // The layers the page uses, with the hidden and centre line types.
    for (const layer of [
      'VISIBLE',
      'HIDDEN',
      'BORDER',
      'THIN',
      'DIMENSION',
      'TEXT'
    ])
      expect(dxf).toContain(`\r\n2\r\n${layer}\r\n70\r\n0\r\n62\r\n`);
    expect(dxf).toMatch(/\r\n2\r\nHIDDEN\r\n70\r\n0\r\n3\r\nHidden/);
    expect(dxf).toMatch(
      /\r\n2\r\nHIDDEN\r\n70\r\n0\r\n62\r\n8\r\n6\r\nHIDDEN\r\n/
    );
    const records = entities(dxf);
    const on = (layer: string) =>
      records.filter((record) => record.groups.get(8)?.[0] === layer);
    // Every page stroke and text is there, each on its layer.
    const strokes = page.strokes.filter((stroke) => stroke.points.length >= 4);
    const vertexCarriers = records.filter((record) =>
      ['LINE', 'POLYLINE', 'SOLID'].includes(record.type)
    );
    expect(vertexCarriers).toHaveLength(strokes.length);
    expect(on('TEXT').filter((record) => record.type === 'TEXT')).toHaveLength(
      page.texts.filter((text) => text.text).length
    );
    expect(
      on('DIMENSION').filter((record) => record.type === 'SOLID')
    ).toHaveLength(2);
    expect(on('HIDDEN').length).toBeGreaterThan(0);
    // The dimension's value at its page position, centred; Ø escaped.
    const value = page.texts.find((text) => text.text === '20')!;
    const twenty = on('TEXT').find(
      (record) => record.groups.get(1)?.[0] === '20'
    )!;
    expect(Number(twenty.groups.get(11)![0])).toBeCloseTo(value.x, 6);
    expect(Number(twenty.groups.get(21)![0])).toBeCloseTo(value.y, 6);
    expect(twenty.groups.get(72)).toEqual(['1']);
    expect(dxf).toContain('BREAK EDGES \\U+00D80.5');
    // A visible edge lands where the page draws it.
    const edge = page.strokes.find((stroke) => stroke.kind === 'visible')!;
    const firstVisible = records.find(
      (record) =>
        record.groups.get(8)?.[0] === 'VISIBLE' &&
        (record.type === 'LINE' || record.type === 'POLYLINE')
    )!;
    if (firstVisible.type === 'LINE')
      expect(Number(firstVisible.groups.get(10)![0])).toBeCloseTo(
        edge.points[0]!,
        6
      );
    // Deterministic: the same page writes the same bytes.
    expect(sheetPageToDxf(page)).toBe(dxf);
  });

  it('reads back through a DXF reader: the lines import, the text and arrowheads are counted', async () => {
    const { page } = await drawn();
    const imported = importDxfSketch(sheetPageToDxf(page), 'mm');
    expect(imported.sourceUnit).toBe('millimetres');
    expect(imported.objects.length).toBeGreaterThan(20);
    expect(imported.dropped.TEXT).toBe(
      page.texts.filter((text) => text.text).length
    );
  });

  it('names the file .dxf and keeps the writer’s older layer tables byte-identical', () => {
    expect(drawingExportFileName('Bracket', 'Sheet 1', 'dxf')).toBe(
      'Bracket-Sheet-1.dxf'
    );
    // Flat patterns name only DASHED: its line-type table is unchanged.
    const dashed = writeDxf(
      [{ kind: 'line', layer: 'BEND', start: [0, 0], end: [1, 0] }],
      { layers: [{ name: 'BEND', lineType: 'DASHED' }] }
    );
    expect(dashed).toContain(
      '0\r\nLTYPE\r\n2\r\nDASHED\r\n70\r\n0\r\n3\r\nDashed __ __ __\r\n72\r\n65\r\n73\r\n2\r\n40\r\n0.75\r\n49\r\n0.5\r\n49\r\n-0.25\r\n'
    );
    expect(dashed).toContain('2\r\nLTYPE\r\n70\r\n2\r\n');
    // A SOLID repeats a triangle's last corner, in its 1-2-4-3 order.
    const solid = writeDxf([
      {
        kind: 'solid',
        points: [
          [0, 0],
          [2, 0],
          [1, 1]
        ]
      }
    ]);
    expect(solid).toContain(
      'SOLID\r\n8\r\n0\r\n10\r\n0\r\n20\r\n0\r\n30\r\n0\r\n11\r\n2\r\n21\r\n0\r\n31\r\n0\r\n12\r\n1\r\n22\r\n1\r\n32\r\n0\r\n13\r\n1\r\n23\r\n1\r\n33\r\n0\r\n'
    );
  });
});

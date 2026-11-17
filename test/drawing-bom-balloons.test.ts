import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  assertStorableDocument,
  createProjectDocument,
  normalizeDocument
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  drawingSetError,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingViewId,
  type ProjectDocument
} from '@openzcad/shared';
import { projectView } from '../apps/web/src/lib/drawing/projectView';
import { projectionBodyInput } from '../apps/web/src/lib/drawing/sheetSources';
import { composeSheetPage } from '../apps/web/src/lib/drawing/sheetPage';
import { sheetPageToSvg } from '../apps/web/src/lib/drawing/sheetExport';
import {
  balloonComponent,
  composeSheetAnnotations,
  markHiddenLeaders,
  resolveSheetAnnotations,
  sheetBom
} from '../apps/web/src/lib/drawing/annotations';
import {
  draftAnnotation,
  repairedAnnotation,
  startAnnotationTool
} from '../apps/web/src/lib/drawing/annotationPicking';

/**
 * D02 parts lists and balloons (schema v80): an assembly's BOM table on the
 * paper and balloons naming a part's item number, both read from the AS03
 * table model each time the sheet is drawn.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const sheetId = 'dsht_bom' as DrawingSheetId;
const frontId = 'dvw_front' as DrawingViewId;
const id = (name: string) => `dann_${name}` as DrawingAnnotationId;

/** A plate and two pins, assembled: the pins share one BOM row. */
async function assembly() {
  const manager = new CommandManager(
    createProjectDocument('Rig', toUserId('test'))
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 10, depth: 20 }
    })
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Pin',
      primitiveKind: 'cylinder',
      dimensions: { radius: 3, height: 12 }
    })
  );
  const [plate, pin] = manager.document.bodyOrder as [BodyId, BodyId];
  // A second pin: a moved copy of the first, the same part.
  manager.execute(
    commandFactories.transformBody({
      name: 'Copy',
      targetBodyId: pin,
      translation: { x: 30, y: 0, z: 0 },
      copy: true
    })
  );
  const pinCopy = manager.document.bodyOrder.at(-1)!;
  let document = manager.document;
  const next = new CommandManager(document);
  next.execute(
    commandFactories.addAssemblyComponents({
      components: [
        {
          componentId: 'comp_plate',
          name: 'Plate',
          bodyId: plate,
          grounded: true
        },
        {
          componentId: 'comp_pin_a',
          name: 'Pin A',
          bodyId: pin,
          grounded: false
        },
        {
          componentId: 'comp_pin_b',
          name: 'Pin B',
          bodyId: pinCopy,
          grounded: false
        }
      ]
    })
  );
  document = next.document;
  const derived = await adapter.syncDocument(document);
  document = {
    ...document,
    derived: {
      ...document.derived,
      bodyRepresentations: derived.bodyRepresentations
    }
  };
  const bodies = derived.bodyRepresentations;
  const edgeOf = (bodyId: BodyId) => {
    const edge = bodies[bodyId]!.topology!.edges.find(
      (entry) => entry.curve?.type === 'LINE' || entry.curve?.circle
    )!;
    return { bodyId, hash: edge.hash };
  };
  return { document, bodies, plate, pin, edgeOf };
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
      {
        viewId: frontId,
        orientation: 'front',
        bodyIds,
        centerMm: { x: 150, y: 150 },
        hiddenLines: false
      }
    ],
    annotations
  };
}

function drawn(
  sheet: DrawingSheet,
  bodies: Record<string, BodyRepresentation>,
  document: ProjectDocument
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
  const bom = sheetBom(document)!;
  const resolutions = resolveSheetAnnotations(
    sheet,
    bodies,
    'mm',
    undefined,
    bom
  );
  const layer = composeSheetAnnotations(sheet, views, resolutions, 'mm');
  return { views, bom, resolutions, layer };
}

describe('D02 parts lists and balloons (schema v80)', () => {
  it('claims v80 and validates both by name', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(80);
    const edge = { bodyId: 'b' as BodyId, hash: 7 };
    const check = (annotations: unknown[]) =>
      drawingSetError({
        sheets: [sheetOf(['b' as BodyId], annotations as DrawingAnnotation[])]
      });
    const list = {
      annotationId: id('l'),
      kind: 'bom-table',
      placementMm: { x: 20, y: 280 }
    };
    const balloon = {
      annotationId: id('b'),
      kind: 'balloon',
      viewId: frontId,
      leader: edge,
      componentId: 'comp_plate',
      placementMm: { x: 10, y: 10 }
    };
    expect(check([list, balloon])).toBeNull();
    expect(
      check([{ ...list, columns: ['item', 'part', 'source_body'] }])
    ).toBeNull();
    const bad: [unknown, RegExp][] = [
      [{ ...list, viewId: frontId }, /sits on the paper/],
      [{ ...list, columns: [] }, /each known BOM column once/],
      [{ ...list, columns: ['item', 'item'] }, /each known BOM column once/],
      [{ ...list, columns: ['mass'] }, /each known BOM column once/],
      [{ ...list, decimals: 2 }, /states no measured value/],
      [{ ...balloon, viewId: undefined }, /balloon that belongs to no view/],
      [{ ...balloon, componentId: '' }, /names no assembly component/],
      [{ ...balloon, leader: { bodyId: 'b', hash: 0 } }, /invalid edge hash/]
    ];
    for (const [annotation, message] of bad)
      expect(check([annotation])).toMatch(message);
  });

  it('lists the assembly from the AS03 table and balloons a part with its row’s item number', async () => {
    const { document, bodies, plate, pin, edgeOf } = await assembly();
    const annotations: DrawingAnnotation[] = [
      {
        annotationId: id('list'),
        kind: 'bom-table',
        placementMm: { x: 20, y: 280 }
      },
      {
        annotationId: id('plate'),
        kind: 'balloon',
        viewId: frontId,
        leader: edgeOf(plate),
        componentId: 'comp_plate',
        placementMm: { x: -40, y: 30 }
      },
      {
        annotationId: id('pin'),
        kind: 'balloon',
        viewId: frontId,
        leader: edgeOf(pin),
        componentId: 'comp_pin_b',
        placementMm: { x: 60, y: 30 }
      }
    ];
    const sheet = sheetOf([plate, pin], annotations);
    expect(drawingSetError({ sheets: [sheet] })).toBeNull();
    const { views, bom, resolutions, layer } = drawn(sheet, bodies, document);
    expect(
      bom.rows.map((row) => [row.item, row.cells.quantity, row.cells.part])
    ).toEqual([
      [1, '1', 'Plate Body'],
      [2, '2', 'Pin Body']
    ]);
    const label = (name: string) => {
      const resolution = resolutions.get(id(name))!;
      return resolution.ok ? resolution.resolved.label : resolution.reason;
    };
    expect(label('plate')).toBe('1');
    // Either pin's component names the same row.
    expect(label('pin')).toBe('2');
    // The table's cells, header first, exactly as the BOM table wrote them.
    const texts = layer.texts.map((text) => text.text);
    for (const cell of [
      'Item',
      'Qty',
      'Part',
      'Plate Body',
      'Pin Body',
      '1',
      '2'
    ])
      expect(texts).toContain(cell);
    expect(layer.texts.find((text) => text.text === 'Item')!.bold).toBe(true);
    // Numeric cells align to their column's end.
    expect(
      layer.texts.filter((text) => text.text === '2' && text.align === 'end')
        .length
    ).toBeGreaterThan(0);
    // A ruled table: its frame, a rule under each row and between columns.
    const list = layer.boxes.get(id('list'))!;
    expect(list.height).toBeCloseTo(3 * 6, 9);
    expect(list.x).toBe(20);
    expect(list.y + list.height).toBe(280);
    // Each balloon: a circle with its number, and a leader to its part.
    const balloon = layer.boxes.get(id('plate'))!;
    expect(balloon.width).toBeCloseTo(8, 9);
    expect(layer.strokes.filter((stroke) => stroke.filled)).toHaveLength(2);
    const page = composeSheetPage(
      sheet,
      views,
      { projectName: 'Rig', units: 'mm' },
      layer
    );
    const svg = sheetPageToSvg(page, sheet.name);
    expect(svg).toContain('>Part</text>');
    expect(svg).toContain('>Pin Body</text>');
  });

  it('breaks by name rather than guessing: no assembly, a part gone from it, or another part’s edge', async () => {
    const { document, bodies, plate, pin, edgeOf } = await assembly();
    const annotations: DrawingAnnotation[] = [
      {
        annotationId: id('list'),
        kind: 'bom-table',
        placementMm: { x: 20, y: 280 }
      },
      {
        annotationId: id('gone'),
        kind: 'balloon',
        viewId: frontId,
        leader: edgeOf(plate),
        componentId: 'comp_removed',
        placementMm: { x: -40, y: 30 }
      }
    ];
    const sheet = sheetOf([plate], annotations);
    const { resolutions } = drawn(sheet, bodies, document);
    const gone = resolutions.get(id('gone'))!;
    expect(!gone.ok && gone.reason).toBe('not-in-bom');
    // A balloon on another part's edge would print that part's edge with
    // this part's number: refused by name.
    const wrong = sheetOf(
      [plate, pin],
      [
        {
          annotationId: id('wrong'),
          kind: 'balloon',
          viewId: frontId,
          leader: edgeOf(pin),
          componentId: 'comp_plate',
          placementMm: { x: -40, y: 30 }
        }
      ]
    );
    const refused = drawn(wrong, bodies, document).resolutions.get(
      id('wrong')
    )!;
    expect(!refused.ok && refused.reason).toBe('not-on-part');
    const empty = resolveSheetAnnotations(sheet, bodies, 'mm').get(id('list'))!;
    expect(!empty.ok && empty.reason).toBe('no-bom');
  });

  it('points a balloon only at what its view draws of the edge, as a note does', async () => {
    const { document, bodies, plate, edgeOf } = await assembly();
    const sheet = sheetOf(
      [plate],
      [
        {
          annotationId: id('plate'),
          kind: 'balloon',
          viewId: frontId,
          leader: edgeOf(plate),
          componentId: 'comp_plate',
          placementMm: { x: -40, y: 30 }
        }
      ]
    );
    const { views, resolutions } = drawn(sheet, bodies, document);
    const shown = markHiddenLeaders(
      sheet,
      resolutions,
      views,
      'mm',
      bodies
    ).get(id('plate'))!;
    // Its edge drawn: kept, with the pieces the view draws of it.
    expect(shown.ok && shown.resolved.kind === 'balloon').toBe(true);
    if (shown.ok && shown.resolved.kind === 'balloon')
      expect(shown.resolved.leaderPieces?.length).toBeGreaterThan(0);
    // The view drawing none of it (only silhouettes): broken, not an arrow
    // at blank paper.
    const silhouetteOnly = views.map((entry) => ({
      ...entry,
      projection: {
        ...entry.projection,
        edgeRuns: {
          visible: [] as Float64Array[],
          hidden: [] as Float64Array[]
        }
      }
    }));
    expect(
      markHiddenLeaders(sheet, resolutions, silhouetteOnly, 'mm', bodies).get(
        id('plate')
      )
    ).toMatchObject({ ok: false, reason: 'leader-hidden' });
  });

  it('shows only the chosen columns, in the table’s order', async () => {
    const { document, bodies, plate } = await assembly();
    const sheet = sheetOf(
      [plate],
      [
        {
          annotationId: id('list'),
          kind: 'bom-table',
          columns: ['part', 'item', 'source_body'],
          placementMm: { x: 20, y: 280 }
        }
      ]
    );
    const { resolutions } = drawn(sheet, bodies, document);
    const list = resolutions.get(id('list'))!;
    if (!list.ok || list.resolved.kind !== 'bom-table')
      throw new Error('no list');
    expect(list.resolved.header).toEqual(['Part', 'Item', 'Source body']);
    expect(list.resolved.rows[0]![0]).toBe('Plate Body');
  });

  it('drafts from the tools, names a re-picked balloon’s new part, and is gated below v80', async () => {
    const { document, bodies, plate, pin, edgeOf } = await assembly();
    const placed = {
      ...startAnnotationTool('parts-list'),
      placed: { x: 20, y: 280 }
    };
    expect(draftAnnotation(placed, id('l'), { x: 20, y: 280 })).toEqual({
      annotationId: id('l'),
      kind: 'bom-table',
      placementMm: { x: 20, y: 280 }
    });
    const picked = {
      ...startAnnotationTool('balloon'),
      viewId: frontId,
      edges: [edgeOf(plate)]
    };
    expect(draftAnnotation(picked, id('b'), { x: 1, y: 2 })).toBeNull();
    const balloon = draftAnnotation(
      picked,
      id('b'),
      { x: 1, y: 2 },
      undefined,
      'comp_plate'
    )!;
    expect(balloon).toMatchObject({
      kind: 'balloon',
      componentId: 'comp_plate'
    });
    const repick = {
      ...startAnnotationTool('balloon', id('b'), frontId),
      edges: [{ ...edgeOf(plate) }]
    };
    expect(repairedAnnotation(balloon, repick)).toMatchObject({
      componentId: 'comp_plate'
    });
    // Re-picked onto a pin, it names the pin's part, not the plate's.
    const bom = sheetBom(document)!;
    expect(balloonComponent(bom, plate)).toBe('comp_plate');
    expect(balloonComponent(bom, pin)).toBe('comp_pin_a');
    expect(balloonComponent(bom, 'body_elsewhere')).toBeUndefined();
    const onPin = repairedAnnotation(
      balloon,
      { ...repick, edges: [edgeOf(pin)] },
      balloonComponent(bom, pin)
    )!;
    expect(onPin).toMatchObject({
      componentId: 'comp_pin_a',
      leader: edgeOf(pin)
    });
    const repicked = resolveSheetAnnotations(
      sheetOf([plate, pin], [onPin]),
      bodies,
      'mm',
      undefined,
      bom
    ).get(id('b'))!;
    expect(repicked.ok && repicked.resolved.label).toBe('2');

    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.addDrawingSheet({ sheet: sheetOf([plate], [balloon]) })
    );
    expect(() => assertStorableDocument(manager.document)).not.toThrow();
    const saved = normalizeDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    expect(saved.drawings).toEqual(manager.document.drawings);
    expect(() =>
      assertStorableDocument({ ...manager.document, schemaVersion: 76 })
    ).toThrow(/Parts lists and balloons require project schema v80/);
  });
});

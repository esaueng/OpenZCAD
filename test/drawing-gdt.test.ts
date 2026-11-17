import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  assertStorableDocument,
  createProjectDocument,
  normalizeDocument,
  setParameter,
  transformBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  DRAWING_GEOMETRIC_CHARACTERISTICS,
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
import {
  composeSheetPage,
  viewPageTransform
} from '../apps/web/src/lib/drawing/sheetPage';
import {
  sheetPageToDxf,
  sheetPageToPdf,
  sheetPageToSvg
} from '../apps/web/src/lib/drawing/sheetExport';
import {
  composeSheetAnnotations,
  drawingDatumLetters,
  formatFrameTolerance,
  drawingNumberFormat,
  previewAnnotationLayer,
  resolveSheetAnnotations,
  type AnnotationResolution
} from '../apps/web/src/lib/drawing/annotations';
import {
  draftAnnotation,
  nextDatumLetter,
  pickedEnough,
  repairedAnnotation,
  startAnnotationTool
} from '../apps/web/src/lib/drawing/annotationPicking';
import {
  characteristicSymbol,
  featureControlFrameLayout,
  FRAME_HEIGHT_MM
} from '../apps/web/src/lib/drawing/toleranceFrames';

/**
 * D07 geometric tolerancing (schema v98): datum feature symbols and feature
 * control frames on drawing views, pointing at an edge or attached to a
 * size dimension, breaking by name rather than rebinding.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const sheetId = 'dsht_gdt' as DrawingSheetId;
const frontId = 'dvw_front' as DrawingViewId;
const topId = 'dvw_top' as DrawingViewId;
const id = (name: string) => `dann_${name}` as DrawingAnnotationId;
const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;
const at = { x: 0, y: 0 };

/** A w × 10 × 6 box (w a parameter) beside a Ø8 pin, 40 along x. */
function boxDocument(width = 20, from?: ProjectDocument): ProjectDocument {
  if (from) return setParameter(from, { name: 'w', expression: String(width) });
  let document = createProjectDocument('Bracket', toUserId('test'));
  document = setParameter(document, { name: 'w', expression: String(width) });
  document = addPrimitiveFeature(document, {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 'w', height: 10, depth: 6 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Pin',
    primitiveKind: 'cylinder',
    dimensions: { radius: 4, height: 12 }
  });
  return transformBody(document, {
    name: 'Move',
    targetBodyId: document.bodyOrder[1]!,
    translation: { x: 40, y: 0, z: 0 }
  }).document;
}

function ref(bodyId: BodyId, edge: EdgeTopology): DrawingEdgeRef {
  return {
    bodyId,
    hash: edge.hash,
    ...(edge.reference ? { reference: edge.reference } : {})
  };
}

async function model(width = 20, from?: ProjectDocument) {
  const document = boxDocument(width, from);
  const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
  const [boxId, pinId] = document.bodyOrder as [BodyId, BodyId];
  const box = bodies[boxId]!;
  const { min, max } = box.bbox;
  // The front view looks along +Y: these are its near edges.
  const front = (axis: 0 | 2, value: number) => {
    const found = box.topology!.edges.filter((edge) => {
      const p = edge.points;
      const a = p.slice(0, 3);
      const b = p.slice(p.length - 3);
      return [
        [a, b],
        [b, a]
      ].some(
        ([u, v]) =>
          near(u![1]!, min.y) &&
          near(v![1]!, min.y) &&
          near(u![axis]!, value) &&
          near(v![axis]!, value)
      );
    });
    expect(found).toHaveLength(1);
    return ref(boxId, found[0]!);
  };
  const rims = bodies[pinId]!.topology!.edges.filter(
    (edge) => edge.curve?.circle
  );
  const topRim = rims.reduce((best, edge) =>
    edge.curve!.circle!.center.z > best.curve!.circle!.center.z ? edge : best
  );
  return {
    document,
    bodies,
    boxId,
    pinId,
    bottom: front(2, min.z),
    left: front(0, min.x),
    right: front(0, max.x),
    rim: ref(pinId, topRim)
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

type Bodies = Awaited<
  ReturnType<Adapter['syncDocument']>
>['bodyRepresentations'];

function drawnViews(sheet: DrawingSheet, bodies: Bodies) {
  return sheet.views.map((entry) => ({
    view: entry,
    projection: projectView({
      orientation: entry.orientation,
      hiddenLines: entry.hiddenLines,
      bodies: entry.bodyIds.map((bodyId) =>
        projectionBodyInput(bodies[bodyId]!)!
      )
    })
  }));
}

/** A resolved leader's polyline on the paper. */
function leaderOnPage(
  sheet: DrawingSheet,
  views: ReturnType<typeof drawnViews>,
  resolution: { leader?: number[] }
): [number, number][] {
  const entry = views.find((candidate) => candidate.view.viewId === frontId)!;
  const toPage = viewPageTransform(
    entry.view,
    entry.projection.bounds!,
    sheet,
    'mm'
  );
  const flat = resolution.leader ?? [];
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2)
    out.push(toPage(flat[i]!, flat[i + 1]!));
  return out;
}

function resolved(
  resolutions: Map<DrawingAnnotationId, AnnotationResolution>,
  name: string
) {
  const resolution = resolutions.get(id(name))!;
  if (!resolution.ok) throw new Error(`${name}: ${resolution.message}`);
  return resolution.resolved;
}

function reason(
  resolutions: Map<DrawingAnnotationId, AnnotationResolution>,
  name: string
) {
  const resolution = resolutions.get(id(name))!;
  return resolution.ok ? 'ok' : resolution.reason;
}

/**
 * The bracket's GD&T: datum A on the box's bottom, the left side square to
 * A, and the pin's Ø8 located by a Ø0.1 Ⓜ position frame to A under its
 * diameter, with datum B hanging from that frame.
 */
function bracketAnnotations(m: Awaited<ReturnType<typeof model>>) {
  return [
    {
      annotationId: id('a'),
      kind: 'datum-feature',
      viewId: frontId,
      leader: m.bottom,
      letter: 'A',
      placementMm: { x: -20, y: -30 }
    },
    {
      annotationId: id('perp'),
      kind: 'feature-control-frame',
      viewId: frontId,
      leader: m.left,
      characteristic: 'perpendicularity',
      amount: 0.05,
      datums: [{ letter: 'A' }],
      placementMm: { x: -60, y: 20 }
    },
    {
      annotationId: id('dia'),
      kind: 'diameter',
      viewId: topId,
      edge: m.rim,
      placementMm: { x: 60, y: 20 },
      tolerance: { kind: 'symmetric', value: 0.02 }
    },
    {
      annotationId: id('pos'),
      kind: 'feature-control-frame',
      viewId: topId,
      attachedTo: id('dia'),
      characteristic: 'position',
      amount: 0.1,
      diameterZone: true,
      material: 'mmc',
      datums: [{ letter: 'A' }],
      placementMm: at
    },
    {
      annotationId: id('b'),
      kind: 'datum-feature',
      viewId: topId,
      attachedTo: id('pos'),
      letter: 'B',
      placementMm: { x: 60, y: 0 }
    }
  ] as DrawingAnnotation[];
}

describe('D07 geometric tolerancing (schema v98)', () => {
  it('claims v98 and validates datum symbols and frames by name', async () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(98);
    const m = await model();
    const [datum, perp, dia, pos] = bracketAnnotations(m) as [
      Record<string, unknown>,
      Record<string, unknown>,
      DrawingAnnotation,
      Record<string, unknown>
    ];
    const check = (annotations: unknown[]) =>
      drawingSetError({
        sheets: [
          sheetOf([m.boxId, m.pinId], annotations as DrawingAnnotation[])
        ]
      });
    expect(check(bracketAnnotations(m))).toBeNull();
    // A missing host is broken when drawn, not refused: deleting a
    // dimension must never make the sheet unstorable.
    expect(check([{ ...pos, attachedTo: id('gone') }])).toBeNull();
    const bad: [unknown[], RegExp][] = [
      [[{ ...datum, letter: 'I' }], /capitals other than I, O and Q/],
      [[{ ...datum, letter: 'a' }], /capitals other than I, O and Q/],
      [[{ ...datum, viewId: undefined }], /belongs to no view/],
      [[{ ...datum, attachedTo: id('dia') }, dia], /not both/],
      [[{ ...datum, leader: undefined }], /not both/],
      [[{ ...datum, decimals: 2 }], /has no decimals/],
      [[{ ...perp, characteristic: 'roundness' }], /unknown characteristic/],
      [[{ ...perp, amount: 0 }], /not a positive amount/],
      [[{ ...perp, amount: 0.0000001 }], /at most six decimals/],
      [
        [{ ...perp, datums: undefined }],
        /perpendicularity, which needs at least one datum/
      ],
      [
        [{ ...perp, characteristic: 'flatness' }],
        /flatness, a form tolerance, which takes no datum/
      ],
      [
        [
          {
            ...perp,
            characteristic: 'flatness',
            datums: undefined,
            diameterZone: true
          }
        ],
        /cylindrical \(Ø\) zone/
      ],
      [
        [
          {
            ...perp,
            characteristic: 'flatness',
            datums: undefined,
            material: 'mmc'
          }
        ],
        /material condition, which it cannot take/
      ],
      [
        [
          {
            ...perp,
            characteristic: 'circular-runout',
            datums: [{ letter: 'A', material: 'mmc' }]
          }
        ],
        /datum of circular-runout/
      ],
      [
        [{ ...perp, datums: [{ letter: 'A' }, { letter: 'A' }] }],
        /datum A twice/
      ],
      [
        [
          {
            ...perp,
            datums: ['A', 'B', 'C', 'D'].map((letter) => ({ letter }))
          }
        ],
        /one to 3 datum references/
      ],
      [[{ ...perp, datums: [{ letter: 'A', extra: 1 }] }], /malformed datum/],
      // Attached to a note, or to a dimension on another view.
      [
        [
          {
            annotationId: id('n'),
            kind: 'note',
            text: 'NOTE',
            placementMm: at
          },
          { ...pos, attachedTo: id('n') }
        ],
        /not a dimension on its view/
      ],
      [[dia, { ...pos, viewId: frontId }], /not a dimension on its view/],
      // A frame may hang from a dimension only; a datum symbol may hang
      // from a frame too.
      [
        [
          dia,
          pos,
          { ...perp, leader: undefined, attachedTo: id('pos'), viewId: topId }
        ],
        /not a dimension on its view/
      ]
    ];
    for (const [annotations, message] of bad)
      expect(check(annotations)).toMatch(message);
  });

  it('resolves the bracket on kernel bodies and lays frames out per Y14.5', async () => {
    const m = await model();
    const sheet = sheetOf([m.boxId, m.pinId], bracketAnnotations(m));
    const resolutions = resolveSheetAnnotations(sheet, m.bodies, 'mm');
    for (const name of ['a', 'perp', 'dia', 'pos', 'b'])
      expect(reason(resolutions, name)).toBe('ok');
    const perp = resolved(resolutions, 'perp');
    expect(perp.label).toBe('Perpendicularity | 0.05 | A');
    expect(resolved(resolutions, 'pos').label).toBe('Position | Ø0.1 (M) | A');
    expect(resolved(resolutions, 'b').label).toBe('B');
    const views = drawnViews(sheet, m.bodies);
    const layer = composeSheetAnnotations(sheet, views, resolutions, 'mm');
    expect(layer.boxes.size).toBe(5);
    // The position frame sits just below the diameter's text, left aligned,
    // one frame (2 × 3 mm text) tall.
    const dia = layer.boxes.get(id('dia'))!;
    const pos = layer.boxes.get(id('pos'))!;
    expect(pos.x).toBeCloseTo(dia.x, 9);
    expect(pos.y + pos.height).toBeCloseTo(dia.y - 1, 9);
    expect(pos.height).toBe(FRAME_HEIGHT_MM);
    // Its texts: Ø0.1, the circled M, the datum A.
    const texts = layer.texts.map((text) => text.text);
    expect(texts).toEqual(
      expect.arrayContaining(['Ø0.1', 'M', 'A', 'B', '0.05'])
    );
    // Datum B's filled triangle stands on the frame's outline.
    const b = layer.boxes.get(id('b'))!;
    const triangles = layer.strokes.filter(
      (stroke) => stroke.filled && stroke.points.length === 6
    );
    const onFrame = triangles.find((stroke) => {
      const [, , x1, y1, x2, y2] = stroke.points as [
        number,
        number,
        number,
        number,
        number,
        number
      ];
      const foot = [(x1 + x2) / 2, (y1 + y2) / 2] as const;
      return (
        near(foot[1], pos.y) && foot[0] >= pos.x && foot[0] <= pos.x + pos.width
      );
    });
    expect(onFrame).toBeDefined();
    expect(b.y).toBeLessThan(pos.y + pos.height);
    // Datum A's triangle stands on the box's bottom edge in the front view,
    // its base along the edge.
    const bottom = leaderOnPage(
      sheet,
      views,
      resolved(resolutions, 'a') as { leader?: number[] }
    );
    expect(near(bottom[0]![1], bottom.at(-1)![1])).toBe(true);
    const datumFoot = triangles.some((stroke) => {
      const [, , x1, y1, x2, y2] = stroke.points;
      return (
        near(y1!, bottom[0]![1]) &&
        near(y2!, bottom[0]![1]) &&
        Math.min(x1!, x2!) >= Math.min(bottom[0]![0], bottom.at(-1)![0])
      );
    });
    expect(datumFoot).toBe(true);
    // The perpendicularity frame's leader ends on the box's left edge, its
    // arrow pointing at it.
    const left = leaderOnPage(
      sheet,
      views,
      resolved(resolutions, 'perp') as { leader?: number[] }
    );
    expect(
      triangles.some((stroke) => near(stroke.points[0]!, left[0]![0]))
    ).toBe(true);
  });

  it('breaks by name: undeclared or repeated datums, and lost or broken hosts', async () => {
    const m = await model();
    const [a, perp, dia, pos, b] = bracketAnnotations(m) as [
      DrawingAnnotation,
      DrawingAnnotation,
      DrawingAnnotation,
      DrawingAnnotation,
      DrawingAnnotation
    ];
    const resolve = (annotations: DrawingAnnotation[]) =>
      resolveSheetAnnotations(
        sheetOf([m.boxId, m.pinId], annotations),
        m.bodies,
        'mm'
      );
    // No datum A declared: both frames name it.
    let resolutions = resolve([perp, dia, pos]);
    expect(reason(resolutions, 'perp')).toBe('datum-undefined');
    expect(reason(resolutions, 'pos')).toBe('datum-undefined');
    // Declared on another sheet of the drawing, it is defined.
    resolutions = resolveSheetAnnotations(
      sheetOf([m.boxId, m.pinId], [perp]),
      m.bodies,
      'mm',
      undefined,
      undefined,
      undefined,
      drawingDatumLetters([{ annotations: [a] }])
    );
    expect(reason(resolutions, 'perp')).toBe('ok');
    // Two symbols declaring A: both broken, and nothing guesses which.
    resolutions = resolve([a, { ...a, annotationId: id('a2') }, perp]);
    expect(reason(resolutions, 'a')).toBe('datum-duplicate');
    expect(reason(resolutions, 'a2')).toBe('datum-duplicate');
    // The diameter deleted: the frame under it is host-missing, and B,
    // which hangs from the frame, is host-broken.
    resolutions = resolve([a, pos, b]);
    expect(reason(resolutions, 'pos')).toBe('host-missing');
    expect(reason(resolutions, 'b')).toBe('host-broken');
    // The diameter broken (its rim gone from the view): both cascade.
    const boxOnly = resolveSheetAnnotations(
      sheetOf([m.boxId], [a, dia, pos, b]),
      m.bodies,
      'mm'
    );
    expect(reason(boxOnly, 'dia')).not.toBe('ok');
    expect(reason(boxOnly, 'pos')).toBe('host-broken');
    expect(reason(boxOnly, 'b')).toBe('host-broken');
    // A broken attachment is not drawn.
    const layer = composeSheetAnnotations(
      sheetOf([m.boxId], [a, dia, pos, b]),
      drawnViews(sheetOf([m.boxId], []), m.bodies),
      boxOnly,
      'mm'
    );
    expect([...layer.boxes.keys()]).toEqual([id('a')]);
  });

  it('follows the model through a parameter edit by lineage', async () => {
    const narrow = await model(20);
    // The frame on the right side, which moves as the box widens.
    const annotations = bracketAnnotations(narrow).map((annotation) =>
      annotation.annotationId === id('perp')
        ? { ...annotation, leader: narrow.right }
        : annotation
    );
    const wide = await model(30, narrow.document);
    expect(wide.right.hash).not.toBe(narrow.right.hash);
    const sheet = sheetOf([wide.boxId, wide.pinId], annotations);
    const resolutions = resolveSheetAnnotations(sheet, wide.bodies, 'mm');
    for (const name of ['a', 'perp', 'pos', 'b'])
      expect(reason(resolutions, name)).toBe('ok');
    // The leader now ends on the widened box's right edge.
    const views = drawnViews(sheet, wide.bodies);
    const layer = composeSheetAnnotations(sheet, views, resolutions, 'mm');
    const right = leaderOnPage(
      sheet,
      views,
      resolved(resolutions, 'perp') as { leader?: number[] }
    );
    const narrowSheet = sheetOf([narrow.boxId, narrow.pinId], annotations);
    const before = leaderOnPage(
      narrowSheet,
      drawnViews(narrowSheet, narrow.bodies),
      resolved(
        resolveSheetAnnotations(narrowSheet, narrow.bodies, 'mm'),
        'perp'
      ) as { leader?: number[] }
    );
    // It moved with the edge rather than staying where the narrow box's was.
    const leftOf = (edge: [number, number][]) => edge[0]![0];
    expect(right[0]![0] - before[0]![0]).not.toBeCloseTo(0, 3);
    expect(
      layer.strokes.some(
        (stroke) => stroke.filled && near(stroke.points[0]!, leftOf(right))
      )
    ).toBe(true);
  });

  it('draws every characteristic as strokes inside its cell', () => {
    for (const characteristic of DRAWING_GEOMETRIC_CHARACTERISTICS) {
      const strokes = characteristicSymbol(characteristic, [10, 10], 1.8);
      expect(strokes.length).toBeGreaterThan(0);
      for (const stroke of strokes)
        for (let i = 0; i < stroke.points.length; i += 2) {
          // Within the 6 mm square cell centred on (10, 10).
          expect(Math.abs(stroke.points[i]! - 10)).toBeLessThanOrEqual(3);
          expect(Math.abs(stroke.points[i + 1]! - 10)).toBeLessThanOrEqual(3);
        }
    }
    // A frame's compartments: symbol, tolerance and one per datum.
    const frame = featureControlFrameLayout(
      {
        characteristic: 'position',
        tolerance: '0,1',
        diameterZone: true,
        material: 'mmc',
        datums: [
          { letter: 'A' },
          { letter: 'B', material: 'mmc' },
          { letter: 'C' }
        ]
      },
      [0, 0]
    );
    const dividers = frame.strokes.filter(
      (stroke) =>
        stroke.points.length === 4 &&
        near(stroke.points[0]!, stroke.points[2]!) &&
        near(stroke.points[1]!, 0) &&
        near(stroke.points[3]!, -FRAME_HEIGHT_MM)
    );
    expect(dividers).toHaveLength(4);
    expect(frame.texts.map((text) => text.text)).toEqual([
      'Ø0,1',
      'M',
      'A',
      'B',
      'M',
      'C'
    ]);
    // The sheet's number format: a comma, and inches as stored.
    expect(
      formatFrameTolerance(
        0.05,
        drawingNumberFormat({ decimalSeparator: 'comma' }, 'mm')
      )
    ).toBe('0,05');
    expect(
      formatFrameTolerance(0.002, drawingNumberFormat(undefined, 'inch'))
    ).toBe('0.002');
  });

  it('exports frames and datum symbols to SVG, PDF and DXF', async () => {
    const m = await model();
    const sheet = sheetOf([m.boxId, m.pinId], bracketAnnotations(m));
    const views = drawnViews(sheet, m.bodies);
    const layer = composeSheetAnnotations(
      sheet,
      views,
      resolveSheetAnnotations(sheet, m.bodies, 'mm'),
      'mm'
    );
    const page = composeSheetPage(
      sheet,
      views,
      { projectName: m.document.name, units: 'mm' },
      layer
    );
    const svg = sheetPageToSvg(page, sheet.name);
    for (const text of ['Ø0.1', '>A<', '>B<', '0.05'])
      expect(svg).toContain(text.startsWith('>') ? text : `>${text}<`);
    const pdf = new TextDecoder('latin1').decode(
      sheetPageToPdf(page, sheet.name)
    );
    expect(pdf).toContain('(0.05)');
    expect(pdf).toContain('(B)');
    const dxf = sheetPageToDxf(page);
    expect(dxf).toContain('0.05');
    // Filled triangles (arrows, datum feet) are DXF solids.
    expect(dxf).toContain('SOLID');
    // Byte-stable across a reload.
    const reloaded = normalizeDocument(
      JSON.parse(
        JSON.stringify({
          ...m.document,
          drawings: { sheets: [sheet] }
        })
      ) as ProjectDocument
    );
    const again = reloaded.drawings!.sheets[0]!;
    const svgAgain = sheetPageToSvg(
      composeSheetPage(
        again,
        views,
        { projectName: m.document.name, units: 'mm' },
        composeSheetAnnotations(
          again,
          views,
          resolveSheetAnnotations(again, m.bodies, 'mm'),
          'mm'
        )
      ),
      sheet.name
    );
    expect(svgAgain).toBe(svg);
  });

  it('previews an attached frame against its host', async () => {
    const m = await model();
    const [, , dia, pos] = bracketAnnotations(m);
    const sheet = sheetOf([m.boxId, m.pinId], [dia!]);
    const views = drawnViews(sheet, m.bodies);
    const preview = previewAnnotationLayer(sheet, pos!, views, m.bodies, 'mm');
    expect(preview.boxes.get(id('pos'))).toBeDefined();
  });

  it('drafts from the tools, re-picks onto a host, and picks the next letter', async () => {
    const m = await model();
    const tool = {
      ...startAnnotationTool('datum-feature'),
      viewId: frontId,
      edges: [m.bottom]
    };
    expect(pickedEnough(startAnnotationTool('datum-feature'))).toBe(false);
    expect(pickedEnough(tool)).toBe(true);
    const datum = draftAnnotation(tool, id('d'), at, undefined, undefined, {
      letter: nextDatumLetter(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']),
      amount: 0.1
    });
    // I is skipped.
    expect(datum).toMatchObject({
      kind: 'datum-feature',
      letter: 'J',
      leader: m.bottom
    });
    expect(nextDatumLetter([...'ABCDEFGHJKLMNPRSTUVWXYZ'])).toBe('AA');
    const frameTool = {
      ...startAnnotationTool('feature-control-frame'),
      viewId: topId,
      hostId: id('dia')
    };
    const frame = draftAnnotation(
      frameTool,
      id('f'),
      at,
      undefined,
      undefined,
      {
        letter: 'A',
        amount: 0.004
      }
    );
    // A new frame states flatness, valid with no datum.
    expect(frame).toEqual({
      annotationId: id('f'),
      kind: 'feature-control-frame',
      viewId: topId,
      attachedTo: id('dia'),
      characteristic: 'flatness',
      amount: 0.004,
      placementMm: at
    });
    // A re-pick moves a frame from its host onto an edge, and keeps the rest.
    const positioned = {
      ...frame!,
      characteristic: 'position',
      datums: [{ letter: 'A' }]
    } as DrawingAnnotation;
    const repaired = repairedAnnotation(positioned, {
      ...startAnnotationTool('feature-control-frame', id('f'), topId),
      edges: [m.rim]
    });
    expect(repaired).toEqual({
      annotationId: id('f'),
      kind: 'feature-control-frame',
      viewId: topId,
      leader: m.rim,
      characteristic: 'position',
      amount: 0.004,
      datums: [{ letter: 'A' }],
      placementMm: at
    });
  });

  it('stores them through undoable commands, gated below v98', async () => {
    const m = await model();
    const manager = new CommandManager(m.document);
    manager.execute(
      commandFactories.addDrawingSheet({
        sheet: sheetOf([m.boxId, m.pinId], [])
      })
    );
    for (const annotation of bracketAnnotations(m))
      manager.execute(
        commandFactories.addDrawingAnnotation({ sheetId, annotation })
      );
    expect(manager.document.drawings!.sheets[0]!.annotations).toHaveLength(5);
    expect(() => assertStorableDocument(manager.document)).not.toThrow();
    const saved = normalizeDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    expect(saved.drawings).toEqual(manager.document.drawings);
    expect(() =>
      assertStorableDocument({
        ...manager.document,
        schemaVersion: 97
      })
    ).toThrow(/Geometric tolerancing require project schema v98/);
    manager.undo();
    expect(manager.document.drawings!.sheets[0]!.annotations).toHaveLength(4);
  });
});

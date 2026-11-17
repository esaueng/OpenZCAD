import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch,
  holeBody,
  listFeaturesInOrder,
  sheetMetalBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  FLAT_PATTERN_DXF_LAYERS,
  flatPatternBendNote,
  formatFlatPatternNumber,
  flatPatternDxf,
  flatPatternExtents,
  flatPatternSvg,
  type SheetMetalFlatPattern
} from '@openzcad/kernel-adapter/sheet-metal-flat-pattern';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  sheetMetalBendMetrics,
  toUserId,
  type BodyId,
  type EntityId,
  type FeatureId,
  type ParamValue,
  type ProjectDocument,
  type SheetMetalBend,
  type SketchId,
  type SketchObjectData,
  type SketchProfileReference
} from '@openzcad/shared';
import { computeSketchRegions, profileContainsPoint } from '@openzcad/geometry';
import { importDxfSketch } from '../apps/web/src/lib/dxfImport';
import {
  bendTableCsv,
  bendTableRows,
  flatPatternChangedWarning
} from '../apps/web/src/lib/sheetMetalFlatPattern';
import {
  flatPatternTarget,
  sheetMetalFeatureForBody,
  sheetMetalFeatureOptions
} from '../apps/web/src/lib/sheetMetalFeatures';

/**
 * ROADMAP M16 slice 4: the flat pattern as a layered DXF, an SVG and a bend
 * table, from the adapter's flat-pattern API on the spec's parts.
 */
let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);

afterAll(() => {
  adapter.dispose();
});

const user = toUserId('user_flat_pattern');
const DEG = Math.PI / 180;
const T = 2;
const R = 2;
const K = 0.44;
/** The spec's L bracket: 50 × 50 outside from a 96.5239 blank. */
const L_BLANK = 96.5239;
const L_LINE = 48.262;
const WIDTH = 40;

const rectangle = (
  x0: number,
  y0: number,
  x1: number,
  y1: number
): SketchObjectData => ({
  objectKind: 'rectangle',
  width: x1 - x0,
  height: y1 - y0,
  centerX: (x0 + x1) / 2,
  centerY: (y0 + y1) / 2
});

const line = (
  x1: number,
  y1: number,
  x2: number,
  y2: number
): SketchObjectData => ({
  objectKind: 'line',
  x1,
  y1,
  x2,
  y2,
  construction: true
});

const circle = (x: number, y: number, radius: number): SketchObjectData => ({
  objectKind: 'circle',
  radius,
  centerX: x,
  centerY: y
});

/** The sketch cell that contains `point`, as a stored region reference. */
function cellAt(
  document: ProjectDocument,
  sketchId: SketchId,
  point: { x: number; y: number }
): SketchProfileReference {
  const sketch = findSketch(document, sketchId)!;
  const objects = sketch.objectIds.flatMap((id) => {
    const node = document.nodes[id];
    return node?.kind === 'sketch-object' ? [{ id, data: node.data }] : [];
  });
  const profile = computeSketchRegions(objects, (value: ParamValue) =>
    Number(value)
  ).find((candidate) => profileContainsPoint(candidate, point))!;
  return {
    profileId: profile.profileId,
    regionFingerprint: profile.regionFingerprint,
    samplePoint: profile.samplePoint,
    sourceArea: profile.area,
    sourceEntityIds: profile.sourceEntityIds
  };
}

interface Sheet {
  document: ProjectDocument;
  featureId: FeatureId;
  bodyId: BodyId;
}

/** A sheet on XY from `blank` objects and construction bend `lines`. */
function sheet(
  blank: SketchObjectData[],
  lines: SketchObjectData[],
  bends: (lineIds: EntityId[], sketchId: SketchId) => SheetMetalBend[],
  cells?: { x: number; y: number }[],
  options: {
    base?: ProjectDocument;
    name?: string;
    fixedPoint?: [number, number];
  } = {}
): Sheet {
  const { document: withSketch, sketchId } = addSketchFeature(
    options.base ?? createProjectDocument('Flat pattern', user),
    {
      name: 'Blank',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [...blank, ...lines]
    }
  );
  const objectIds = [...findSketch(withSketch, sketchId)!.objectIds];
  const { document, bodyId } = sheetMetalBody(withSketch, {
    name: options.name ?? 'Bracket',
    sketchId,
    ...(options.fixedPoint ? { fixedPoint: options.fixedPoint } : {}),
    profiles: cells
      ? cells.map((point) => cellAt(withSketch, sketchId, point))
      : [{ all: true, sourceEntityIds: objectIds.slice(0, blank.length) }],
    thickness: T,
    bendRadius: R,
    kFactor: K,
    relief: { shape: 'none' },
    bends: bends(objectIds.slice(blank.length), sketchId)
  });
  const feature = listFeaturesInOrder(document).find(
    (entry) => entry.bodyId === bodyId
  )!;
  return { document, featureId: feature.featureId, bodyId };
}

const bend = (
  id: string,
  sketchId: SketchId,
  objectId: EntityId,
  overrides: Partial<SheetMetalBend> = {}
): SheetMetalBend => ({
  id,
  line: { sketchId, objectId },
  angleDeg: 90,
  direction: 'up',
  ...overrides
});

const lBracket = () =>
  sheet(
    [rectangle(0, 0, L_BLANK, WIDTH)],
    [line(L_LINE, 0, L_LINE, WIDTH)],
    ([lineId], sketchId) => [bend('b1', sketchId, lineId!)]
  );

/** A Z part: one bend up, one down, 30 / 60 / 30 outside. */
const BD90 = sheetMetalBendMetrics(90 * DEG, R, T, K).bendDeduction;
const BA90 = sheetMetalBendMetrics(90 * DEG, R, T, K).bendAllowance;
const Z_FLAT = 120 - 2 * BD90;
const Z_FIRST = 30 - (R + T) + BA90 / 2;
const zPart = () =>
  sheet(
    [rectangle(0, 0, Z_FLAT, WIDTH)],
    [
      line(Z_FIRST, 0, Z_FIRST, WIDTH),
      line(Z_FLAT - Z_FIRST, 0, Z_FLAT - Z_FIRST, WIDTH)
    ],
    ([a, b], sketchId) => [
      bend('up', sketchId, a!),
      bend('down', sketchId, b!, { direction: 'down' })
    ]
  );

interface DxfRecord {
  type: string;
  groups: [number, string][];
}

/** The group pairs of one DXF section, split into records at each code 0. */
function dxfSection(text: string, name: string): DxfRecord[] {
  const lines = text.split('\r\n');
  const pairs: [number, string][] = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    pairs.push([Number(lines[index]!.trim()), lines[index + 1]!]);
  }
  const start = pairs.findIndex(
    ([code, value], index) =>
      code === 0 &&
      value === 'SECTION' &&
      pairs[index + 1]?.[0] === 2 &&
      pairs[index + 1]?.[1] === name
  );
  expect(start).toBeGreaterThanOrEqual(0);
  // HEADER variables come before any code-0 record: they open one of type ''.
  const records: DxfRecord[] = [{ type: '', groups: [] }];
  for (let index = start + 2; pairs[index]![1] !== 'ENDSEC'; index += 1) {
    const [code, value] = pairs[index]!;
    if (code === 0) records.push({ type: value, groups: [] });
    else records.at(-1)!.groups.push([code, value]);
  }
  return records.filter(
    (record) => record.type !== '' || record.groups.length > 0
  );
}

const value = (record: DxfRecord, code: number) =>
  record.groups.find(([entry]) => entry === code)?.[1];
const num = (record: DxfRecord, code: number) => Number(value(record, code));

describe('flat-pattern DXF', { timeout: 240_000 }, () => {
  let bracket: Sheet;
  let pattern: SheetMetalFlatPattern;
  let text: string;

  beforeAll(async () => {
    bracket = lBracket();
    pattern = await adapter.sheetMetalFlatPattern(
      bracket.document,
      bracket.featureId
    );
    text = flatPatternDxf(pattern, 'mm');
  });

  it('declares the four layers, the bend lines dashed in two colours', () => {
    const header = dxfSection(text, 'HEADER');
    const insunits = header.flatMap((record) => record.groups);
    expect(insunits).toContainEqual([9, '$INSUNITS']);
    expect(
      insunits[insunits.findIndex(([, v]) => v === '$INSUNITS') + 1]
    ).toEqual([70, '4']);
    const layers = dxfSection(text, 'TABLES')
      .filter((record) => record.type === 'LAYER')
      .map((record) => ({
        name: value(record, 2),
        color: num(record, 62),
        lineType: value(record, 6)
      }));
    expect(layers).toEqual([
      { name: '0', color: 7, lineType: 'CONTINUOUS' },
      { name: 'BEND_UP', color: 5, lineType: 'DASHED' },
      { name: 'BEND_DOWN', color: 1, lineType: 'DASHED' },
      { name: 'BEND_NOTES', color: 7, lineType: 'CONTINUOUS' }
    ]);
    expect(
      dxfSection(text, 'TABLES').some(
        (record) => record.type === 'LTYPE' && value(record, 2) === 'DASHED'
      )
    ).toBe(true);
    expect(FLAT_PATTERN_DXF_LAYERS.map((layer) => layer.name)).toEqual(
      layers.map((layer) => layer.name)
    );
  });

  it('puts the L bracket outline on layer 0, 96.5239 × the width', () => {
    const entities = dxfSection(text, 'ENTITIES');
    const outline = entities.filter((record) => value(record, 8) === '0');
    expect(outline).toHaveLength(4);
    expect(outline.every((record) => record.type === 'LINE')).toBe(true);
    const xs = outline.flatMap((record) => [num(record, 10), num(record, 11)]);
    const ys = outline.flatMap((record) => [num(record, 20), num(record, 21)]);
    expect(Math.min(...xs)).toBeCloseTo(0, 9);
    expect(Math.max(...xs)).toBeCloseTo(L_BLANK, 9);
    expect(Math.min(...ys)).toBeCloseTo(0, 9);
    expect(Math.max(...ys)).toBeCloseTo(WIDTH, 9);
    const extents = flatPatternExtents(pattern);
    expect(extents.width).toBeCloseTo(L_BLANK, 9);
    expect(extents.height).toBeCloseTo(WIDTH, 9);
  });

  it('draws one BEND_UP line across the width at the bend line, and its note', () => {
    const entities = dxfSection(text, 'ENTITIES');
    const up = entities.filter((record) => value(record, 8) === 'BEND_UP');
    expect(up).toHaveLength(1);
    expect(up[0]!.type).toBe('LINE');
    expect(num(up[0]!, 10)).toBeCloseTo(L_LINE, 9);
    expect(num(up[0]!, 11)).toBeCloseTo(L_LINE, 9);
    expect(Math.abs(num(up[0]!, 21) - num(up[0]!, 20))).toBeCloseTo(WIDTH, 9);
    expect(entities.some((record) => value(record, 8) === 'BEND_DOWN')).toBe(
      false
    );
    const notes = entities.filter(
      (record) => value(record, 8) === 'BEND_NOTES'
    );
    expect(notes).toHaveLength(1);
    const [note] = notes;
    expect(note!.type).toBe('TEXT');
    // `°` is written as the R12 Unicode escape.
    expect(value(note!, 1)).toBe('UP 90\\U+00B0 R2');
    expect(flatPatternBendNote(pattern.bends[0]!)).toBe('UP 90° R2');
    // Along the vertical line, read bottom to top, just left of it.
    expect(num(note!, 50)).toBeCloseTo(90, 9);
    expect(num(note!, 10)).toBeLessThan(L_LINE);
    expect(num(note!, 10)).toBeGreaterThan(L_LINE - 5);
    expect(num(note!, 20)).toBeCloseTo(WIDTH / 2, 9);
    expect(value(note!, 72)).toBe('1');
  });

  it('writes the document units into $INSUNITS', () => {
    const inches = flatPatternDxf(pattern, 'inch');
    const groups = dxfSection(inches, 'HEADER').flatMap(
      (record) => record.groups
    );
    expect(groups[groups.findIndex(([, v]) => v === '$INSUNITS') + 1]).toEqual([
      70,
      '1'
    ]);
  });

  it('imports back through the DXF sketch import as the outline', () => {
    const imported = importDxfSketch(text, 'mm');
    expect(imported.sourceUnit).not.toBeNull();
    const lines = imported.objects.filter(
      (object): object is Extract<SketchObjectData, { objectKind: 'line' }> =>
        object.objectKind === 'line'
    );
    // The four outline edges, plus the bend line on its own layer.
    expect(lines).toHaveLength(5);
    const xs = lines.flatMap((entry) => [Number(entry.x1), Number(entry.x2)]);
    const ys = lines.flatMap((entry) => [Number(entry.y1), Number(entry.y2)]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(L_BLANK, 9);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(WIDTH, 9);
    expect(
      lines.filter(
        (entry) =>
          Math.abs(Number(entry.x1) - L_LINE) < 1e-9 &&
          Math.abs(Number(entry.x2) - L_LINE) < 1e-9
      )
    ).toHaveLength(1);
    expect(imported.refused).toEqual({});
  });

  it('separates an up and a down bend on their layers', async () => {
    const z = zPart();
    const zPattern = await adapter.sheetMetalFlatPattern(
      z.document,
      z.featureId
    );
    const entities = dxfSection(flatPatternDxf(zPattern, 'mm'), 'ENTITIES');
    const on = (layer: string) =>
      entities.filter((record) => value(record, 8) === layer);
    expect(on('0')).toHaveLength(4);
    expect(on('BEND_UP')).toHaveLength(1);
    expect(on('BEND_DOWN')).toHaveLength(1);
    expect(num(on('BEND_UP')[0]!, 10)).toBeCloseTo(Z_FIRST, 9);
    expect(num(on('BEND_DOWN')[0]!, 10)).toBeCloseTo(Z_FLAT - Z_FIRST, 9);
    expect(
      on('BEND_NOTES')
        .map((record) => value(record, 1))
        .sort()
    ).toEqual(['DOWN 90\\U+00B0 R2', 'UP 90\\U+00B0 R2']);

    const svg = flatPatternSvg(zPattern, { units: 'mm', title: 'Z <part>' });
    expect(svg).toContain('<title>Z &lt;part&gt;</title>');
    expect(svg).toMatch(/<g data-layer="BEND_UP"[^>]*stroke-dasharray/);
    expect(svg).toMatch(/<g data-layer="BEND_DOWN"[^>]*stroke-dasharray/);
    expect(svg).toContain('>UP 90° R2</text>');
    expect(svg).toContain('>DOWN 90° R2</text>');
    expect(svg).toMatch(/width="[\d.]+mm"/);

    const rows = bendTableRows(zPattern);
    expect(rows.map((row) => row.direction)).toEqual(['Up', 'Down']);
    expect(rows.map((row) => row.number)).toEqual(['1', '2']);
  });

  it('keeps holes exact and gives a hem no bend deduction', async () => {
    const hem = sheet(
      [rectangle(0, 0, 100, 30), circle(20, 15, 5)],
      [line(60, 0, 60, 30)],
      ([lineId], sketchId) => [
        bend('hem', sketchId, lineId!, { angleDeg: 180 })
      ],
      // The cell outside the circle: the circle is a hole.
      [{ x: 2, y: 2 }]
    );
    const hemPattern = await adapter.sheetMetalFlatPattern(
      hem.document,
      hem.featureId
    );
    const entities = dxfSection(flatPatternDxf(hemPattern, 'mm'), 'ENTITIES');
    const circles = entities.filter((record) => record.type === 'CIRCLE');
    expect(circles).toHaveLength(1);
    expect(value(circles[0]!, 8)).toBe('0');
    expect(num(circles[0]!, 40)).toBeCloseTo(5, 9);
    const [row] = bendTableRows(hemPattern);
    expect(row!.bendDeduction).toBe('—');
    expect(row!.angle).toBe('180');
  });
});

describe('bend table and flat-pattern lookups', { timeout: 240_000 }, () => {
  it('copies the L bracket as CSV with a header row', async () => {
    const bracket = lBracket();
    const pattern = await adapter.sheetMetalFlatPattern(
      bracket.document,
      bracket.featureId
    );
    const metrics = sheetMetalBendMetrics(90 * DEG, R, T, K);
    const round = (value: number) => String(Math.round(value * 1000) / 1000);
    expect(bendTableCsv(pattern, 'mm').split('\r\n')).toEqual([
      'No.,Direction,Angle (°),Inside radius (mm),K-factor,Bend allowance (mm),Bend deduction (mm),Line length (mm)',
      `1,Up,90,2,0.44,${round(metrics.bendAllowance)},${round(metrics.bendDeduction)},40`,
      ''
    ]);
    expect(bendTableCsv(pattern, 'inch').split('\r\n')[0]).toContain(
      'Inside radius (in)'
    );
  });

  it('finds the sheet behind a body a later feature changed, and warns', async () => {
    const bracket = lBracket();
    expect(sheetMetalFeatureOptions(bracket.document)).toEqual([
      {
        featureId: bracket.featureId,
        name: 'Bracket',
        bodyId: bracket.bodyId
      }
    ]);
    expect(
      sheetMetalFeatureForBody(bracket.document, bracket.bodyId)?.featureId
    ).toBe(bracket.featureId);
    const body = (await adapter.syncDocument(bracket.document))
      .bodyRepresentations[bracket.bodyId]!;
    const top = body.topology!.faces.find(
      (face) => face.reference?.lineageName === 'sheet.face.top[fixed]'
    )!;
    const drilled = holeBody(bracket.document, {
      name: 'Hole 1',
      targetBodyId: bracket.bodyId,
      faceHash: top.hash,
      faceReference: top.reference,
      position: { u: 0, v: 0 },
      positionAnchor: 'centroid',
      diameter: 6,
      depthMode: 'through',
      style: 'simple'
    });
    const after = listFeaturesInOrder(drilled.document).at(-1)!;
    expect(
      sheetMetalFeatureForBody(drilled.document, after.bodyId ?? bracket.bodyId)
        ?.featureId
    ).toBe(bracket.featureId);
    const pattern = await adapter.sheetMetalFlatPattern(
      drilled.document,
      bracket.featureId
    );
    expect(flatPatternChangedWarning(pattern.changedBy)).toBe(
      '1 later feature changes this body; the flat pattern shows the sheet before it.'
    );
    expect(
      flatPatternChangedWarning([
        { featureId: 'a' as FeatureId, name: 'A' },
        { featureId: 'b' as FeatureId, name: 'B' }
      ])
    ).toBe(
      '2 later features change this body; the flat pattern shows the sheet before them.'
    );
  });
});

describe('review fixes (PR #1560)', { timeout: 240_000 }, () => {
  it('refuses the flat pattern of a part the build refused (folded-overlap)', async () => {
    // Spec example: a 20 mm base, two outward 135° up bends, 30 mm flanges.
    const ba = sheetMetalBendMetrics(135 * DEG, R, T, K).bendAllowance;
    const flat = 30 + ba + 20 + ba + 30;
    const first = 30 + ba / 2;
    const second = 30 + ba + 20 + ba / 2;
    const overlap = sheet(
      [rectangle(0, 0, flat, 30)],
      [line(first, 0, first, 30), line(second, 0, second, 30)],
      ([a, b], sketchId) => [
        bend('left', sketchId, a!, { angleDeg: 135 }),
        bend('right', sketchId, b!, { angleDeg: 135 })
      ],
      undefined,
      { fixedPoint: [flat / 2, 15] }
    );
    // Cold, and again after the history cache holds the refused build.
    for (let pass = 0; pass < 2; pass += 1) {
      await expect(
        adapter.sheetMetalFlatPattern(overlap.document, overlap.featureId)
      ).rejects.toThrow(
        'Feature "Bracket": Sheet metal: Folded, the flange of bend 1 passes through the flange of bend 2.'
      );
      await expect(
        adapter.sheetMetalFlatPattern(overlap.document, overlap.featureId)
      ).rejects.toThrow(/not exported until the part builds/);
      await adapter.syncDocument(overlap.document);
    }
    // A part that builds still flattens.
    const bracket = lBracket();
    await expect(
      adapter.sheetMetalFlatPattern(bracket.document, bracket.featureId)
    ).resolves.toMatchObject({ featureId: bracket.featureId });
  });

  it('opens the requested sheet or says why, never another sheet', () => {
    const first = lBracket();
    const second = sheet(
      [rectangle(0, 100, L_BLANK, 100 + WIDTH)],
      [line(L_LINE, 100, L_LINE, 100 + WIDTH)],
      ([lineId], sketchId) => [bend('c1', sketchId, lineId!)],
      undefined,
      { base: first.document, name: 'Cover' }
    );
    const both = second.document;
    expect(flatPatternTarget(both)).toEqual({ featureId: first.featureId });
    expect(flatPatternTarget(both, second.featureId)).toEqual({
      featureId: second.featureId
    });
    const [nodeId, node] = Object.entries(both.nodes).find(
      ([, entry]) =>
        entry.kind === 'feature' && entry.featureId === second.featureId
    )!;
    const suppressed: ProjectDocument = {
      ...both,
      nodes: {
        ...both.nodes,
        [nodeId]: {
          ...node,
          metadata: {
            ...node.metadata,
            [FEATURE_SUPPRESSED_METADATA_KEY]: true
          }
        }
      }
    };
    expect(sheetMetalFeatureOptions(suppressed).map((o) => o.name)).toEqual([
      'Bracket'
    ]);
    // Inspector › Flat pattern… on the suppressed sheet: not the other one.
    expect(flatPatternTarget(suppressed, second.featureId)).toEqual({
      error:
        'Cover is suppressed, so it has no flat pattern. Resume it to flatten it.'
    });
    expect(flatPatternTarget(suppressed)).toEqual({
      featureId: first.featureId
    });
    expect(flatPatternTarget(suppressed, 'feature_gone' as FeatureId)).toEqual({
      error: 'That sheet-metal part is no longer in this project.'
    });
  });

  it('keeps small values in notes and the table (0.0004 m radius)', () => {
    const pattern: SheetMetalFlatPattern = {
      featureId: 'feature_small' as FeatureId,
      thickness: 0.0005,
      frame: {
        origin: [0, 0, 0],
        u: [1, 0, 0],
        v: [0, 1, 0],
        normal: [0, 0, 1]
      },
      loops: [
        {
          outer: true,
          entities: [
            { kind: 'line', start: [0, 0], end: [0.1, 0] },
            { kind: 'line', start: [0.1, 0], end: [0.1, 0.04] },
            { kind: 'line', start: [0.1, 0.04], end: [0, 0.04] },
            { kind: 'line', start: [0, 0.04], end: [0, 0] }
          ]
        }
      ],
      bends: [
        {
          bendId: 'b1',
          piece: 0,
          segment: [
            [0.05, 0],
            [0.05, 0.04]
          ],
          direction: 'up',
          angleDeg: 90,
          insideRadius: 0.0004,
          kFactor: 0.44,
          bendAllowance: 0.00097397,
          bendDeduction: 0.00082603,
          lineLength: 0.04
        }
      ],
      changedBy: []
    };
    expect(flatPatternBendNote(pattern.bends[0]!)).toBe('UP 90° R0.0004');
    expect(flatPatternDxf(pattern, 'm')).toContain('UP 90\\U+00B0 R0.0004');
    expect(flatPatternSvg(pattern, { units: 'm' })).toContain(
      '>UP 90° R0.0004</text>'
    );
    expect(bendTableRows(pattern)[0]).toMatchObject({
      insideRadius: '0.0004',
      bendAllowance: '0.000974',
      bendDeduction: '0.000826',
      lineLength: '0.04'
    });
    // The app's three decimals where they are enough.
    expect(
      [96.5239, 1.5, 0.44, 4.52389, 90, 0, -0.00012346, 12345678].map(
        formatFlatPatternNumber
      )
    ).toEqual([
      '96.524',
      '1.5',
      '0.44',
      '4.524',
      '90',
      '0',
      '-0.0001235',
      '1.235e+7'
    ]);
  });
});

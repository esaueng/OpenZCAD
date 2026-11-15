import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addSketchFeature,
  assertDocumentContentSchema,
  createProjectDocument,
  findSketch,
  holeBody,
  listFeaturesInOrder,
  normalizeDocument,
  renameParameter,
  setParameter,
  sheetMetalBody,
  type SheetMetalInput
} from '@openzcad/document-core';
import { computeSketchRegions, profileContainsPoint } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  bendZoneStart,
  bentZoneVolume,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  sheetMetalBendMetrics,
  toUserId,
  type BodyId,
  type DerivedState,
  type EntityId,
  type FeatureData,
  type FeatureId,
  type ParamValue,
  type ProjectDocument,
  type SheetMetalBend,
  type SheetMetalBendPosition,
  type SketchId,
  type SketchObjectData,
  type SketchProfileReference
} from '@openzcad/shared';
import * as webGlimpse from '../apps/web/src/lib/glimpseContract';
import * as workerGlimpse from '../apps/web/worker/glimpseContract';
import { featureValueSummary } from '../apps/web/src/lib/featureSummary';

/**
 * ROADMAP M16 slice 2: the `sheet-metal` feature kind, its commands and the
 * exact fold build, against analytic values from
 * `docs/plans/sheet-metal-plan.md`.
 */
let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);

afterAll(() => {
  adapter.dispose();
});

const user = toUserId('user_sheet_metal');
const DEG = Math.PI / 180;

/** The spec's L bracket: 50 × 50 outside from a 96.5239 blank. */
const T = 2;
const R = 2;
const K = 0.44;
const L_BLANK = 96.5239;
const L_LINE = 48.262;
const WIDTH = 40;

interface Sheet {
  document: ProjectDocument;
  bodyId: BodyId;
  featureId: FeatureId;
  sketchId: SketchId;
  /** Sketch object ids in order: the blank's objects, then the bend lines. */
  objectIds: EntityId[];
}

function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): SketchObjectData {
  return { objectKind: 'line', x1, y1, x2, y2, construction: true };
}

function rectangle(
  x0: number,
  y0: number,
  x1: number,
  y1: number
): SketchObjectData {
  return {
    objectKind: 'rectangle',
    width: x1 - x0,
    height: y1 - y0,
    centerX: (x0 + x1) / 2,
    centerY: (y0 + y1) / 2
  };
}

function circle(x: number, y: number, radius: number): SketchObjectData {
  return { objectKind: 'circle', radius, centerX: x, centerY: y };
}

function bend(
  id: string,
  sketchId: SketchId,
  objectId: EntityId,
  overrides: Partial<SheetMetalBend> = {}
): SheetMetalBend {
  return {
    id,
    line: { sketchId, objectId },
    angleDeg: 90,
    direction: 'up',
    ...overrides
  };
}

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

/**
 * A sheet-metal part on the XY plane from `blank` (profile objects) and
 * `lines` (construction bend lines). `bends(lineIds)` builds the table.
 * `cells` picks the blank by points inside its cells; without it every cell
 * the blank's objects bound is used.
 */
function sheet(
  blank: SketchObjectData[],
  lines: SketchObjectData[],
  bends: (lineIds: EntityId[], sketchId: SketchId) => SheetMetalBend[],
  overrides: Partial<SheetMetalInput> = {},
  cells?: { x: number; y: number }[],
  base: ProjectDocument = createProjectDocument('Sheet', user)
): Sheet {
  const { document: withSketch, sketchId } = addSketchFeature(base, {
    name: 'Blank',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
    objects: [...blank, ...lines]
  });
  const objectIds = [...(findSketch(withSketch, sketchId)?.objectIds ?? [])];
  const { document, bodyId } = sheetMetalBody(withSketch, {
    name: 'Sheet metal 1',
    sketchId,
    profiles: cells
      ? cells.map((point) => cellAt(withSketch, sketchId, point))
      : [{ all: true, sourceEntityIds: objectIds.slice(0, blank.length) }],
    thickness: T,
    bendRadius: R,
    kFactor: K,
    relief: { shape: 'none' },
    bends: bends(objectIds.slice(blank.length), sketchId),
    ...overrides
  });
  const feature = listFeaturesInOrder(document).find(
    (entry) => entry.bodyId === bodyId
  )!;
  return {
    document,
    bodyId,
    featureId: feature.featureId,
    sketchId,
    objectIds
  };
}

function lBracket(
  bendOverrides: Partial<SheetMetalBend> = {},
  overrides: Partial<SheetMetalInput> = {}
): Sheet {
  return sheet(
    [rectangle(0, 0, L_BLANK, WIDTH)],
    [line(L_LINE, 0, L_LINE, WIDTH)],
    ([lineId], sketchId) => [bend('b1', sketchId, lineId!, bendOverrides)],
    overrides
  );
}

function faceNames(derived: DerivedState, bodyId: BodyId): string[] {
  return derived.bodyRepresentations[bodyId]!.topology!.faces.map(
    (face) => face.reference?.lineageName ?? '(unnamed)'
  ).sort();
}

function refusalCode(derived: DerivedState): string | undefined {
  return derived.featureWarnings?.find((warning) => warning.kernelRefusal)
    ?.kernelRefusal?.code;
}

/** `F`'s volume with each zone's flat volume replaced by its bent volume. */
function foldedVolume(
  flat: number,
  zones: { angleDeg: number; width: number }[],
  thickness = T
): number {
  return zones.reduce((volume, { angleDeg, width }) => {
    const metrics = sheetMetalBendMetrics(angleDeg * DEG, R, thickness, K);
    return (
      volume -
      metrics.bendAllowance * thickness * width +
      bentZoneVolume(angleDeg * DEG, R, thickness, width)
    );
  }, flat);
}

const BA90 = sheetMetalBendMetrics(90 * DEG, R, T, K).bendAllowance;

describe('sheet-metal commands and document', () => {
  function blankDocument(): {
    document: ProjectDocument;
    sketchId: SketchId;
    rectId: EntityId;
    lineId: EntityId;
  } {
    const { document, sketchId } = addSketchFeature(
      createProjectDocument('Sheet', user),
      {
        name: 'Blank',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [
          rectangle(0, 0, L_BLANK, WIDTH),
          line(L_LINE, 0, L_LINE, WIDTH)
        ]
      }
    );
    const [rectId, lineId] = findSketch(document, sketchId)!.objectIds;
    return { document, sketchId, rectId: rectId!, lineId: lineId! };
  }

  function input(
    base: ReturnType<typeof blankDocument>,
    overrides: Partial<SheetMetalInput> = {}
  ): SheetMetalInput {
    return {
      name: 'Sheet metal 1',
      sketchId: base.sketchId,
      profiles: [{ all: true, sourceEntityIds: [base.rectId] }],
      thickness: T,
      bendRadius: R,
      kFactor: K,
      bends: [bend('b1', base.sketchId, base.lineId)],
      ...overrides
    };
  }

  it('creates one feature owning one new body on the v58 schema', () => {
    const base = blankDocument();
    const command = commandFactories.sheetMetalBody(input(base));
    expect(() => command.validate(base.document)).not.toThrow();
    const next = command.apply(base.document);
    expect(next.bodyOrder).toHaveLength(1);
    const feature = listFeaturesInOrder(next).at(-1)!;
    expect(feature.featureKind).toBe('sheet-metal');
    expect(feature.bodyId).toBe(next.bodyOrder[0]);
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(58);
    expect(next.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(() => assertDocumentContentSchema(next)).not.toThrow();
  });

  it('accepts a flat sheet with no bends', () => {
    const base = blankDocument();
    expect(() =>
      commandFactories
        .sheetMetalBody(input(base, { bends: [] }))
        .validate(base.document)
    ).not.toThrow();
  });

  it.each<
    [
      string,
      (base: ReturnType<typeof blankDocument>) => Partial<SheetMetalInput>,
      RegExp
    ]
  >([
    [
      'zero thickness',
      () => ({ thickness: 0 }),
      /thickness must be greater than 0/
    ],
    ['zero radius', () => ({ bendRadius: 0 }), /radius must be greater than 0/],
    [
      'K-factor of 1',
      () => ({ kFactor: 1 }),
      /K-factor must be greater than 0 and less than 1/
    ],
    ['K-factor of 0', () => ({ kFactor: 0 }), /K-factor/],
    ['no cells', () => ({ profiles: [] }), /at least one sketch cell/],
    [
      'unknown material',
      () => ({ materialPresetId: 'unobtainium' }),
      /Unknown sheet metal material/
    ],
    [
      'unknown gauge',
      () => ({ gaugeId: 'steel-msg:99' }),
      /Unknown sheet metal gauge/
    ],
    [
      'zero relief width',
      () => ({ relief: { shape: 'rectangular', width: 0 } }),
      /relief width must be greater than 0/
    ],
    [
      'negative relief extension',
      () => ({ relief: { shape: 'obround', extension: -1 } }),
      /extension must not be negative/
    ],
    [
      'angle of 0°',
      (base) => ({
        bends: [bend('b1', base.sketchId, base.lineId, { angleDeg: 0 })]
      }),
      /angle must be greater than 0° and at most 180°/
    ],
    [
      'angle above 180°',
      (base) => ({
        bends: [bend('b1', base.sketchId, base.lineId, { angleDeg: 181 })]
      }),
      /at most 180°/
    ],
    [
      'bend radius of 0',
      (base) => ({
        bends: [bend('b1', base.sketchId, base.lineId, { radius: 0 })]
      }),
      /inside radius must be greater than 0/
    ],
    [
      'bend K-factor above 1',
      (base) => ({
        bends: [bend('b1', base.sketchId, base.lineId, { kFactor: 1.2 })]
      }),
      /K-factor must be greater than 0 and less than 1/
    ],
    [
      'outside mold line at 180°',
      (base) => ({
        bends: [
          bend('b1', base.sketchId, base.lineId, {
            angleDeg: 180,
            position: 'outside-mold-line'
          })
        ]
      }),
      /outside mold line/
    ],
    [
      'a bend on a rectangle',
      (base) => ({ bends: [bend('b1', base.sketchId, base.rectId)] }),
      /needs a straight sketch line/
    ],
    [
      'two bends with one id',
      (base) => ({
        bends: [
          bend('b1', base.sketchId, base.lineId),
          bend('b1', base.sketchId, base.lineId)
        ]
      }),
      /used twice/
    ],
    [
      'two bends on one line',
      (base) => ({
        bends: [
          bend('b1', base.sketchId, base.lineId),
          bend('b2', base.sketchId, base.lineId)
        ]
      }),
      /reuses another bend's line/
    ],
    [
      'a bend id with a bracket',
      (base) => ({ bends: [bend('b[1]', base.sketchId, base.lineId)] }),
      /needs an id/
    ]
  ])('refuses %s', (_label, overrides, message) => {
    const base = blankDocument();
    expect(() =>
      commandFactories
        .sheetMetalBody(input(base, overrides(base)))
        .validate(base.document)
    ).toThrow(message);
  });

  it('undoes, redoes and replays a create and an edit', () => {
    const base = blankDocument();
    const manager = new CommandManager(base.document);
    manager.execute(commandFactories.sheetMetalBody(input(base)));
    const feature = listFeaturesInOrder(manager.document).at(-1)!;
    const created = manager.document;
    manager.execute(
      commandFactories.updateSheetMetal({
        featureId: feature.featureId,
        rule: { thickness: 1.5, materialPresetId: 'mild-steel' },
        bends: [
          bend('b1', base.sketchId, base.lineId, {
            angleDeg: 45,
            direction: 'down'
          })
        ]
      })
    );
    const data = (document: ProjectDocument) =>
      listFeaturesInOrder(document).at(-1)!.data as Extract<
        FeatureData,
        { featureKind: 'sheet-metal' }
      >;
    expect(data(manager.document).thickness).toBe(1.5);
    expect(data(manager.document).bends[0]).toMatchObject({
      angleDeg: 45,
      direction: 'down'
    });
    // One transaction: one undo restores the rule and the bend table.
    manager.undo();
    expect(data(manager.document)).toEqual(data(created));
    manager.undo();
    expect(manager.document.bodyOrder).toHaveLength(0);
    manager.redo();
    manager.redo();
    expect(data(manager.document).materialPresetId).toBe('mild-steel');
    const replayed = replayCommands(base.document, manager.document.commandLog);
    expect(data(replayed)).toEqual(data(manager.document));
  });

  it('clears an optional rule field back to its default', () => {
    const base = blankDocument();
    const manager = new CommandManager(base.document);
    manager.execute(
      commandFactories.sheetMetalBody(
        input(base, { fixedPoint: [10, 10], kFactorMethod: 'din-6935' })
      )
    );
    const feature = listFeaturesInOrder(manager.document).at(-1)!;
    manager.execute(
      commandFactories.updateSheetMetal({
        featureId: feature.featureId,
        clear: ['fixedPoint', 'kFactorMethod']
      })
    );
    const data = listFeaturesInOrder(manager.document).at(-1)!.data;
    expect('fixedPoint' in data).toBe(false);
    expect('kFactorMethod' in data).toBe(false);
  });

  it('refuses an edit that leaves a bend out of range', () => {
    const base = blankDocument();
    const manager = new CommandManager(base.document);
    manager.execute(commandFactories.sheetMetalBody(input(base)));
    const feature = listFeaturesInOrder(manager.document).at(-1)!;
    expect(() =>
      manager.execute(
        commandFactories.updateSheetMetal({
          featureId: feature.featureId,
          bends: [bend('b1', base.sketchId, base.lineId, { angleDeg: 270 })]
        })
      )
    ).toThrow(/at most 180°/);
  });

  it('keeps expressions as stored and rewrites them on a parameter rename', () => {
    const base = blankDocument();
    let document = setParameter(base.document, { name: 't', expression: '2' });
    document = setParameter(document, { name: 'ang', expression: '90' });
    document = setParameter(document, { name: 'k', expression: '0.44' });
    const command = commandFactories.sheetMetalBody(
      input(base, {
        thickness: 't',
        bendRadius: 't',
        kFactor: 'k',
        relief: { shape: 'rectangular', width: 't', extension: 't / 2' },
        bends: [
          bend('b1', base.sketchId, base.lineId, {
            angleDeg: 'ang',
            radius: 't * 1.5',
            kFactor: 'k',
            relief: { shape: 'obround', width: 't' }
          })
        ]
      })
    );
    expect(() => command.validate(document)).not.toThrow();
    const stored = command.apply(document);
    const renamed = renameParameter(stored, { name: 't', newName: 'gauge' });
    const data = listFeaturesInOrder(renamed).at(-1)!.data as Extract<
      FeatureData,
      { featureKind: 'sheet-metal' }
    >;
    expect(data.thickness).toBe('gauge');
    expect(data.bendRadius).toBe('gauge');
    expect(data.kFactor).toBe('k');
    expect(data.relief).toEqual({
      shape: 'rectangular',
      width: 'gauge',
      extension: 'gauge / 2'
    });
    expect(data.bends[0]).toMatchObject({
      angleDeg: 'ang',
      radius: 'gauge * 1.5',
      kFactor: 'k',
      relief: { shape: 'obround', width: 'gauge' }
    });
  });

  it('refuses the feature on a document that declares an older schema', () => {
    const base = blankDocument();
    const older = {
      ...base.document,
      schemaVersion: 57
    } as unknown as ProjectDocument;
    expect(() => sheetMetalBody(older, input(base))).toThrow(
      /Sheet-metal features require project schema v58 or newer/
    );
    const current = sheetMetalBody(base.document, input(base)).document;
    // A stored document that claims v57 but holds the feature is refused...
    expect(() =>
      assertDocumentContentSchema({
        ...current,
        schemaVersion: 57
      } as unknown as ProjectDocument)
    ).toThrow(/schema v58/);
    // ...and a client older than the document refuses the document.
    expect(() =>
      normalizeDocument({
        ...current,
        schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION + 1
      } as unknown as ProjectDocument)
    ).toThrow();
  });

  it('summarises the feature and lists its operation for analytics', () => {
    const base = blankDocument();
    const document = sheetMetalBody(
      base.document,
      input(base, { thickness: 1.5 })
    ).document;
    const feature = listFeaturesInOrder(document).at(-1)!;
    expect(featureValueSummary(feature, {}, 'mm')).toBe('1.5 mm, 1 bend');
    const three = {
      ...feature,
      data: {
        ...feature.data,
        materialPresetId: 'mild-steel',
        bends: ['a', 'b', 'c'].map((id) => bend(id, base.sketchId, base.lineId))
      }
    } as typeof feature;
    expect(featureValueSummary(three, {}, 'mm')).toBe(
      '1.5 mm mild steel (crs), 3 bends'
    );
    for (const contract of [webGlimpse, workerGlimpse]) {
      expect(contract.CAD_OPERATIONS).toContain('feature.sheet-metal');
    }
  });
});

describe('sheet-metal exact build', { timeout: 240_000 }, () => {
  it('builds a flat sheet with no bends', async () => {
    const flat = sheet([rectangle(0, 0, 60, 40)], [], () => []);
    const derived = await adapter.syncDocument(flat.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[flat.bodyId]!;
    expect(body.volume).toBeCloseTo(60 * 40 * T, 6);
    const names = faceNames(derived, flat.bodyId);
    expect(names).toHaveLength(6);
    expect(new Set(names).size).toBe(6);
    expect(names).toEqual(
      expect.arrayContaining([
        'sheet.face.top[fixed]',
        'sheet.face.bottom[fixed]'
      ])
    );
    expect(
      names.filter((name) => name.startsWith('sheet.face.edge[fixed].'))
    ).toHaveLength(4);
  });

  it("folds the spec's L bracket to 50 × 50 outside, every face named once", async () => {
    const bracket = lBracket();
    const derived = await adapter.syncDocument(bracket.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[bracket.bodyId]!;
    // The larger region (x < 48.262) stays fixed; the flange turns up.
    expect(body.bbox.min.x).toBeCloseTo(0, 6);
    expect(body.bbox.max.x).toBeCloseTo(50, 3);
    expect(body.bbox.min.z).toBeCloseTo(0, 6);
    expect(body.bbox.max.z).toBeCloseTo(50, 3);
    expect(body.bbox.max.y - body.bbox.min.y).toBeCloseTo(WIDTH, 6);
    expect(body.volume).toBeCloseTo(
      foldedVolume(L_BLANK * WIDTH * T, [{ angleDeg: 90, width: WIDTH }]),
      5
    );
    const names = faceNames(derived, bracket.bodyId);
    expect(names).not.toContain('(unnamed)');
    expect(new Set(names).size).toBe(names.length);
    const rect = bracket.objectIds[0]!;
    // Two plate faces per region, the bend's two cylinders, and the blank's
    // four edges: the two long ones run on through the bend as one face.
    expect(names).toEqual(
      [
        'sheet.bend[b1].inner',
        'sheet.bend[b1].outer',
        'sheet.face.bottom[b1]',
        'sheet.face.bottom[fixed]',
        'sheet.face.top[b1]',
        'sheet.face.top[fixed]',
        ...[0, 1, 2, 3].map((segment) =>
          segment === 1
            ? `sheet.face.edge[b1].${rect}.${segment}`
            : `sheet.face.edge[fixed].${rect}.${segment}`
        )
      ].sort()
    );
    // Every edge between two of those faces is named from them.
    const edges = body.topology!.edges.map(
      (edge) => edge.reference?.lineageName
    );
    expect(edges).toContain(
      'sheet.edge.between.sheet.bend[b1].inner|sheet.face.top[fixed]'
    );
  });

  it('keeps every name across a thickness edit', async () => {
    const bracket = lBracket();
    const before = await adapter.syncDocument(bracket.document);
    const thicker = commandFactories
      .updateSheetMetal({
        featureId: bracket.featureId,
        rule: { thickness: 3 }
      })
      .apply(bracket.document);
    const after = await adapter.syncDocument(thicker);
    expect(after.warnings).toEqual([]);
    expect(after.bodyRepresentations[bracket.bodyId]!.volume).toBeCloseTo(
      foldedVolume(L_BLANK * WIDTH * 3, [{ angleDeg: 90, width: WIDTH }], 3),
      5
    );
    expect(faceNames(after, bracket.bodyId)).toEqual(
      faceNames(before, bracket.bodyId)
    );
    const edgeNames = (derived: DerivedState) =>
      derived.bodyRepresentations[bracket.bodyId]!.topology!.edges.map(
        (edge) => edge.reference?.lineageName ?? '(unnamed)'
      ).sort();
    expect(edgeNames(after)).toEqual(edgeNames(before));
  });

  it('mirrors the bracket for a down bend', async () => {
    const bracket = lBracket({ direction: 'down' });
    const derived = await adapter.syncDocument(bracket.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[bracket.bodyId]!;
    expect(body.bbox.max.x).toBeCloseTo(50, 3);
    expect(body.bbox.max.z).toBeCloseTo(T, 6);
    expect(body.bbox.min.z).toBeCloseTo(T - 50, 3);
    expect(body.volume).toBeCloseTo(
      foldedVolume(L_BLANK * WIDTH * T, [{ angleDeg: 90, width: WIDTH }]),
      5
    );
  });

  it('builds the sheet below the sketch plane on the negative side', async () => {
    const bracket = lBracket({}, { thicknessSide: 'negative' });
    const derived = await adapter.syncDocument(bracket.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[bracket.bodyId]!;
    expect(body.bbox.min.z).toBeCloseTo(-T, 6);
    expect(body.bbox.max.z).toBeCloseTo(50 - T, 3);
  });

  it('folds a U channel about its web', async () => {
    // Outside 30 / 60 / 30: flat 120 − 2·BD.
    const bd = sheetMetalBendMetrics(90 * DEG, R, T, K).bendDeduction;
    const flat = 120 - 2 * bd;
    const first = 30 - (R + T) + BA90 / 2;
    const channel = sheet(
      [rectangle(0, 0, flat, WIDTH)],
      [
        line(first, 0, first, WIDTH),
        line(flat - first, 0, flat - first, WIDTH)
      ],
      ([a, b], sketchId) => [
        bend('left', sketchId, a!),
        bend('right', sketchId, b!)
      ]
    );
    const derived = await adapter.syncDocument(channel.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[channel.bodyId]!;
    expect(body.bbox.max.x - body.bbox.min.x).toBeCloseTo(60, 6);
    expect(body.bbox.max.z - body.bbox.min.z).toBeCloseTo(30, 6);
    expect(body.volume).toBeCloseTo(
      foldedVolume(flat * WIDTH * T, [
        { angleDeg: 90, width: WIDTH },
        { angleDeg: 90, width: WIDTH }
      ]),
      5
    );
    const names = faceNames(derived, channel.bodyId);
    expect(names).not.toContain('(unnamed)');
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        'sheet.face.top[fixed]',
        'sheet.face.top[left]',
        'sheet.face.top[right]',
        'sheet.bend[left].inner',
        'sheet.bend[right].outer'
      ])
    );
  });

  it('folds a 180° bend back over the sheet', async () => {
    const hem = sheet(
      [rectangle(0, 0, 100, 30)],
      [line(60, 0, 60, 30)],
      ([lineId], sketchId) => [
        bend('hem', sketchId, lineId!, { angleDeg: 180 })
      ]
    );
    const derived = await adapter.syncDocument(hem.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[hem.bodyId]!;
    // The flange lies 2R above the sheet: 2T + 2R high in all.
    expect(body.bbox.max.z - body.bbox.min.z).toBeCloseTo(2 * T + 2 * R, 6);
    expect(body.volume).toBeCloseTo(
      foldedVolume(100 * 30 * T, [{ angleDeg: 180, width: 30 }]),
      5
    );
  });

  it.each<SheetMetalBendPosition>([
    'centerline',
    'fixed-side',
    'moving-side',
    'outside-mold-line'
  ])('places a %s bend where bendZoneStart says', async (position) => {
    const bracket = lBracket({ position }, { fixedPoint: [10, 20] });
    const derived = await adapter.syncDocument(bracket.document);
    expect(derived.warnings).toEqual([]);
    const metrics = sheetMetalBendMetrics(90 * DEG, R, T, K);
    const start = bendZoneStart(position, metrics);
    // The zone starts `start` from the line toward the flange; at 90° up the
    // flange's outside face stands R + T beyond it.
    const body = derived.bodyRepresentations[bracket.bodyId]!;
    expect(body.bbox.max.x).toBeCloseTo(L_LINE + start + R + T, 6);
    const pattern = await adapter.sheetMetalFlatPattern(
      bracket.document,
      bracket.featureId
    );
    expect(pattern.bends[0]!.segment[0][0]).toBeCloseTo(
      L_LINE + start + metrics.bendAllowance / 2,
      9
    );
  });

  it('follows the fixed point: the other region stays still', async () => {
    const bracket = lBracket({}, { fixedPoint: [90, 20] });
    const derived = await adapter.syncDocument(bracket.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[bracket.bodyId]!;
    expect(body.bbox.max.x).toBeCloseTo(L_BLANK, 6);
    expect(body.bbox.max.z).toBeCloseTo(50, 3);
    expect(faceNames(derived, bracket.bodyId)).toContain('sheet.face.top[b1]');
  });

  it('builds a tab on a plate with relief, and refuses it without', async () => {
    // Plate x ∈ [0, 40], y ∈ [0, 60]; tab x ∈ [40, 70], y ∈ [20, 40]. The
    // bend line spans the tab's width just inside the plate's edge.
    const outline: [number, number][] = [
      [0, 0],
      [40, 0],
      [40, 20],
      [70, 20],
      [70, 40],
      [40, 40],
      [40, 60],
      [0, 60]
    ];
    const blank = outline.map(([x, y], index): SketchObjectData => {
      const [nextX, nextY] = outline[(index + 1) % outline.length]!;
      return { objectKind: 'line', x1: x, y1: y, x2: nextX, y2: nextY };
    });
    const lines = [line(39, 20, 39, 40)];
    const table = ([lineId]: EntityId[], sketchId: SketchId) => [
      bend('tab', sketchId, lineId!)
    ];
    const cells = [{ x: 5, y: 5 }];
    const relieved = sheet(
      blank,
      lines,
      table,
      { relief: { shape: 'rectangular' } },
      cells
    );
    const derived = await adapter.syncDocument(relieved.document);
    expect(derived.warnings).toEqual([]);
    const zoneLo = 39 - BA90 / 2;
    // Each slot is T wide and runs from T behind the zone to the plate edge.
    const flat = (40 * 60 + 30 * 20 - 2 * T * (40 - (zoneLo - T))) * T;
    const body = derived.bodyRepresentations[relieved.bodyId]!;
    expect(body.volume).toBeCloseTo(
      foldedVolume(flat, [{ angleDeg: 90, width: 20 }]),
      5
    );
    expect(faceNames(derived, relieved.bodyId)).toEqual(
      expect.arrayContaining([
        'sheet.face.top[tab]',
        'sheet.bend[tab].inner',
        'sheet.face.edge[fixed].relief[tab].start.far',
        'sheet.face.edge[fixed].relief[tab].end.back'
      ])
    );

    const obround = await adapter.syncDocument(
      sheet(blank, lines, table, { relief: { shape: 'obround' } }, cells)
        .document
    );
    expect(obround.warnings).toEqual([]);

    const attached = await adapter.syncDocument(
      sheet(blank, lines, table, { relief: { shape: 'none' } }, cells).document
    );
    expect(refusalCode(attached)).toBe('sheet-metal:bend-not-separating');
    expect(attached.warnings.join('\n')).toMatch(/add relief/);
  });

  it('keeps holes in the regions and refuses one in a bend zone', async () => {
    const lines = [line(L_LINE, 0, L_LINE, WIDTH)];
    const table = ([lineId]: EntityId[], sketchId: SketchId) => [
      bend('b1', sketchId, lineId!)
    ];
    const holed = sheet(
      [rectangle(0, 0, L_BLANK, WIDTH), circle(20, 20, 4), circle(80, 20, 4)],
      lines,
      table,
      {},
      [{ x: 5, y: 5 }]
    );
    const derived = await adapter.syncDocument(holed.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[holed.bodyId]!;
    expect(body.volume).toBeCloseTo(
      foldedVolume((L_BLANK * WIDTH - 2 * Math.PI * 16) * T, [
        { angleDeg: 90, width: WIDTH }
      ]),
      5
    );
    const names = faceNames(derived, holed.bodyId);
    expect(names).not.toContain('(unnamed)');
    expect(names).toEqual(
      expect.arrayContaining([
        `sheet.face.edge[fixed].${holed.objectIds[1]}.circle`,
        `sheet.face.edge[b1].${holed.objectIds[2]}.circle`
      ])
    );

    const blocked = await adapter.syncDocument(
      sheet(
        [rectangle(0, 0, L_BLANK, WIDTH), circle(L_LINE, 20, 4)],
        lines,
        table,
        {},
        [{ x: 5, y: 5 }]
      ).document
    );
    expect(refusalCode(blocked)).toBe('sheet-metal:bend-zone-not-clear');
  });

  it('refuses overlapping bend zones', async () => {
    const derived = await adapter.syncDocument(
      sheet(
        [rectangle(0, 0, L_BLANK, WIDTH)],
        [line(48, 0, 48, WIDTH), line(50, 0, 50, WIDTH)],
        ([a, b], sketchId) => [bend('a', sketchId, a!), bend('b', sketchId, b!)]
      ).document
    );
    expect(refusalCode(derived)).toBe('sheet-metal:bends-overlap');
  });

  it('folds one line across a window, and refuses two bends that close a loop', async () => {
    // A frame: 100 × 100 with a 60 × 60 window.
    const blank = [rectangle(0, 0, 100, 100), rectangle(20, 20, 80, 80)];
    const cells = [{ x: 5, y: 5 }];
    const across = sheet(
      blank,
      [line(60, 0, 60, 100)],
      ([lineId], sketchId) => [bend('b1', sketchId, lineId!)],
      {},
      cells
    );
    const derived = await adapter.syncDocument(across.document);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[across.bodyId]!.volume).toBeCloseTo(
      foldedVolume((100 * 100 - 60 * 60) * T, [
        { angleDeg: 90, width: 20 },
        { angleDeg: 90, width: 20 }
      ]),
      5
    );
    expect(faceNames(derived, across.bodyId)).toEqual(
      expect.arrayContaining([
        'sheet.bend[b1.0].inner',
        'sheet.bend[b1.1].inner',
        'sheet.face.top[b1.0]'
      ])
    );

    const loop = await adapter.syncDocument(
      sheet(
        blank,
        [line(60, 0, 60, 20), line(60, 80, 60, 100)],
        ([a, b], sketchId) => [
          bend('a', sketchId, a!),
          bend('b', sketchId, b!)
        ],
        {},
        cells
      ).document
    );
    expect(refusalCode(loop)).toBe('sheet-metal:bend-loop');
  });

  it('refuses flanges that fold through each other', async () => {
    // Spec example: a 20 mm base, two outward 135° up bends, 30 mm flanges.
    const ba = sheetMetalBendMetrics(135 * DEG, R, T, K).bendAllowance;
    const flat = 30 + ba + 20 + ba + 30;
    const first = 30 + ba / 2;
    const second = 30 + ba + 20 + ba / 2;
    const derived = await adapter.syncDocument(
      sheet(
        [rectangle(0, 0, flat, 30)],
        [line(first, 0, first, 30), line(second, 0, second, 30)],
        ([a, b], sketchId) => [
          bend('left', sketchId, a!, { angleDeg: 135 }),
          bend('right', sketchId, b!, { angleDeg: 135 })
        ],
        { fixedPoint: [flat / 2, 15] }
      ).document
    );
    expect(refusalCode(derived)).toBe('sheet-metal:folded-overlap');
    const message = derived.warnings.join('\n');
    expect(message).toMatch(/bend 1/);
    expect(message).toMatch(/bend 2/);
  });

  it('refuses a bend line that misses the sheet or lies off its plane', async () => {
    const outside = await adapter.syncDocument(
      sheet(
        [rectangle(0, 0, 60, 40)],
        [line(80, 0, 80, 40)],
        ([lineId], sketchId) => [bend('b1', sketchId, lineId!)]
      ).document
    );
    expect(refusalCode(outside)).toBe('sheet-metal:bend-line-outside');

    const base = sheet([rectangle(0, 0, 60, 40)], [], () => []);
    const { document: withOther, sketchId: other } = addSketchFeature(
      createProjectDocument('Sheet', user),
      {
        name: 'Elsewhere',
        planeRef: { type: 'canonical', plane: 'XY', offset: 5 },
        objects: [line(30, 0, 30, 40)]
      }
    );
    const otherLine = findSketch(withOther, other)!.objectIds[0]!;
    const lifted = sheet(
      [rectangle(0, 0, 60, 40)],
      [],
      () => [bend('b1', other, otherLine)],
      {},
      undefined,
      withOther
    );
    const derived = await adapter.syncDocument(lifted.document);
    expect(refusalCode(derived)).toBe('sheet-metal:bend-line-not-coplanar');
    expect(base.bodyId).toBeDefined();
  });

  it('resolves expressions and the DIN 6935 K-factor', async () => {
    let base = createProjectDocument('Sheet', user);
    base = setParameter(base, { name: 't', expression: '2' });
    base = setParameter(base, { name: 'ang', expression: '90' });
    const bracket = sheet(
      [rectangle(0, 0, L_BLANK, WIDTH)],
      [line(L_LINE, 0, L_LINE, WIDTH)],
      ([lineId], sketchId) => [
        bend('b1', sketchId, lineId!, { angleDeg: 'ang', radius: 't' })
      ],
      { thickness: 't', bendRadius: 't * 2', kFactor: 't * 0.22' },
      undefined,
      base
    );
    const derived = await adapter.syncDocument(bracket.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[bracket.bodyId]!;
    expect(body.bbox.max.x).toBeCloseTo(50, 3);

    // DIN 6935 at R = T: K = ½·0.65 = 0.325, so the zone is narrower.
    const din = lBracket(
      {},
      { kFactorMethod: 'din-6935', fixedPoint: [10, 20] }
    );
    const pattern = await adapter.sheetMetalFlatPattern(
      din.document,
      din.featureId
    );
    expect(pattern.bends[0]!.kFactor).toBeCloseTo(0.325, 12);
    expect(pattern.bends[0]!.bendAllowance).toBeCloseTo(
      (Math.PI / 2) * (R + 0.325 * T),
      12
    );
  });

  it('raises shop advisories without refusing', async () => {
    // A 6 mm flange (below 0.7 · 8T), a hole 1 mm from the zone, and a
    // radius below 6061-T6's nominal 3T.
    const metrics = sheetMetalBendMetrics(90 * DEG, R, T, K);
    const zoneLo = 60 - metrics.bendAllowance / 2;
    const derived = await adapter.syncDocument(
      sheet(
        [
          rectangle(0, 0, 60 + metrics.bendAllowance / 2 + 6, WIDTH),
          circle(zoneLo - 1 - 3, 20, 3)
        ],
        [line(60, 0, 60, WIDTH)],
        ([lineId], sketchId) => [bend('b1', sketchId, lineId!)],
        { materialPresetId: 'aluminium-6061-t6' },
        [{ x: 5, y: 5 }]
      ).document
    );
    const advisories = (derived.featureWarnings ?? []).filter(
      (warning) => warning.kind === 'advisory'
    );
    expect(derived.featureWarnings?.some((w) => w.kernelRefusal)).toBe(false);
    const text = advisories.map((warning) => warning.message).join('\n');
    expect(text).toMatch(/below the nominal minimum for Aluminium 6061-T6/);
    expect(text).toMatch(/shorter than a press brake usually holds/);
    expect(text).toMatch(/closer than 4 \(2 × thickness\)/);
  });
});

describe(
  'sheet-metal fold preview and flat pattern',
  { timeout: 240_000 },
  () => {
    it('returns the flat sheet at fraction 0 and the stored part at 1', async () => {
      const bracket = lBracket();
      const flat = await adapter.sheetMetalFoldPreview(
        bracket.document,
        bracket.featureId,
        0
      );
      expect(flat.volume).toBeCloseTo(L_BLANK * WIDTH * T, 3);
      expect(flat.boundingBox[5] - flat.boundingBox[2]).toBeCloseTo(T, 6);
      expect(flat.indices.length).toBeGreaterThan(0);

      const full = await adapter.sheetMetalFoldPreview(
        bracket.document,
        bracket.featureId,
        1
      );
      expect(full.boundingBox[3]).toBeCloseTo(50, 3);
      expect(full.boundingBox[5]).toBeCloseTo(50, 3);

      // Half way the zone keeps its flat width, so its radius opens up:
      // R' = BA / (θ/2) − K·T.
      const half = await adapter.sheetMetalFoldPreview(
        bracket.document,
        bracket.featureId,
        0.5
      );
      const opened = BA90 / (Math.PI / 4) - K * T;
      const flange = L_BLANK - (L_LINE + BA90 / 2);
      expect(half.boundingBox[5]).toBeCloseTo(
        T +
          opened * (1 - Math.cos(Math.PI / 4)) +
          flange * Math.sin(Math.PI / 4),
        3
      );
      await expect(
        adapter.sheetMetalFoldPreview(bracket.document, bracket.featureId, 1.5)
      ).rejects.toThrow(/between 0 and 1/);
    });

    it('gives the outline, the bend line and the features that changed the body', async () => {
      const bracket = lBracket();
      const pattern = await adapter.sheetMetalFlatPattern(
        bracket.document,
        bracket.featureId
      );
      expect(pattern.thickness).toBe(T);
      expect(pattern.frame).toEqual({
        origin: [0, 0, 0],
        u: [1, 0, 0],
        v: [0, 1, 0],
        normal: [0, 0, 1]
      });
      expect(pattern.loops).toHaveLength(1);
      expect(pattern.loops[0]!.outer).toBe(true);
      const corners = pattern.loops[0]!.entities.flatMap((entity) =>
        entity.kind === 'line' ? [entity.start, entity.end] : []
      );
      expect(pattern.loops[0]!.entities).toHaveLength(4);
      expect(Math.min(...corners.map(([x]) => x))).toBeCloseTo(0, 9);
      expect(Math.max(...corners.map(([x]) => x))).toBeCloseTo(L_BLANK, 9);
      expect(Math.max(...corners.map(([, y]) => y))).toBeCloseTo(WIDTH, 9);
      const metrics = sheetMetalBendMetrics(90 * DEG, R, T, K);
      expect(pattern.bends).toHaveLength(1);
      expect(pattern.bends[0]).toMatchObject({
        bendId: 'b1',
        piece: 0,
        direction: 'up',
        insideRadius: R,
        kFactor: K
      });
      const [bendLine] = pattern.bends;
      expect(bendLine!.angleDeg).toBeCloseTo(90, 9);
      expect(bendLine!.bendAllowance).toBeCloseTo(metrics.bendAllowance, 12);
      expect(bendLine!.bendDeduction).toBeCloseTo(metrics.bendDeduction, 12);
      expect(bendLine!.lineLength).toBeCloseTo(WIDTH, 9);
      expect(bendLine!.segment[0][0]).toBeCloseTo(L_LINE, 9);
      expect(bendLine!.segment[1][0]).toBeCloseTo(L_LINE, 9);
      expect(
        Math.abs(bendLine!.segment[1][1] - bendLine!.segment[0][1])
      ).toBeCloseTo(WIDTH, 9);
      expect(pattern.changedBy).toEqual([]);

      // A hole drilled in the folded part is not in the flat pattern.
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
      const changed = await adapter.sheetMetalFlatPattern(
        drilled.document,
        bracket.featureId
      );
      expect(changed.changedBy.map((entry) => entry.name)).toEqual(['Hole 1']);
      expect(changed.loops).toHaveLength(1);
    });

    it('reports a hem with no finite bend deduction and holes as inner loops', async () => {
      const hem = sheet(
        [rectangle(0, 0, 100, 30), circle(20, 15, 5)],
        [line(60, 0, 60, 30)],
        ([lineId], sketchId) => [
          bend('hem', sketchId, lineId!, { angleDeg: 180 })
        ],
        {},
        [{ x: 2, y: 2 }]
      );
      const pattern = await adapter.sheetMetalFlatPattern(
        hem.document,
        hem.featureId
      );
      expect(pattern.bends[0]!.bendDeduction).toBeNull();
      expect(pattern.loops.map((loop) => loop.outer)).toEqual([true, false]);
      expect(pattern.loops[1]!.entities[0]).toMatchObject({
        kind: 'circle',
        radius: 5
      });
    });
  }
);

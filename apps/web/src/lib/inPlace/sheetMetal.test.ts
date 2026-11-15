import { describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch
} from '@openzcad/document-core';
import { canonicalPlaneBasis } from '@openzcad/geometry';
import {
  toUserId,
  type BodyId,
  type EntityId,
  type FeatureData,
  type FeatureId,
  type FeatureNode,
  type SketchId,
  type UnitSystem
} from '@openzcad/shared';
import {
  inPlaceEditSeed,
  inPlaceEditSourceSketchIds,
  inPlaceFeatureUpdate,
  inPlaceToolForFeature,
  type InPlaceEditContext
} from './edit';
import { inPlacePanelSections, inPlacePanelState } from './panel';
import {
  FIXED_POINT_OPTION,
  bendFixedPoint,
  bendLineCandidates,
  bendOptionId,
  bendRows,
  bendSpec,
  defaultSheetThickness,
  gaugeOptionId,
  onBlank,
  sheetMetalSpec,
  sheetMetalUpdate,
  sketchPointOf,
  type SheetMetalRequest
} from './sheetMetal';
import {
  IN_PLACE_TOOL_SPECS,
  type CurvePick,
  type InPlaceContext,
  type InPlaceSlots,
  type InPlaceToolSpec,
  type ProfilePick
} from './tools';

const SKETCH = 'sketch_blank' as SketchId;
const OTHER = 'sketch_lines' as SketchId;
const BODY = 'body_sheet' as BodyId;

const SLOTS: InPlaceSlots = {
  profiles: [],
  axis: null,
  path: [],
  guide: [],
  faces: [],
  bodies: [],
  plane: null,
  edges: [],
  placement: null,
  refs: [],
  image: null
};

const XY = canonicalPlaneBasis('XY');

function cell(sketchId = SKETCH, fingerprint = 1): ProfilePick {
  return {
    sketchId,
    regionFingerprint: fingerprint,
    reference: {
      profileId: `p${fingerprint}`,
      regionFingerprint: fingerprint,
      samplePoint: { x: 5, y: 5 },
      sourceArea: 100,
      sourceEntityIds: ['ent_rect']
    }
  };
}

function context(overrides: Partial<InPlaceContext> = {}): InPlaceContext {
  return {
    sketchViews: [
      {
        sketchId: SKETCH,
        basis: XY,
        regions: [
          {
            regionFingerprint: 1,
            outer: [
              { x: 0, y: 0 },
              { x: 100, y: 0 },
              { x: 100, y: 40 },
              { x: 0, y: 40 }
            ]
          }
        ]
      }
    ],
    datumAxes: undefined,
    datumLabel: () => 'Axis',
    evaluate: (value) =>
      typeof value === 'number' ? value : value === 't + 1' ? 3 : null,
    ...overrides
  };
}

/**
 * The request a spec would build with the hook's rules: every value its
 * initial one, defaults over those the user has not set, `set` over both.
 */
function requestOf(
  spec: InPlaceToolSpec,
  slots: Partial<InPlaceSlots>,
  {
    set = {},
    raws = {},
    options = {},
    ctx = context(),
    touched = []
  }: {
    set?: Record<string, number>;
    raws?: Record<string, string>;
    options?: Record<string, string>;
    ctx?: InPlaceContext;
    touched?: string[];
  } = {}
): SheetMetalRequest | null {
  const filled = { ...SLOTS, ...slots };
  const chosen = {
    ...Object.fromEntries(
      (spec.options ?? []).map((option) => [option.id, option.initial])
    ),
    ...options
  };
  const allTouched = [...new Set([...touched, ...Object.keys(set)])];
  const withTouched = { ...ctx, touched: allTouched };
  const numbers: Record<string, number> = Object.fromEntries(
    spec.values.map((value) => [value.id, value.initial])
  );
  Object.assign(numbers, set);
  for (const [id, value] of Object.entries(
    spec.defaults?.(filled, withTouched, numbers, chosen) ?? {}
  )) {
    if (!allTouched.includes(id)) numbers[id] = value;
  }
  const values: Record<string, number | string> = { ...numbers, ...raws };
  if (!spec.ready(filled, chosen, withTouched)) return null;
  const request = spec.request(filled, values, chosen, withTouched, numbers);
  if (request?.tool !== 'sheet-metal') return null;
  return request.sheet;
}

describe('Sheet metal: the request it builds', () => {
  it('makes a flat mild-steel sheet with R = T and K 0.44 by default', () => {
    expect(requestOf(sheetMetalSpec, { profiles: [cell()] })).toEqual({
      sketchId: SKETCH,
      profiles: [cell().reference],
      thickness: 1.5,
      bendRadius: 1.5,
      kFactor: 0.44,
      materialPresetId: 'mild-steel',
      bends: []
    });
  });

  it('defaults to 16 ga in an inch document and scales in others', () => {
    expect(defaultSheetThickness('inch')).toBe(0.0598);
    expect(defaultSheetThickness('cm')).toBeCloseTo(0.15, 12);
    const inch = requestOf(
      sheetMetalSpec,
      { profiles: [cell()] },
      {
        ctx: context({ units: 'inch' as UnitSystem })
      }
    )!;
    expect(inch.thickness).toBe(0.0598);
    expect(inch.bendRadius).toBe(0.0598);
  });

  it('takes every picked cell of one sketch, and waits on cells of two', () => {
    const two = requestOf(sheetMetalSpec, {
      profiles: [cell(SKETCH, 1), cell(SKETCH, 2)]
    })!;
    expect(two.profiles).toHaveLength(2);
    expect(
      requestOf(sheetMetalSpec, { profiles: [cell(SKETCH), cell(OTHER, 2)] })
    ).toBeNull();
    expect(
      sheetMetalSpec.hint({ ...SLOTS, profiles: [cell(), cell(OTHER, 2)] })
    ).toBe('Pick cells of one sketch only');
  });

  it('stores the rare choices only when they differ from the defaults', () => {
    const sheet = requestOf(
      sheetMetalSpec,
      { profiles: [cell()] },
      {
        set: { thickness: 2, reliefWidth: 3 },
        options: {
          side: 'negative',
          material: 'none',
          kMethod: 'din-6935',
          reliefShape: 'obround'
        }
      }
    )!;
    expect(sheet).toMatchObject({
      thickness: 2,
      // The radius still follows the thickness it was not set apart from.
      bendRadius: 2,
      thicknessSide: 'negative',
      kFactorMethod: 'din-6935',
      relief: { shape: 'obround', width: 3 }
    });
    expect(sheet.materialPresetId).toBeUndefined();
    expect(sheet.relief).not.toHaveProperty('extension');
  });

  it('keeps a typed expression as typed', () => {
    const sheet = requestOf(
      sheetMetalSpec,
      { profiles: [cell()] },
      { raws: { bendRadius: 't + 1' }, touched: ['bendRadius'] }
    )!;
    expect(sheet.bendRadius).toBe('t + 1');
  });

  it('sets the thickness from a gauge and records it while it still matches', () => {
    const units = 'mm' as UnitSystem;
    const ctx = context({ units });
    const option = gaugeOptionId('steel-msg');
    const carried = sheetMetalSpec.optionCarries!(
      option,
      'steel-msg:16',
      inPlacePanelState(sheetMetalSpec, {}, {}),
      ctx
    );
    expect(carried?.thickness?.value).toBeCloseTo(1.5189, 4);
    const gauged = requestOf(
      sheetMetalSpec,
      { profiles: [cell()] },
      { options: { [option]: 'steel-msg:16' }, ctx }
    )!;
    expect(gauged.gaugeId).toBe('steel-msg:16');
    expect(gauged.thickness).toBeCloseTo(1.5189, 4);
    // A thickness typed over it is no longer that gauge.
    const typed = requestOf(
      sheetMetalSpec,
      { profiles: [cell()] },
      { options: { [option]: 'steel-msg:16' }, set: { thickness: 2 }, ctx }
    )!;
    expect(typed.gaugeId).toBeUndefined();
    // Another material reads another table: the steel gauge is not its.
    const aluminium = requestOf(
      sheetMetalSpec,
      { profiles: [cell()] },
      {
        options: { [option]: 'steel-msg:16', material: 'aluminium-5052-h32' },
        ctx
      }
    )!;
    expect(aluminium.gaugeId).toBeUndefined();
    expect(aluminium.thickness).toBe(1.5);
  });

  it('stands its thickness handle on the cells, along the side the sheet is', () => {
    const [up] = sheetMetalSpec.handles(
      { ...SLOTS, profiles: [cell()] },
      {},
      context(),
      {}
    );
    expect(up).toMatchObject({
      valueId: 'thickness',
      kind: 'linear',
      params: { origin: { x: 50, y: 20 }, direction: { x: 0, y: 0, z: 1 } }
    });
    const [down] = sheetMetalSpec.handles(
      { ...SLOTS, profiles: [cell()] },
      {},
      context(),
      { side: 'negative' }
    );
    expect(down?.kind === 'linear' && down.params.direction.z).toBe(-1);
  });
});

describe('Sheet metal: its Options panel', () => {
  const rows = (spec: InPlaceToolSpec, options: Record<string, string>) =>
    inPlacePanelSections(
      spec,
      inPlacePanelState(spec, options, {}),
      new Set(spec === sheetMetalSpec ? ['thickness'] : [])
    ).map((section) => ({
      label: section.label ?? null,
      rows: section.rows.map((row) => (row.kind === 'vector' ? '' : row.id))
    }));

  it('shows the material’s own gauges and hides K for DIN 6935', () => {
    expect(rows(sheetMetalSpec, {})).toEqual([
      {
        label: null,
        rows: ['side', 'material', 'gauge.steel-msg', 'thickness']
      },
      { label: 'Bends', rows: ['bendRadius', 'kMethod', 'kFactor'] },
      {
        label: 'Relief',
        rows: ['reliefShape', 'reliefWidth', 'reliefExtension']
      }
    ]);
    const changed = rows(sheetMetalSpec, {
      material: 'brass',
      kMethod: 'din-6935',
      reliefShape: 'none'
    });
    expect(changed[0]!.rows).toContain('gauge.metric');
    expect(changed[1]!.rows).toEqual(['bendRadius', 'kMethod']);
    expect(changed[2]!.rows).toEqual(['reliefShape']);
  });

  it('puts Bend’s thickness under Options, with no handle', () => {
    expect(rows(bendSpec, {})[0]!.rows).toContain('thickness');
    expect(bendSpec.handles(SLOTS, {}, context(), {})).toEqual([]);
  });

  it('reads out the rule, DIN 6935 included', () => {
    const state = inPlacePanelState(
      sheetMetalSpec,
      { kMethod: 'din-6935' },
      { thickness: 2, bendRadius: 2 }
    );
    expect(sheetMetalSpec.summary!(state, 'mm')).toBe(
      '2 mm mild steel (crs) · R 2 mm · K 0.325 (DIN 6935) · Mild steel (CRS) bends to R 1 mm (rule of thumb)'
    );
  });
});

const LINE_A = 'ent_line_a' as EntityId;
const LINE_B = 'ent_line_b' as EntityId;

const STORED: Extract<FeatureData, { featureKind: 'sheet-metal' }> = {
  featureKind: 'sheet-metal',
  sketchId: SKETCH,
  profiles: [cell().reference],
  thickness: 't',
  thicknessSide: 'positive',
  bendRadius: 2,
  kFactor: 0.4,
  relief: { shape: 'obround', width: 3 },
  materialPresetId: 'stainless-304',
  gaugeId: 'stainless:16',
  fixedPoint: [10, 20],
  bends: [
    {
      id: 'b1',
      line: { sketchId: SKETCH, objectId: LINE_A },
      angleDeg: 'a + 5',
      direction: 'down',
      position: 'centerline',
      radius: 1
    },
    {
      id: 'b2',
      line: { sketchId: OTHER, objectId: LINE_B },
      angleDeg: 45,
      direction: 'up',
      kFactor: 0.33,
      relief: { shape: 'none' }
    }
  ]
};

const EDIT_CTX: InPlaceEditContext = {
  evaluate: (value) =>
    typeof value === 'number'
      ? value
      : value === 't'
        ? 1.5875
        : value === 'a + 5'
          ? 95
          : null,
  profile: (sketchId, reference) => ({
    sketchId,
    reference,
    regionFingerprint: 1
  }),
  firstRegion: () => 1,
  face: () => null,
  anyFace: () => null,
  edge: () => null,
  curve: (_sketchId, entityId) => entityId !== 'ent_gone',
  body: () => null
};

function storedNode(
  data: Extract<FeatureData, { featureKind: 'sheet-metal' }> = STORED
): FeatureNode {
  return {
    id: 'node_sheet',
    kind: 'feature',
    featureId: 'feat_sheet' as FeatureId,
    name: 'Sheet metal 1',
    bodyId: BODY,
    data
  } as unknown as FeatureNode;
}

/** An armed Bend edit's request, the user's `changes` applied over it. */
function editRequest(
  data = STORED,
  changes: {
    options?: Record<string, string>;
    path?: CurvePick[];
    set?: Record<string, number>;
  } = {}
): SheetMetalRequest {
  const armed = inPlaceEditSeed(storedNode(data), EDIT_CTX)!;
  expect(armed.tool).toBe('bend');
  const spec = IN_PLACE_TOOL_SPECS[armed.tool];
  const ctx = context({ saved: data, evaluate: EDIT_CTX.evaluate });
  const touched = [...armed.seed.touched, ...Object.keys(changes.set ?? {})];
  const withTouched = { ...ctx, touched };
  const slots = { ...SLOTS, path: changes.path ?? armed.seed.slots.path };
  const options = { ...armed.seed.options, ...changes.options };
  const numbers: Record<string, number> = {
    ...Object.fromEntries(
      spec.values.map((value) => [value.id, value.initial])
    ),
    ...armed.seed.values,
    ...changes.set
  };
  for (const [id, value] of Object.entries(
    spec.defaults?.(slots, withTouched, numbers, options) ?? {}
  )) {
    if (!touched.includes(id)) numbers[id] = value;
  }
  const values: Record<string, number | string> = { ...numbers };
  for (const [id, raw] of Object.entries(armed.seed.raws)) {
    if (!(id in (changes.set ?? {}))) values[id] = raw;
  }
  const request = spec.request(slots, values, options, withTouched, numbers);
  if (request?.tool !== 'sheet-metal') throw new Error('No request');
  return request.sheet;
}

describe('Bend: History edit round trip', () => {
  it('is what History reopens a sheet-metal feature with', () => {
    expect(inPlaceToolForFeature(STORED)).toBe('bend');
    expect(inPlaceEditSourceSketchIds(STORED)).toEqual([SKETCH, OTHER]);
  });

  it('writes an untouched edit back exactly as stored, expressions kept', () => {
    const { featureKind: _kind, ...stored } = STORED;
    expect(editRequest()).toEqual(stored);
    const update = inPlaceFeatureUpdate(storedNode(), {
      tool: 'sheet-metal',
      sheet: editRequest()
    })!;
    expect(update.clearData).toBeUndefined();
    expect(update.data).toEqual(STORED);
    expect(
      sheetMetalUpdate('feat_sheet' as FeatureId, STORED, editRequest())
    ).toEqual({
      featureId: 'feat_sheet',
      rule: {
        profiles: STORED.profiles,
        thickness: 't',
        thicknessSide: 'positive',
        bendRadius: 2,
        kFactor: 0.4,
        relief: { shape: 'obround', width: 3 },
        materialPresetId: 'stainless-304',
        gaugeId: 'stainless:16',
        fixedPoint: [10, 20]
      },
      bends: STORED.bends
    });
  });

  it('round-trips a bare feature without adding a field', () => {
    const bare: typeof STORED = {
      featureKind: 'sheet-metal',
      sketchId: SKETCH,
      profiles: [cell().reference],
      thickness: 1.5,
      bendRadius: 1.5,
      kFactor: 0.44,
      bends: []
    };
    const { featureKind: _kind, ...stored } = bare;
    expect(editRequest(bare)).toEqual(stored);
  });

  it('keeps a bend whose line is gone as a row, and says so', () => {
    const gone: typeof STORED = {
      ...STORED,
      bends: [
        {
          ...STORED.bends[0]!,
          line: { sketchId: SKETCH, objectId: 'ent_gone' as EntityId }
        }
      ]
    };
    const armed = inPlaceEditSeed(storedNode(gone), EDIT_CTX)!;
    expect(armed.seed.slots.path).toHaveLength(1);
    expect(armed.seed.notice).toContain('bend line');
  });

  it('changes a row, adds one with the defaults and clears a fixed point', () => {
    const lineC: CurvePick = { sketchId: SKETCH, entityId: 'ent_line_c' };
    const armed = inPlaceEditSeed(storedNode(), EDIT_CTX)!;
    const sheet = editRequest(STORED, {
      path: [...armed.seed.slots.path, lineC],
      options: {
        [bendOptionId(LINE_A, 'direction')]: 'up',
        [bendOptionId(LINE_A, 'radius')]: '',
        [bendOptionId(LINE_B, 'angle')]: 'a + 5',
        [bendOptionId(LINE_B, 'position')]: 'outside-mold-line',
        [FIXED_POINT_OPTION]: ''
      }
    });
    expect(sheet.bends).toEqual([
      {
        id: 'b1',
        line: { sketchId: SKETCH, objectId: LINE_A },
        angleDeg: 'a + 5',
        direction: 'up',
        position: 'centerline'
      },
      {
        id: 'b2',
        line: { sketchId: OTHER, objectId: LINE_B },
        angleDeg: 'a + 5',
        direction: 'up',
        position: 'outside-mold-line',
        kFactor: 0.33,
        relief: { shape: 'none' }
      },
      {
        id: 'b-ent_line_c',
        line: { sketchId: SKETCH, objectId: 'ent_line_c' },
        angleDeg: 90,
        direction: 'up'
      }
    ]);
    expect(sheet.fixedPoint).toBeUndefined();
    expect(
      inPlaceFeatureUpdate(storedNode(), { tool: 'sheet-metal', sheet })!
        .clearData
    ).toEqual(['fixedPoint']);
  });

  it('removes a row when its line is clicked out of the path', () => {
    const sheet = editRequest(STORED, {
      path: [{ sketchId: OTHER, entityId: LINE_B }]
    });
    expect(sheet.bends.map((bend) => bend.id)).toEqual(['b2']);
  });

  it('changes the rule: a new thickness drops the gauge it no longer is', () => {
    const sheet = editRequest(STORED, { set: { thickness: 2 } });
    expect(sheet.thickness).toBe(2);
    expect(sheet.gaugeId).toBeUndefined();
    expect(
      inPlaceFeatureUpdate(storedNode(), { tool: 'sheet-metal', sheet })!
        .clearData
    ).toEqual(['gaugeId']);
  });

  it('waits for a sheet-metal feature before it builds anything', () => {
    expect(bendSpec.ready(SLOTS, {}, context())).toBe(false);
    expect(bendSpec.hint(SLOTS, {}, context())).toBe(
      'Click a sheet-metal body to bend'
    );
    expect(bendSpec.hint(SLOTS, {}, context({ saved: STORED }))).toBe(
      'Click a line across the sheet to bend along it'
    );
  });
});

describe('Bend: table rows and picks', () => {
  it('reads each row over the stored bend, a new one at its defaults', () => {
    const rows = bendRows(
      [
        { sketchId: SKETCH, entityId: LINE_A },
        { sketchId: SKETCH, entityId: 'ent with space' }
      ],
      { [bendOptionId('ent with space', 'relief')]: 'rectangular' },
      { saved: STORED }
    );
    expect(rows[0]).toMatchObject({
      id: 'b1',
      angle: 'a + 5',
      direction: 'down',
      position: 'centerline',
      radius: 1,
      saved: true
    });
    expect(rows[1]).toEqual({
      id: 'b-entwithspace',
      line: { sketchId: SKETCH, entityId: 'ent with space' },
      angle: 90,
      direction: 'up',
      position: 'centerline',
      relief: { shape: 'rectangular' },
      saved: false
    });
  });

  it('keeps the clicked fixed point, the stored one, or none', () => {
    expect(bendFixedPoint({}, STORED)).toEqual([10, 20]);
    expect(bendFixedPoint({ [FIXED_POINT_OPTION]: '3.5,-2' }, STORED)).toEqual([
      3.5, -2
    ]);
    expect(
      bendFixedPoint({ [FIXED_POINT_OPTION]: '' }, STORED)
    ).toBeUndefined();
  });

  it('reads a click on the flat sheet in sketch coordinates', () => {
    const point = sketchPointOf(XY, { x: 12.345678, y: 7, z: 0.75 });
    expect(point).toEqual([12.3457, 7]);
    const regions = [
      {
        outer: [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 20, y: 20 },
          { x: 0, y: 20 }
        ],
        holes: [
          [
            { x: 5, y: 5 },
            { x: 8, y: 5 },
            { x: 8, y: 8 },
            { x: 5, y: 8 }
          ]
        ]
      }
    ];
    expect(onBlank([12, 7], regions)).toBe(true);
    expect(onBlank([6, 6], regions)).toBe(false);
    expect(onBlank([25, 7], regions)).toBe(false);
  });

  it('offers the straight lines of sketches on the blank’s plane only', () => {
    const user = toUserId('user_sheet');
    let document = createProjectDocument('Sheet', user);
    const blank = addSketchFeature(document, {
      name: 'Blank',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        {
          objectKind: 'rectangle',
          width: 100,
          height: 40,
          centerX: 50,
          centerY: 20
        },
        {
          objectKind: 'line',
          x1: 50,
          y1: 0,
          x2: 50,
          y2: 40,
          construction: true
        },
        { objectKind: 'circle', radius: 3, centerX: 20, centerY: 20 }
      ]
    });
    document = blank.document;
    const same = addSketchFeature(document, {
      name: 'Lines',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [{ objectKind: 'line', x1: 0, y1: 10, x2: 100, y2: 10 }]
    });
    document = same.document;
    const lifted = addSketchFeature(document, {
      name: 'Lifted',
      planeRef: { type: 'canonical', plane: 'XY', offset: 5 },
      objects: [{ objectKind: 'line', x1: 0, y1: 30, x2: 100, y2: 30 }]
    });
    document = lifted.document;
    const views = [blank.sketchId, same.sketchId, lifted.sketchId].map(
      (sketchId, index) => ({
        sketchId,
        basis:
          index === 2
            ? { ...XY, origin: { x: 0, y: 0, z: 5 } }
            : canonicalPlaneBasis('XY')
      })
    );
    const candidates = bendLineCandidates(
      document,
      views,
      blank.sketchId,
      (value) => Number(value)
    );
    const blankIds = findSketch(document, blank.sketchId)!.objectIds;
    const sameIds = findSketch(document, same.sketchId)!.objectIds;
    expect(candidates.map((candidate) => candidate.entityId)).toEqual([
      blankIds[1],
      sameIds[0]
    ]);
    expect(candidates[0]!.points).toEqual([
      { x: 50, y: 0, z: 0 },
      { x: 50, y: 40, z: 0 }
    ]);
  });
});

import {
  DEFAULT_SHEET_METAL_K_FACTOR,
  SHEET_METAL_GAUGE_TABLES,
  SHEET_METAL_MATERIAL_PRESETS,
  UNIT_TO_MM,
  din6935KFactor,
  ownEntry,
  sheetMetalGaugeById,
  sheetMetalMaterialById,
  type EntityId,
  type FeatureData,
  type ParamValue,
  type ProjectDocument,
  type SheetMetalBend,
  type SheetMetalBendDirection,
  type SheetMetalBendPosition,
  type SheetMetalGaugeTableId,
  type SheetMetalRelief,
  type SheetMetalReliefShape,
  type SketchId,
  type UnitSystem,
  type Vector3
} from '@openzcad/shared';
import type { PlaneBasis } from '@openzcad/geometry';
import type { SheetMetalUpdateInput } from '@openzcad/command-system';
import type {
  CurvePick,
  HandleSpec,
  InPlaceContext,
  InPlacePanelSection,
  InPlacePanelState,
  InPlaceRequest,
  InPlaceSlots,
  InPlaceToolSpec,
  OptionSpec,
  ValueSpec
} from './tools';
import { revolveProfileRegions } from './revolve';
import { curveCandidateId, type SketchCurveCandidate } from './curves';

/**
 * M16 slice 3: the in-place Sheet metal and Bend commands
 * ([specification](../../../../../docs/plans/sheet-metal-plan.md),
 * "Interaction").
 *
 * Sheet metal turns picked sketch cells into a flat sheet: its thickness is
 * the one handle, and the rule (side, material, gauge, inside radius,
 * K-factor, relief) sits under Options. Bend edits a sheet-metal feature:
 * each line clicked on the flat sheet is a row of the bend table, and the
 * rule is under Options again. Both store the feature as
 * `commandFactories.sheetMetalBody` and `updateSheetMetal` take it.
 *
 * A bend row's settings ride in the session's options under
 * `bend.<lineObjectId>.<field>`, read over the stored bend: an option left
 * unset is the stored value (or the new row's default), `''` clears an
 * override, so an untouched edit writes every bend back as stored.
 */

/** A sheet-metal feature's fields, as {@link InPlaceRequest} carries them. */
export type SheetMetalRequest = Omit<
  Extract<FeatureData, { featureKind: 'sheet-metal' }>,
  'featureKind'
>;

type SheetMetalData = Extract<FeatureData, { featureKind: 'sheet-metal' }>;

/** 1.5 mm, or 16 ga (0.0598 in) in an inch document. */
export function defaultSheetThickness(units: UnitSystem | undefined): number {
  if (units === 'inch') return 0.0598;
  return 1.5 / UNIT_TO_MM[units ?? 'mm'];
}

export const SHEET_METAL_DEFAULT_MATERIAL = 'mild-steel';

const GAUGE_TABLE_IDS = Object.keys(
  SHEET_METAL_GAUGE_TABLES
) as SheetMetalGaugeTableId[];

/** The option that holds the gauge picked from one table. */
export function gaugeOptionId(table: SheetMetalGaugeTableId): string {
  return `gauge.${table}`;
}

/** The gauge table a material reads its gauges from (none: metric). */
export function sheetGaugeTable(material: string | undefined) {
  const preset =
    material === undefined ? null : sheetMetalMaterialById(material);
  return preset?.gaugeTableId ?? 'metric';
}

function lengthText(millimetres: number): string {
  return `${Math.round(millimetres * 1000) / 1000} mm`;
}

const GAUGE_OPTIONS: OptionSpec[] = GAUGE_TABLE_IDS.map((table) => ({
  id: gaugeOptionId(table),
  label: 'Gauge',
  initial: 'custom',
  choices: [
    {
      value: 'custom',
      label: 'Custom',
      tip: 'Any thickness; nothing is recorded as a gauge'
    },
    ...SHEET_METAL_GAUGE_TABLES[table].map((gauge) => ({
      value: gauge.id,
      // An inch gauge also reads in millimetres; a metric one is its size.
      label:
        table === 'metric'
          ? gauge.label
          : `${gauge.label} · ${lengthText(gauge.thicknessMm)}`
    }))
  ],
  when: (state: InPlacePanelState) =>
    sheetGaugeTable(state.options.material) === table
}));

const SHEET_OPTIONS: readonly OptionSpec[] = [
  {
    id: 'side',
    label: 'Side',
    initial: 'positive',
    choices: [
      { value: 'positive', label: 'Up', tip: 'Along the sketch normal' },
      { value: 'negative', label: 'Down', tip: 'Against the sketch normal' }
    ]
  },
  {
    id: 'material',
    label: 'Material',
    initial: SHEET_METAL_DEFAULT_MATERIAL,
    choices: [
      ...SHEET_METAL_MATERIAL_PRESETS.map((preset) => ({
        value: preset.id,
        label: preset.label
      })),
      {
        value: 'none',
        label: 'None',
        tip: 'No material: no minimum-radius advice'
      }
    ]
  },
  ...GAUGE_OPTIONS,
  {
    id: 'kMethod',
    label: 'K-factor',
    initial: 'value',
    choices: [
      { value: 'value', label: 'Value' },
      {
        value: 'din-6935',
        label: 'DIN 6935',
        tip: 'From R/T by DIN 6935, an approximation'
      }
    ]
  },
  {
    id: 'reliefShape',
    label: 'Relief',
    initial: 'rectangular',
    choices: [
      { value: 'rectangular', label: 'Rectangular' },
      { value: 'obround', label: 'Obround' },
      { value: 'none', label: 'None' }
    ]
  }
];

function sheetValues(thicknessInOptions: boolean): ValueSpec[] {
  const relief = (state: InPlacePanelState) =>
    state.options.reliefShape !== 'none';
  return [
    {
      id: 'thickness',
      label: 'Thickness',
      unit: 'length',
      initial: 1.5,
      min: 0,
      exclusive: true,
      ...(thicknessInOptions ? { inOptions: true } : {})
    },
    {
      id: 'bendRadius',
      label: 'Inside radius',
      unit: 'length',
      initial: 1.5,
      min: 0,
      exclusive: true,
      inOptions: true,
      note: 'Each bend’s inside radius unless its row sets one'
    },
    {
      id: 'kFactor',
      label: 'K',
      unit: 'count',
      initial: DEFAULT_SHEET_METAL_K_FACTOR,
      min: 0,
      max: 1,
      exclusive: true,
      step: 0.01,
      inOptions: true,
      note: 'Neutral axis as a fraction of the thickness; a rule of thumb',
      when: (state) => state.options.kMethod !== 'din-6935'
    },
    {
      id: 'reliefWidth',
      label: 'Relief width',
      unit: 'length',
      initial: 1.5,
      min: 0,
      exclusive: true,
      inOptions: true,
      when: relief
    },
    {
      id: 'reliefExtension',
      label: 'Relief extension',
      unit: 'length',
      initial: 1.5,
      min: 0,
      inOptions: true,
      note: 'How far the relief runs past the bend into the fixed side',
      when: relief
    }
  ];
}

const SHEET_LAYOUT: readonly InPlacePanelSection[] = [
  {
    boxed: true,
    compact: true,
    items: [
      'side',
      'material',
      ...GAUGE_OPTIONS.map((option) => option.id),
      'thickness'
    ]
  },
  {
    label: 'Bends',
    boxed: true,
    compact: true,
    items: ['bendRadius', 'kMethod', 'kFactor']
  },
  {
    label: 'Relief',
    collapsed: true,
    compact: true,
    items: ['reliefShape', 'reliefWidth', 'reliefExtension']
  }
];

/** A gauge's thickness in the document's unit. */
function gaugeThickness(
  gaugeId: string,
  units: UnitSystem | undefined
): number | null {
  const gauge = sheetMetalGaugeById(gaugeId);
  return gauge ? gauge.thicknessMm / UNIT_TO_MM[units ?? 'mm'] : null;
}

/** The gauge chosen for the material's own table, or null. */
function chosenGauge(options: Readonly<Record<string, string>>): string | null {
  const table = sheetGaugeTable(options.material);
  const chosen = options[gaugeOptionId(table)];
  return chosen && chosen !== 'custom' ? chosen : null;
}

function sameLength(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

function sheetDefaults(
  ctx: InPlaceContext,
  numbers: Record<string, number>,
  options: Readonly<Record<string, string>> = {}
): Record<string, number> {
  // A gauge picked for the material is the thickness until one is typed.
  const gauge = chosenGauge(options);
  const thickness =
    (gauge ? gaugeThickness(gauge, ctx.units) : null) ??
    defaultSheetThickness(ctx.units);
  const touched = new Set(ctx.touched ?? []);
  const t = touched.has('thickness')
    ? (numbers.thickness ?? thickness)
    : thickness;
  // R = T and relief T × T follow the thickness until they are set.
  return {
    thickness,
    bendRadius: t,
    reliefWidth: t,
    reliefExtension: t
  };
}

function sheetOptionCarries(
  optionId: string,
  value: string,
  _state: InPlacePanelState,
  ctx: InPlaceContext
): Record<string, { value: number; from: string }> | null {
  if (!optionId.startsWith('gauge.') || value === 'custom') return null;
  const thickness = gaugeThickness(value, ctx.units);
  return thickness === null
    ? null
    : { thickness: { value: thickness, from: 'thickness' } };
}

function formatLength(value: number, units: UnitSystem | undefined): string {
  const unit = units === 'inch' ? 'in' : (units ?? 'mm');
  return `${Math.round(value * 10000) / 10000} ${unit}`;
}

function sheetSummary(
  state: InPlacePanelState,
  units: UnitSystem
): string | null {
  const t = state.numbers.thickness;
  const r = state.numbers.bendRadius;
  if (t === undefined || r === undefined) return null;
  const material = sheetMetalMaterialById(state.options.material ?? '');
  const gauge = chosenGauge(state.options);
  const gaugeLabel = gauge ? sheetMetalGaugeById(gauge)?.label : undefined;
  let k = `K ${state.numbers.kFactor ?? DEFAULT_SHEET_METAL_K_FACTOR}`;
  if (state.options.kMethod === 'din-6935') {
    try {
      k = `K ${Math.round(din6935KFactor(r, t) * 1000) / 1000} (DIN 6935)`;
    } catch {
      k = 'K by DIN 6935';
    }
  }
  const minimum = material
    ? ` · ${material.label} bends to R ${formatLength(material.minInsideRadiusOverT * t, units)} (rule of thumb)`
    : '';
  return `${formatLength(t, units)}${gaugeLabel ? ` (${gaugeLabel})` : ''}${
    material ? ` ${material.label.toLowerCase()}` : ''
  } · R ${formatLength(r, units)} · ${k}${minimum}`;
}

/** A typed number stays a number; anything else is an expression. */
export function sheetParam(text: string): ParamValue {
  const trimmed = text.trim();
  const number = Number(trimmed);
  return trimmed !== '' && Number.isFinite(number) ? number : trimmed;
}

/**
 * An optional choice as stored: the stored one while the option was not
 * changed, absent when it is at its default and nothing was stored.
 */
function storedChoice<T extends string>(
  option: string | undefined,
  saved: T | undefined,
  fallback: T
): T | undefined {
  if (option === undefined) return saved;
  if (option === fallback && saved === undefined) return undefined;
  return option as T;
}

/** The rule fields every sheet-metal request carries. */
function ruleFields(
  values: Record<string, ParamValue>,
  options: Record<string, string>,
  ctx: InPlaceContext,
  numbers: Record<string, number> | undefined,
  saved: SheetMetalData | undefined
): Omit<SheetMetalRequest, 'sketchId' | 'profiles' | 'bends' | 'fixedPoint'> {
  const touched = new Set(ctx.touched ?? []);
  const thickness = values.thickness ?? defaultSheetThickness(ctx.units);
  const side = storedChoice(options.side, saved?.thicknessSide, 'positive');
  const method = storedChoice(options.kMethod, saved?.kFactorMethod, 'value');
  const material =
    options.material === undefined
      ? saved?.materialPresetId
      : options.material === 'none'
        ? undefined
        : options.material;
  // A gauge is recorded only while the thickness is still that gauge's: the
  // thickness is what builds, and a gauge it no longer matches would say
  // otherwise. An edit that changes neither keeps what it stored.
  const gauge = chosenGauge(options);
  const thicknessNumber =
    typeof thickness === 'number' ? thickness : numbers?.thickness;
  const gaugeLength = gauge ? gaugeThickness(gauge, ctx.units) : null;
  const gaugeId =
    gauge &&
    gaugeLength !== null &&
    thicknessNumber !== undefined &&
    sameLength(gaugeLength, thicknessNumber)
      ? gauge
      : saved?.gaugeId !== undefined &&
          saved.gaugeId === gauge &&
          thickness === saved.thickness
        ? saved.gaugeId
        : undefined;
  const shape = (options.reliefShape ?? 'rectangular') as SheetMetalReliefShape;
  const width = touched.has('reliefWidth') ? values.reliefWidth : undefined;
  const extension = touched.has('reliefExtension')
    ? values.reliefExtension
    : undefined;
  const relief: SheetMetalRelief | undefined =
    saved?.relief === undefined &&
    shape === 'rectangular' &&
    width === undefined &&
    extension === undefined
      ? undefined
      : {
          shape,
          ...(shape !== 'none' && width !== undefined ? { width } : {}),
          ...(shape !== 'none' && extension !== undefined ? { extension } : {})
        };
  return {
    thickness,
    ...(side === undefined ? {} : { thicknessSide: side }),
    bendRadius: values.bendRadius ?? thickness,
    kFactor: values.kFactor ?? DEFAULT_SHEET_METAL_K_FACTOR,
    ...(method === undefined ? {} : { kFactorMethod: method }),
    ...(relief === undefined ? {} : { relief }),
    ...(material === undefined ? {} : { materialPresetId: material }),
    ...(gaugeId === undefined ? {} : { gaugeId })
  };
}

/** The rule as an edit seeds it: each stored choice as its option. */
export function sheetMetalEditOptions(
  data: SheetMetalData
): Record<string, string> {
  const options: Record<string, string> = {
    side: data.thicknessSide ?? 'positive',
    material: data.materialPresetId ?? 'none',
    kMethod: data.kFactorMethod ?? 'value',
    reliefShape: data.relief?.shape ?? 'rectangular'
  };
  for (const table of GAUGE_TABLE_IDS) {
    options[gaugeOptionId(table)] = 'custom';
  }
  if (data.gaugeId !== undefined) {
    const gauge = sheetMetalGaugeById(data.gaugeId);
    const table = data.gaugeId.split(':')[0] as SheetMetalGaugeTableId;
    if (gauge && GAUGE_TABLE_IDS.includes(table)) {
      options[gaugeOptionId(table)] = data.gaugeId;
    }
  }
  return options;
}

/** The thickness handle: on the picked cells, along the side the sheet is. */
function thicknessHandle(
  slots: InPlaceSlots,
  ctx: InPlaceContext,
  options: Record<string, string>
): HandleSpec[] {
  const first = slots.profiles[0];
  const view = first
    ? ctx.sketchViews.find((candidate) => candidate.sketchId === first.sketchId)
    : undefined;
  if (!first || !view) return [];
  const { basis } = view;
  const outline = revolveProfileRegions(view.regions, first).flatMap((region) =>
    region.outer.map((point) => ({
      x: basis.origin.x + basis.u.x * point.x + basis.v.x * point.y,
      y: basis.origin.y + basis.u.y * point.x + basis.v.y * point.y,
      z: basis.origin.z + basis.u.z * point.x + basis.v.z * point.y
    }))
  );
  if (outline.length === 0) return [];
  const centre = outline.reduce(
    (sum, point) => ({
      x: sum.x + point.x / outline.length,
      y: sum.y + point.y / outline.length,
      z: sum.z + point.z / outline.length
    }),
    { x: 0, y: 0, z: 0 }
  );
  const sense = options.side === 'negative' ? -1 : 1;
  const { normal } = basis;
  return [
    {
      valueId: 'thickness',
      kind: 'linear',
      key: `${first.sketchId}:${first.regionFingerprint}:thickness:${sense}`,
      params: {
        origin: centre,
        direction: {
          x: normal.x * sense,
          y: normal.y * sense,
          z: normal.z * sense
        }
      }
    }
  ];
}

/** Whether every picked cell is in the first one's sketch. */
function oneSketch(slots: InPlaceSlots): boolean {
  const first = slots.profiles[0];
  return (
    first !== undefined &&
    slots.profiles.every((pick) => pick.sketchId === first.sketchId)
  );
}

export const sheetMetalSpec: InPlaceToolSpec = {
  id: 'sheet-metal',
  title: 'Sheet metal',
  profileMode: 'many',
  wantsAxis: false,
  wantsPath: false,
  options: SHEET_OPTIONS,
  layout: SHEET_LAYOUT,
  values: sheetValues(false),
  defaults: (_slots, ctx, numbers, options) =>
    sheetDefaults(ctx, numbers, options),
  optionCarries: sheetOptionCarries,
  summary: (state, units) => sheetSummary(state, units),
  hint(slots) {
    if (slots.profiles.length === 0) {
      return 'Click the sketch cells to make a sheet of';
    }
    if (!oneSketch(slots)) return 'Pick cells of one sketch only';
    const cells =
      slots.profiles.length === 1 ? '1 cell' : `${slots.profiles.length} cells`;
    return `${cells} · drag the thickness · Bend adds bends`;
  },
  ready: (slots) => oneSketch(slots),
  request(slots, values, options, ctx, numbers) {
    const first = slots.profiles[0];
    if (!first || !oneSketch(slots)) return null;
    return {
      tool: 'sheet-metal',
      sheet: {
        sketchId: first.sketchId,
        profiles: slots.profiles.map((pick) => pick.reference),
        ...ruleFields(values, options, ctx, numbers, undefined),
        bends: []
      }
    };
  },
  handles: (slots, _values, ctx, options) =>
    thicknessHandle(slots, ctx, options)
};

// ---------------------------------------------------------------------------
// Bend
// ---------------------------------------------------------------------------

export const BEND_FIELDS = [
  'angle',
  'direction',
  'position',
  'radius',
  'kFactor',
  'relief',
  'reliefWidth',
  'reliefExtension'
] as const;
export type BendField = (typeof BEND_FIELDS)[number];

/** The session option holding one field of the bend on this line. */
export function bendOptionId(lineObjectId: string, field: BendField): string {
  return `bend.${lineObjectId}.${field}`;
}

/** The option holding the clicked fixed point, `x,y` in the sketch. */
export const FIXED_POINT_OPTION = 'fixedPoint';

export function fixedPointText(point: readonly [number, number]): string {
  return `${point[0]},${point[1]}`;
}

function parseFixedPoint(text: string): [number, number] | undefined {
  const parts = text.split(',').map((part) => Number(part));
  return parts.length === 2 && parts.every((part) => Number.isFinite(part))
    ? [parts[0]!, parts[1]!]
    : undefined;
}

export const BEND_POSITIONS: readonly {
  value: SheetMetalBendPosition;
  label: string;
}[] = [
  { value: 'centerline', label: 'Centre line' },
  { value: 'fixed-side', label: 'Bend on fixed side' },
  { value: 'moving-side', label: 'Bend on moving side' },
  { value: 'outside-mold-line', label: 'Outside corner on line' }
];

/** One row of the bend table as the panel shows it. */
export interface BendRow {
  /** The bend's id as stored, or as Done would store it. */
  id: string;
  line: CurvePick;
  /** As stored (a number, or an expression as typed). */
  angle: ParamValue;
  direction: SheetMetalBendDirection;
  position: SheetMetalBendPosition;
  radius?: ParamValue;
  kFactor?: ParamValue;
  relief?: SheetMetalRelief;
  /** Stored before this edit (its id names faces already). */
  saved: boolean;
}

function savedBends(ctx: Pick<InPlaceContext, 'saved'>): SheetMetalBend[] {
  return ctx.saved?.featureKind === 'sheet-metal' ? ctx.saved.bends : [];
}

const BEND_ID_INVALID = /[^A-Za-z0-9_-]/g;

/**
 * A new bend's id: from its line, which one feature uses once, so the id
 * (and the face names it makes) stays put while the table changes.
 */
function newBendId(lineObjectId: string, taken: ReadonlySet<string>): string {
  const base = `b-${lineObjectId.replace(BEND_ID_INVALID, '')}`.slice(0, 60);
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

/**
 * The bend table: one row per picked line, in pick order, each read from
 * the session's options over the stored bend (or a new row's defaults).
 */
export function bendRows(
  path: readonly CurvePick[],
  options: Readonly<Record<string, string>>,
  ctx: Pick<InPlaceContext, 'saved'>
): BendRow[] {
  const stored = savedBends(ctx);
  const taken = new Set(stored.map((bend) => bend.id));
  return path.map((line) => {
    const saved = stored.find(
      (bend) =>
        bend.line.objectId === line.entityId &&
        bend.line.sketchId === line.sketchId
    );
    const option = (field: BendField) =>
      options[bendOptionId(line.entityId, field)];
    const id = saved?.id ?? newBendId(line.entityId, taken);
    taken.add(id);
    const angleText = option('angle');
    const override = (
      field: 'radius' | 'kFactor',
      stored: ParamValue | undefined
    ): ParamValue | undefined => {
      const text = option(field);
      if (text === undefined) return stored;
      return text.trim() === '' ? undefined : sheetParam(text);
    };
    const reliefOption = option('relief');
    const reliefShape =
      reliefOption === undefined ? saved?.relief?.shape : reliefOption;
    const reliefTouched =
      reliefOption !== undefined ||
      option('reliefWidth') !== undefined ||
      option('reliefExtension') !== undefined;
    let relief: SheetMetalRelief | undefined = saved?.relief;
    if (reliefTouched) {
      if (reliefShape === undefined || reliefShape === '') relief = undefined;
      else {
        const width = option('reliefWidth');
        const extension = option('reliefExtension');
        const keep = (
          text: string | undefined,
          stored: ParamValue | undefined
        ) =>
          text === undefined
            ? stored
            : text.trim() === ''
              ? undefined
              : sheetParam(text);
        const w = keep(width, saved?.relief?.width);
        const e = keep(extension, saved?.relief?.extension);
        relief = {
          shape: reliefShape as SheetMetalReliefShape,
          ...(reliefShape !== 'none' && w !== undefined ? { width: w } : {}),
          ...(reliefShape !== 'none' && e !== undefined ? { extension: e } : {})
        };
      }
    }
    const radius = override('radius', saved?.radius);
    const kFactor = override('kFactor', saved?.kFactor);
    return {
      id,
      line,
      angle:
        angleText === undefined
          ? (saved?.angleDeg ?? 90)
          : sheetParam(angleText),
      direction: (option('direction') ??
        saved?.direction ??
        'up') as SheetMetalBendDirection,
      position: (option('position') ??
        saved?.position ??
        'centerline') as SheetMetalBendPosition,
      ...(radius === undefined ? {} : { radius }),
      ...(kFactor === undefined ? {} : { kFactor }),
      ...(relief === undefined ? {} : { relief }),
      saved: saved !== undefined
    };
  });
}

/** A row as the feature stores it. */
function storedBend(
  row: BendRow,
  options: Readonly<Record<string, string>>,
  ctx: Pick<InPlaceContext, 'saved'>
): SheetMetalBend {
  const saved = savedBends(ctx).find((bend) => bend.id === row.id);
  const position = storedChoice(
    options[bendOptionId(row.line.entityId, 'position')],
    saved?.position,
    'centerline'
  );
  return {
    id: row.id,
    line: {
      sketchId: row.line.sketchId,
      objectId: row.line.entityId as EntityId
    },
    angleDeg: row.angle,
    direction: row.direction,
    ...(position === undefined ? {} : { position }),
    ...(row.radius === undefined ? {} : { radius: row.radius }),
    ...(row.kFactor === undefined ? {} : { kFactor: row.kFactor }),
    ...(row.relief === undefined ? {} : { relief: row.relief })
  };
}

/** The fixed point Done stores: the clicked one, else as stored. */
export function bendFixedPoint(
  options: Readonly<Record<string, string>>,
  saved: SheetMetalData | undefined
): [number, number] | undefined {
  const text = options[FIXED_POINT_OPTION];
  if (text === undefined) return saved?.fixedPoint;
  return text === '' ? undefined : parseFixedPoint(text);
}

function bendHint(slots: InPlaceSlots, ctx?: InPlaceContext): string {
  if (ctx?.saved?.featureKind !== 'sheet-metal') {
    return 'Click a sheet-metal body to bend';
  }
  const count = slots.path.length;
  if (count === 0) return 'Click a line across the sheet to bend along it';
  return `${count === 1 ? '1 bend' : `${count} bends`} · click a line to add or remove one · click a flat region to hold it`;
}

export const bendSpec: InPlaceToolSpec = {
  id: 'bend',
  title: 'Bend',
  featureName: 'Sheet metal',
  profileMode: 'none',
  bodyMode: 'one',
  wantsAxis: false,
  wantsPath: true,
  pathAcrossSketches: true,
  options: SHEET_OPTIONS,
  layout: SHEET_LAYOUT,
  values: sheetValues(true),
  defaults: (_slots, ctx, numbers, options) =>
    sheetDefaults(ctx, numbers, options),
  optionCarries: sheetOptionCarries,
  summary: (state, units) => sheetSummary(state, units),
  hint: (slots, _options, ctx) => bendHint(slots, ctx),
  ready: (_slots, _options, ctx) => ctx?.saved?.featureKind === 'sheet-metal',
  request(slots, values, options, ctx, numbers) {
    const saved =
      ctx.saved?.featureKind === 'sheet-metal' ? ctx.saved : undefined;
    if (!saved) return null;
    const rows = bendRows(slots.path, options, ctx);
    const fixedPoint = bendFixedPoint(options, saved);
    return {
      tool: 'sheet-metal',
      sheet: {
        sketchId: saved.sketchId,
        profiles: saved.profiles,
        ...ruleFields(values, options, ctx, numbers, saved),
        ...(fixedPoint === undefined ? {} : { fixedPoint }),
        bends: rows.map((row) => storedBend(row, options, ctx))
      }
    };
  },
  handles: () => []
};

// ---------------------------------------------------------------------------
// Picks on the flat sheet
// ---------------------------------------------------------------------------

function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Whether two sketch planes are one plane (either facing). */
export function samePlane(a: PlaneBasis, b: PlaneBasis): boolean {
  const facing = Math.abs(dot(a.normal, b.normal));
  if (Math.abs(facing - 1) > 1e-6) return false;
  const offset = {
    x: b.origin.x - a.origin.x,
    y: b.origin.y - a.origin.y,
    z: b.origin.z - a.origin.z
  };
  const size = Math.max(
    1,
    Math.abs(a.origin.x),
    Math.abs(a.origin.y),
    Math.abs(a.origin.z),
    Math.abs(b.origin.x),
    Math.abs(b.origin.y),
    Math.abs(b.origin.z)
  );
  return Math.abs(dot(offset, a.normal)) <= 1e-6 * size;
}

/**
 * The lines a bend may run along: straight lines, construction ones
 * included, of every sketch lying on the blank's plane.
 */
export function bendLineCandidates(
  document: ProjectDocument,
  views: readonly { sketchId: string; basis: PlaneBasis }[],
  blankSketchId: SketchId,
  resolve: (value: ParamValue) => number
): SketchCurveCandidate[] {
  const blank = views.find((view) => view.sketchId === blankSketchId);
  if (!blank) return [];
  const out: SketchCurveCandidate[] = [];
  for (const view of views) {
    if (!samePlane(blank.basis, view.basis)) continue;
    const sketch = Object.values(document.nodes).find(
      (node) => node.kind === 'sketch' && node.sketchId === view.sketchId
    );
    if (sketch?.kind !== 'sketch') continue;
    for (const objectId of sketch.objectIds) {
      const node = ownEntry(document.nodes, objectId);
      if (node?.kind !== 'sketch-object') continue;
      const data = node.data;
      if (data.objectKind !== 'line') continue;
      let ends: [number, number, number, number];
      try {
        ends = [
          resolve(data.x1),
          resolve(data.y1),
          resolve(data.x2),
          resolve(data.y2)
        ];
      } catch {
        continue;
      }
      if (!ends.every((value) => Number.isFinite(value))) continue;
      const { basis } = view;
      const lift = (x: number, y: number): Vector3 => ({
        x: basis.origin.x + basis.u.x * x + basis.v.x * y,
        y: basis.origin.y + basis.u.y * x + basis.v.y * y,
        z: basis.origin.z + basis.u.z * x + basis.v.z * y
      });
      out.push({
        id: curveCandidateId(view.sketchId, objectId),
        sketchId: view.sketchId as SketchId,
        entityId: objectId,
        points: [lift(ends[0], ends[1]), lift(ends[2], ends[3])]
      });
    }
  }
  return out;
}

/** A world point on the blank's plane, in its sketch's coordinates. */
export function sketchPointOf(
  basis: PlaneBasis,
  point: Vector3
): [number, number] {
  const offset = {
    x: point.x - basis.origin.x,
    y: point.y - basis.origin.y,
    z: point.z - basis.origin.z
  };
  const round = (value: number) => Math.round(value * 1e4) / 1e4;
  return [round(dot(offset, basis.u)), round(dot(offset, basis.v))];
}

function insidePolygon(
  point: readonly [number, number],
  polygon: readonly { x: number; y: number }[]
): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (
      a.y > point[1] !== b.y > point[1] &&
      point[0] < ((b.x - a.x) * (point[1] - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Whether a sketch point lies on the blank: inside a cell, not a hole. */
export function onBlank(
  point: readonly [number, number],
  regions: readonly {
    outer: readonly { x: number; y: number }[];
    holes?: readonly (readonly { x: number; y: number }[])[];
  }[]
): boolean {
  return regions.some(
    (region) =>
      insidePolygon(point, region.outer) &&
      !(region.holes ?? []).some((hole) => insidePolygon(point, hole))
  );
}

/** The feature summary's bend count and rule, for the bend table header. */
export function bendTableTitle(rows: readonly BendRow[]): string {
  return rows.length === 0
    ? 'No bends · a flat sheet'
    : rows.length === 1
      ? '1 bend'
      : `${rows.length} bends`;
}

/** Optional fields an edit that no longer sets them returns to default. */
export const SHEET_METAL_CLEARABLE = [
  'thicknessSide',
  'kFactorMethod',
  'relief',
  'materialPresetId',
  'gaugeId',
  'fixedPoint'
] as const;

/** The stored optional fields a request no longer sets. */
export function sheetMetalCleared(
  saved: SheetMetalData,
  sheet: SheetMetalRequest
): (typeof SHEET_METAL_CLEARABLE)[number][] {
  return SHEET_METAL_CLEARABLE.filter(
    (key) => saved[key] !== undefined && sheet[key] === undefined
  );
}

/**
 * Bend's Done as `updateSheetMetal` takes it: the rule and the whole bend
 * table in one transaction, the cleared optional fields named.
 */
export function sheetMetalUpdate(
  featureId: SheetMetalUpdateInput['featureId'],
  saved: SheetMetalData,
  sheet: SheetMetalRequest
): SheetMetalUpdateInput {
  const { sketchId: _sketchId, bends, ...rule } = sheet;
  const clear = sheetMetalCleared(saved, sheet);
  return {
    featureId,
    rule,
    bends,
    ...(clear.length > 0 ? { clear } : {})
  };
}

export type SheetMetalInPlaceRequest = Extract<
  InPlaceRequest,
  { tool: 'sheet-metal' }
>;

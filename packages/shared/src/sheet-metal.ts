/**
 * Sheet-metal bend arithmetic, presets and fold kinematics (ROADMAP M16,
 * [specification](../../../docs/plans/sheet-metal-plan.md)).
 *
 * Pure arithmetic, no kernel calls. Lengths are in whatever unit the caller
 * uses consistently (the document unit); angles are radians unless a name
 * says `Deg`. The exact build, the fold preview and the flat-pattern bend
 * table all read these functions, so the folded part, the preview and the
 * numbers handed to a brake operator cannot disagree.
 *
 * Every shop value here (K-factor defaults, minimum radii, die openings,
 * hole and flange distances) is a nominal rule of thumb, not a material
 * certification; the UI says so and every one is overridable.
 */

import type {
  EntityId,
  ParamValue,
  SketchId,
  SketchProfileReference
} from './index';

/** `up` folds toward the blank's +sketch-normal side, `down` away from it. */
export type SheetMetalBendDirection = 'up' | 'down';

/**
 * Where the bend zone sits relative to the drawn bend line in the flat:
 * centred on it, wholly on the fixed side, wholly on the moving side, or
 * placed so the fixed flange's outside mold line (virtual sharp) lies on it.
 */
export type SheetMetalBendPosition =
  'centerline' | 'fixed-side' | 'moving-side' | 'outside-mold-line';

export type SheetMetalReliefShape = 'rectangular' | 'obround' | 'none';

export type SheetMetalKFactorMethod = 'value' | 'din-6935';

/** A relief cut at each end of a bend line (spec "Exact build"). */
export interface SheetMetalRelief {
  shape: SheetMetalReliefShape;
  /** Along the bend line, outward from its end; absent is the thickness. */
  width?: ParamValue;
  /** Past the bend zone into the fixed side; absent is the thickness. */
  extension?: ParamValue;
}

/** One row of the bend table, defined on the flat blank. */
export interface SheetMetalBend {
  /** Stable per feature; names the bend's faces (`sheet.bend[<id>]…`). */
  id: string;
  /** A straight line of a sketch coplanar with the blank. */
  line: { sketchId: SketchId; objectId: EntityId };
  /** Degrees in (0, 180]. */
  angleDeg: ParamValue;
  direction: SheetMetalBendDirection;
  /** Absent is `'centerline'`. */
  position?: SheetMetalBendPosition;
  /** Inside radius override; absent is the feature's `bendRadius`. */
  radius?: ParamValue;
  /** K-factor override; when set this bend uses it whatever the method. */
  kFactor?: ParamValue;
  /** Relief override; absent is the feature's `relief`. */
  relief?: SheetMetalRelief;
}

/**
 * The fields of a `featureKind: 'sheet-metal'` feature (ROADMAP M16). The
 * feature owns one new body: the blank folded by every bend in `bends`.
 */
export interface SheetMetalFeatureFields {
  /** The blank's sketch. */
  sketchId: SketchId;
  /** Cells fused into one connected blank. */
  profiles: SketchProfileReference[];
  thickness: ParamValue;
  /** Which side of the sketch plane the sheet lies on; absent is positive. */
  thicknessSide?: 'positive' | 'negative';
  /** Default inside radius, > 0. */
  bendRadius: ParamValue;
  /** Default K-factor, used when `kFactorMethod` is `'value'` (absent). */
  kFactor: ParamValue;
  kFactorMethod?: SheetMetalKFactorMethod;
  /** Default relief; absent is rectangular with width and extension T. */
  relief?: SheetMetalRelief;
  /** {@link SHEET_METAL_MATERIAL_PRESETS} id; advisory thresholds only. */
  materialPresetId?: string;
  /** {@link SHEET_METAL_GAUGE_TABLES} id; display only. */
  gaugeId?: string;
  /** Sketch-local point inside the fixed region; absent is the largest. */
  fixedPoint?: [number, number];
  /** May be empty: a flat sheet. */
  bends: SheetMetalBend[];
}

/** K-factor used when nothing else is chosen: typical air bending at R ≈ T. */
export const DEFAULT_SHEET_METAL_K_FACTOR = 0.44;

/** The `outside-mold-line` position needs a finite setback. */
export const SHEET_METAL_MOLD_LINE_MAX_ANGLE_DEG = 179;

/** Bend angles are in (0, 180] degrees. */
export const SHEET_METAL_MAX_BEND_ANGLE_DEG = 180;

const DEG = Math.PI / 180;

function assertFinitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
}

function assertBendAngle(angle: number): void {
  if (
    !Number.isFinite(angle) ||
    angle <= 0 ||
    angle > SHEET_METAL_MAX_BEND_ANGLE_DEG * DEG + 1e-12
  ) {
    throw new RangeError(
      'Bend angle must be greater than 0° and at most 180°.'
    );
  }
}

function assertKFactor(kFactor: number): void {
  if (!Number.isFinite(kFactor) || kFactor <= 0 || kFactor >= 1) {
    throw new RangeError('K-factor must be greater than 0 and less than 1.');
  }
}

/** Neutral-fibre arc length of a bend: `θ · (R + K·T)`. */
export function bendAllowance(
  angle: number,
  insideRadius: number,
  thickness: number,
  kFactor: number
): number {
  assertBendAngle(angle);
  assertFinitePositive(insideRadius, 'Inside radius');
  assertFinitePositive(thickness, 'Thickness');
  assertKFactor(kFactor);
  return angle * (insideRadius + kFactor * thickness);
}

/**
 * Outside setback `tan(θ/2) · (R + T)`: from the outside tangent line to the
 * outside mold line (virtual sharp). Infinite at 180°, so a hem has none.
 */
export function outsideSetback(
  angle: number,
  insideRadius: number,
  thickness: number
): number {
  assertBendAngle(angle);
  assertFinitePositive(insideRadius, 'Inside radius');
  assertFinitePositive(thickness, 'Thickness');
  if (angle >= SHEET_METAL_MAX_BEND_ANGLE_DEG * DEG - 1e-12) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.tan(angle / 2) * (insideRadius + thickness);
}

/** Inside setback `tan(θ/2) · R`. */
export function insideSetback(angle: number, insideRadius: number): number {
  assertBendAngle(angle);
  assertFinitePositive(insideRadius, 'Inside radius');
  if (angle >= SHEET_METAL_MAX_BEND_ANGLE_DEG * DEG - 1e-12) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.tan(angle / 2) * insideRadius;
}

/**
 * Bend deduction `2·OSSB − BA`: how much shorter the flat is than the sum
 * of the two outside flange lengths.
 */
export function bendDeduction(
  angle: number,
  insideRadius: number,
  thickness: number,
  kFactor: number
): number {
  return (
    2 * outsideSetback(angle, insideRadius, thickness) -
    bendAllowance(angle, insideRadius, thickness, kFactor)
  );
}

/**
 * DIN 6935 correction expressed as a K-factor:
 * `K = ½ · (0.65 + ½·log₁₀(R/T))` below `R/T = 5`, else `0.5`, clamped to
 * `[0.25, 0.5]`. An approximation for cold-formed steel; measured values win.
 */
export function din6935KFactor(
  insideRadius: number,
  thickness: number
): number {
  assertFinitePositive(insideRadius, 'Inside radius');
  assertFinitePositive(thickness, 'Thickness');
  const ratio = insideRadius / thickness;
  const k = ratio >= 5 ? 0.5 : 0.5 * (0.65 + 0.5 * Math.log10(ratio));
  return Math.min(0.5, Math.max(0.25, k));
}

/** The K-factor a bend uses: an explicit value, or DIN 6935 from R and T. */
export function resolveKFactor(
  method: SheetMetalKFactorMethod,
  value: number | undefined,
  insideRadius: number,
  thickness: number
): number {
  if (method === 'din-6935') return din6935KFactor(insideRadius, thickness);
  const k = value ?? DEFAULT_SHEET_METAL_K_FACTOR;
  assertKFactor(k);
  return k;
}

/** The numbers of one bend, as printed in a bend table. */
export interface SheetMetalBendMetrics {
  angle: number;
  insideRadius: number;
  thickness: number;
  kFactor: number;
  bendAllowance: number;
  /** Infinite at 180°. */
  outsideSetback: number;
  /** Infinite at 180°. */
  bendDeduction: number;
}

export function sheetMetalBendMetrics(
  angle: number,
  insideRadius: number,
  thickness: number,
  kFactor: number
): SheetMetalBendMetrics {
  const allowance = bendAllowance(angle, insideRadius, thickness, kFactor);
  const setback = outsideSetback(angle, insideRadius, thickness);
  return {
    angle,
    insideRadius,
    thickness,
    kFactor,
    bendAllowance: allowance,
    outsideSetback: setback,
    bendDeduction: 2 * setback - allowance
  };
}

/**
 * Start of the bend zone in the flat, measured along the in-plane normal
 * from the bend line toward the moving side. The zone is `[s₀, s₀ + BA]`.
 */
export function bendZoneStart(
  position: SheetMetalBendPosition,
  metrics: Pick<
    SheetMetalBendMetrics,
    'angle' | 'bendAllowance' | 'outsideSetback'
  >
): number {
  switch (position) {
    case 'centerline':
      return -metrics.bendAllowance / 2;
    case 'fixed-side':
      return -metrics.bendAllowance;
    case 'moving-side':
      return 0;
    case 'outside-mold-line':
      if (
        metrics.angle > SHEET_METAL_MOLD_LINE_MAX_ANGLE_DEG * DEG + 1e-12 ||
        !Number.isFinite(metrics.outsideSetback)
      ) {
        throw new RangeError(
          `An outside-mold-line bend must be at most ${SHEET_METAL_MOLD_LINE_MAX_ANGLE_DEG}°.`
        );
      }
      return -metrics.outsideSetback;
  }
}

/**
 * Flat length of a part from its outside flange lengths and bends. Refuses
 * a bend with no finite deduction (180°).
 */
export function flatLengthFromOutsideFlanges(
  outsideFlangeLengths: readonly number[],
  bends: readonly Pick<SheetMetalBendMetrics, 'bendDeduction'>[]
): number {
  if (outsideFlangeLengths.length !== bends.length + 1) {
    throw new RangeError('A part with n bends has n + 1 flanges.');
  }
  const flanges = outsideFlangeLengths.reduce((sum, length) => sum + length, 0);
  if (bends.some((bend) => !Number.isFinite(bend.bendDeduction))) {
    // A 180° bend has no outside mold line, so outside flange lengths do
    // not define its flat length.
    throw new RangeError(
      'A 180° bend has no outside mold line; lay it out from the flat instead.'
    );
  }
  const deductions = bends.reduce((sum, bend) => sum + bend.bendDeduction, 0);
  return flanges - deductions;
}

// ---------------------------------------------------------------------------
// Fold kinematics
// ---------------------------------------------------------------------------

export type SheetMetalVec3 = readonly [number, number, number];

/**
 * A row-major 3×4 affine transform `[r00 r01 r02 tx, r10 r11 r12 ty,
 * r20 r21 r22 tz]` acting on column vectors, the layout the kernel adapter's
 * `affineMatrix` takes.
 */
export type SheetMetalAffine = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number
];

export const SHEET_METAL_IDENTITY: SheetMetalAffine = [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0
];

/** One bend in the blank's sketch frame (the plate's faces are z = const). */
export interface SheetMetalFoldInput {
  /** A point on the bend line, z ignored. */
  linePoint: SheetMetalVec3;
  /**
   * Unit in-plane normal of the line pointing from the fixed (parent) side
   * to the moving (child) side, z = 0.
   */
  movingNormal: SheetMetalVec3;
  /** Zone start `s₀` from {@link bendZoneStart}. */
  zoneStart: number;
  metrics: Pick<
    SheetMetalBendMetrics,
    'angle' | 'insideRadius' | 'thickness' | 'kFactor' | 'bendAllowance'
  >;
  direction: SheetMetalBendDirection;
  /** The plate occupies `z ∈ [plateBottom, plateBottom + thickness]`. */
  plateBottom: number;
  /**
   * View-only fold fraction in (0, 1]; absent is 1. The zone keeps its flat
   * width and turns by `fraction·θ`, so its effective radius grows.
   */
  fraction?: number;
}

export interface SheetMetalFold {
  /** A point on the bend axis (at the zone start, at the inside radius). */
  axisPoint: SheetMetalVec3;
  /** Unit axis direction `n̂ × ẑ`. */
  axisDirection: SheetMetalVec3;
  /** Signed turn about `axisDirection`: `+θ` up, `−θ` down. */
  signedAngle: number;
  /** Inside radius actually used (larger than R when folded partially). */
  effectiveInsideRadius: number;
  /** Rigid motion of everything beyond the zone on the moving side. */
  movingTransform: SheetMetalAffine;
  /** Maps a flat point of the zone (or of the moving side) to its folded place. */
  mapPoint(point: SheetMetalVec3): SheetMetalVec3;
}

function cross(a: SheetMetalVec3, b: SheetMetalVec3): SheetMetalVec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function dot(a: SheetMetalVec3, b: SheetMetalVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Rotation by `angle` about the line through `point` along unit `axis`. */
export function rotationAbout(
  point: SheetMetalVec3,
  axis: SheetMetalVec3,
  angle: number
): SheetMetalAffine {
  const [x, y, z] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  const r = [
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c
  ];
  // p' = R (p − q) + q  ⇒  translation q − R q
  const tx = point[0] - (r[0] * point[0] + r[1] * point[1] + r[2] * point[2]);
  const ty = point[1] - (r[3] * point[0] + r[4] * point[1] + r[5] * point[2]);
  const tz = point[2] - (r[6] * point[0] + r[7] * point[1] + r[8] * point[2]);
  return [r[0], r[1], r[2], tx, r[3], r[4], r[5], ty, r[6], r[7], r[8], tz];
}

/** `a · b`: apply `b` first, then `a`. */
export function composeAffine(
  a: SheetMetalAffine,
  b: SheetMetalAffine
): SheetMetalAffine {
  const out: number[] = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      let value =
        a[row * 4] * b[col] +
        a[row * 4 + 1] * b[4 + col] +
        a[row * 4 + 2] * b[8 + col];
      if (col === 3) value += a[row * 4 + 3];
      out.push(value);
    }
  }
  return out as unknown as SheetMetalAffine;
}

export function applyAffine(
  m: SheetMetalAffine,
  p: SheetMetalVec3
): SheetMetalVec3 {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]
  ];
}

export function translation(v: SheetMetalVec3): SheetMetalAffine {
  return [1, 0, 0, v[0], 0, 1, 0, v[1], 0, 0, 1, v[2]];
}

/**
 * Fold kinematics of one bend in its parent's flat frame (spec "Fold
 * kinematics"). The zone point at `n = s₀ + u` maps to angle `θ·u/BA` at its
 * radius from the axis, so the neutral fibre keeps its length; everything
 * beyond the zone moves by `Rot(axis, ±θ) · Translate(−BA·n̂)`.
 */
export function sheetMetalFold(input: SheetMetalFoldInput): SheetMetalFold {
  const { metrics, direction, plateBottom } = input;
  const fraction = input.fraction ?? 1;
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction > 1) {
    throw new RangeError('Fold fraction must be in (0, 1].');
  }
  const n = input.movingNormal;
  const nLength = Math.hypot(n[0], n[1], n[2]);
  if (Math.abs(nLength - 1) > 1e-9 || Math.abs(n[2]) > 1e-9) {
    throw new RangeError('Moving normal must be a unit in-plane vector.');
  }
  const angle = metrics.angle * fraction;
  const allowance = metrics.bendAllowance;
  const thickness = metrics.thickness;
  const effectiveInsideRadius =
    fraction === 1
      ? metrics.insideRadius
      : allowance / angle - metrics.kFactor * thickness;
  const up = direction === 'up';
  const plateTop = plateBottom + thickness;
  const axisZ = up
    ? plateTop + effectiveInsideRadius
    : plateBottom - effectiveInsideRadius;
  const s0 = input.zoneStart;
  const lp = input.linePoint;
  const axisPoint: SheetMetalVec3 = [
    lp[0] + s0 * n[0],
    lp[1] + s0 * n[1],
    axisZ
  ];
  const axisDirection = cross(n, [0, 0, 1]);
  const signedAngle = up ? angle : -angle;
  const movingTransform = composeAffine(
    rotationAbout(axisPoint, axisDirection, signedAngle),
    translation([-allowance * n[0], -allowance * n[1], 0])
  );

  const mapPoint = (point: SheetMetalVec3): SheetMetalVec3 => {
    const rel: SheetMetalVec3 = [point[0] - lp[0], point[1] - lp[1], 0];
    const u = dot(rel, n) - s0;
    if (u <= 0) return point;
    if (u >= allowance) return applyAffine(movingTransform, point);
    const along = dot(
      [point[0] - axisPoint[0], point[1] - axisPoint[1], 0],
      axisDirection
    );
    const phi = (angle * u) / allowance;
    const radius = up ? axisZ - point[2] : point[2] - axisZ;
    const inPlane = radius * Math.sin(phi);
    const vertical = up ? -radius * Math.cos(phi) : radius * Math.cos(phi);
    return [
      axisPoint[0] + along * axisDirection[0] + inPlane * n[0],
      axisPoint[1] + along * axisDirection[1] + inPlane * n[1],
      axisZ + vertical
    ];
  };

  return {
    axisPoint,
    axisDirection,
    signedAngle,
    effectiveInsideRadius,
    movingTransform,
    mapPoint
  };
}

/** Volume of a bent zone of width `w` along the line: `θ·T·(R + T/2)·w`. */
export function bentZoneVolume(
  angle: number,
  insideRadius: number,
  thickness: number,
  width: number
): number {
  return angle * thickness * (insideRadius + thickness / 2) * width;
}

// ---------------------------------------------------------------------------
// Manufacturing rules of thumb
// ---------------------------------------------------------------------------

/** Air-bending V-die opening, `8·T`. */
export function nominalDieOpening(thickness: number): number {
  assertFinitePositive(thickness, 'Thickness');
  return 8 * thickness;
}

/** Shortest outside flange a brake holds, about `0.7·V`. */
export function minimumFlangeLength(thickness: number): number {
  return 0.7 * nominalDieOpening(thickness);
}

/** Nearest a hole or cut-out edge should come to a bend zone, `2·T`. */
export function minimumHoleToBendDistance(thickness: number): number {
  assertFinitePositive(thickness, 'Thickness');
  return 2 * thickness;
}

/** Narrowest useful relief, `T`. */
export function minimumReliefWidth(thickness: number): number {
  assertFinitePositive(thickness, 'Thickness');
  return thickness;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export interface SheetMetalMaterialPreset {
  id: string;
  label: string;
  /** `MATERIAL_DENSITY_PRESETS` id, for mass properties, when one fits. */
  densityPresetId?: string;
  /** Nominal smallest inside radius for a 90° bend, as a multiple of T. */
  minInsideRadiusOverT: number;
  /** Which gauge table this material's gauges come from. */
  gaugeTableId: SheetMetalGaugeTableId;
}

/**
 * Nominal minimum radii for 90° air bends across the grain; 6061-T6 cracks
 * at tight radii, which is why it sits far above 5052-H32.
 */
export const SHEET_METAL_MATERIAL_PRESETS: readonly SheetMetalMaterialPreset[] =
  [
    {
      id: 'mild-steel',
      label: 'Mild steel (CRS)',
      densityPresetId: 'steel',
      minInsideRadiusOverT: 0.5,
      gaugeTableId: 'steel-msg'
    },
    {
      id: 'stainless-304',
      label: 'Stainless 304',
      densityPresetId: 'stainless',
      minInsideRadiusOverT: 1,
      gaugeTableId: 'stainless'
    },
    {
      id: 'aluminium-5052-h32',
      label: 'Aluminium 5052-H32',
      densityPresetId: 'aluminium-6061',
      minInsideRadiusOverT: 1,
      gaugeTableId: 'aluminium-bs'
    },
    {
      id: 'aluminium-6061-t6',
      label: 'Aluminium 6061-T6',
      densityPresetId: 'aluminium-6061',
      minInsideRadiusOverT: 3,
      gaugeTableId: 'aluminium-bs'
    },
    {
      id: 'copper',
      label: 'Copper',
      minInsideRadiusOverT: 0.5,
      gaugeTableId: 'metric'
    },
    {
      id: 'brass',
      label: 'Brass',
      densityPresetId: 'brass',
      minInsideRadiusOverT: 1,
      gaugeTableId: 'metric'
    }
  ];

export function sheetMetalMaterialById(
  id: string
): SheetMetalMaterialPreset | null {
  return (
    SHEET_METAL_MATERIAL_PRESETS.find((preset) => preset.id === id) ?? null
  );
}

export type SheetMetalGaugeTableId =
  'steel-msg' | 'stainless' | 'aluminium-bs' | 'metric';

export interface SheetMetalGauge {
  /** Unique across tables, e.g. `steel-msg:16`. */
  id: string;
  label: string;
  thicknessMm: number;
}

function inchGauges(
  table: SheetMetalGaugeTableId,
  rows: readonly (readonly [number, number])[]
): SheetMetalGauge[] {
  return rows.map(([gauge, inches]) => ({
    id: `${table}:${gauge}`,
    label: `${gauge} ga (${inches.toFixed(4)} in)`,
    thicknessMm: Math.round(inches * 25.4 * 1e4) / 1e4
  }));
}

/** Nominal thicknesses; mills supply within a tolerance band around these. */
export const SHEET_METAL_GAUGE_TABLES: Readonly<
  Record<SheetMetalGaugeTableId, readonly SheetMetalGauge[]>
> = {
  'steel-msg': inchGauges('steel-msg', [
    [10, 0.1345],
    [11, 0.1196],
    [12, 0.1046],
    [14, 0.0747],
    [16, 0.0598],
    [18, 0.0478],
    [20, 0.0359],
    [22, 0.0299],
    [24, 0.0239]
  ]),
  stainless: inchGauges('stainless', [
    [10, 0.1406],
    [11, 0.125],
    [12, 0.1094],
    [14, 0.0781],
    [16, 0.0625],
    [18, 0.05],
    [20, 0.0375],
    [22, 0.0312],
    [24, 0.025]
  ]),
  'aluminium-bs': inchGauges('aluminium-bs', [
    [10, 0.1019],
    [12, 0.0808],
    [14, 0.0641],
    [16, 0.0508],
    [18, 0.0403],
    [20, 0.032],
    [22, 0.0253]
  ]),
  metric: [0.5, 0.8, 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6].map((mm) => ({
    id: `metric:${mm}`,
    label: `${mm} mm`,
    thicknessMm: mm
  }))
};

export function sheetMetalGaugeById(id: string): SheetMetalGauge | null {
  const table = id.split(':')[0] as SheetMetalGaugeTableId;
  return (
    SHEET_METAL_GAUGE_TABLES[table]?.find((gauge) => gauge.id === id) ?? null
  );
}

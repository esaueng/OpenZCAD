/**
 * M01 (schema v65): standard hole sizes for screws, ISO metric and ANSI
 * (Unified inch), as clearance holes and as tap drills.
 *
 * - ISO clearance holes: ISO 273, fine / medium / coarse series, here the
 *   close / normal / loose fits, in millimetres.
 * - ISO tap drills: the ISO 2306 drill for each ISO 261 coarse thread, in
 *   millimetres (about `D − P`).
 * - ANSI clearance holes: the close and free (normal) fit drills of the
 *   common machinist's table for Unified screws, in inches; that table has
 *   no loose fit.
 * - ANSI tap drills: the drill for a 75% thread in each UNC size, in inches.
 *
 * Each table carries its standard's own columns and units, so a typo in one
 * shows against the thread it is for (a tap drill falls between the basic
 * minor diameter `D − 1.0825 P` and `D − P / 2`; a clearance hole clears the
 * nominal size, each fit wider than the one before), which the tests check.
 */
import type { HoleStandard, HoleTapped, UnitSystem } from './index';
import { millimetresPerUnit } from './index';

/** A screw thread standard a hole may be sized by. */
export type HoleStandardSystem = 'iso' | 'ansi';
/** What the hole is for: a screw to pass through, or a thread to be tapped. */
export type HoleStandardKind = 'clearance' | 'tap-drill';
/** How freely a clearance hole takes its screw. */
export type HoleClearanceFit = 'close' | 'normal' | 'loose';

/** ISO 261 coarse sizes with an ISO 273 clearance and ISO 2306 tap drill. */
export const ISO_HOLE_SIZES = [
  'M1.6',
  'M2',
  'M2.5',
  'M3',
  'M3.5',
  'M4',
  'M5',
  'M6',
  'M8',
  'M10',
  'M12',
  'M14',
  'M16',
  'M18',
  'M20',
  'M22',
  'M24',
  'M27',
  'M30',
  'M33',
  'M36'
] as const;
export type IsoHoleSize = (typeof ISO_HOLE_SIZES)[number];

/** UNC sizes, numbered and fractional, in the order of their diameters. */
export const ANSI_HOLE_SIZES = [
  '#0',
  '#1',
  '#2',
  '#3',
  '#4',
  '#5',
  '#6',
  '#8',
  '#10',
  '#12',
  '1/4',
  '5/16',
  '3/8',
  '7/16',
  '1/2',
  '5/8',
  '3/4',
  '7/8',
  '1'
] as const;
export type AnsiHoleSize = (typeof ANSI_HOLE_SIZES)[number];

/**
 * ISO, millimetres: nominal diameter, coarse pitch (ISO 261), the ISO 2306
 * tap drill, and the ISO 273 clearance holes, fine / medium / coarse.
 */
const ISO: Record<
  IsoHoleSize,
  readonly [
    nominal: number,
    pitch: number,
    tapDrill: number,
    close: number,
    normal: number,
    loose: number
  ]
> = {
  'M1.6': [1.6, 0.35, 1.25, 1.7, 1.8, 2],
  M2: [2, 0.4, 1.6, 2.2, 2.4, 2.6],
  'M2.5': [2.5, 0.45, 2.05, 2.7, 2.9, 3.1],
  M3: [3, 0.5, 2.5, 3.2, 3.4, 3.6],
  'M3.5': [3.5, 0.6, 2.9, 3.7, 3.9, 4.2],
  M4: [4, 0.7, 3.3, 4.3, 4.5, 4.8],
  M5: [5, 0.8, 4.2, 5.3, 5.5, 5.8],
  M6: [6, 1, 5, 6.4, 6.6, 7],
  M8: [8, 1.25, 6.8, 8.4, 9, 10],
  M10: [10, 1.5, 8.5, 10.5, 11, 12],
  M12: [12, 1.75, 10.2, 13, 13.5, 14.5],
  M14: [14, 2, 12, 15, 15.5, 16.5],
  M16: [16, 2, 14, 17, 17.5, 18.5],
  M18: [18, 2.5, 15.5, 19, 20, 21],
  M20: [20, 2.5, 17.5, 21, 22, 24],
  M22: [22, 2.5, 19.5, 23, 24, 26],
  M24: [24, 3, 21, 25, 26, 28],
  M27: [27, 3, 24, 28, 30, 32],
  M30: [30, 3.5, 26.5, 31, 33, 35],
  M33: [33, 3.5, 29.5, 34, 36, 38],
  M36: [36, 4, 32, 37, 39, 42]
};

/**
 * ANSI, inches: basic major diameter, UNC threads per inch, the 75% tap
 * drill and the close and free-fit clearance drills.
 */
const ANSI: Record<
  AnsiHoleSize,
  readonly [
    major: number,
    tpi: number,
    tapDrill: number,
    close: number,
    normal: number
  ]
> = {
  '#0': [0.06, 80, 0.0469, 0.0635, 0.07],
  '#1': [0.073, 64, 0.0595, 0.076, 0.081],
  '#2': [0.086, 56, 0.07, 0.089, 0.096],
  '#3': [0.099, 48, 0.0785, 0.104, 0.11],
  '#4': [0.112, 40, 0.089, 0.116, 0.1285],
  '#5': [0.125, 40, 0.1015, 0.1285, 0.136],
  '#6': [0.138, 32, 0.1065, 0.144, 0.1495],
  '#8': [0.164, 32, 0.136, 0.1695, 0.177],
  '#10': [0.19, 24, 0.1495, 0.196, 0.201],
  '#12': [0.216, 24, 0.177, 0.221, 0.228],
  '1/4': [0.25, 20, 0.201, 0.257, 0.266],
  '5/16': [0.3125, 18, 0.257, 0.323, 0.332],
  '3/8': [0.375, 16, 0.3125, 0.386, 0.397],
  '7/16': [0.4375, 14, 0.368, 0.4531, 0.4687],
  '1/2': [0.5, 13, 0.4219, 0.5156, 0.5312],
  '5/8': [0.625, 11, 0.5312, 0.6406, 0.6562],
  '3/4': [0.75, 10, 0.6562, 0.7656, 0.7812],
  '7/8': [0.875, 9, 0.7656, 0.8906, 0.9062],
  '1': [1, 8, 0.875, 1.0156, 1.0312]
};

const MM_PER_INCH = 25.4;

/** A standard size's thread, in millimetres: major diameter and pitch. */
export interface HoleStandardThread {
  majorDiameterMm: number;
  pitchMm: number;
}

function isIsoSize(size: unknown): size is IsoHoleSize {
  return typeof size === 'string' && Object.hasOwn(ISO, size);
}

function isAnsiSize(size: unknown): size is AnsiHoleSize {
  return typeof size === 'string' && Object.hasOwn(ANSI, size);
}

/**
 * Why a hole's standard cannot be stored, else null: a known system, a size
 * of that system, a kind, and a fit only on a clearance hole and only one
 * the system's table has.
 */
export function holeStandardProblem(standard: unknown): string | null {
  if (standard === undefined) return null;
  if (!standard || typeof standard !== 'object' || Array.isArray(standard)) {
    return 'A standard hole needs its system, size and kind.';
  }
  const { system, size, kind, fit } = standard as Partial<HoleStandard>;
  if (system !== 'iso' && system !== 'ansi') {
    return 'A standard hole is ISO metric or ANSI inch.';
  }
  if (system === 'iso' ? !isIsoSize(size) : !isAnsiSize(size)) {
    return `${String(size)} is not an ${system === 'iso' ? 'ISO metric' : 'ANSI inch'} size.`;
  }
  if (kind !== 'clearance' && kind !== 'tap-drill') {
    return 'A standard hole is a clearance hole or a tap drill.';
  }
  if (fit !== undefined) {
    if (kind !== 'clearance') {
      return 'Only a clearance hole has a fit.';
    }
    if (fit !== 'close' && fit !== 'normal' && fit !== 'loose') {
      return 'A clearance fit is close, normal or loose.';
    }
    if (system === 'ansi' && fit === 'loose') {
      return 'The ANSI clearance table has close and normal fits only.';
    }
  }
  return null;
}

/** The thread a standard size is for, in millimetres. */
export function holeStandardThread(
  standard: Pick<HoleStandard, 'system' | 'size'>
): HoleStandardThread {
  if (standard.system === 'iso' && isIsoSize(standard.size)) {
    const [nominal, pitch] = ISO[standard.size];
    return { majorDiameterMm: nominal, pitchMm: pitch };
  }
  if (standard.system === 'ansi' && isAnsiSize(standard.size)) {
    const [major, tpi] = ANSI[standard.size];
    return {
      majorDiameterMm: major * MM_PER_INCH,
      pitchMm: MM_PER_INCH / tpi
    };
  }
  throw new Error(holeStandardProblem(standard) ?? 'Unknown hole standard.');
}

/**
 * The hole's diameter its standard gives, in millimetres. A clearance hole
 * without a fit takes the normal one.
 */
export function holeStandardDiameterMm(standard: HoleStandard): number {
  const problem = holeStandardProblem(standard);
  if (problem) throw new Error(problem);
  const fit = standard.fit ?? 'normal';
  if (standard.system === 'iso') {
    const [, , tapDrill, close, normal, loose] =
      ISO[standard.size as IsoHoleSize];
    if (standard.kind === 'tap-drill') return tapDrill;
    return fit === 'close' ? close : fit === 'loose' ? loose : normal;
  }
  const [, , tapDrill, close, normal] = ANSI[standard.size as AnsiHoleSize];
  return (
    (standard.kind === 'tap-drill'
      ? tapDrill
      : fit === 'close'
        ? close
        : normal) * MM_PER_INCH
  );
}

/**
 * How a standard reads in a label: `M6 clearance (normal)`, `M6×1 tap
 * drill`, `1/4-20 UNC tap drill`, `#10 clearance (close)`.
 */
export function holeStandardLabel(standard: HoleStandard): string {
  const thread =
    standard.system === 'iso'
      ? standard.kind === 'tap-drill'
        ? `${standard.size}×${ISO[standard.size as IsoHoleSize]?.[1] ?? '?'}`
        : standard.size
      : standard.kind === 'tap-drill'
        ? `${standard.size}-${ANSI[standard.size as AnsiHoleSize]?.[1] ?? '?'} UNC`
        : standard.size;
  return standard.kind === 'tap-drill'
    ? `${thread} tap drill`
    : `${thread} clearance (${standard.fit ?? 'normal'})`;
}

/** The hole's diameter its standard gives, in `units`. */
export function holeStandardDiameter(
  standard: HoleStandard,
  units: UnitSystem
): number {
  return holeStandardDiameterMm(standard) / millimetresPerUnit(units);
}

/**
 * The standard a Hole command's choices name, or null for any size (or a
 * combination its table refuses): `standard` is `'iso'` or `'ansi'`, the
 * size and fit are read from that system's own choice.
 */
export function holeStandardFromChoices(choices: {
  readonly standard?: string | undefined;
  readonly isoSize?: string | undefined;
  readonly ansiSize?: string | undefined;
  readonly holeFor?: string | undefined;
  readonly fit?: string | undefined;
  readonly ansiFit?: string | undefined;
}): HoleStandard | null {
  const system = choices.standard;
  if (system !== 'iso' && system !== 'ansi') return null;
  const kind: HoleStandardKind =
    choices.holeFor === 'tap-drill' ? 'tap-drill' : 'clearance';
  const fit = (system === 'iso' ? choices.fit : choices.ansiFit) ?? 'normal';
  const standard: HoleStandard = {
    system,
    size:
      system === 'iso'
        ? (choices.isoSize ?? 'M6')
        : (choices.ansiSize ?? '1/4'),
    kind,
    ...(kind === 'clearance' ? { fit: fit as HoleClearanceFit } : {})
  };
  return holeStandardProblem(standard) === null ? standard : null;
}

/**
 * M01 (schema v66): why a hole's tapping cannot be stored, else null: only a
 * hole sized as a standard tap drill is tapped, by a right or left hand.
 */
export function holeTappedProblem(data: {
  standard?: HoleStandard | undefined;
  tapped?: HoleTapped | undefined;
}): string | null {
  const tapped = data.tapped as unknown;
  if (tapped === undefined) return null;
  if (!tapped || typeof tapped !== 'object' || Array.isArray(tapped)) {
    return 'A tapped hole describes its thread.';
  }
  if (data.standard?.kind !== 'tap-drill') {
    return 'Only a hole sized as a standard tap drill can be tapped.';
  }
  const { hand, cosmetic } = tapped as HoleTapped;
  if (hand !== undefined && hand !== 'right' && hand !== 'left') {
    return "A tapped hole's thread is right- or left-handed.";
  }
  if (cosmetic !== undefined && cosmetic !== true) {
    return 'A cosmetic thread is marked true or left out.';
  }
  return null;
}

/**
 * M01: what a drawing, a callout or an export reads about a hole: its bore,
 * its standard and its thread, cut or cosmetic, in document units. Built
 * from the stored hole by document-core's `holeCallout`.
 */
export interface HoleCallout {
  /** How many bores the hole drills (its sketch points), at least 1. */
  count: number;
  /** The bore's diameter. */
  diameter: number;
  /** The bore's depth from the entry face; null drills through. */
  depth: number | null;
  style: 'simple' | 'counterbore' | 'countersink';
  /** The standard size it is drilled to, if any. */
  standard?: HoleStandard;
  /** The thread tapped into it, if any. */
  thread?: {
    /** `M6×1`, `1/4-20 UNC`. */
    designation: string;
    majorDiameter: number;
    pitch: number;
    /** From the entry end; null runs the whole bore. */
    length: number | null;
    hand: 'right' | 'left';
    /** Described, not cut: the bore is still its tap drill. */
    cosmetic: boolean;
  };
}

/** A standard size's thread as a drawing names it: `M6×1`, `1/4-20 UNC`. */
export function holeThreadDesignation(
  standard: Pick<HoleStandard, 'system' | 'size'>
): string {
  return standard.system === 'iso'
    ? `${standard.size}×${ISO[standard.size as IsoHoleSize]?.[1] ?? '?'}`
    : `${standard.size}-${ANSI[standard.size as AnsiHoleSize]?.[1] ?? '?'} UNC`;
}

/**
 * The callout a drawing writes for a hole, numbers formatted by `format`
 * (the drawing's precision): `M6×1 THRU`, `3× M6×1 × 8 DEEP, Ø5 × 12 DEEP`,
 * `Ø6.6 THRU, M6 CLEARANCE`, `Ø5 × 12 DEEP, M6×1 TAP DRILL`; a left-hand
 * thread adds `LH`, a cosmetic one is called out the same as a cut one.
 */
export function holeCalloutLabel(
  callout: HoleCallout,
  format: (value: number) => string
): string {
  const count = callout.count > 1 ? `${callout.count}× ` : '';
  const extent = (depth: number | null) =>
    depth === null ? ' THRU' : ` × ${format(depth)} DEEP`;
  const bore = `Ø${format(callout.diameter)}${extent(callout.depth)}`;
  const { thread, standard } = callout;
  if (thread) {
    const hand = thread.hand === 'left' ? ' LH' : '';
    // A thread the whole bore needs no second extent unless the bore is
    // blind: then the tap drill's depth is the bore's.
    if (thread.length === null) {
      return `${count}${thread.designation}${hand}${extent(callout.depth)}`;
    }
    return `${count}${thread.designation}${hand} × ${format(thread.length)} DEEP, ${bore}`;
  }
  if (standard) {
    const name =
      standard.kind === 'tap-drill'
        ? `${holeThreadDesignation(standard)} TAP DRILL`
        : `${standard.size} CLEARANCE`;
    return `${count}${bore}, ${name}`;
  }
  return `${count}${bore}`;
}

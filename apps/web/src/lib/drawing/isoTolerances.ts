import type { DrawingIsoLinearClass, DrawingFitClass } from '@openzcad/shared';

/**
 * D07 slice B: the tolerance tables a drawing prints from, in micrometres or
 * millimetres as the standards state them.
 *
 * - ISO 286-1:2010 table 1 (standard tolerance grades IT5–IT11) and tables
 *   2–3 (fundamental deviations), for the fit classes whose limits follow
 *   from the tables alone: holes F, G, H and JS; shafts f, g, h, js, k, m, n
 *   and p, nominal sizes over 0 up to 500 mm. Holes K to ZC need the Δ
 *   correction and shafts r to zc subdivided size ranges; the schema
 *   refuses them rather than print a guessed limit.
 * - ISO 2768-1:1989 tables 1 and 3: general tolerances for linear and
 *   angular dimensions in classes f, m, c and v.
 */

/** Upper bounds (mm, inclusive) of ISO 286 nominal size ranges. */
const SIZE_STEPS = [3, 6, 10, 18, 30, 50, 80, 120, 180, 250, 315, 400, 500];

/** ISO 286-1 table 1, µm, by grade then size range. */
const IT: Readonly<Record<number, readonly number[]>> = {
  5: [4, 5, 6, 8, 9, 11, 13, 15, 18, 20, 23, 25, 27],
  6: [6, 8, 9, 11, 13, 16, 19, 22, 25, 29, 32, 36, 40],
  7: [10, 12, 15, 18, 21, 25, 30, 35, 40, 46, 52, 57, 63],
  8: [14, 18, 22, 27, 33, 39, 46, 54, 63, 72, 81, 89, 97],
  9: [25, 30, 36, 43, 52, 62, 74, 87, 100, 115, 130, 140, 155],
  10: [40, 48, 58, 70, 84, 100, 120, 140, 160, 185, 210, 230, 250],
  11: [60, 75, 90, 110, 130, 160, 190, 220, 250, 290, 320, 360, 400]
};

/** ISO 286-1 table 2: upper deviation es of shafts f and g, µm. */
const SHAFT_UPPER: Readonly<Record<'f' | 'g', readonly number[]>> = {
  f: [-6, -10, -13, -16, -20, -25, -30, -36, -43, -50, -56, -62, -68],
  g: [-2, -4, -5, -6, -7, -9, -10, -12, -14, -15, -17, -18, -20]
};

/** ISO 286-1 table 3: lower deviation ei of shafts m, n and p, µm. */
const SHAFT_LOWER: Readonly<Record<'m' | 'n' | 'p', readonly number[]>> = {
  m: [2, 4, 6, 7, 8, 9, 11, 13, 15, 17, 20, 21, 23],
  n: [4, 8, 10, 12, 15, 17, 20, 23, 27, 31, 34, 37, 40],
  p: [6, 12, 15, 18, 22, 26, 32, 37, 43, 50, 56, 62, 68]
};

/** Shaft k's ei for grades IT4–IT7 (0 above IT7 and up to 3 mm), µm. */
const K_LOWER = [0, 1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5];

/** The ISO 286 fit classes the tables above state. */
export const FIT_LETTERS = {
  hole: ['F', 'G', 'H', 'JS'],
  shaft: ['f', 'g', 'h', 'js', 'k', 'm', 'n', 'p']
} as const;
export const FIT_GRADES = [5, 6, 7, 8, 9, 10, 11] as const;

export function parseFitClass(fit: DrawingFitClass): {
  letter: string;
  grade: number;
} {
  const match = /^([A-Za-z]+)(\d+)$/.exec(fit)!;
  return { letter: match[1]!, grade: Number(match[2]) };
}

/**
 * The limit deviations of `fit` on a nominal size in millimetres, in
 * millimetres (upper over lower), or null outside the tables (a size of 0,
 * or over 500 mm).
 */
export function fitDeviations(
  fit: DrawingFitClass,
  nominalMm: number
): { upper: number; lower: number } | null {
  if (!(nominalMm > 0) || nominalMm > 500 + 1e-9) return null;
  const range = SIZE_STEPS.findIndex((step) => nominalMm <= step + 1e-9);
  const { letter, grade } = parseFitClass(fit);
  const it = IT[grade]?.[range];
  if (it === undefined) return null;
  let upper: number;
  let lower: number;
  switch (letter) {
    case 'H':
      [lower, upper] = [0, it];
      break;
    case 'h':
      [upper, lower] = [0, -it];
      break;
    case 'F':
    case 'G': {
      // Holes A–H mirror their shafts: EI = −es (ISO 286-1 table 3).
      lower = -SHAFT_UPPER[letter === 'F' ? 'f' : 'g'][range]!;
      upper = lower + it;
      break;
    }
    case 'f':
    case 'g':
      upper = SHAFT_UPPER[letter][range]!;
      lower = upper - it;
      break;
    case 'JS':
    case 'js': {
      // ±IT/2; for IT7–IT11 an odd value in µm is first rounded down to
      // the even value below it (ISO 286-1 table 2, note 2).
      const even = grade >= 7 && it % 2 === 1 ? it - 1 : it;
      [upper, lower] = [even / 2, -even / 2];
      break;
    }
    case 'k':
      lower = grade <= 7 ? K_LOWER[range]! : 0;
      upper = lower + it;
      break;
    case 'm':
    case 'n':
    case 'p':
      lower = SHAFT_LOWER[letter][range]!;
      upper = lower + it;
      break;
    default:
      return null;
  }
  // µm to mm, exact to the micrometre (or half of one).
  const mm = (value: number) => Math.round(value * 10) / 10000;
  return { upper: mm(upper), lower: mm(lower) };
}

/** ISO 2768-1 table 1 range bounds, mm: over the first up to the second. */
export const ISO_2768_LINEAR_RANGES: readonly (readonly [number, number])[] = [
  [0.5, 3],
  [3, 6],
  [6, 30],
  [30, 120],
  [120, 400],
  [400, 1000],
  [1000, 2000],
  [2000, 4000]
];

/** ISO 2768-1 table 1: ± permissible deviation, mm; null where none. */
export const ISO_2768_LINEAR: Readonly<
  Record<DrawingIsoLinearClass, readonly (number | null)[]>
> = {
  f: [0.05, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, null],
  m: [0.1, 0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 2],
  c: [0.2, 0.3, 0.5, 0.8, 1.2, 2, 3, 4],
  v: [null, 0.5, 1, 1.5, 2.5, 4, 6, 8]
};

/** ISO 2768-1 table 3 shorter-side bounds, mm: up to 10, …, over 400. */
export const ISO_2768_ANGULAR_RANGES: readonly (readonly [
  number | null,
  number | null
])[] = [
  [null, 10],
  [10, 50],
  [50, 120],
  [120, 400],
  [400, null]
];

/** ISO 2768-1 table 3: ± permissible deviation, in minutes of arc. */
export const ISO_2768_ANGULAR: Readonly<
  Record<DrawingIsoLinearClass, readonly number[]>
> = {
  f: [60, 30, 20, 10, 5],
  m: [60, 30, 20, 10, 5],
  c: [90, 60, 30, 15, 10],
  v: [180, 120, 60, 30, 20]
};

/** Minutes of arc as ISO 2768 prints them: 1°, 0°30', 1°30'. */
export function formatArcMinutes(minutes: number): string {
  const degrees = Math.floor(minutes / 60);
  const rest = minutes - degrees * 60;
  return rest === 0 ? `${degrees}°` : `${degrees}°${rest}'`;
}

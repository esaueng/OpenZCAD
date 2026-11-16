/**
 * M17 (schema v69): the standard parts catalogue. Parametric ISO metric and
 * ANSI inch screws, nuts, washers, threaded inserts, dowel pins and deep
 * groove ball bearings, each a size row of its standard's own table, in the
 * standard's own units. The exact geometry is generated from these rows by
 * the kernel adapter (`exact-standard-part.ts`): revolved blanks, M15
 * threads and M14 gear-tooth knurls, never imported meshes.
 *
 * Sources, by part:
 * - Socket head cap screws: ISO 4762 (head diameter `dk` max, head height
 *   `k` max, hex key `s`, key engagement `t` min) and ASME B18.3 (UNC, head
 *   diameter, head height = D, hex key). ASME B18.3 gives no key depth in
 *   the same form; half the head height is used, an approximation.
 * - Hex head screws: ISO 4017 (fully threaded; across flats `s`, head
 *   height `k`) and ASME B18.2.1 finished hex cap screws (1/4 and up).
 * - Countersunk socket screws: ISO 10642 (90°, theoretical sharp head
 *   diameter `dk`, key `s`) and ASME B18.3 flat head (82°).
 * - Hex nuts: ISO 4032 (style 1; `s`, `m`), ASME B18.2.2 finished hex nuts
 *   (1/4 and up) and ASME B18.6.3 machine screw nuts (#2 to #12).
 * - Plain washers: ISO 7089 (normal series; `d1`, `d2`, `h`) and ASME
 *   B18.22.1 type A, N (narrow) series.
 * - Threaded inserts: heat-set inserts for plastics. No standard fixes their
 *   outside; these rows are typical catalogue sizes and are labelled so.
 * - Dowel pins: ISO 8734 (hardened) and ASME B18.8.2 (hardened ground)
 *   diameters; both ends take a 45° chamfer of an eighth of the diameter,
 *   an approximation of the standards' chamfer and crown.
 * - Ball bearings: ISO 15 boundary dimensions (`d`, `D`, `B`) of the 60, 62,
 *   68 and 6x miniature series, and the ABMA R series in inches. The balls
 *   and raceways are not standardized: ball diameter 0.3 (D − d), on the
 *   pitch circle (D + d) / 2, as many as fit 1.6 ball diameters apart, an
 *   approximation that keeps the outside exact.
 *
 * Every table's typo shows against its own thread or neighbour, which the
 * tests check (a nut wider than its screw head key, a washer bore over the
 * nominal, sizes increasing, rings that enclose their balls).
 */
import { holeStandardThread, type HoleStandardSystem } from './hole-standards';

/** What a standard part is. */
export type StandardPartKind =
  'screw' | 'nut' | 'washer' | 'insert' | 'dowel' | 'bearing';
/** A screw's head. */
export type StandardScrewHead = 'socket' | 'hex' | 'countersunk';
/** ISO metric or ANSI inch, as for hole standards. */
export type StandardPartSystem = HoleStandardSystem;

export const STANDARD_PART_KINDS: readonly StandardPartKind[] = [
  'screw',
  'nut',
  'washer',
  'insert',
  'dowel',
  'bearing'
];
export const STANDARD_SCREW_HEADS: readonly StandardScrewHead[] = [
  'socket',
  'hex',
  'countersunk'
];

const MM_PER_INCH = 25.4;

// ---------------------------------------------------------------------------
// Tables. ISO rows in millimetres, ANSI rows in inches.

/** ISO 4762: dk, k, s, t. */
const ISO_SOCKET = {
  M2: [3.8, 2, 1.5, 1],
  'M2.5': [4.5, 2.5, 2, 1.1],
  M3: [5.5, 3, 2.5, 1.3],
  M4: [7, 4, 3, 2],
  M5: [8.5, 5, 4, 2.5],
  M6: [10, 6, 5, 3],
  M8: [13, 8, 6, 4],
  M10: [16, 10, 8, 5],
  M12: [18, 12, 10, 6],
  M16: [24, 16, 14, 8],
  M20: [30, 20, 17, 10],
  M24: [36, 24, 19, 12]
} as const satisfies Record<string, readonly [number, number, number, number]>;

/** ASME B18.3 socket head cap screws: head diameter, head height, key. */
const ANSI_SOCKET = {
  '#2': [0.14, 0.086, 0.0781],
  '#4': [0.183, 0.112, 0.0938],
  '#6': [0.226, 0.138, 0.1094],
  '#8': [0.27, 0.164, 0.1406],
  '#10': [0.312, 0.19, 0.1562],
  '1/4': [0.375, 0.25, 0.1875],
  '5/16': [0.469, 0.312, 0.25],
  '3/8': [0.562, 0.375, 0.3125],
  '1/2': [0.75, 0.5, 0.375],
  '5/8': [0.938, 0.625, 0.5],
  '3/4': [1.125, 0.75, 0.625],
  '1': [1.5, 1, 0.75]
} as const satisfies Record<string, readonly [number, number, number]>;

/** ISO 4017: s, k. */
const ISO_HEX = {
  M2: [4, 1.4],
  'M2.5': [5, 1.7],
  M3: [5.5, 2],
  M4: [7, 2.8],
  M5: [8, 3.5],
  M6: [10, 4],
  M8: [13, 5.3],
  M10: [16, 6.4],
  M12: [18, 7.5],
  M16: [24, 10],
  M20: [30, 12.5],
  M24: [36, 15]
} as const satisfies Record<string, readonly [number, number]>;

/** ASME B18.2.1 finished hex cap screws: across flats, head height. */
const ANSI_HEX = {
  '1/4': [0.4375, 0.1562],
  '5/16': [0.5, 0.2031],
  '3/8': [0.5625, 0.2344],
  '7/16': [0.625, 0.2812],
  '1/2': [0.75, 0.3125],
  '5/8': [0.9375, 0.3906],
  '3/4': [1.125, 0.4688],
  '7/8': [1.3125, 0.5469],
  '1': [1.5, 0.6094]
} as const satisfies Record<string, readonly [number, number]>;

/** ISO 10642 (90°): dk, s, t. */
const ISO_COUNTERSUNK = {
  M3: [6.72, 2, 1.1],
  M4: [8.96, 2.5, 1.5],
  M5: [11.2, 3, 1.9],
  M6: [13.44, 4, 2.2],
  M8: [17.92, 5, 3],
  M10: [22.4, 6, 3.6],
  M12: [26.88, 8, 4.3],
  M16: [33.6, 10, 4.8],
  M20: [40.32, 12, 5.6]
} as const satisfies Record<string, readonly [number, number, number]>;

/** ASME B18.3 flat head socket cap screws (82°): head diameter, key. */
const ANSI_COUNTERSUNK = {
  '#4': [0.255, 0.0625],
  '#6': [0.307, 0.0781],
  '#8': [0.359, 0.0938],
  '#10': [0.411, 0.125],
  '1/4': [0.531, 0.1562],
  '5/16': [0.656, 0.1875],
  '3/8': [0.781, 0.2188],
  '1/2': [1.031, 0.3125]
} as const satisfies Record<string, readonly [number, number]>;

/** ISO 4032: s, m. */
const ISO_NUT = {
  M2: [4, 1.6],
  'M2.5': [5, 2],
  M3: [5.5, 2.4],
  M4: [7, 3.2],
  M5: [8, 4.7],
  M6: [10, 5.2],
  M8: [13, 6.8],
  M10: [16, 8.4],
  M12: [18, 10.8],
  M16: [24, 14.8],
  M20: [30, 18],
  M24: [36, 21.5]
} as const satisfies Record<string, readonly [number, number]>;

/** ASME B18.6.3 (numbered) and B18.2.2 hex nuts: across flats, height. */
const ANSI_NUT = {
  '#2': [0.1875, 0.0625],
  '#4': [0.25, 0.0938],
  '#6': [0.3125, 0.1094],
  '#8': [0.3438, 0.125],
  '#10': [0.375, 0.125],
  '1/4': [0.4375, 0.2188],
  '5/16': [0.5, 0.2656],
  '3/8': [0.5625, 0.3281],
  '7/16': [0.6875, 0.375],
  '1/2': [0.75, 0.4375],
  '5/8': [0.9375, 0.5469],
  '3/4': [1.125, 0.6406],
  '7/8': [1.3125, 0.75],
  '1': [1.5, 0.8594]
} as const satisfies Record<string, readonly [number, number]>;

/** ISO 7089: d1, d2, h. */
const ISO_WASHER = {
  M2: [2.2, 5, 0.3],
  'M2.5': [2.7, 6, 0.5],
  M3: [3.2, 7, 0.5],
  M4: [4.3, 9, 0.8],
  M5: [5.3, 10, 1],
  M6: [6.4, 12, 1.6],
  M8: [8.4, 16, 1.6],
  M10: [10.5, 20, 2],
  M12: [13, 24, 2.5],
  M16: [17, 30, 3],
  M20: [21, 37, 3],
  M24: [25, 44, 4]
} as const satisfies Record<string, readonly [number, number, number]>;

/** ASME B18.22.1 type A, N series: inside, outside, thickness. */
const ANSI_WASHER = {
  '#6': [0.156, 0.375, 0.049],
  '#8': [0.188, 0.438, 0.049],
  '#10': [0.219, 0.5, 0.049],
  '1/4': [0.281, 0.625, 0.065],
  '5/16': [0.344, 0.688, 0.065],
  '3/8': [0.406, 0.812, 0.065],
  '7/16': [0.469, 0.922, 0.065],
  '1/2': [0.531, 1.062, 0.095],
  '5/8': [0.656, 1.312, 0.095],
  '3/4': [0.812, 1.469, 0.134],
  '7/8': [0.938, 1.75, 0.134],
  '1': [1.062, 2, 0.134]
} as const satisfies Record<string, readonly [number, number, number]>;

/** Typical heat-set inserts, millimetres: outside, length. */
const ISO_INSERT = {
  M2: [3.6, 4],
  'M2.5': [4, 5],
  M3: [4.6, 5.7],
  M4: [5.6, 8.1],
  M5: [6.4, 9.5],
  M6: [8, 12.7],
  M8: [10, 12.7]
} as const satisfies Record<string, readonly [number, number]>;

/** Typical heat-set inserts, inches: outside, length. */
const ANSI_INSERT = {
  '#2': [0.142, 0.157],
  '#4': [0.18, 0.25],
  '#6': [0.213, 0.3],
  '#8': [0.25, 0.32],
  '#10': [0.29, 0.38],
  '1/4': [0.36, 0.5]
} as const satisfies Record<string, readonly [number, number]>;

/** ISO 8734 nominal diameters, millimetres. */
const ISO_DOWEL = {
  '1': 1,
  '1.5': 1.5,
  '2': 2,
  '2.5': 2.5,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '8': 8,
  '10': 10,
  '12': 12,
  '16': 16,
  '20': 20
} as const satisfies Record<string, number>;

/** ASME B18.8.2 nominal diameters, inches. */
const ANSI_DOWEL = {
  '1/16': 0.0625,
  '3/32': 0.0938,
  '1/8': 0.125,
  '5/32': 0.1562,
  '3/16': 0.1875,
  '1/4': 0.25,
  '5/16': 0.3125,
  '3/8': 0.375,
  '7/16': 0.4375,
  '1/2': 0.5,
  '5/8': 0.625,
  '3/4': 0.75,
  '1': 1
} as const satisfies Record<string, number>;

/** ISO 15 deep groove ball bearings: d, D, B, millimetres. */
const ISO_BEARING = {
  '623': [3, 10, 4],
  '624': [4, 13, 5],
  '625': [5, 16, 5],
  '626': [6, 19, 6],
  '688': [8, 16, 5],
  '608': [8, 22, 7],
  '609': [9, 24, 7],
  '6800': [10, 19, 5],
  '6000': [10, 26, 8],
  '6200': [10, 30, 9],
  '6001': [12, 28, 8],
  '6201': [12, 32, 10],
  '6002': [15, 32, 9],
  '6202': [15, 35, 11],
  '6003': [17, 35, 10],
  '6203': [17, 40, 12],
  '6004': [20, 42, 12],
  '6204': [20, 47, 14],
  '6205': [25, 52, 15]
} as const satisfies Record<string, readonly [number, number, number]>;

/** ABMA R series deep groove ball bearings: d, D, B, inches. */
const ANSI_BEARING = {
  R2: [0.125, 0.375, 0.1562],
  R3: [0.1875, 0.5, 0.1562],
  R4: [0.25, 0.625, 0.196],
  R6: [0.375, 0.875, 0.2188],
  R8: [0.5, 1.125, 0.25],
  R10: [0.625, 1.375, 0.2812],
  R12: [0.75, 1.625, 0.4375]
} as const satisfies Record<string, readonly [number, number, number]>;

// ---------------------------------------------------------------------------
// Sizes.

type KeysOf<T> = Extract<keyof T, string>;

type CatalogueTable =
  | typeof ISO_SOCKET
  | typeof ANSI_SOCKET
  | typeof ISO_HEX
  | typeof ANSI_HEX
  | typeof ISO_COUNTERSUNK
  | typeof ANSI_COUNTERSUNK
  | typeof ISO_NUT
  | typeof ANSI_NUT
  | typeof ISO_WASHER
  | typeof ANSI_WASHER
  | typeof ISO_INSERT
  | typeof ANSI_INSERT
  | typeof ISO_DOWEL
  | typeof ANSI_DOWEL
  | typeof ISO_BEARING
  | typeof ANSI_BEARING;

/** Every size string any catalogue row uses; the feature's `size` enum. */
export type StandardPartSize = CatalogueTable extends infer T
  ? T extends unknown
    ? KeysOf<T>
    : never
  : never;

function tableOf(
  kind: StandardPartKind,
  system: StandardPartSystem,
  head: StandardScrewHead
): Readonly<Record<string, unknown>> {
  const iso = system === 'iso';
  switch (kind) {
    case 'screw':
      return head === 'hex'
        ? iso
          ? ISO_HEX
          : ANSI_HEX
        : head === 'countersunk'
          ? iso
            ? ISO_COUNTERSUNK
            : ANSI_COUNTERSUNK
          : iso
            ? ISO_SOCKET
            : ANSI_SOCKET;
    case 'nut':
      return iso ? ISO_NUT : ANSI_NUT;
    case 'washer':
      return iso ? ISO_WASHER : ANSI_WASHER;
    case 'insert':
      return iso ? ISO_INSERT : ANSI_INSERT;
    case 'dowel':
      return iso ? ISO_DOWEL : ANSI_DOWEL;
    case 'bearing':
      return iso ? ISO_BEARING : ANSI_BEARING;
  }
}

/**
 * The sizes a part's table lists, smallest first: by nominal diameter, and a
 * bearing by bore, then outside. (An object's integer-like keys, `'6'` or
 * `'608'`, do not keep their written order, so the order is computed.)
 */
export function standardPartSizes(
  kind: StandardPartKind,
  system: StandardPartSystem,
  head: StandardScrewHead = 'socket'
): readonly StandardPartSize[] {
  const table = tableOf(kind, system, head);
  const nominal = (size: string): [number, number] => {
    const row = table[size];
    if (kind === 'dowel') return [row as number, 0];
    if (kind === 'bearing') {
      const [d, D] = row as readonly number[];
      return [d!, D!];
    }
    const thread = holeStandardThread({
      system,
      size
    });
    return [thread.majorDiameterMm, 0];
  };
  return (Object.keys(table) as StandardPartSize[]).sort((a, b) => {
    const [a0, a1] = nominal(a);
    const [b0, b1] = nominal(b);
    return a0 - b0 || a1 - b1;
  });
}

/** Every size any table lists (the feature's `size` enum). */
export const STANDARD_PART_SIZES: ReadonlySet<string> = new Set(
  STANDARD_PART_KINDS.flatMap((kind) =>
    (['iso', 'ansi'] as const).flatMap((system) =>
      STANDARD_SCREW_HEADS.flatMap((head) =>
        standardPartSizes(kind, system, head)
      )
    )
  )
);

/** What identifies a standard part's row and length. */
export interface StandardPartChoice {
  partKind: StandardPartKind;
  system: StandardPartSystem;
  size: string;
  /** Screws only; absent is `'socket'`. */
  head?: StandardScrewHead;
}

/** Screws and dowel pins have a length; the others take their table's. */
export function standardPartHasLength(kind: StandardPartKind): boolean {
  return kind === 'screw' || kind === 'dowel';
}

/** Whether a part's bore or shank is threaded (and so has a thread size). */
export function standardPartIsThreaded(kind: StandardPartKind): boolean {
  return kind === 'screw' || kind === 'nut' || kind === 'insert';
}

/**
 * Why a choice cannot be stored, else null: a known kind and system, a head
 * only on a screw, and a size that kind's table lists.
 */
export function standardPartProblem(choice: unknown): string | null {
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) {
    return 'A standard part needs its kind, system and size.';
  }
  const { partKind, system, size, head } =
    choice as Partial<StandardPartChoice>;
  if (!STANDARD_PART_KINDS.includes(partKind as StandardPartKind)) {
    return `${String(partKind)} is not a standard part.`;
  }
  if (system !== 'iso' && system !== 'ansi') {
    return 'A standard part is ISO metric or ANSI inch.';
  }
  if (head !== undefined) {
    if (partKind !== 'screw') return 'Only a screw has a head.';
    if (!STANDARD_SCREW_HEADS.includes(head)) {
      return 'A screw head is socket, hex or countersunk.';
    }
  }
  const table = tableOf(partKind!, system, head ?? 'socket');
  if (typeof size !== 'string' || !Object.hasOwn(table, size)) {
    return `${String(size)} is not ${system === 'iso' ? 'an ISO' : 'an ANSI'} ${standardPartNoun({ partKind: partKind!, system, size: '', ...(head ? { head } : {}) })} size.`;
  }
  return null;
}

function requireRow(choice: StandardPartChoice): void {
  const problem = standardPartProblem(choice);
  if (problem) throw new Error(problem);
}

// ---------------------------------------------------------------------------
// Dimensions, always in millimetres.

/** A screw thread, millimetres: major diameter and pitch. */
export interface StandardThread {
  majorDiameterMm: number;
  pitchMm: number;
  /** `M6×1`, `1/4-20 UNC`. */
  designation: string;
}

/** The thread a threaded part's size is for. */
export function standardPartThread(choice: StandardPartChoice): StandardThread {
  requireRow(choice);
  const thread = holeStandardThread({
    system: choice.system,
    size: choice.size
  });
  const designation =
    choice.system === 'iso'
      ? `${choice.size}×${formatNumber(thread.pitchMm)}`
      : `${choice.size}-${Math.round(MM_PER_INCH / thread.pitchMm)} UNC`;
  return { ...thread, designation };
}

/** What the generator builds, in millimetres, by part. */
export type StandardPartGeometry =
  | {
      partKind: 'screw';
      head: StandardScrewHead;
      thread: StandardThread;
      /** Socket and hex: across the head (round) or its flats (hex). */
      headDiameterMm: number;
      /** Socket and hex: head height; countersunk: cone height. */
      headHeightMm: number;
      /** Countersunk: the cone's included angle, degrees. */
      headAngleDeg?: number;
      /** Socket and countersunk: hex key across flats and its depth. */
      keyMm?: number;
      keyDepthMm?: number;
      /** The standard's thread length rule for a given nominal length. */
      threadLengthMm(lengthMm: number): number;
    }
  | {
      partKind: 'nut';
      thread: StandardThread;
      acrossFlatsMm: number;
      heightMm: number;
    }
  | {
      partKind: 'washer';
      insideMm: number;
      outsideMm: number;
      thicknessMm: number;
    }
  | {
      partKind: 'insert';
      thread: StandardThread;
      outsideMm: number;
      lengthMm: number;
    }
  | { partKind: 'dowel'; diameterMm: number }
  | {
      partKind: 'bearing';
      boreMm: number;
      outsideMm: number;
      widthMm: number;
      ballDiameterMm: number;
      pitchDiameterMm: number;
      balls: number;
    };

/** A row's dimensions, millimetres. */
export function standardPartGeometry(
  choice: StandardPartChoice
): StandardPartGeometry {
  requireRow(choice);
  const iso = choice.system === 'iso';
  const s = (inches: number) => (iso ? inches : inches * MM_PER_INCH);
  const size = choice.size;
  switch (choice.partKind) {
    case 'screw': {
      const head = choice.head ?? 'socket';
      const thread = standardPartThread(choice);
      const d = thread.majorDiameterMm;
      // ISO 4762 / 10642: b = 2d + 12 below 125 mm; ASME B18.3: 2D + 1/2";
      // ASME B18.2.1 hex cap screws: 2D + 1/4". ISO 4017 is threaded full.
      const b =
        head === 'hex'
          ? iso
            ? Number.POSITIVE_INFINITY
            : 2 * d + 0.25 * MM_PER_INCH
          : iso
            ? 2 * d + 12
            : 2 * d + 0.5 * MM_PER_INCH;
      const threadLengthMm = (lengthMm: number) => Math.min(b, lengthMm);
      if (head === 'hex') {
        const [af, k] = (iso ? ISO_HEX : ANSI_HEX)[
          size as keyof typeof ISO_HEX & keyof typeof ANSI_HEX
        ] as readonly [number, number];
        return {
          partKind: 'screw',
          head,
          thread,
          headDiameterMm: s(af),
          headHeightMm: s(k),
          threadLengthMm
        };
      }
      if (head === 'countersunk') {
        const angle = iso ? 90 : 82;
        const row = (iso ? ISO_COUNTERSUNK : ANSI_COUNTERSUNK)[
          size as keyof typeof ISO_COUNTERSUNK & keyof typeof ANSI_COUNTERSUNK
        ] as readonly number[];
        const dk = s(row[0]!);
        const key = s(row[1]!);
        const coneHeight = (dk - d) / 2 / Math.tan((angle / 2) * DEG);
        return {
          partKind: 'screw',
          head,
          thread,
          headDiameterMm: dk,
          headHeightMm: coneHeight,
          headAngleDeg: angle,
          keyMm: key,
          // ANSI rows carry no key depth: 0.6 of the cone, approximate.
          keyDepthMm: iso ? row[2]! : 0.6 * coneHeight,
          threadLengthMm
        };
      }
      const row = (iso ? ISO_SOCKET : ANSI_SOCKET)[
        size as keyof typeof ISO_SOCKET & keyof typeof ANSI_SOCKET
      ] as readonly number[];
      return {
        partKind: 'screw',
        head,
        thread,
        headDiameterMm: s(row[0]!),
        headHeightMm: s(row[1]!),
        keyMm: s(row[2]!),
        // ANSI rows carry no key depth: half the head, approximate.
        keyDepthMm: iso ? row[3]! : s(row[1]!) / 2,
        threadLengthMm
      };
    }
    case 'nut': {
      const [af, m] = (iso ? ISO_NUT : ANSI_NUT)[
        size as keyof typeof ISO_NUT & keyof typeof ANSI_NUT
      ] as readonly [number, number];
      return {
        partKind: 'nut',
        thread: standardPartThread(choice),
        acrossFlatsMm: s(af),
        heightMm: s(m)
      };
    }
    case 'washer': {
      const [d1, d2, h] = (iso ? ISO_WASHER : ANSI_WASHER)[
        size as keyof typeof ISO_WASHER & keyof typeof ANSI_WASHER
      ] as readonly [number, number, number];
      return {
        partKind: 'washer',
        insideMm: s(d1),
        outsideMm: s(d2),
        thicknessMm: s(h)
      };
    }
    case 'insert': {
      const [od, l] = (iso ? ISO_INSERT : ANSI_INSERT)[
        size as keyof typeof ISO_INSERT & keyof typeof ANSI_INSERT
      ] as readonly [number, number];
      return {
        partKind: 'insert',
        thread: standardPartThread(choice),
        outsideMm: s(od),
        lengthMm: s(l)
      };
    }
    case 'dowel':
      return {
        partKind: 'dowel',
        diameterMm: s(
          (iso ? ISO_DOWEL : ANSI_DOWEL)[
            size as keyof typeof ISO_DOWEL & keyof typeof ANSI_DOWEL
          ]
        )
      };
    case 'bearing': {
      const [d, D, B] = (iso ? ISO_BEARING : ANSI_BEARING)[
        size as keyof typeof ISO_BEARING & keyof typeof ANSI_BEARING
      ] as readonly [number, number, number];
      const bore = s(d);
      const outside = s(D);
      const ball = 0.3 * (outside - bore);
      const pitch = (outside + bore) / 2;
      return {
        partKind: 'bearing',
        boreMm: bore,
        outsideMm: outside,
        widthMm: s(B),
        ballDiameterMm: ball,
        pitchDiameterMm: pitch,
        balls: Math.max(3, Math.floor((Math.PI * pitch) / (1.6 * ball)))
      };
    }
  }
}

const DEG = Math.PI / 180;

/** The overall length along its axis, millimetres, for a given length. */
export function standardPartOverallLengthMm(
  geometry: StandardPartGeometry,
  lengthMm: number | undefined
): number {
  switch (geometry.partKind) {
    case 'screw':
      // A countersunk screw's nominal length includes its head.
      return geometry.head === 'countersunk'
        ? (lengthMm ?? 0)
        : (lengthMm ?? 0) + geometry.headHeightMm;
    case 'nut':
      return geometry.heightMm;
    case 'washer':
      return geometry.thicknessMm;
    case 'insert':
      return geometry.lengthMm;
    case 'dowel':
      return lengthMm ?? 0;
    case 'bearing':
      return geometry.widthMm;
  }
}

/**
 * The shortest length a screw or dowel pin can be built at, millimetres:
 * a screw keeps two pitches of thread between its tip chamfer and the two
 * pitches it leaves plain under its head,
 * a dowel pin more than its two chamfers.
 */
export function standardPartMinimumLengthMm(
  geometry: StandardPartGeometry
): number {
  if (geometry.partKind === 'dowel') return geometry.diameterMm / 2;
  if (geometry.partKind !== 'screw') return 0;
  const { pitchMm } = geometry.thread;
  const head = geometry.head === 'countersunk' ? geometry.headHeightMm : 0;
  return head + 5 * pitchMm;
}

/** Preferred lengths, ISO in mm and ANSI in inches. */
const ISO_LENGTHS = [
  3, 4, 5, 6, 8, 10, 12, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90,
  100, 110, 120, 130, 140, 150, 160, 180, 200
];
const ANSI_LENGTHS = [
  0.125, 0.1875, 0.25, 0.3125, 0.375, 0.5, 0.625, 0.75, 0.875, 1, 1.25, 1.5,
  1.75, 2, 2.25, 2.5, 2.75, 3, 3.5, 4, 4.5, 5, 5.5, 6
];

/**
 * The preferred lengths a screw or dowel pin is offered in, millimetres:
 * the standard series from the shortest buildable length to ten diameters
 * (a commercial range, approximate).
 */
export function standardPartLengthsMm(choice: StandardPartChoice): number[] {
  const geometry = standardPartGeometry(choice);
  if (geometry.partKind !== 'screw' && geometry.partKind !== 'dowel') {
    return [];
  }
  const diameter =
    geometry.partKind === 'screw'
      ? geometry.thread.majorDiameterMm
      : geometry.diameterMm;
  const minimum = standardPartMinimumLengthMm(geometry);
  const series =
    choice.system === 'iso'
      ? ISO_LENGTHS
      : ANSI_LENGTHS.map((inches) => inches * MM_PER_INCH);
  const lengths = series.filter(
    (length) => length >= minimum - 1e-9 && length <= 10 * diameter + 1e-9
  );
  return lengths.length > 0 ? lengths : [series.find((l) => l >= minimum)!];
}

/** A default length: the preferred length nearest three diameters. */
export function standardPartDefaultLengthMm(
  choice: StandardPartChoice
): number | undefined {
  const lengths = standardPartLengthsMm(choice);
  if (lengths.length === 0) return undefined;
  const geometry = standardPartGeometry(choice);
  const diameter =
    geometry.partKind === 'screw'
      ? geometry.thread.majorDiameterMm
      : geometry.partKind === 'dowel'
        ? geometry.diameterMm
        : 0;
  const target = 3 * diameter;
  return lengths.reduce((best, length) =>
    Math.abs(length - target) < Math.abs(best - target) ? length : best
  );
}

// ---------------------------------------------------------------------------
// Names.

const NOUNS: Record<StandardPartKind, string> = {
  screw: 'screw',
  nut: 'hex nut',
  washer: 'plain washer',
  insert: 'heat-set insert',
  dowel: 'dowel pin',
  bearing: 'ball bearing'
};

const HEAD_NOUNS: Record<StandardScrewHead, string> = {
  socket: 'socket head cap screw',
  hex: 'hex head screw',
  countersunk: 'countersunk socket screw'
};

/** `socket head cap screw`, `hex nut`, `ball bearing`. */
export function standardPartNoun(choice: StandardPartChoice): string {
  return choice.partKind === 'screw'
    ? HEAD_NOUNS[choice.head ?? 'socket']
    : NOUNS[choice.partKind];
}

/** The standard a row is from: `ISO 4762`, `ASME B18.3`, `typical`. */
export function standardPartStandard(choice: StandardPartChoice): string {
  const iso = choice.system === 'iso';
  switch (choice.partKind) {
    case 'screw': {
      const head = choice.head ?? 'socket';
      if (head === 'hex') return iso ? 'ISO 4017' : 'ASME B18.2.1';
      if (head === 'countersunk') return iso ? 'ISO 10642' : 'ASME B18.3';
      return iso ? 'ISO 4762' : 'ASME B18.3';
    }
    case 'nut':
      return iso
        ? 'ISO 4032'
        : choice.size.startsWith('#')
          ? 'ASME B18.6.3'
          : 'ASME B18.2.2';
    case 'washer':
      return iso ? 'ISO 7089' : 'ASME B18.22.1';
    case 'insert':
      return 'typical';
    case 'dowel':
      return iso ? 'ISO 8734' : 'ASME B18.8.2';
    case 'bearing':
      return iso ? 'ISO 15' : 'ABMA';
  }
}

function formatNumber(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/** A length in the system's own units: `20`, `3/4"`, `1.25"`. */
export function formatStandardLength(
  system: StandardPartSystem,
  lengthMm: number
): string {
  if (system === 'iso') return formatNumber(lengthMm);
  const inches = lengthMm / MM_PER_INCH;
  for (const denominator of [2, 4, 8, 16, 32, 64]) {
    const numerator = inches * denominator;
    if (Math.abs(numerator - Math.round(numerator)) < 1e-6) {
      const whole = Math.floor(Math.round(numerator) / denominator);
      const rest = Math.round(numerator) - whole * denominator;
      if (rest === 0) return `${whole}"`;
      const g = gcd(rest, denominator);
      const fraction = `${rest / g}/${denominator / g}`;
      return whole > 0 ? `${whole}-${fraction}"` : `${fraction}"`;
    }
  }
  return `${formatNumber(inches)}"`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * The part's designation, as a bill of materials lists it: `ISO 4762
 * M6×1 × 20`, `ASME B18.2.2 1/4-20 UNC hex nut`, `ISO 7089 M6 plain washer`,
 * `ISO 8734 Ø6 × 20 dowel pin`, `ISO 15 608 ball bearing`.
 */
export function standardPartDesignation(
  choice: StandardPartChoice,
  lengthMm?: number
): string {
  requireRow(choice);
  const standard = standardPartStandard(choice);
  const noun = standardPartNoun(choice);
  const length =
    lengthMm !== undefined && standardPartHasLength(choice.partKind)
      ? ` × ${formatStandardLength(choice.system, lengthMm)}`
      : '';
  const size =
    choice.partKind === 'dowel'
      ? `Ø${choice.system === 'iso' ? choice.size : `${choice.size}"`}`
      : standardPartIsThreaded(choice.partKind)
        ? standardPartThread(choice).designation
        : choice.size;
  const label = `${size}${length} ${noun}`;
  return standard === 'typical' ? `${label} (typical)` : `${standard} ${label}`;
}

// ---------------------------------------------------------------------------
// M17 slice 2: parts inserted into M01 holes.

/** What a part inserted into a hole needs to know about the hole, in mm. */
export interface StandardHoleFit {
  /** The hole's standard size, if it has one. */
  standard?: {
    system: StandardPartSystem;
    size: string;
    kind: 'clearance' | 'tap-drill';
  };
  /** The bore's diameter. */
  diameterMm: number;
  /** Whether the hole runs through its body. */
  through: boolean;
  /**
   * The bore's length below its seat (a counterbore's floor, else the entry
   * face): the material a through hole passes, a blind hole's depth.
   */
  boreMm: number;
  /** A tapped hole's thread length from the seat; absent is untapped. */
  threadMm?: number;
  /** A countersink at the entry, for a countersunk head to sit in. */
  countersunk?: boolean;
}

/** The kinds a hole takes: a screw by its standard, a dowel pin by size. */
export type StandardHoleKind = 'screw' | 'dowel';

/**
 * The catalogue row a hole takes, matched by size: a screw of the hole's
 * own standard size (a clearance hole passes it, a tap drill is threaded
 * for it), a dowel pin whose diameter is the hole's. A string says why the
 * hole takes none.
 */
export function standardPartForHole(
  kind: StandardHoleKind,
  fit: StandardHoleFit,
  system: StandardPartSystem,
  head: StandardScrewHead = 'socket'
): StandardPartChoice | string {
  if (kind === 'screw') {
    if (!fit.standard) {
      return 'A screw goes into a standard hole: give the hole an ISO or ANSI size.';
    }
    const choice: StandardPartChoice = {
      partKind: 'screw',
      system: fit.standard.system,
      size: fit.standard.size,
      ...(head !== 'socket' ? { head } : {})
    };
    return standardPartProblem(choice) === null
      ? choice
      : `The ${standardPartNoun(choice)} table has no ${fit.standard.size}.`;
  }
  const sizes = standardPartSizes('dowel', system);
  const size = sizes.find((candidate) => {
    const g = standardPartGeometry({
      partKind: 'dowel',
      system,
      size: candidate
    });
    return (
      g.partKind === 'dowel' &&
      Math.abs(g.diameterMm - fit.diameterMm) <=
        1e-6 * Math.max(1, g.diameterMm)
    );
  });
  return size
    ? { partKind: 'dowel', system, size }
    : `No ${system === 'iso' ? 'ISO' : 'ANSI'} dowel pin is ${formatNumber(fit.diameterMm)} mm across.`;
}

/** Every preferred length a row can be built at, shortest first, mm. */
function standardSeriesMm(choice: StandardPartChoice): number[] {
  const geometry = standardPartGeometry(choice);
  const minimum = standardPartMinimumLengthMm(geometry);
  const series =
    choice.system === 'iso'
      ? ISO_LENGTHS
      : ANSI_LENGTHS.map((inches) => inches * MM_PER_INCH);
  return series.filter((length) => length > minimum - 1e-9);
}

/**
 * The preferred length a part in `fit` takes, mm, or a string saying why
 * none fits:
 * - a screw through a clearance hole passes the material and a standard
 *   nut on the far side with two pitches to spare: the shortest such length;
 * - a screw in a tap drill or a blind hole stops short of the bore's end
 *   (and of its thread, if tapped): the longest such length;
 * - a dowel pin fills a blind hole short of its floor (the longest such
 *   length), or passes a through hole (the shortest).
 * A countersunk head's own height is added, as its nominal length includes
 * it.
 */
export function matchedStandardLengthMm(
  choice: StandardPartChoice,
  fit: StandardHoleFit
): number | string {
  const geometry = standardPartGeometry(choice);
  const series = standardSeriesMm(choice);
  const head =
    geometry.partKind === 'screw' && geometry.head === 'countersunk'
      ? geometry.headHeightMm
      : 0;
  const shortest = (need: number) =>
    series.find((length) => length >= need - 1e-9) ??
    `No preferred length reaches ${formatNumber(need)} mm.`;
  const longest = (room: number) =>
    [...series].reverse().find((length) => length <= room + 1e-9) ??
    'The hole is too shallow for this part.';
  if (geometry.partKind === 'dowel') {
    return fit.through ? shortest(fit.boreMm) : longest(fit.boreMm);
  }
  if (geometry.partKind !== 'screw') {
    return 'Only a screw or a dowel pin goes into a hole.';
  }
  if (fit.through && fit.standard?.kind === 'clearance') {
    const nut = standardPartGeometry({
      partKind: 'nut',
      system: choice.system,
      size: choice.size
    });
    const nutHeight = nut.partKind === 'nut' ? nut.heightMm : 0;
    return shortest(
      head + fit.boreMm + nutHeight + 2 * geometry.thread.pitchMm
    );
  }
  const room = Math.min(fit.boreMm, fit.threadMm ?? Number.POSITIVE_INFINITY);
  return longest(head + room);
}

/**
 * The fit a hole offers, from its stored data and its bore as built (or as
 * picked): one rule for the kernel's build and the tool's preview. A tapped
 * hole's thread runs the whole bore unless its own length stops it.
 */
export function standardHoleFit(
  hole: {
    standard?: { system: StandardPartSystem; size: string; kind: string };
    depthMode: string;
    style: string;
    tapped?: object;
  },
  diameterMm: number,
  boreMm: number,
  threadMm?: number
): StandardHoleFit {
  const { standard } = hole;
  return {
    ...(standard &&
    (standard.kind === 'clearance' || standard.kind === 'tap-drill')
      ? {
          standard: {
            system: standard.system,
            size: standard.size,
            kind: standard.kind
          }
        }
      : {}),
    diameterMm,
    through: hole.depthMode === 'through',
    boreMm,
    ...(hole.tapped ? { threadMm: threadMm ?? boreMm } : {}),
    ...(hole.style === 'countersink' ? { countersunk: true } : {})
  };
}

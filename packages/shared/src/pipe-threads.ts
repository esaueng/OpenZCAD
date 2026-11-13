/**
 * Schema v57 (M15): tapered pipe threads, NPT (ASME B1.20.1, 60°) and BSPT
 * R/Rc (ISO 7-1, 55°), both tapering 1 in 16 on the diameter.
 *
 * The tables carry each standard's own columns, NPT's in inches, so a
 * typo in one column shows against the standard's relations (`E1 = E0 +
 * L1/16`, BSPT's `major − minor = 2h`), which the tests check.
 */

/** A tapered pipe thread standard. */
export type PipeThreadStandard = 'npt' | 'bspt';

/** The nominal pipe sizes both tables carry, in inches. */
export const PIPE_THREAD_SIZES = [
  '1/8',
  '1/4',
  '3/8',
  '1/2',
  '3/4',
  '1',
  '1-1/4',
  '1-1/2',
  '2'
] as const;
export type PipeThreadSize = (typeof PIPE_THREAD_SIZES)[number];

/** Diameter change per unit of length: 1 in 16 for NPT and BSPT alike. */
export const PIPE_THREAD_TAPER = 1 / 16;

/**
 * ASME B1.20.1 NPT, inches: threads per inch, pipe outside diameter `D`,
 * pitch diameter `E0` at the external thread's small end, hand-tight
 * engagement `L1`, pitch diameter `E1` at `L1` (the gauge plane) and the
 * effective thread length `L2`.
 */
const NPT: Record<
  PipeThreadSize,
  readonly [
    tpi: number,
    D: number,
    E0: number,
    L1: number,
    E1: number,
    L2: number
  ]
> = {
  '1/8': [27, 0.405, 0.36351, 0.1615, 0.3736, 0.2639],
  '1/4': [18, 0.54, 0.47739, 0.2278, 0.49163, 0.4018],
  '3/8': [18, 0.675, 0.61201, 0.24, 0.62701, 0.4078],
  '1/2': [14, 0.84, 0.75843, 0.32, 0.77843, 0.5337],
  '3/4': [14, 1.05, 0.96768, 0.339, 0.98887, 0.5457],
  '1': [11.5, 1.315, 1.21363, 0.4, 1.23863, 0.6828],
  '1-1/4': [11.5, 1.66, 1.55713, 0.42, 1.58338, 0.7068],
  '1-1/2': [11.5, 1.9, 1.79609, 0.42, 1.82234, 0.7235],
  '2': [11.5, 2.375, 2.26902, 0.436, 2.29627, 0.7565]
};

/**
 * ISO 7-1 BSPT, millimetres: threads per inch, pipe outside diameter (ISO
 * 65), major, pitch and minor diameters on the gauge plane, the basic gauge
 * length from the external thread's small end, and its minimum useful
 * thread length.
 */
const BSPT: Record<
  PipeThreadSize,
  readonly [
    tpi: number,
    pipeOd: number,
    major: number,
    pitchDiameter: number,
    minor: number,
    gaugeLength: number,
    usefulLength: number
  ]
> = {
  '1/8': [28, 10.2, 9.728, 9.147, 8.566, 4.0, 6.5],
  '1/4': [19, 13.5, 13.157, 12.301, 11.445, 6.0, 9.7],
  '3/8': [19, 17.2, 16.662, 15.806, 14.95, 6.4, 10.1],
  '1/2': [14, 21.3, 20.955, 19.793, 18.631, 8.2, 13.2],
  '3/4': [14, 26.9, 26.441, 25.279, 24.117, 9.5, 14.5],
  '1': [11, 33.7, 33.249, 31.77, 30.291, 10.4, 16.8],
  '1-1/4': [11, 42.4, 41.91, 40.431, 38.952, 12.7, 19.1],
  '1-1/2': [11, 48.3, 47.803, 46.324, 44.845, 12.7, 19.1],
  '2': [11, 60.3, 59.614, 58.135, 56.656, 15.9, 23.4]
};

/** The raw table rows, for tests that check them against their standard. */
export const PIPE_THREAD_TABLES = { npt: NPT, bspt: BSPT } as const;

/** One pipe thread size, in millimetres. */
export interface PipeThreadSpec {
  standard: PipeThreadStandard;
  size: PipeThreadSize;
  pitch: number;
  /** The pipe's outside diameter. */
  pipeOd: number;
  /** The major diameter on the gauge plane. */
  gaugeMajor: number;
  /** The gauge plane's distance from the external thread's small end. */
  gaugeLength: number;
  /**
   * The thread length a feature takes by default: NPT's effective thread
   * `L2`, BSPT's minimum useful thread.
   */
  threadLength: number;
}

/** A pipe thread's form, in the unit its pitch is given in. */
export interface PipeThreadForm {
  depth: number;
  crestWidth: number;
  flankAngleDeg: number;
}

/**
 * The form the kernel cuts for a pipe thread of `pitch`. NPT's flat crests
 * and roots are its own; BSPT's rounded crests and roots are approximated
 * by flats of P/6 at the standard's major and minor diameters.
 */
export function pipeThreadForm(
  standard: PipeThreadStandard,
  pitch: number
): PipeThreadForm {
  return standard === 'npt'
    ? { depth: 0.8 * pitch, crestWidth: 0.03812 * pitch, flankAngleDeg: 30 }
    : {
        depth: 0.640327 * pitch,
        crestWidth: pitch / 6,
        flankAngleDeg: 27.5
      };
}

const INCH = 25.4;

export function isPipeThreadSize(value: unknown): value is PipeThreadSize {
  return (PIPE_THREAD_SIZES as readonly unknown[]).includes(value);
}

/** One size of a standard, in millimetres. */
export function pipeThreadSpec(
  standard: PipeThreadStandard,
  size: PipeThreadSize
): PipeThreadSpec {
  if (standard === 'npt') {
    const [tpi, D, , L1, E1, L2] = NPT[size];
    const pitch = INCH / tpi;
    return {
      standard,
      size,
      pitch,
      pipeOd: D * INCH,
      gaugeMajor: E1 * INCH + pipeThreadForm('npt', pitch).depth,
      gaugeLength: L1 * INCH,
      threadLength: L2 * INCH
    };
  }
  const [tpi, pipeOd, major, , , gaugeLength, usefulLength] = BSPT[size];
  return {
    standard,
    size,
    pitch: INCH / tpi,
    pipeOd,
    gaugeMajor: major,
    gaugeLength,
    threadLength: usefulLength
  };
}

/**
 * The size a face takes when the feature leaves it to the face: on a boss
 * the size whose pipe is nearest its diameter, in a bore the size whose
 * minor diameter on the gauge plane is nearest it (a tap drill's choice).
 */
export function pipeThreadForFace(
  standard: PipeThreadStandard,
  kind: 'external' | 'internal',
  diameterMm: number
): PipeThreadSpec {
  const measure = (spec: PipeThreadSpec) =>
    kind === 'external'
      ? spec.pipeOd
      : spec.gaugeMajor - 2 * pipeThreadForm(standard, spec.pitch).depth;
  return PIPE_THREAD_SIZES.map((size) => pipeThreadSpec(standard, size)).reduce(
    (best, spec) =>
      Math.abs(measure(spec) - diameterMm) <
      Math.abs(measure(best) - diameterMm)
        ? spec
        : best
  );
}

/**
 * The callout: `1/2-14 NPT`, and for BSPT `R 1/2` on a boss or `Rc 1/2` in
 * a bore.
 */
export function pipeThreadLabel(
  standard: PipeThreadStandard,
  size: PipeThreadSize,
  kind?: 'external' | 'internal'
): string {
  if (standard === 'npt') {
    return `${size}-${NPT[size][0]} NPT`;
  }
  const prefix =
    kind === 'external' ? 'R' : kind === 'internal' ? 'Rc' : 'R/Rc';
  return `${prefix} ${size}`;
}

/**
 * Where the gauge plane lies from the thread's fitting end: the end the
 * mating part enters from, a boss's free end or a bore's opening. On a
 * boss it is the gauge length in from the small end; NPT gauges an
 * internal thread on its opening face; ISO 7-1 gauges Rc half a pitch
 * behind it.
 */
export function pipeGaugeFromFittingEnd(
  spec: PipeThreadSpec,
  kind: 'external' | 'internal'
): number {
  if (kind === 'external') return spec.gaugeLength;
  return spec.standard === 'npt' ? 0 : spec.pitch / 2;
}

/**
 * How far from its fitting end a pipe thread may run before its crest
 * meets the cylinder: on a boss where the growing major diameter reaches
 * it, in a bore where the shrinking minor diameter does. All lengths in one
 * unit; `majorAtGauge` already carries any fit clearance. Not positive when
 * the thread does not fit at its fitting end at all.
 */
export function pipeThreadReach(input: {
  kind: 'external' | 'internal';
  majorAtGauge: number;
  depth: number;
  gaugeFromFittingEnd: number;
  diameter: number;
}): number {
  const { kind, majorAtGauge, depth, gaugeFromFittingEnd, diameter } = input;
  return kind === 'external'
    ? gaugeFromFittingEnd + (diameter - majorAtGauge) / PIPE_THREAD_TAPER
    : gaugeFromFittingEnd +
        (majorAtGauge - 2 * depth - diameter) / PIPE_THREAD_TAPER;
}

/**
 * M09 body clash, and through it AS04 assembly interference: one exact query
 * for "do these two bodies share material, and where?", answered by the
 * kernel's own booleans and classifier. AS04 is this query run pairwise on
 * posed components; there is no second engine, no mesh boolean and no
 * display-mesh test anywhere in this file.
 *
 * Per solid pair:
 *
 * 1. Bounding boxes apart by more than a length tolerance prove the pair is
 *    clear, and the gap is a lower bound on the clearance.
 * 2. Otherwise the exact intersection measures the shared volume. Remus
 *    answers an empty intersection of planar solids with an empty result,
 *    but declines (`exact_only_unattainable`) an empty or tangent one it
 *    cannot build on curved faces — a pin in a clearance hole is the common
 *    assembly case. The exact difference of one solid by the other then
 *    measures the same volume as `volume(b) − volume(b − a)`, and the other
 *    way round if that is declined too.
 * 3. A resolved shared volume is interference. An intersection the kernel
 *    built resolves when it has thickness on every axis at its own scale
 *    (never the bodies': a micrometre overlap of kilometre bars is real); a
 *    difference resolves above its cancellation noise, 1e-9 of the minuend,
 *    the smaller solid tried first. An unresolved figure is still
 *    interference when a point lies strictly inside both solids, and is
 *    unknown (never clear) when it is above the smaller solid's floor
 *    (diagonal³ × 1e-9) or the kernel built a positive sliver. Its witness is a point
 *    classified strictly inside both solids by the exact and the robust
 *    classifiers, and the box of the shared region when the kernel built it.
 * 4. No shared volume is clearance. Where the kernel certifies the solid
 *    distance (planar faces with straight edges, sphere pairs) it supplies
 *    the distance and the two closest points; zero is contact.
 * 5. When no boolean answers, a point strictly inside both solids still
 *    proves interference (unmeasured). Anything else is unknown, with the
 *    kernel's typed refusal, and is never reported as clear.
 */
import type {
  BodyClashBounds,
  BodyClashClear,
  BodyClashInterference,
  BodyClashUnknown,
  BodyClashVerdict,
  Vector3
} from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';
import { exactBooleanOutcome } from './exact-boolean-refusal';
import {
  certifiedSolidDistanceWitness,
  sharedInteriorPoint,
  strictlyInside
} from './exact-boolean-helpers';
import { MEASUREMENT_DEFLECTION } from './exact-witnesses';
import { DIRECT_EDIT_TOLERANCE } from './exact-math';

type Box = readonly [number, number, number, number, number, number];

function boxOf(kernel: RemusKernel, solid: number): Box {
  const raw = kernel.boundingBox(solid);
  return [raw[0]!, raw[1]!, raw[2]!, raw[3]!, raw[4]!, raw[5]!];
}

function boundsOf(box: Box): BodyClashBounds {
  return {
    min: { x: box[0], y: box[1], z: box[2] },
    max: { x: box[3], y: box[4], z: box[5] }
  };
}

function vector(point: readonly number[]): Vector3 {
  return { x: point[0]!, y: point[1]!, z: point[2]! };
}

/** Largest per-axis separation: positive when the boxes are apart. */
function boxGap(a: Box, b: Box): number {
  let gap = -Infinity;
  for (let axis = 0; axis < 3; axis += 1) {
    gap = Math.max(
      gap,
      Math.max(a[axis]!, b[axis]!) - Math.min(a[axis + 3]!, b[axis + 3]!)
    );
  }
  return gap;
}

function boxDiagonal(box: Box): number {
  return Math.hypot(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
}

function pairDiagonal(a: Box, b: Box): number {
  return Math.hypot(
    Math.max(a[3], b[3]) - Math.min(a[0], b[0]),
    Math.max(a[4], b[4]) - Math.min(a[1], b[1]),
    Math.max(a[5], b[5]) - Math.min(a[2], b[2])
  );
}

function safeDelete(kernel: RemusKernel, solid: number, keep: number[]) {
  if (keep.includes(solid)) return;
  try {
    kernel.deleteSolid(solid);
  } catch {
    // Already gone with its owner; nothing to release.
  }
}

interface SharedMeasure {
  volume: number;
  proof: 'intersect' | 'difference';
  /** The intersection solid, when the kernel built a non-empty one. */
  region: number | null;
  /**
   * Whether the measure resolves a real overlap, judged at the scale it was
   * measured at. An intersection the kernel built is real when it has volume
   * and thickness on every axis, judged against its OWN box (two kilometre
   * bars overlapping by a micrometre share a real 0.1 mm³ the bars' scale
   * would round away). A difference `volume(m) − volume(m − s)` carries the
   * cancellation noise of m, so it resolves only what clears that noise.
   */
  resolved: boolean;
  /**
   * A positive figure that did not resolve and is above the pair's floor:
   * it may be real, so without other proof it is unknown, never clear.
   */
  ambiguous: boolean;
}

type SharedOutcome =
  | { ok: true; measure: SharedMeasure }
  | { ok: false; reason: string; message: string };

function volumeOf(kernel: RemusKernel, solid: number): number {
  const volume = kernel.volume(solid, MEASUREMENT_DEFLECTION);
  if (!Number.isFinite(volume)) {
    throw new Error('The geometry kernel returned an invalid volume.');
  }
  return volume;
}

/**
 * `volume(minuend) − volume(minuend − subtrahend)`, or null when the kernel
 * declines that difference or answers outside [0, volume(minuend)].
 */
function differenceShare(
  kernel: RemusKernel,
  minuend: number,
  subtrahend: number,
  floor: number
): { shared: number; noise: number } | null {
  // `floor` stays the pair's: the noise below scales with the minuend.
  const outcome = exactBooleanOutcome(kernel, 'cut', minuend, subtrahend);
  if (outcome.status !== 'ok') return null;
  try {
    const whole = volumeOf(kernel, minuend);
    const rest = volumeOf(kernel, outcome.solid);
    const shared = whole - rest;
    const noise = Math.max(floor, whole * 1e-9);
    if (shared < -noise || shared > whole + noise) return null;
    return { shared: Math.min(whole, Math.max(0, shared)), noise };
  } finally {
    safeDelete(kernel, outcome.solid, [minuend, subtrahend]);
  }
}

function measureShared(
  kernel: RemusKernel,
  a: number,
  b: number,
  floor: number
): SharedOutcome {
  const common = exactBooleanOutcome(kernel, 'intersect', a, b);
  if (common.status === 'ok') {
    const volume = volumeOf(kernel, common.solid);
    if (volume > 0) {
      const box = boxOf(kernel, common.solid);
      const thickness = Math.min(
        box[3] - box[0],
        box[4] - box[1],
        box[5] - box[2]
      );
      const resolved = thickness > Math.max(boxDiagonal(box), 1) * 1e-9;
      return {
        ok: true,
        measure: {
          volume,
          proof: 'intersect',
          region: common.solid,
          resolved,
          ambiguous: !resolved
        }
      };
    }
    safeDelete(kernel, common.solid, [a, b]);
    // The kernel built the intersection and it is empty: no shared volume.
    return {
      ok: true,
      measure: {
        volume,
        proof: 'intersect',
        region: null,
        resolved: false,
        ambiguous: false
      }
    };
  }
  // The smaller solid first: the difference's noise scales with its minuend.
  const ordered: (readonly [number, number])[] =
    volumeOf(kernel, a) <= volumeOf(kernel, b)
      ? [
          [a, b],
          [b, a]
        ]
      : [
          [b, a],
          [a, b]
        ];
  for (const [minuend, subtrahend] of ordered) {
    const measured = differenceShare(kernel, minuend, subtrahend, floor);
    if (measured !== null) {
      return {
        ok: true,
        measure: {
          volume: measured.shared,
          proof: 'difference',
          region: null,
          resolved: measured.shared > measured.noise,
          ambiguous:
            measured.shared > floor && measured.shared <= measured.noise
        }
      };
    }
  }
  return {
    ok: false,
    reason: common.refusal.kernelCode,
    message: common.refusal.reason
  };
}

const PROBE_FRACTIONS = [0.5, 0.25, 0.75, 0.125, 0.375, 0.625, 0.875];

/**
 * A point strictly inside both solids: the shared region's centre of mass
 * when it lies inside, then a grid over the shared region's box (or, without
 * a region, the boxes' common part, which `sharedInteriorPoint` probes).
 */
function witnessPoint(
  kernel: RemusKernel,
  a: number,
  b: number,
  region: number | null
): Vector3 | null {
  if (region !== null) {
    const box = boxOf(kernel, region);
    const spans = [box[3] - box[0], box[4] - box[1], box[5] - box[2]];
    const minSpan = Math.min(...spans);
    const scale = Math.max(1, ...box.map((value) => Math.abs(value)));
    const tolerance = Math.min(DIRECT_EDIT_TOLERANCE * scale, minSpan / 8);
    const inside = (point: readonly [number, number, number]) =>
      tolerance > 0 &&
      strictlyInside(kernel, a, point, tolerance) &&
      strictlyInside(kernel, b, point, tolerance);
    try {
      const raw = JSON.parse(String(kernel.massProperties(region))) as {
        centerOfMass?: unknown;
      };
      const center = raw.centerOfMass;
      if (
        Array.isArray(center) &&
        center.length === 3 &&
        center.every((value) => typeof value === 'number' && isFinite(value))
      ) {
        const point = center as [number, number, number];
        if (inside(point)) return vector(point);
      }
    } catch {
      // A region the kernel cannot integrate still has a box to probe.
    }
    for (const fx of PROBE_FRACTIONS) {
      for (const fy of PROBE_FRACTIONS) {
        for (const fz of PROBE_FRACTIONS) {
          const point = [
            box[0] + spans[0]! * fx,
            box[1] + spans[1]! * fy,
            box[2] + spans[2]! * fz
          ] as const;
          if (inside(point)) return vector(point);
        }
      }
    }
  }
  const shared = sharedInteriorPoint(kernel, a, b);
  return shared ? vector(shared) : null;
}

function certifiedDistance(kernel: RemusKernel, a: number, b: number) {
  try {
    return certifiedSolidDistanceWitness(kernel, a, b);
  } catch {
    // Distance is supporting evidence here, never the proof of clearance:
    // a failed distance leaves the clearance unmeasured, not unknown.
    return null;
  }
}

/** The clash verdict for two exact solids in the same frame. */
export function exactSolidClash(
  kernel: RemusKernel,
  a: number,
  b: number
): BodyClashVerdict {
  const boxA = boxOf(kernel, a);
  const boxB = boxOf(kernel, b);
  const diagonal = pairDiagonal(boxA, boxB);
  const lengthTolerance = Math.max(diagonal, 1) * 1e-9;
  // Scaled to the SMALLER body: a part sunk whole into a much larger one
  // shares all of its own volume, which a floor sized to the pair (or to the
  // larger body) could exceed.
  const floor = Math.min(boxDiagonal(boxA), boxDiagonal(boxB)) ** 3 * 1e-9;
  const gap = boxGap(boxA, boxB);
  if (gap > lengthTolerance) {
    const distance = certifiedDistance(kernel, a, b);
    return {
      kind: 'clear',
      touching: false,
      distance: distance?.distance ?? null,
      closest: distance
        ? [vector(distance.closest[0]), vector(distance.closest[1])]
        : null,
      atLeast: gap
    };
  }

  let shared: SharedOutcome;
  try {
    shared = measureShared(kernel, a, b, floor);
  } catch (error) {
    shared = {
      ok: false,
      reason: 'failed',
      message: error instanceof Error ? error.message : String(error)
    };
  }

  if (shared.ok && shared.measure.resolved) {
    const { volume, proof, region } = shared.measure;
    try {
      return {
        kind: 'interference',
        volume,
        proof,
        point: witnessPoint(kernel, a, b, region),
        bounds: region === null ? null : boundsOf(boxOf(kernel, region)),
        complete: true
      };
    } finally {
      if (region !== null) safeDelete(kernel, region, [a, b]);
    }
  }

  if (!shared.ok) {
    const point = sharedInteriorPoint(kernel, a, b);
    if (point) {
      return {
        kind: 'interference',
        volume: null,
        proof: 'point',
        point: vector(point),
        bounds: null,
        complete: false
      };
    }
    return { kind: 'unknown', reason: shared.reason, message: shared.message };
  }

  // Unresolved is not yet clear: a point the exact classifiers place
  // strictly inside both solids still proves an overlap too small to
  // measure, so clearance is only reported where no such point exists.
  // (`sharedInteriorPoint` itself returns null for a degenerate common box,
  // so touching boxes are never probed into an overlap.)
  const { volume, proof, region, ambiguous } = shared.measure;
  if (region !== null) safeDelete(kernel, region, [a, b]);
  const inside = sharedInteriorPoint(kernel, a, b);
  if (inside) {
    return {
      kind: 'interference',
      volume: volume > 0 ? volume : null,
      proof: volume > 0 ? proof : 'point',
      point: vector(inside),
      bounds: null,
      complete: volume > 0
    };
  }
  if (ambiguous) {
    return {
      kind: 'unknown',
      reason: 'below_resolution',
      message: `the exact ${
        proof === 'intersect' ? 'intersection' : 'difference'
      } found a shared volume too small to tell from rounding`
    };
  }

  const distance = certifiedDistance(kernel, a, b);
  return {
    kind: 'clear',
    touching: distance ? distance.distance <= lengthTolerance : null,
    distance: distance?.distance ?? null,
    closest: distance
      ? [vector(distance.closest[0]), vector(distance.closest[1])]
      : null,
    atLeast: gap > 0 ? gap : null
  };
}

function unionBounds(
  left: BodyClashBounds | null,
  right: BodyClashBounds | null
): BodyClashBounds | null {
  if (!left) return right;
  if (!right) return left;
  return {
    min: {
      x: Math.min(left.min.x, right.min.x),
      y: Math.min(left.min.y, right.min.y),
      z: Math.min(left.min.z, right.min.z)
    },
    max: {
      x: Math.max(left.max.x, right.max.x),
      y: Math.max(left.max.y, right.max.y),
      z: Math.max(left.max.z, right.max.z)
    }
  };
}

/**
 * Combine the verdicts of every solid pair of two bodies. Any interference
 * makes the bodies interfere (an unmeasured pair leaves the volume a lower
 * bound); otherwise any unknown makes them unknown; otherwise they are clear,
 * at the smallest distance only where every pair's distance is certified.
 */
export function combineClashVerdicts(
  verdicts: readonly BodyClashVerdict[]
): BodyClashVerdict {
  const interferences = verdicts.filter(
    (v): v is BodyClashInterference => v.kind === 'interference'
  );
  const unknowns = verdicts.filter(
    (v): v is BodyClashUnknown => v.kind === 'unknown'
  );
  if (interferences.length > 0) {
    const measured = interferences.filter((v) => v.volume !== null);
    const proofs = new Set(interferences.map((v) => v.proof));
    return {
      kind: 'interference',
      volume:
        measured.length === 0
          ? null
          : measured.reduce((sum, v) => sum + v.volume!, 0),
      proof: proofs.has('point')
        ? 'point'
        : proofs.has('difference')
          ? 'difference'
          : 'intersect',
      point: interferences.find((v) => v.point !== null)?.point ?? null,
      bounds: interferences.reduce<BodyClashBounds | null>(
        (box, v) => unionBounds(box, v.bounds),
        null
      ),
      complete: unknowns.length === 0 && interferences.every((v) => v.complete)
    };
  }
  if (unknowns.length > 0) return unknowns[0]!;
  const clears = verdicts as readonly BodyClashClear[];
  if (clears.length === 0) {
    return {
      kind: 'clear',
      touching: false,
      distance: null,
      closest: null,
      atLeast: null
    };
  }
  const touching = clears.some((v) => v.touching === true)
    ? true
    : clears.some((v) => v.touching === null)
      ? null
      : false;
  const allCertified = clears.every((v) => v.distance !== null);
  const nearest = allCertified
    ? clears.reduce((best, v) => (v.distance! < best.distance! ? v : best))
    : null;
  const bounds = clears.map((v) => v.distance ?? v.atLeast);
  return {
    kind: 'clear',
    touching,
    distance: nearest?.distance ?? null,
    closest: nearest?.closest ?? null,
    atLeast: bounds.every((value) => value !== null)
      ? Math.min(...bounds)
      : null
  };
}

/** The clash verdict for two bodies, each one or more exact solids. */
export function exactBodyClash(
  kernel: RemusKernel,
  left: readonly number[],
  right: readonly number[]
): BodyClashVerdict {
  const verdicts: BodyClashVerdict[] = [];
  for (const a of left) {
    for (const b of right) verdicts.push(exactSolidClash(kernel, a, b));
  }
  return combineClashVerdicts(verdicts);
}

/**
 * An operand of the pairwise check: its solids in the shared frame, or, for
 * one whose geometry could not be had, the reason. Every pair naming such an
 * operand is that unknown: it is still a pair, and is never left out as if
 * nothing were there to clash.
 */
export type PairwiseClashOperand<Id> =
  { id: Id; solids: readonly number[] } | { id: Id; unknown: BodyClashUnknown };

/** The clash verdict for two operands; unknown when either has no solids. */
export function operandClash<Id>(
  kernel: RemusKernel,
  left: PairwiseClashOperand<Id>,
  right: PairwiseClashOperand<Id>
): BodyClashVerdict {
  if ('unknown' in left) return left.unknown;
  if ('unknown' in right) return right.unknown;
  return exactBodyClash(kernel, left.solids, right.solids);
}

/**
 * Every unordered pair of operands, in input order. Each operand's solids
 * must already sit in one shared frame (assembly components posed).
 */
export function pairwiseBodyClash<Id>(
  kernel: RemusKernel,
  operands: readonly PairwiseClashOperand<Id>[]
): { a: Id; b: Id; verdict: BodyClashVerdict }[] {
  const pairs: { a: Id; b: Id; verdict: BodyClashVerdict }[] = [];
  for (let i = 0; i < operands.length; i += 1) {
    for (let j = i + 1; j < operands.length; j += 1) {
      pairs.push({
        a: operands[i]!.id,
        b: operands[j]!.id,
        verdict: operandClash(kernel, operands[i]!, operands[j]!)
      });
    }
  }
  return pairs;
}

/** Column-major 4×4 (three.js order) to the row-major one the kernel reads. */
export function rowMajorMatrix(columnMajor: readonly number[]): Float64Array {
  if (columnMajor.length !== 16 || !columnMajor.every(Number.isFinite)) {
    throw new Error('A component pose must be a finite 4×4 matrix.');
  }
  const out = new Float64Array(16);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      out[row * 4 + column] = columnMajor[column * 4 + row]!;
    }
  }
  return out;
}

/**
 * WS6 edit-strategy ladder, step 2, for a cylindrical wall resize: remove the
 * blends incident to the wall, resize the now-sharp wall, rebuild the blends
 * at their recognised radius (docs/plans/kernel-robustness-plan-2026-11-05.md,
 * WS6 and reference scenario R2).
 *
 * The kernel's replace-surface re-limits a moved wall only against plane,
 * cylinder and axial-cone neighbours, so a wall that meets a blend band
 * either refuses or comes back with the band left at the old size (the
 * `resize_left_blend_behind` acceptance refusal). An imported body has no
 * source dimension to edit instead, so this local route is the only one it
 * has.
 *
 * Every step is proved from exact data and fails closed:
 *
 * - Recognition reads each curved neighbour of the wall through the kernel's
 *   own blend-region proof (`getBlendRegion`). A neighbour that is not a
 *   proven constant-radius band — a chamfer cone, a freeform band, another
 *   wall — refuses the ladder. Each band must roll between the wall and one
 *   other support carrier, so a band that ends on further faces (a partial
 *   seam running off a block edge) refuses too.
 * - Removal uses `resizeBlend(…, 0)`, which restores the sharp support
 *   intersection exactly. Later bands, and the supports after every step, are
 *   found again by their exact analytic carrier, never by position.
 * - The rebuilt bands must be proven blend regions of the recorded classes
 *   and radii, meeting the new wall, and the volume the re-blend adds or
 *   removes must mirror the volume the removal took (an independent check:
 *   the two differ only by the band's centroid moving with the wall).
 *
 * A step that fails any check throws; the caller keeps its original refusal.
 */
import type { Vec3 } from '@openzcad/geometry';
import type { RecordedBlendCarrier } from '@openzcad/shared';
import type { RemusKernel } from './remus-runtime';
import {
  blendCarrierSnapshot,
  measureBlendRegion,
  measureOwnedFaceGeometry,
  type BlendCarrierSnapshot
} from './exact-measure';
import { coaxialCylinderFacesAt } from './result-acceptance';
import { edgeToFaceMapOf, surfaceTypeOf } from './exact-sync-memo';
import { faceWitnessOf, MEASUREMENT_DEFLECTION } from './exact-witnesses';
import { sameAnalyticCarrier } from './exact-lineage-builders';
import { requireValidSolid } from './kernel-validation';
import { dot, length, normalized, scale, subtract } from './exact-math';
import type { FaceWitnessV1 } from '@openzcad/shared';

type AnalyticCarrier = FaceWitnessV1['analytic'];

/** One constant-radius band incident to the wall, as recognised. */
export interface IncidentBlend {
  carrier: BlendCarrierSnapshot;
  /** The band's exact radius, from the kernel's region proof. */
  radius: number;
  /** The exact carrier of the band's other support face. */
  support: AnalyticCarrier;
}

/**
 * Whether a measured band is the recorded one: same surface class and radius,
 * and the same carrier up to sign. A cylinder band is pinned by its axis line
 * rather than its midpoint, because removing a neighbouring band can lengthen
 * it; a torus is pinned by its centre, which nothing around it moves.
 */
export function sameBlendCarrier(
  measured: BlendCarrierSnapshot,
  recorded: RecordedBlendCarrier
): boolean {
  if (
    measured.surfaceClass !== recorded.surfaceClass ||
    Math.abs(measured.radius - recorded.radius) >
      Math.max(recorded.radius * 1e-5, 1e-9)
  ) {
    return false;
  }
  const axis = normalized(recorded.axis);
  if (!axis || Math.abs(dot(measured.axis, axis)) < 1 - 1e-6) return false;
  const tolerance = Math.max(recorded.radius * 1e-5, 1e-6);
  const offset = subtract(measured.center, recorded.center);
  return recorded.surfaceClass === 'torus'
    ? length(offset) <= tolerance
    : length(subtract(offset, scale(axis, dot(offset, axis)))) <= tolerance;
}

function neighbours(
  kernel: RemusKernel,
  solid: number,
  faces: readonly number[]
): Set<number> {
  const own = new Set(faces);
  const map = edgeToFaceMapOf(kernel, solid);
  const found = new Set<number>();
  for (const face of faces) {
    for (const edge of kernel.getFaceEdges(face)) {
      for (const other of map[String(edge)] ?? []) {
        if (!own.has(other)) found.add(other);
      }
    }
  }
  return found;
}

/** The exact plane or cylinder carrier of a face, or null for anything else. */
function analyticCarrierOf(
  kernel: RemusKernel,
  face: number
): AnalyticCarrier | null {
  try {
    const analytic = faceWitnessOf(kernel, face).analytic;
    return analytic.kind === 'plane' || analytic.kind === 'cylinder'
      ? analytic
      : null;
  } catch {
    return null;
  }
}

/**
 * The constant-radius bands incident to a cylindrical wall, or null when the
 * wall has none or any curved neighbour is not a band this ladder can remove
 * and rebuild exactly.
 */
export function recognizeWallBlends(
  kernel: RemusKernel,
  solid: number,
  wall: number
): IncidentBlend[] | null {
  const curved = [...neighbours(kernel, solid, [wall])].filter(
    (face) => surfaceTypeOf(kernel, face) !== 'plane'
  );
  if (curved.length === 0) return null;
  const regions = new Map<string, number[]>();
  for (const face of curved) {
    const region = measureBlendRegion(kernel, solid, face);
    if (!region) return null;
    regions.set(region.faces.join(','), region.faces);
  }
  const claimed = new Set([...regions.values()].flat());
  const blends: IncidentBlend[] = [];
  for (const faces of regions.values()) {
    const region = measureBlendRegion(kernel, solid, faces[0]!);
    if (!region) return null;
    const carriers = faces.map((face) =>
      blendCarrierSnapshot(measureOwnedFaceGeometry(kernel, solid, face))
    );
    const carrier = carriers[0];
    if (
      !carrier ||
      carriers.some(
        (other) =>
          !other ||
          !sameBlendCarrier(other, { ...carrier, radius: region.radius })
      )
    ) {
      return null;
    }
    const around = neighbours(kernel, solid, faces);
    if (!around.has(wall)) return null;
    around.delete(wall);
    // A band touching another band is a corner the sequential rebuild
    // cannot reproduce.
    if ([...around].some((face) => claimed.has(face))) return null;
    const supports = [...around].map((face) => analyticCarrierOf(kernel, face));
    const support = supports[0];
    if (
      !support ||
      supports.some((other) => !other || !sameAnalyticCarrier(other, support))
    ) {
      return null;
    }
    blends.push({ carrier, radius: region.radius, support });
  }
  return blends;
}

export interface ReblendWallResize {
  solid: number;
  blends: readonly IncidentBlend[];
  sourceRadius: number;
  newRadius: number;
  axisPoint: Vec3;
  axisDirection: Vec3;
  axisTolerance: number;
  radiusTolerance: number;
  /** The plain resize of a sharp wall, with its own exactness checks. */
  resize: (solid: number, wall: number) => number;
}

/** The edges between the walls and the faces on one support carrier. */
function supportEdges(
  kernel: RemusKernel,
  solid: number,
  walls: readonly number[],
  support: AnalyticCarrier
): number[] {
  const wallSet = new Set(walls);
  const map = edgeToFaceMapOf(kernel, solid);
  const edges = new Set<number>();
  for (const wall of walls) {
    for (const edge of kernel.getFaceEdges(wall)) {
      const faces = map[String(edge)] ?? [];
      if (
        faces.some((face) => {
          if (wallSet.has(face)) return false;
          const carrier = analyticCarrierOf(kernel, face);
          return carrier !== null && sameAnalyticCarrier(carrier, support);
        })
      ) {
        edges.add(edge);
      }
    }
  }
  return [...edges].sort((left, right) => left - right);
}

function bandFace(
  kernel: RemusKernel,
  solid: number,
  blend: IncidentBlend
): number {
  const matches = Array.from(kernel.getSolidFaces(solid)).filter((face) => {
    if (surfaceTypeOf(kernel, face) !== blend.carrier.surfaceClass) {
      return false;
    }
    const carrier = blendCarrierSnapshot(
      measureOwnedFaceGeometry(kernel, solid, face)
    );
    return carrier !== null && sameBlendCarrier(carrier, blend.carrier);
  });
  if (matches.length === 0) {
    throw new Error('A recognised blend could not be found again.');
  }
  return matches[0]!;
}

/** Ratio the re-blend's volume may differ from the removal's by. */
const REBLEND_VOLUME_RATIO = 3;

/**
 * Remove the bands, resize the sharp wall, rebuild the bands. Returns the
 * rebuilt solid, or throws when any step fails its check.
 */
export function resizeWallThroughBlends(
  kernel: RemusKernel,
  input: ReblendWallResize
): number {
  const wallsAt = (solid: number, radius: number) =>
    coaxialCylinderFacesAt(
      kernel,
      solid,
      input.axisPoint,
      input.axisDirection,
      radius,
      input.axisTolerance,
      input.radiusTolerance
    );
  const volume = (solid: number) =>
    kernel.volume(solid, MEASUREMENT_DEFLECTION);

  let sharp = input.solid;
  for (const blend of input.blends) {
    const seed = bandFace(kernel, sharp, blend);
    const region = measureBlendRegion(kernel, sharp, seed);
    if (
      !region ||
      Math.abs(region.radius - blend.radius) >
        Math.max(blend.radius * 1e-5, 1e-9)
    ) {
      throw new Error('A recognised blend changed radius before removal.');
    }
    sharp = kernel.resizeBlend(sharp, seed, region.radius, 0);
  }
  requireValidSolid(
    kernel,
    sharp,
    'Removing the blends along the wall does not produce a valid solid.'
  );
  const sharpWalls = wallsAt(sharp, input.sourceRadius);
  if (sharpWalls.length !== 1) {
    throw new Error('The wall could not be found once its blends were removed.');
  }
  const sharpEdgeCounts = input.blends.map(
    (blend) => supportEdges(kernel, sharp, sharpWalls, blend.support).length
  );
  if (sharpEdgeCounts.some((count) => count === 0)) {
    throw new Error('A removed blend left no sharp edge on the wall.');
  }

  const resized = input.resize(sharp, sharpWalls[0]!);
  let output = resized;
  input.blends.forEach((blend, index) => {
    const walls = wallsAt(output, input.newRadius);
    const edges = supportEdges(kernel, output, walls, blend.support);
    if (walls.length === 0 || edges.length !== sharpEdgeCounts[index]) {
      throw new Error('The resized wall does not meet a blend support as before.');
    }
    // Exact only: a sampled band would be a silent approximation.
    const rebuilt = kernel.filletDetailed(
      output,
      Uint32Array.from(edges),
      blend.radius,
      true
    );
    if (rebuilt.status !== 'ok' || rebuilt.details.quality !== 'exact') {
      throw new Error(
        `The R${Number(blend.radius.toPrecision(6))} blend could not be rebuilt exactly along the resized wall.`
      );
    }
    output = rebuilt.value;
  });
  requireValidSolid(
    kernel,
    output,
    'Rebuilding the blends along the resized wall does not produce a valid solid.'
  );

  // Every rebuilt band must be a proven region of a recorded class and
  // radius, and every recorded band must be back.
  const walls = wallsAt(output, input.newRadius);
  const rebuilt = new Map<string, { surfaceClass: string; radius: number }>();
  for (const face of neighbours(kernel, output, walls)) {
    if (surfaceTypeOf(kernel, face) === 'plane') continue;
    const region = measureBlendRegion(kernel, output, face);
    if (!region) {
      throw new Error('A rebuilt blend is not an exact constant-radius band.');
    }
    rebuilt.set(region.faces.join(','), {
      surfaceClass: surfaceTypeOf(kernel, face),
      radius: region.radius
    });
  }
  const pending = [...rebuilt.values()];
  for (const blend of input.blends) {
    const index = pending.findIndex(
      (band) =>
        band.surfaceClass === blend.carrier.surfaceClass &&
        Math.abs(band.radius - blend.radius) <=
          Math.max(blend.radius * 1e-5, 1e-9)
    );
    if (index < 0) {
      throw new Error(
        `The R${Number(blend.radius.toPrecision(6))} ${blend.carrier.surfaceClass} blend was not rebuilt along the wall.`
      );
    }
    pending.splice(index, 1);
  }
  if (pending.length > 0) {
    throw new Error('Rebuilding the blends added a band the wall did not have.');
  }

  // The material the removal took and the material the re-blend puts back
  // differ only by the band's centroid moving with the wall, so they must
  // have opposite signs and comparable size.
  const removed = volume(sharp) - volume(input.solid);
  const restored = volume(output) - volume(resized);
  if (
    removed === 0 ||
    Math.sign(removed) !== -Math.sign(restored) ||
    Math.abs(restored) < Math.abs(removed) / REBLEND_VOLUME_RATIO ||
    Math.abs(restored) > Math.abs(removed) * REBLEND_VOLUME_RATIO
  ) {
    throw new Error(
      `Rebuilding the blends changed the volume by ${Number(restored.toPrecision(6))}; removing them changed it by ${Number(removed.toPrecision(6))}.`
    );
  }
  return output;
}

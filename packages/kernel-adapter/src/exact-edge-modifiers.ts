/**
 * Fillet/chamfer application and its failure diagnosis: the size probe that
 * finds whether a smaller modifier would succeed, the blend-subset remedy,
 * and the user-facing failure message. Kernel-mutating, but stateless.
 */
import type { FaceEvolutionPayloadV1, RemusKernel } from './remus-runtime';
import { GEOMETRY_LINEAR_TOLERANCE } from '@openzcad/geometry';
import { GEOMETRY_EPSILON, errorText } from './exact-math';
import { MEASUREMENT_DEFLECTION, edgeSampleOf } from './exact-witnesses';
import { selectionTouchesBlendFace } from './exact-brep';

/**
 * Fractions of a refused fillet/chamfer size retried to tell a size-bound
 * failure from a structural one. A ladder rather than one probe because the
 * kernel has a small-feature floor as well as a large-feature limit, so a
 * single deep probe can fail on a selection that a halved size would carry.
 */
export const EDGE_MODIFIER_PROBE_RATIOS = [1 / 2, 1 / 8, 1 / 64] as const;

/**
 * Run one edge modifier and apply every acceptance rule the adapter ships a
 * result under, returning `null` when the kernel refused or produced a body
 * this adapter will not accept.
 *
 * This is the single definition of "the edit worked". The failure classifier
 * probes through it too, so a probe can never accept a result the real edit
 * would have rejected — which is exactly how a truthful "try a smaller size"
 * turns into a lie.
 */
export function applyEdgeModifier(
  kernel: RemusKernel,
  target: number,
  selected: number[],
  featureKind: 'fillet' | 'chamfer',
  size: number,
  /** Receives the kernel's own refusal text, when it threw one. */
  reportRefusal?: (message: string) => void,
  /** Receives construction history only after the same result is accepted. */
  reportEvolution?: (payload: FaceEvolutionPayloadV1) => void,
  /** Chamfer only: bevel angle in radians, strictly inside (0, π/2). */
  chamferAngleRadians?: number
): number | null {
  const targetBounds = kernel.boundingBox(target);
  const handles = Uint32Array.from(selected);
  let modified: number;
  let evolution: FaceEvolutionPayloadV1 | undefined;
  if (featureKind === 'fillet') {
    try {
      if (reportEvolution) {
        try {
          evolution = kernel.filletWithEvolution(target, handles, size);
          modified = evolution.result.solid;
        } catch {
          modified = kernel.fillet(target, handles, size);
        }
      } else {
        modified = kernel.fillet(target, handles, size);
      }
    } catch (error) {
      // Keep what the kernel said. It names the edges it could not blend, the
      // vertex the blend engines gave up on, and how many of the selection
      // would round on their own — none of which can be recovered by
      // inspecting the inputs afterwards.
      reportRefusal?.(errorText(error));
      modified = target;
    }
  } else {
    try {
      if (chamferAngleRadians !== undefined) {
        if (reportEvolution) {
          try {
            evolution = kernel.chamferDistanceAngleWithEvolution(
              target,
              handles,
              size,
              chamferAngleRadians
            );
            modified = evolution.result.solid;
          } catch {
            modified = kernel.chamferDistanceAngle(
              target,
              handles,
              size,
              chamferAngleRadians
            );
          }
        } else {
          modified = kernel.chamferDistanceAngle(
            target,
            handles,
            size,
            chamferAngleRadians
          );
        }
      } else if (reportEvolution) {
        try {
          evolution = kernel.chamferWithEvolution(target, handles, size);
          modified = evolution.result.solid;
        } catch {
          modified = kernel.chamfer(target, handles, size);
        }
      } else {
        modified = kernel.chamfer(target, handles, size);
      }
    } catch (error) {
      reportRefusal?.(errorText(error));
      return null;
    }
  }
  // When a blend cannot be attached at all, Remus falls back to returning
  // the input handle. That is a failed feature, not a successful no-op.
  if (modified === target || kernel.validateSolidRelaxed(modified) !== 0) {
    return null;
  }
  if (featureKind === 'fillet') {
    // A fillet rounds material inside the target envelope. Remus can return
    // a closed but severely distorted fallback for an oversized radius,
    // expanding the body to the requested size. Reject that result rather
    // than guessing a radius limit from the selected edge's length: the valid
    // limit is set by its adjacent faces, and can be larger than half the
    // edge length.
    const modifiedBounds = kernel.boundingBox(modified);
    const boundsScale = [0, 1, 2].reduce(
      (maximum, axis) =>
        Math.max(maximum, targetBounds[axis + 3]! - targetBounds[axis]!),
      1
    );
    const tolerance = Math.max(
      GEOMETRY_EPSILON,
      boundsScale * GEOMETRY_LINEAR_TOLERANCE
    );
    if (
      modifiedBounds[0]! < targetBounds[0]! - tolerance ||
      modifiedBounds[1]! < targetBounds[1]! - tolerance ||
      modifiedBounds[2]! < targetBounds[2]! - tolerance ||
      modifiedBounds[3]! > targetBounds[3]! + tolerance ||
      modifiedBounds[4]! > targetBounds[4]! + tolerance ||
      modifiedBounds[5]! > targetBounds[5]! + tolerance
    ) {
      return null;
    }

    // A valid fillet changes material only inside a neighbourhood of its
    // selected edges. A closed, in-bounds fallback can still be corrupt: the
    // partial-revolve blender has returned an internally doubled solid with
    // twice the source volume. Bound the possible change by a deliberately
    // generous radius-2r tube plus one radius-2r ball per selected edge. This
    // scales as volume, allows concave as well as convex blends, and rejects
    // topology duplication that bounds and relaxed validation cannot see.
    const neighbourhoodRadius = size * 2;
    const selectedLength = selected.reduce(
      (total, edge) => total + kernel.edgeLength(edge),
      0
    );
    const volumeEnvelope =
      Math.PI * neighbourhoodRadius ** 2 * selectedLength +
      selected.length * ((4 / 3) * Math.PI * neighbourhoodRadius ** 3);
    const targetVolume = kernel.volume(target, MEASUREMENT_DEFLECTION);
    const modifiedVolume = kernel.volume(modified, MEASUREMENT_DEFLECTION);
    const volumeTolerance = Math.max(1, Math.abs(targetVolume)) * 1e-6;
    if (
      Math.abs(modifiedVolume - targetVolume) >
      volumeEnvelope + volumeTolerance
    ) {
      return null;
    }
  }
  if (evolution) {
    reportEvolution?.(evolution);
  }
  return modified;
}

/**
 * True when the same selection is ACCEPTED at some size below the one that
 * failed, which is the only sound evidence that a failure is size-bound
 * rather than structural. Runs on the failure path only.
 */
export function edgeModifierSucceedsSmaller(
  kernel: RemusKernel,
  target: number,
  selected: number[],
  featureKind: 'fillet' | 'chamfer',
  size: number
): boolean {
  return EDGE_MODIFIER_PROBE_RATIOS.some((ratio) => {
    const probe = size * ratio;
    if (!Number.isFinite(probe) || probe <= GEOMETRY_EPSILON) {
      return false;
    }
    try {
      return (
        applyEdgeModifier(kernel, target, selected, featureKind, probe) !== null
      );
    } catch {
      return false;
    }
  });
}

/**
 * Cause-aware failure message for an edge modifier the kernel refused.
 *
 * The kernel reports why its blender stopped, but not whether the selection
 * could ever work, so that question is answered the only way that is sound:
 * by retrying the same selection at a ladder of smaller sizes. A probe that
 * is accepted means the failure is size-bound and the actionable advice is a
 * smaller size. A ladder that fails everywhere means the cause is structural,
 * and it is named from the selection's topology — a closed rim, a corner
 * chain, or an edge ending on an existing blend.
 *
 * The probe is what keeps those structural messages true. They used to be
 * unconditional because corner chains and closed rims on a boolean-result
 * body failed at EVERY size (docs/qa/2026-08-01). The kernel's blend phases
 * changed that: on the plate from that investigation the hole rim now rounds
 * up to r2.24 and the corner chain up to r2, so an unconditional "cannot be
 * rounded at any radius" would now be false, and would bury the advice that
 * actually works.
 *
 * `partialRevolveTarget` is the one cause the selection's own topology cannot
 * reveal, because a wedge's edges look ordinary — plain lines and arcs, no
 * closed rim, no blend face. It is passed in from the build, where the
 * feature that produced the body is known. It is still reported only after
 * the size ladder has failed, so it never buries a working smaller size.
 */
/**
 * Turns the kernel's own blend refusal into the sentence a user can act on.
 *
 * The kernel reports how many of the named edges it could not blend and how
 * many would round on their own. That count is the whole remedy — deselect
 * the ones it named — and no amount of inspecting the selection afterwards
 * recovers it, so it is relayed rather than re-derived.
 */
export function blendSubsetRemedy(
  reported: string | null,
  featureKind: 'fillet' | 'chamfer'
): string | null {
  if (!reported) {
    return null;
  }
  const refused = /(\d+) of the edges named were not blended/.exec(reported);
  const roundable = /the (\d+) edge\(s\)[^,]*would round on their own/.exec(
    reported
  );
  if (!refused || !roundable) {
    return null;
  }
  const verb = featureKind === 'fillet' ? 'round' : 'chamfer';
  return (
    `${refused[1]} of them cannot be blended where two rounds would meet at a corner, ` +
    `and the kernel will not quietly drop them. The other ${roundable[1]} ${verb} on their own — ` +
    `deselect those ${refused[1]} and try again.`
  );
}

export function edgeModifierFailureMessage(
  kernel: RemusKernel,
  target: number,
  selected: number[],
  featureKind: 'fillet' | 'chamfer',
  size: number,
  partialRevolveTarget: boolean,
  /** What the kernel said when it refused, if it threw. */
  reported: string | null = null
): string {
  const label = featureKind === 'fillet' ? 'Fillet' : 'Chamfer';
  const dimension = featureKind === 'fillet' ? 'radius' : 'distance';
  const verb = featureKind === 'fillet' ? 'rounded' : 'chamfered';
  const prefix = `${label} could not be created on ${selected.length} selected edge${selected.length === 1 ? '' : 's'} with ${dimension} ${size}.`;
  try {
    if (
      edgeModifierSucceedsSmaller(kernel, target, selected, featureKind, size)
    ) {
      return `${prefix} Try a smaller ${dimension}.`;
    }
    // Named before the topology causes because it explains the whole body
    // rather than one selection: measured on an r=2..3, h=1 annulus, a 90
    // degree wedge refuses all 12 of its edges at every radius from 0.4 down
    // to 0.002, while the same profile at 360 rounds 4 of its 6.
    if (partialRevolveTarget) {
      return `${prefix} This body is a partial revolve, and the kernel cannot blend the edges of a revolved wedge at any ${dimension} yet — revolve a full turn and ${featureKind} the result, or apply the ${label.toLowerCase()} before the body is cut back to a wedge.`;
    }
    if (selected.some((edge) => edgeSampleOf(kernel, edge).closed)) {
      return `${prefix} Closed rim edges (such as hole rims) cannot be ${verb} on this body at any ${dimension} — deselect the rim edge and try again.`;
    }
    // Sharing a corner is NOT itself a refusal: all twelve edges of a plain
    // box meet at corners and round together at every radius tried. Only the
    // kernel knows which vertices its blend engines gave up on, so this cause
    // is claimed only when the kernel actually reported it.
    const subsetRemedy = blendSubsetRemedy(reported, featureKind);
    if (subsetRemedy) {
      return `${prefix} ${subsetRemedy}`;
    }
    if (reported?.includes('unsupported vertex blend')) {
      return `${prefix} Two of these rounds would run into each other at a shared corner, which the kernel cannot blend yet — ${featureKind} the edges in smaller groups that do not meet.`;
    }
    if (selectionTouchesBlendFace(kernel, target, selected)) {
      return `${prefix} Edges that end on an existing fillet or chamfer usually cannot be ${verb} afterwards — edit that earlier feature and add this edge to it instead. If that also fails, the kernel cannot blend this edge on this body yet.`;
    }
  } catch {
    // Diagnosis is best-effort; fall through to the generic message.
  }
  return `${prefix} Try a smaller ${dimension}.`;
}

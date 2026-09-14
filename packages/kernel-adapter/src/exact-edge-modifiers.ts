/**
 * Fillet/chamfer application and its failure diagnosis: the size probe that
 * finds whether a smaller modifier would succeed, the blend-subset remedy,
 * and the user-facing failure message. Kernel-mutating, but stateless.
 */
import type { FaceEvolutionPayloadV1, RemusKernel } from './remus-runtime';
import { GEOMETRY_LINEAR_TOLERANCE } from '@openzcad/geometry';
import { GEOMETRY_EPSILON, errorText } from './exact-math';
import { MEASUREMENT_DEFLECTION, edgeSampleOf } from './exact-witnesses';
import { countBlendFaces, selectionTouchesBlendFace } from './exact-brep';

/**
 * Fractions of a refused fillet/chamfer size retried to tell a size-bound
 * failure from a structural one. A ladder rather than one probe because the
 * kernel has a small-feature floor as well as a large-feature limit, so a
 * single deep probe can fail on a selection that a halved size would carry.
 *
 * All three rungs still discriminate on the pinned kernel, measured on a
 * 30x18x24 box with all twelve edges selected: the refusal is
 * `unsupported-vertex-blend` at every size from r9 up, and the first rung
 * that is accepted is 1/2 at size 16, 1/8 at size 20 and 1/64 at size 100.
 * None of them can be dropped without turning a true "try a smaller radius"
 * into a false structural claim. What the ladder no longer has to do blind is
 * find the ceiling — see {@link blendCliffLimit}.
 */
export const EDGE_MODIFIER_PROBE_RATIOS = [1 / 2, 1 / 8, 1 / 64] as const;

/**
 * The largest size the kernel's blend engine says this selection can carry,
 * read out of its own refusal, or `null` when it named none.
 *
 * Remus B23 made fillet one cascade — the walking engine, then a guarded
 * rolling-ball rebuild, each transactional — and a size-bound refusal now
 * comes back typed and measured:
 *
 *   `cliff-encountered: blend: blend cliff on face Id(0) at edge Id(0):
 *    requested radius 30, available radius 18`
 *
 * The kernel computed that ceiling from the support faces. It is not
 * re-derived here, and it is not guessed from the edge length — the old
 * comment on the bounds guard below says why that guess is wrong. It is used
 * ONLY to aim the probe ladder, which still has to prove a smaller size is
 * actually ACCEPTED: the cliff is the first thing the cascade hit, not a
 * promise that nothing else fails underneath it. Measured on the pin, the
 * reported ceiling is exclusive (r18 refuses, r17.999 builds).
 *
 * It is also per-face, and not monotone in the requested size: a 50x50x2
 * plate refuses r60 on one edge with `available radius 50` and r30 on the
 * SAME edge with `available radius 2`, while r2 still refuses. So a reported
 * ceiling is evidence about where the cascade stopped this time, not a limit
 * to hand back to a user — `edgeModifierFailureMessage` never quotes it, and
 * quotes the probed size instead.
 */
export function blendCliffLimit(reported: string | null): number | null {
  if (!reported?.startsWith('cliff-encountered')) {
    return null;
  }
  const match = /available radius ([0-9.eE+-]+)/.exec(reported);
  const limit = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(limit) && limit > 0 ? limit : null;
}

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
  /**
   * Receives the refusal text: the kernel's own when it threw one, and this
   * adapter's when it declined a result the kernel was willing to return.
   */
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

    // A fillet that came back as a chamfer is not a fillet. Remus used to
    // drop to a flat planar bevel when no blend engine could round the
    // selection, and the result passed every check above it: a bevel is
    // closed, valid, inside the target envelope and removes LESS than the
    // neighbourhood volume a round would. Only the surfaces tell the two
    // apart, so they are what is asked. A round leaves a band tangent to the
    // faces it joins; a bevel leaves planes. Measured on the pin, every
    // accepted fillet gains at least one band (a plain box 0 -> 12, a
    // cylinder rim 0 -> 1, a filleted box re-filleted 1 -> 2) and every
    // chamfer gains none (0 -> 0).
    //
    // B23 removed that fallback, so this guard is expected never to fire on
    // the pinned kernel. It stays because the alternative to refusing is
    // shipping a chamfer under a fillet feature's name, and the size probe
    // runs through here too — a probe accepted on a bevel would turn "try a
    // smaller radius" into advice that silently produces the wrong shape.
    if (countBlendFaces(kernel, modified) <= countBlendFaces(kernel, target)) {
      reportRefusal?.(
        'fillet produced no blend band: the result is bevelled rather than rounded'
      );
      return null;
    }
  }
  if (evolution) {
    reportEvolution?.(evolution);
  }
  return modified;
}

/**
 * A probe size rounded DOWN to four significant digits, so that the size the
 * ladder proved is also a size worth printing. Rounding down keeps the probe
 * inside whatever bound produced it; rounding to nearest could step back over
 * a ceiling the kernel just refused.
 */
function probeSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return Number.NaN;
  }
  const scale = 10 ** (3 - Math.floor(Math.log10(value)));
  return Math.floor(value * scale) / scale;
}

/**
 * The distance an ANGLED chamfer's probe ladder is measured down from.
 *
 * `chamferDistanceAngle(d, a)` takes `d` off the first face and `d·tan(a)`
 * off the second, and the kernel says so in its own refusal: on a 30x18x24
 * box, `d=10, a=80°` reports `56.712818 of material must be taken from an
 * edge only 24.000000 long`, and 10·tan80° = 56.712818 exactly; `d=2.5,
 * a=85°` reports 28.575131 = 2.5·tan85°. So past 45° the requested distance
 * understates the cut by a factor of tan(a) — at 88° by a factor of 28.6 —
 * and a ladder of 1/2, 1/8, 1/64 of that distance is aimed an order of
 * magnitude too high.
 *
 * Aim it instead at the distance whose DEEPER setback is the distance asked
 * for, so the rungs remove about what the same ladder removes on a symmetric
 * chamfer. Like the kernel's cliff ceiling this only aims: every rung is
 * still proved by {@link applyEdgeModifier} at the requested angle, so a bad
 * aim costs a rung and never a false claim.
 *
 * Measured on the pin over 1232 refused angled chamfers (five bodies, every
 * edge of each, seven angles from 60° to 89.5°, five distances): aiming finds
 * a proven distance in 412 cases where the unaimed ladder finds none, and
 * loses none the unaimed ladder found. At or below 45° the tangent is at most 1 and the
 * distance itself is the deeper setback, so nothing is moved.
 */
export function chamferLadderAim(
  size: number,
  chamferAngleRadians: number | undefined
): number {
  if (chamferAngleRadians === undefined) {
    return size;
  }
  const tangent = Math.tan(chamferAngleRadians);
  return Number.isFinite(tangent) && tangent > 1 ? size / tangent : size;
}

/**
 * The largest size on the ladder at which this selection is ACCEPTED, or
 * `null` when none is — the only sound evidence that a failure is size-bound
 * rather than structural. Runs on the failure path only.
 *
 * `chamferAngleRadians` is the bevel angle the user asked for, and the ladder
 * is walked WITH it for the reason the probe exists at all: the size it
 * returns is the size the message quotes, so it has to be a size for the
 * operation actually requested. A symmetric probe under an angled request
 * quotes a distance the angled chamfer refuses — on a 30x18x24 box distance
 * 10 builds symmetrically and is refused at 80°, so `distance 10 builds here`
 * sent the user round the same refusal.
 *
 * `ceiling` is the size the kernel itself named as the most its blend can
 * carry here, when its refusal named one. The ladder is then measured down
 * from the ceiling rather than from the refused size, which is what turns the
 * common oversized-radius failure from three kernel round-trips into one: a
 * request far above the limit used to spend the whole ladder walking down to
 * it, while half the kernel's own ceiling is accepted on the first rung.
 *
 * The probe is still run rather than replaced by the ceiling, and the SIZE it
 * returns is the only one the message quotes, because the kernel's ceiling is
 * neither a working value nor reliably a bound. Three things sit below it:
 * the cascade reports where it stopped FIRST, the face it stopped on changes
 * with the requested size, and this adapter's own acceptance rules are
 * stricter than the kernel's. Measured on the pin, a 30x18x24 box refuses a
 * 30 fillet with "available radius 18", and the kernel will indeed build
 * r17.999 — as a body 2x the height of its input, which the bounds guard
 * above rejects. On a 50x50x2 plate the reported ceiling falls from 50 to 2
 * between r60 and r30 on one edge, and 2 still refuses.
 *
 * Being wrong about the ceiling therefore costs at most a wasted rung here,
 * which is why it is used at this end and not in the sentence.
 */
export function acceptedEdgeModifierProbe(
  kernel: RemusKernel,
  target: number,
  selected: number[],
  featureKind: 'fillet' | 'chamfer',
  size: number,
  ceiling: number | null = null,
  /** Chamfer only: the bevel angle in radians the refused request carried. */
  chamferAngleRadians?: number
): number | null {
  const angle = featureKind === 'chamfer' ? chamferAngleRadians : undefined;
  const bounded = ceiling === null ? size : Math.min(size, ceiling);
  const from = chamferLadderAim(bounded, angle);
  for (const ratio of EDGE_MODIFIER_PROBE_RATIOS) {
    const probe = probeSize(from * ratio);
    if (!Number.isFinite(probe) || probe <= GEOMETRY_EPSILON) {
      continue;
    }
    try {
      if (
        applyEdgeModifier(
          kernel,
          target,
          selected,
          featureKind,
          probe,
          undefined,
          undefined,
          angle
        ) !== null
      ) {
        return probe;
      }
    } catch {
      // A throw is a refusal like any other; keep walking the ladder.
    }
  }
  return null;
}

/**
 * Cause-aware failure message for an edge modifier the kernel refused.
 *
 * The kernel reports why its blender stopped, and since Remus B23 a
 * size-bound fillet refusal also reports the ceiling it stopped at. What it
 * still does not report is whether the selection could ever work, so that
 * question is answered the only way that is sound: by retrying the same
 * selection at a ladder of smaller sizes, aimed at the kernel's ceiling when
 * it named one. A probe that is accepted means the failure is size-bound and
 * the actionable advice is a smaller size — named exactly, because the ladder
 * built it. A ladder that fails everywhere means the cause is structural,
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
  reported: string | null = null,
  /**
   * Chamfer only: the bevel angle in radians the refused request carried. It
   * has to reach the ladder, or the sentence quotes a distance proved for the
   * symmetric chamfer and refused by the one the user asked for.
   */
  chamferAngleRadians?: number
): string {
  const label = featureKind === 'fillet' ? 'Fillet' : 'Chamfer';
  const dimension = featureKind === 'fillet' ? 'radius' : 'distance';
  const verb = featureKind === 'fillet' ? 'rounded' : 'chamfered';
  const prefix = `${label} could not be created on ${selected.length} selected edge${selected.length === 1 ? '' : 's'} with ${dimension} ${size}.`;
  // Used to aim the ladder only — see the size-bound branch below for why it
  // is never quoted.
  const cliffLimit = blendCliffLimit(reported);
  try {
    const accepted = acceptedEdgeModifierProbe(
      kernel,
      target,
      selected,
      featureKind,
      size,
      cliffLimit,
      chamferAngleRadians
    );
    if (accepted !== null) {
      // Only the probed size is quoted, and the kernel's reported ceiling
      // never is. The ceiling is per-face and is NOT monotone in the
      // requested size, so it is not a bound on what works: on a 50x50x2
      // plate, one edge, the refusal at r60 names `available radius 50`
      // (the long face) while r30 on the same edge names `available radius
      // 2` (the thickness), and r2 still refuses — the real limit there is
      // between 1 and 2. Quoting 50 would send a user round the same
      // refusal at 40, at 20 and at 5. The ceiling still aims the ladder,
      // where being wrong only costs a rung; it does not go in the
      // sentence, where being wrong is bad advice.
      //
      // The probed size is quotable because the probe ran the operation the
      // user asked for, angle and all. Quoting a size proved for a DIFFERENT
      // operation is the same defect wearing the kernel's clothes: distance
      // 10 builds symmetrically on a 30x18x24 box and is refused at 80°.
      return `${prefix} Try a smaller ${dimension}: ${dimension} ${accepted} builds here.`;
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

import { WAKE_STEP_S } from '../motion';

/**
 * The post-release orbit and pan glide, as a function of wall-clock time.
 *
 * OrbitControls damps per rendered frame: each `update()` applies
 * `dampingFactor` of the residual rotation and pan, then keeps the rest. A
 * fixed factor therefore ties the coast's length to the frame rate and, for a
 * fast flick, to how long the residue takes to fall below the controls'
 * movement epsilon: a fast flick drew for about 800 ms after release.
 *
 * Instead the glide consumes the residue along one normalised exponential:
 * by `t` ms after release the share played out is
 *
 *   F(t) = (1 − e^(−t/τ)) / (1 − e^(−T/τ)),  F(T) = 1
 *
 * so speed decays monotonically with time constant τ, the camera never moves
 * past the pose the residue implies (no overshoot), and at T it lands exactly
 * and stops. The total travel is the residue itself, unchanged; only its
 * timing is bounded. Each frame applies the share of what is still left, so
 * any frame rate traces the same curve and a slow frame simply lands further
 * along it.
 */

/** Decay time constant: ≈0.80× speed per 60 Hz frame. */
export const ORBIT_GLIDE_TAU_MS = 75;
/** Hard cap on the glide: the camera is at rest this long after release. */
export const ORBIT_GLIDE_MAX_MS = 200;

const NOMINAL_FRAME_MS = 1000 / 60;
const TAIL = Math.exp(-ORBIT_GLIDE_MAX_MS / ORBIT_GLIDE_TAU_MS);

/** Share of the release residue played out by `elapsedMs`, in [0, 1]. */
export function orbitGlideProgress(elapsedMs: number): number {
  if (!(elapsedMs > 0)) {
    return 0;
  }
  if (elapsedMs >= ORBIT_GLIDE_MAX_MS) {
    return 1;
  }
  return (1 - Math.exp(-elapsedMs / ORBIT_GLIDE_TAU_MS)) / (1 - TAIL);
}

/**
 * The damping factor for one frame that advances the glide from `fromMs` to
 * `toMs`: the share of the residue still held at `fromMs` that this frame
 * must apply. Returns 1 once `toMs` reaches the cap, so the frame lands it.
 */
export function orbitGlideStepFraction(fromMs: number, toMs: number): number {
  const before = orbitGlideProgress(fromMs);
  const after = orbitGlideProgress(toMs);
  if (after >= 1) {
    return 1;
  }
  return Math.max(0, (after - before) / (1 - before));
}

/**
 * Glide time a frame advances. The first frame after release measures from
 * the last drag frame, bounded like any wake-up step so a loop that slept
 * through a held pointer does not skip the glide; it never advances zero, so
 * the release frame always moves. Later frames take the real gap.
 */
export function orbitGlideFrameMs(gapMs: number, firstStep: boolean): number {
  if (firstStep) {
    return gapMs > 0 ? Math.min(gapMs, WAKE_STEP_S * 1000) : NOMINAL_FRAME_MS;
  }
  return gapMs > 0 ? gapMs : 0;
}

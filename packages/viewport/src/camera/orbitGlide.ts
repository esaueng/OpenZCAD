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
 * timing is bounded. Each frame applies the share of what is still left at
 * its wall-clock time since release, so any frame rate traces the same curve
 * and a slow frame simply lands further along it.
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
 * Glide time at a frame: the wall-clock time since release, so the residue
 * lands on the first frame at or past the cap at any frame rate, however slow.
 * The first frame after release never reads less than one frame step (the gap
 * since the last drag frame, bounded like any wake-up step, or a nominal
 * frame without one): a frame timestamp can predate the pointer-up event, and
 * the release frame must still move. The clock never runs backwards.
 */
export function orbitGlideElapsedMs(
  previousElapsedMs: number | null,
  sinceReleaseMs: number,
  frameGapMs: number
): number {
  const sinceRelease = sinceReleaseMs > 0 ? sinceReleaseMs : 0;
  if (previousElapsedMs === null) {
    const firstStep =
      frameGapMs > 0
        ? Math.min(frameGapMs, WAKE_STEP_S * 1000)
        : NOMINAL_FRAME_MS;
    return Math.max(sinceRelease, firstStep);
  }
  return Math.max(sinceRelease, previousElapsedMs);
}

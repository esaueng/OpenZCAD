/**
 * The viewport's motion vocabulary.
 *
 * Everything that eases on screen should ease at one of these rates, and the
 * numbers deliberately match the CSS tokens the chrome uses
 * (`--dur-fast`, `--dur-base`, `--dur-slow` in `theme/tokens.css`) so a
 * highlight in the scene and a panel beside it settle together instead of
 * each landing on whatever constant its author picked.
 *
 * The 3D layer cannot use CSS transitions: it eases per rendered frame,
 * frame-rate independent, through `easeToward`.
 */

/** Matches `--dur-fast`. Hover response, handle entrances, cursor states. */
export const DUR_FAST_MS = 100;
/** Matches `--dur-base`. Selection changes, panel-scale transitions. */
export const DUR_BASE_MS = 200;
/** Matches `--dur-slow`. Reserved for the largest state changes. */
export const DUR_SLOW_MS = 350;

/**
 * Below this delta an eased value has visually arrived. Callers snap to the
 * target and stop stepping, which is also what ends the render loop's
 * settling frames.
 */
export const SETTLE_EPSILON = 0.004;

/**
 * Time constant of the exponential approach, in milliseconds. A value reaches
 * ~95% of its target in about three of these, so 60 ms lands within
 * `DUR_FAST_MS` — the ramp reads as immediate without stepping.
 */
const TAU_MS = 60;

/**
 * Advances `current` toward `target` for one frame of `dtMs`.
 *
 * Exponential rather than linear so it is frame-rate independent: the same
 * gesture settles in the same wall-clock time at 60 Hz and at 120 Hz, and a
 * dropped frame does not leave the value behind. Interrupting a ramp needs no
 * bookkeeping — retarget and the next step eases from wherever it is.
 */
export function easeToward(
  current: number,
  target: number,
  dtMs: number
): number {
  if (dtMs <= 0) {
    return current;
  }
  const next = current + (target - current) * (1 - Math.exp(-dtMs / TAU_MS));
  return Math.abs(target - next) < SETTLE_EPSILON ? target : next;
}

/**
 * Longest step a frame woken from sleep may take, in seconds. The render loop
 * is on demand, so the clock gap before a wake-up frame is how long the scene
 * sat still, not how long anything has been animating: a fade that starts on
 * that frame takes this one nominal step, so it is seen to begin.
 */
export const WAKE_STEP_S = 0.05;

/**
 * Longest step a frame of a running animation may take, in seconds. Matches
 * `DUR_SLOW_MS`, the largest motion in the vocabulary: a frame that took
 * longer has missed the whole transition, so landing it is the honest result.
 * The cap only guards against gaps no transition needs (a hidden tab).
 */
export const MAX_ANIMATION_STEP_S = DUR_SLOW_MS / 1000;

/**
 * The time, in seconds, one rendered frame advances every eased value.
 *
 * `elapsedS` is the clock gap since the previous frame; `continuing` says
 * whether that frame kept the loop awake (something was still easing). A
 * running animation advances by the real gap so a slow frame does not leave
 * values behind — clamping it to a fraction of a frame made every fade cost a
 * fixed count of frames, so on a machine drawing a frame every 400 ms (a
 * software renderer) one 200 ms highlight took seven frames and three seconds.
 */
export function animationStepSeconds(
  elapsedS: number,
  continuing: boolean
): number {
  if (!(elapsedS > 0)) {
    return 0;
  }
  return Math.min(elapsedS, continuing ? MAX_ANIMATION_STEP_S : WAKE_STEP_S);
}

/**
 * The step, in milliseconds, for one eased value this frame. A fade that was
 * just created or retargeted takes at most the wake step on its first frame,
 * however long that frame was, so it is seen to begin even while an older
 * animation keeps the loop running on real elapsed time. Every later frame
 * of the same fade advances by the full step.
 */
export function fadeStepMs(dtMs: number, firstStep: boolean): number {
  return firstStep ? Math.min(dtMs, WAKE_STEP_S * 1000) : dtMs;
}

/**
 * Whether an eased value has arrived, for callers that must decide to stop
 * stepping or hide an overlay.
 */
export function hasSettled(current: number, target: number): boolean {
  return Math.abs(target - current) < SETTLE_EPSILON;
}

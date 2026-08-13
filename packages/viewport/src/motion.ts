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
 * Whether an eased value has arrived, for callers that must decide to stop
 * stepping or hide an overlay.
 */
export function hasSettled(current: number, target: number): boolean {
  return Math.abs(target - current) < SETTLE_EPSILON;
}

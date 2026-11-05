/**
 * How much rendering a touch device is asked for (L02 slice 8,
 * docs/plans/ipad-touch-plan-2026-11-05.md). Desktop pointers keep the
 * renderer exactly as tuned; these decisions apply to coarse pointers only.
 */

/** The key light's shadow map edge, in texels, on a desktop. */
export const SHADOW_MAP_SIZE = 3072;
/**
 * The edge on a touch-first device: a 3072² depth map is about 38 MB of GPU
 * memory, a 2048² one about 17 MB, which an iPad's shared memory budget
 * (and the tab's ceiling) feels long before the shadow's softness shows.
 */
export const TOUCH_SHADOW_MAP_SIZE = 2048;

export function shadowMapSizeFor(coarsePointer: boolean): number {
  return coarsePointer ? TOUCH_SHADOW_MAP_SIZE : SHADOW_MAP_SIZE;
}

/** Pixel ratio a struggling device navigates at; the full ratio returns at rest. */
export const NAVIGATION_PIXEL_RATIO = 1.25;
/** Below 45 frames a second, a moving view trades sharpness for motion. */
export const SLOW_FRAME_MS = 1000 / 45;

/**
 * The pixel ratio to navigate at, or null to keep the current one: only a
 * device already dropping frames, and only when that is actually lower.
 */
export function navigationPixelRatio(
  devicePixelRatio: number,
  frameIntervalMs: number | null
): number | null {
  return frameIntervalMs !== null &&
    frameIntervalMs > SLOW_FRAME_MS &&
    devicePixelRatio > NAVIGATION_PIXEL_RATIO
    ? NAVIGATION_PIXEL_RATIO
    : null;
}

/**
 * A smoothed frame interval, from frames drawn back to back only: the
 * render loop sleeps when nothing moves, and the gap across a sleep is not
 * a frame's cost.
 */
export class FrameIntervalMeter {
  private last: number | null = null;
  private average: number | null = null;

  /** `continuous` is false for the first frame after the loop slept. */
  sample(now: number, continuous: boolean) {
    const previous = this.last;
    this.last = now;
    if (!continuous || previous === null) return;
    const interval = now - previous;
    if (!(interval > 0) || !Number.isFinite(interval)) return;
    this.average =
      this.average === null ? interval : this.average * 0.8 + interval * 0.2;
  }

  /** Milliseconds per frame while animating, or null before any were seen. */
  get intervalMs(): number | null {
    return this.average;
  }
}

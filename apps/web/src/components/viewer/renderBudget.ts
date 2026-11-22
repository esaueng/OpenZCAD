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

/** The highest backing-store pixel ratio the viewport draws at. */
export const MAX_VIEWPORT_PIXEL_RATIO = 2;

/**
 * How the viewport's WebGL context antialiases.
 *
 * At a device pixel ratio of 2 or more the backing store already holds four
 * pixels per CSS pixel, and 4× MSAA on top of it adds little visible
 * smoothing while costing about 137 MiB of settled VRAM (measured on an
 * RX 6600 at DPR 2, beta 2026.1.152). Such a desktop context is therefore
 * created without MSAA and *supersampled* instead: it keeps a backing ratio
 * of 2 whatever the display reports later. WebGL fixes `antialias` when the
 * context is created, while the ratio changes when the window moves to
 * another display or the page is zoomed; holding the ratio at 2 means a
 * move to a 1× display or a zoom-out stays as smooth as it is today
 * (roughly the memory of 4× MSAA at 1×, more fragment work), rather than
 * turning jagged. For the same reason a supersampled context never lowers
 * its resolution while navigating: below 2 it would have no antialiasing
 * at all, which today's 1.25× navigation with MSAA does not look like.
 *
 * Touch-first devices keep MSAA: they are the ones that rely on the lower
 * navigation ratio to keep a moving view fluid, and their tiled GPUs
 * resolve multisampling on chip. A profile without antialiasing (e2e
 * builds) is left exactly as it is.
 */
export interface ViewportSampling {
  /** The WebGL context's `antialias` attribute. */
  readonly antialias: boolean;
  /** Antialiasing comes from a fixed 2× backing store instead of MSAA. */
  readonly supersampled: boolean;
}

export function viewportSampling(
  profileAntialias: boolean,
  devicePixelRatio: number,
  coarsePointer: boolean
): ViewportSampling {
  const supersampled =
    profileAntialias &&
    !coarsePointer &&
    devicePixelRatio >= MAX_VIEWPORT_PIXEL_RATIO;
  return { antialias: profileAntialias && !supersampled, supersampled };
}

/** The backing-store ratio the viewport draws at rest. */
export function viewportPixelRatio(
  sampling: ViewportSampling,
  devicePixelRatio: number
): number {
  return sampling.supersampled
    ? MAX_VIEWPORT_PIXEL_RATIO
    : Math.min(devicePixelRatio, MAX_VIEWPORT_PIXEL_RATIO);
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

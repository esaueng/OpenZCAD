/** Viewport sampling and frame budgets for still views and camera navigation. */

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
 * turning jagged. Slow navigation may temporarily reduce the backing ratio.
 * The first still frame restores full supersampling.
 *
 * Touch-first devices keep MSAA: they are the ones that rely on the lower
 * navigation ratio to keep a moving view fluid, and their tiled GPUs
 * resolve multisampling on chip. A profile without antialiasing (e2e
 * builds) is left exactly as it is.
 */
export interface ViewportSampling {
  /** The WebGL context's `antialias` attribute. */
  readonly antialias: boolean;
  /** Antialiasing comes from a full-resolution 2× backing store instead of MSAA. */
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

/**
 * The ratio an image export sizes and styles itself by: the display's own,
 * capped as the live view is. A supersampled viewport moved to a 1× display
 * still draws at 2×, but its default export size and its screen-pixel
 * styling (section hatch pitch) stay what that display gave before.
 */
export function displayPixelRatio(devicePixelRatio: number): number {
  return Math.min(devicePixelRatio, MAX_VIEWPORT_PIXEL_RATIO);
}

/**
 * Run `draw` with `renderer.getPixelRatio()` reporting `ratio`, then put the
 * renderer's own reading back. three.js sizes its canvas from its private
 * ratio, so only code that asks the renderer (shader uniforms set in
 * `onBeforeRender`) sees the override; the canvas is never resized.
 */
export function withReportedPixelRatio<T>(
  renderer: { getPixelRatio(): number },
  ratio: number,
  draw: () => T
): T {
  const own = renderer.getPixelRatio;
  if (own.call(renderer) === ratio) return draw();
  renderer.getPixelRatio = () => ratio;
  try {
    return draw();
  } finally {
    renderer.getPixelRatio = own;
  }
}

/** Pixel ratio a struggling device navigates at; the full ratio returns at rest. */
export const NAVIGATION_PIXEL_RATIO = 1.25;
/** Below 45 frames a second, a moving view trades sharpness for motion. */
export const SLOW_FRAME_MS = 1000 / 45;
export const SEVERE_FRAME_MS = 4 * SLOW_FRAME_MS;

/**
 * The pixel ratio to navigate at, or null to keep the current one: only a
 * device already dropping frames, and only when that is actually lower.
 */
export function navigationPixelRatio(
  devicePixelRatio: number,
  frameIntervalMs: number | null
): number | null {
  if (
    frameIntervalMs === null ||
    !Number.isFinite(frameIntervalMs) ||
    frameIntervalMs <= SLOW_FRAME_MS
  )
    return null;
  // Below roughly 11 FPS, render fewer than one sample per CSS pixel.
  const cap = frameIntervalMs > SEVERE_FRAME_MS ? 0.75 : NAVIGATION_PIXEL_RATIO;
  return cap < devicePixelRatio ? cap : null;
}

/** Two consecutive slow moving intervals at one ratio can lower it.
 * Grow the backing store again only on the first frame at rest.
 */
export class NavigationResolution {
  private lastFrame: number | null = null;
  private previousInterval: number | null = null;
  private limitedRatio: number | null = null;

  reset() {
    this.lastFrame = null;
    this.previousInterval = null;
    this.limitedRatio = null;
  }

  ratio(
    now: number,
    moving: boolean,
    fullRatio: number,
    fullDrawGpuMs: number | null = null
  ): number {
    if (!moving) {
      this.reset();
      return fullRatio;
    }
    // Measured full-size GPU cost or a still-unfinished full-size draw can
    // qualify navigation before the backlog reaches the animation clock.
    if (fullDrawGpuMs !== null && fullDrawGpuMs > SEVERE_FRAME_MS) {
      this.limitedRatio = navigationPixelRatio(fullRatio, fullDrawGpuMs);
    }
    const currentRatio = Math.min(fullRatio, this.limitedRatio ?? fullRatio);
    if (this.lastFrame !== null) {
      const interval = now - this.lastFrame;
      const lower = navigationPixelRatio(
        currentRatio,
        this.previousInterval === null
          ? null
          : Math.min(this.previousInterval, interval)
      );
      if (lower !== null) this.limitedRatio = lower;
      // Measure two new intervals after a resize before reducing it again.
      this.previousInterval = lower === null ? interval : null;
    }
    this.lastFrame = now;
    return Math.min(fullRatio, this.limitedRatio ?? fullRatio);
  }
}

/**
 * Velocity-adaptive wheel zoom, the way professional CAD navigation feels:
 * a single deliberate notch gives the same fine step it always has, while
 * spinning the wheel compounds each notch harder so crossing a large model
 * takes a flick instead of thirty clicks.
 *
 * OrbitControls reads `zoomSpeed` fresh on every wheel event, so the whole
 * mechanism is a per-event modulation of that one property. Recent wheel
 * input accumulates into a momentum that decays exponentially with the time
 * since the previous event; the multiplier is computed from the momentum
 * *carried into* the event, so an isolated tick — however hard — always
 * lands at the base speed and only sustained spinning accelerates.
 */

/** OrbitControls' stock speed; a lone wheel notch behaves exactly as before. */
export const ZOOM_BASE_SPEED = 1;
/** How quickly spin memory fades. ~180 ms ≈ two frames of wheel silence. */
export const ZOOM_ACCEL_TAU_MS = 180;
/** Extra speed per notch of surviving momentum. */
export const ZOOM_ACCEL_GAIN = 0.5;
/** Ceiling on the multiplier, so a long spin stays steerable. */
export const ZOOM_ACCEL_MAX = 4;

/**
 * One wheel notch expressed in `deltaY` pixels. Mirrors the normalisation
 * OrbitControls applies in `_customWheelEvent` (LINE ×16, PAGE ×100).
 */
const WHEEL_NOTCH_PX = 100;

export interface ZoomDynamicsState {
  /** Recent zoom input in wheel notches, decayed to this event's time. */
  momentum: number;
  /** Timestamp of the last wheel event, in `performance.now()` ms. */
  lastEventAt: number;
}

export function initialZoomDynamics(): ZoomDynamicsState {
  return { momentum: 0, lastEventAt: Number.NEGATIVE_INFINITY };
}

/** Normalises a wheel event's deltaY into notches, matching OrbitControls. */
export function wheelNotches(deltaY: number, deltaMode: number): number {
  const pixels =
    deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 100 : deltaY;
  return Math.abs(pixels) / WHEEL_NOTCH_PX;
}

/**
 * Advances the momentum for one wheel event and returns the `zoomSpeed` to
 * present to OrbitControls for it. Mutates nothing; callers own the state.
 */
export function stepZoomDynamics(
  state: ZoomDynamicsState,
  now: number,
  notches: number
): { state: ZoomDynamicsState; speed: number } {
  const dt = now - state.lastEventAt;
  const carried =
    dt > 0 && Number.isFinite(dt)
      ? state.momentum * Math.exp(-dt / ZOOM_ACCEL_TAU_MS)
      : state.momentum;
  const speed =
    ZOOM_BASE_SPEED *
    Math.min(1 + ZOOM_ACCEL_GAIN * carried, ZOOM_ACCEL_MAX);
  return {
    state: { momentum: carried + notches, lastEventAt: now },
    speed
  };
}

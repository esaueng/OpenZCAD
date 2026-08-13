/**
 * What a wheel event means.
 *
 * A mouse wheel and a trackpad both arrive as `wheel`, and the browser does
 * not say which one moved. CAD navigation needs them to mean different
 * things: a wheel notch zooms, two fingers on a trackpad pan, and a pinch
 * zooms. Getting that wrong in either direction is bad — a trackpad user who
 * cannot pan is stuck, and a mouse user whose wheel pans has lost zoom
 * entirely — so the classification is explicit, and overridable.
 */

export type WheelIntent = 'zoom' | 'pan';

export type PointerNavigationMode = 'auto' | 'mouse' | 'trackpad';

export interface WheelSample {
  deltaX: number;
  deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages. */
  deltaMode: number;
  /** Browsers synthesise ctrl for a trackpad pinch, on every platform. */
  ctrlKey: boolean;
}

/**
 * A wheel notch is coarse and vertical. Anything finer than this in pixel
 * mode is hard to produce with a notched wheel and easy to produce with a
 * finger, so it is the strongest single hint available without device APIs.
 */
const WHEEL_NOTCH_MIN_PX = 40;

/**
 * Classifies one wheel event.
 *
 * A pinch is unambiguous: the browser sets `ctrlKey` for it whether or not
 * the key is down, and it always means zoom. Everything else is a judgement
 * call, so the rules are ordered from most to least certain:
 *
 * 1. line or page deltas — only a wheel reports those;
 * 2. any horizontal component — a wheel has no horizontal axis;
 * 3. a small pixel delta — finer than a notch can produce.
 */
export function wheelIntent(
  sample: WheelSample,
  mode: PointerNavigationMode = 'auto'
): WheelIntent {
  if (sample.ctrlKey) {
    return 'zoom';
  }
  if (mode === 'mouse') {
    return 'zoom';
  }
  if (mode === 'trackpad') {
    return 'pan';
  }
  if (sample.deltaMode !== 0) {
    return 'zoom';
  }
  if (sample.deltaX !== 0) {
    return 'pan';
  }
  return Math.abs(sample.deltaY) < WHEEL_NOTCH_MIN_PX ? 'pan' : 'zoom';
}

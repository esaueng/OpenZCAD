/**
 * What a wheel event means.
 *
 * A mouse wheel and a trackpad both arrive as `wheel`, and the browser does
 * not say which one moved. CAD navigation needs them to mean different
 * things: a wheel notch zooms, two fingers on a trackpad pan, and a pinch
 * zooms. Getting that wrong in either direction is bad — a trackpad user who
 * cannot pan is stuck, and a mouse user whose wheel pans has lost zoom
 * entirely — so the classification is explicit, and overridable.
 *
 * No single event can tell the devices apart. macOS applies scroll
 * acceleration to a mouse wheel, so a slow notch reaches the page as a
 * handful of pixel-mode events as small as a finger produces, and the legacy
 * `wheelDeltaY` notch multiple that identifies a mouse on Windows collapses
 * onto the trackpad relation there too. What a mouse can never produce is
 * motion on both axes at once, or a pinch. Those two signals are the only
 * ones trusted, and each one is remembered: auto mode zooms on the wheel
 * until a diagonal swipe or a pinch proves a trackpad, and pans on vertical
 * motion from then on.
 */

export type WheelIntent = 'zoom' | 'pan';

export type PointerNavigationMode = 'auto' | 'mouse' | 'trackpad';

/** The pointing device a wheel event has proved, when it proves one. */
export type WheelDevice = 'mouse' | 'trackpad';

export interface WheelSample {
  deltaX: number;
  deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages. */
  deltaMode: number;
  /** Browsers synthesise ctrl for a trackpad pinch, on every platform. */
  ctrlKey: boolean;
  /**
   * Whether the physical Control key is known to be down. A ctrl-flagged
   * event without it is a pinch; with it, a mouse user zooming faster.
   */
  controlKeyHeld?: boolean;
}

/**
 * The longest silence inside one physical gesture. Trackpad streams and
 * momentum tails arrive every frame or two, and a spun wheel delivers
 * notches well inside this, so a longer gap starts a new gesture.
 */
export const WHEEL_BURST_GAP_MS = 200;

/**
 * What one event proves about the device, or null when it proves nothing.
 *
 * Line and page deltas come only from a wheel. Motion on both axes at once
 * comes only from a finger — a tilt wheel scrolls sideways, but never while
 * the main wheel turns, so a horizontal-only event proves nothing. A pinch
 * is a ctrl-flagged event while no Control key is down.
 */
export function wheelDeviceEvidence(sample: WheelSample): WheelDevice | null {
  if (sample.deltaMode !== 0) {
    return 'mouse';
  }
  if (sample.ctrlKey) {
    return sample.controlKeyHeld === false ? 'trackpad' : null;
  }
  if (sample.deltaX !== 0 && sample.deltaY !== 0) {
    return 'trackpad';
  }
  return null;
}

/**
 * Classifies one wheel event on its own.
 *
 * A pinch is unambiguous: the browser sets `ctrlKey` for it whether or not
 * the key is down, and it always means zoom. An explicit preference settles
 * everything else. In auto mode the rules run from most to least certain:
 *
 * 1. line or page deltas — only a wheel reports those;
 * 2. any horizontal component — a wheel's tilt is a scroll, not a zoom;
 * 3. a device already proved to be a trackpad pans on vertical motion;
 * 4. everything else is a wheel notch.
 *
 * Rule 4 is the deliberate default: a vertical-only pixel delta of any size
 * is what an accelerated mouse wheel produces, and a trackpad proves itself
 * within a swipe or two through rule 3's memory.
 */
export function wheelIntent(
  sample: WheelSample,
  mode: PointerNavigationMode = 'auto',
  device: WheelDevice | null = null
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
  return device === 'trackpad' ? 'pan' : 'zoom';
}

export interface WheelClassification {
  intent: WheelIntent;
  /** The device this event proved, when that differs from what was known. */
  learned: WheelDevice | null;
}

/**
 * Classifies wheel events one gesture at a time.
 *
 * The first event of a gesture decides its intent and every event inside
 * the same burst keeps it, so a gesture never zooms on its fast events and
 * pans on its slow ones. Evidence is still gathered from every event: a
 * diagonal swipe seen mid-gesture does not change that gesture, but the next
 * one starts as a trackpad's. A pinch is never held to a burst — it is
 * always a zoom, and it ends whatever gesture was running.
 */
export class WheelGestureClassifier {
  private device: WheelDevice | null;
  private readonly burstGapMs: number;
  private burstIntent: WheelIntent | null = null;
  private burstLastAt = Number.NEGATIVE_INFINITY;

  constructor(
    options: { device?: WheelDevice | null; burstGapMs?: number } = {}
  ) {
    this.device = options.device ?? null;
    this.burstGapMs = options.burstGapMs ?? WHEEL_BURST_GAP_MS;
  }

  /** The device proved so far, from a prior session or this one. */
  get learnedDevice(): WheelDevice | null {
    return this.device;
  }

  classify(
    sample: WheelSample,
    mode: PointerNavigationMode,
    now: number
  ): WheelClassification {
    let learned: WheelDevice | null = null;
    // Memory only serves auto mode; an explicit preference has already
    // answered the question and must not report a device it ignores.
    if (mode === 'auto') {
      const evidence = wheelDeviceEvidence(sample);
      if (evidence !== null && evidence !== this.device) {
        this.device = evidence;
        learned = evidence;
      }
    }
    if (sample.ctrlKey) {
      this.burstIntent = null;
      return { intent: 'zoom', learned };
    }
    const continuing =
      this.burstIntent !== null && now - this.burstLastAt <= this.burstGapMs;
    this.burstLastAt = now;
    if (mode !== 'auto') {
      // An explicit preference cannot flip mid-gesture, so a burst is moot;
      // keep the clock honest without holding a stale auto decision.
      this.burstIntent = null;
      return { intent: wheelIntent(sample, mode), learned };
    }
    if (!continuing) {
      this.burstIntent = wheelIntent(sample, mode, this.device);
    }
    return { intent: this.burstIntent ?? 'zoom', learned };
  }
}

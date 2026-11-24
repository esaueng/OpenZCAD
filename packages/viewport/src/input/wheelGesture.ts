export type WheelIntent = 'zoom' | 'pan';

export type PointerNavigationMode = 'auto' | 'mouse' | 'trackpad';

/** Device used for otherwise ambiguous vertical pixel deltas. */
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
  /** Legacy wheel ticks when exposed by the browser. */
  wheelDeltaY?: number;
  /** Chromium can expose legacy wheel ticks divided by this scale. */
  pixelRatio?: number;
  /** True on an inertial scroll when the browser exposes its phase. */
  momentum?: boolean;
}

/** Read the unit first: Firefox can otherwise convert a line wheel to pixels. */
export function readWheelSample(
  event: WheelEvent & { wheelDeltaY?: number; momentum?: boolean },
  controlKeyHeld?: boolean
): WheelSample {
  return {
    deltaMode: event.deltaMode,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    ctrlKey: event.ctrlKey,
    wheelDeltaY: event.wheelDeltaY,
    pixelRatio: event.view?.devicePixelRatio ?? globalThis.devicePixelRatio,
    momentum: event.momentum,
    controlKeyHeld
  };
}

/**
 * The longest silence inside one physical gesture. Trackpad streams and
 * momentum tails arrive every frame or two, and a spun wheel delivers
 * notches well inside this, so a longer gap starts a new gesture.
 */
export const WHEEL_BURST_GAP_MS = 200;

/** Device clues available without comparing successive events. */
export function wheelDeviceEvidence(sample: WheelSample): WheelDevice | null {
  if (sample.deltaMode !== 0) {
    return 'mouse';
  }
  if (sample.ctrlKey) {
    return sample.controlKeyHeld === false ? 'trackpad' : null;
  }
  if (sample.momentum || (sample.deltaX !== 0 && sample.deltaY !== 0)) {
    return 'trackpad';
  }
  return null;
}

/** Resolve a packet using the preference and any known device. */
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
 * Accelerated wheels and straight swipes can send identical vertical pixels.
 * Keep the current gesture's intent until stronger evidence resolves it.
 */
export class WheelGestureClassifier {
  private device: WheelDevice | null;
  private readonly burstGapMs: number;
  private burstIntent: WheelIntent | null = null;
  private burstLastAt = Number.NEGATIVE_INFINITY;
  private notchCandidate = 0;
  private fineDelta = 0;
  private fineSteps = 0;

  constructor(
    options: { device?: WheelDevice | null; burstGapMs?: number } = {}
  ) {
    this.device = options.device ?? null;
    this.burstGapMs = options.burstGapMs ?? WHEEL_BURST_GAP_MS;
  }

  get learnedDevice(): WheelDevice | null {
    return this.device;
  }

  /**
   * Pixel deltas overlap. Look for a pattern at the beginning of a wheel
   * gesture so repeated large values at the peak of a swipe stay a pan.
   */
  private verticalEvidence(
    sample: WheelSample,
    continuing: boolean,
    gap: number
  ): WheelDevice | null {
    const size = Math.abs(sample.deltaY);
    const ticks = sample.wheelDeltaY ?? 0;
    // A legacy detent is 120 units. Precise scrolling can hit 120 too:
    // Firefox and macOS may derive the legacy value from 3x the pixel delta.
    const proportional = ticks !== 0 && Math.abs(ticks + 3 * sample.deltaY) < 1;
    const scale = sample.pixelRatio ?? 1;
    const scaledDetents = Math.round((Math.abs(ticks) * scale) / 120);
    const scaledNotch =
      scaledDetents > 0 &&
      Math.trunc((scaledDetents * 120) / scale) === Math.abs(ticks);
    const nativeNotch =
      ticks !== 0 &&
      (ticks % 120 === 0 || scaledNotch) &&
      Math.sign(ticks) === -Math.sign(sample.deltaY) &&
      !proportional &&
      ticks !== -sample.deltaY;
    const repeats = size !== 0 && size === this.notchCandidate;
    // A handoff can happen inside the burst timeout. Use the same cadence
    // to start a notch sequence and confirm it on a subsequent event.
    const spacedNotch = gap >= 40;
    const checkingNotch =
      !continuing || repeats || (this.burstIntent === 'pan' && spacedNotch);
    this.notchCandidate =
      checkingNotch && size >= 40 && Number.isInteger(size) ? size : 0;
    if (nativeNotch || (repeats && spacedNotch && gap <= 1500)) {
      this.fineSteps = 0;
      return 'mouse';
    }

    // Finger motion often begins with changing, fine steps about one frame
    // apart. With whole pixels require a longer run and a proportional tick
    // signal. Size or frequency alone also describes an accelerated wheel.
    const fine = size > 0 && size < 16;
    const changing =
      continuing && gap <= 32 && this.fineSteps > 0 && this.fineDelta !== size;
    this.fineSteps = fine ? (changing ? this.fineSteps + 1 : 1) : 0;
    const fractionalPair =
      !Number.isInteger(this.fineDelta) && !Number.isInteger(size);
    this.fineDelta = size;
    if (
      this.fineSteps >= 2 &&
      (fractionalPair || (proportional && this.fineSteps >= 4))
    ) {
      return 'trackpad';
    }
    return null;
  }

  classify(
    sample: WheelSample,
    mode: PointerNavigationMode,
    now: number
  ): WheelClassification {
    const gap = now - this.burstLastAt;
    const continuing =
      this.burstIntent !== null && gap >= 0 && gap <= this.burstGapMs;
    this.burstLastAt = now;
    let evidence = mode === 'auto' ? wheelDeviceEvidence(sample) : null;
    if (
      mode === 'auto' &&
      !evidence &&
      !sample.ctrlKey &&
      sample.deltaX === 0
    ) {
      evidence = this.verticalEvidence(sample, continuing, gap);
    } else {
      this.notchCandidate = 0;
      this.fineSteps = 0;
    }
    const learned = evidence !== this.device ? evidence : null;
    if (learned) this.device = learned;
    if (mode !== 'auto' || sample.ctrlKey) {
      this.burstIntent = null;
      return { intent: wheelIntent(sample, mode), learned };
    }
    if (!continuing || evidence || sample.deltaX !== 0) {
      this.burstIntent = wheelIntent(sample, mode, this.device);
    }
    return { intent: this.burstIntent ?? 'zoom', learned };
  }
}

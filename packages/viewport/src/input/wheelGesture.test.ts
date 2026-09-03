import { describe, expect, it } from 'vitest';
import {
  WHEEL_BURST_GAP_MS,
  WheelGestureClassifier,
  wheelDeviceEvidence,
  wheelIntent,
  type WheelSample
} from './wheelGesture';

function sample(overrides: Partial<WheelSample> = {}): WheelSample {
  return { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, ...overrides };
}

describe('wheel intent', () => {
  it('reads a pinch as zoom however it is spelled', () => {
    // Browsers synthesise ctrlKey for a trackpad pinch, so this is the one
    // unambiguous signal and it outranks every override below.
    expect(wheelIntent(sample({ deltaY: 4, ctrlKey: true }))).toBe('zoom');
    expect(wheelIntent(sample({ deltaY: 4, ctrlKey: true }), 'trackpad')).toBe(
      'zoom'
    );
    expect(
      wheelIntent(sample({ deltaY: 4, ctrlKey: true }), 'auto', 'trackpad')
    ).toBe('zoom');
  });

  it('reads a notched wheel as zoom', () => {
    expect(wheelIntent(sample({ deltaY: 100 }))).toBe('zoom');
    expect(wheelIntent(sample({ deltaY: -120 }))).toBe('zoom');
    // Line and page deltas come only from a wheel.
    expect(wheelIntent(sample({ deltaY: 3, deltaMode: 1 }))).toBe('zoom');
    expect(wheelIntent(sample({ deltaY: 1, deltaMode: 2 }))).toBe('zoom');
  });

  it('reads an accelerated slow notch as zoom until a trackpad is proved', () => {
    // macOS scroll acceleration turns a slow notch into a few-pixel event;
    // reading that as a pan is the "zoom also scrolls" defect.
    expect(wheelIntent(sample({ deltaY: 7 }))).toBe('zoom');
    expect(wheelIntent(sample({ deltaY: -1 }))).toBe('zoom');
    expect(wheelIntent(sample({ deltaY: 7 }), 'auto', 'mouse')).toBe('zoom');
  });

  it('reads any horizontal component as pan', () => {
    // A wheel's tilt scrolls sideways; a finger wanders off-axis.
    expect(wheelIntent(sample({ deltaX: 12, deltaY: 0 }))).toBe('pan');
    expect(wheelIntent(sample({ deltaX: -3, deltaY: 2 }))).toBe('pan');
  });

  it('pans on vertical motion once the device is known to be a trackpad', () => {
    expect(wheelIntent(sample({ deltaY: 7 }), 'auto', 'trackpad')).toBe('pan');
    // Including the fast events of a flick, which used to read as a zoom.
    expect(wheelIntent(sample({ deltaY: 140 }), 'auto', 'trackpad')).toBe(
      'pan'
    );
  });

  it('lets the preference settle what the heuristic cannot', () => {
    expect(wheelIntent(sample({ deltaY: 7 }), 'mouse')).toBe('zoom');
    expect(wheelIntent(sample({ deltaX: 5, deltaY: 7 }), 'mouse')).toBe('zoom');
    expect(wheelIntent(sample({ deltaY: 140 }), 'trackpad')).toBe('pan');
    // An explicit preference also outranks whatever was learned.
    expect(wheelIntent(sample({ deltaY: 7 }), 'mouse', 'trackpad')).toBe(
      'zoom'
    );
  });
});

describe('wheel device evidence', () => {
  it('trusts only what one device cannot produce', () => {
    expect(wheelDeviceEvidence(sample({ deltaY: 3, deltaMode: 1 }))).toBe(
      'mouse'
    );
    expect(wheelDeviceEvidence(sample({ deltaX: 2, deltaY: -9 }))).toBe(
      'trackpad'
    );
    expect(
      wheelDeviceEvidence(
        sample({ deltaY: -2, ctrlKey: true, controlKeyHeld: false })
      )
    ).toBe('trackpad');
  });

  it('proves nothing from ambiguous events', () => {
    // Any vertical-only pixel delta: an accelerated notch or a straight swipe.
    expect(wheelDeviceEvidence(sample({ deltaY: 4 }))).toBeNull();
    expect(wheelDeviceEvidence(sample({ deltaY: 160 }))).toBeNull();
    // Horizontal-only: a tilt wheel, or a sideways swipe.
    expect(wheelDeviceEvidence(sample({ deltaX: 8 }))).toBeNull();
    // Ctrl+wheel with the key physically down is a mouse zooming faster,
    // and without knowing the key state a ctrl event proves nothing.
    expect(
      wheelDeviceEvidence(
        sample({ deltaY: -100, ctrlKey: true, controlKeyHeld: true })
      )
    ).toBeNull();
    expect(wheelDeviceEvidence(sample({ deltaY: -100, ctrlKey: true }))).toBe(
      null
    );
  });
});

describe('wheel gesture classifier', () => {
  const frame = 16;

  it('holds one intent across a whole burst', () => {
    const classifier = new WheelGestureClassifier({ device: 'trackpad' });
    // A trackpad flick opens gently and peaks past the old notch threshold.
    const deltas = [3, 9, 24, 61, 118, 90, 40, 12, 2];
    const intents = deltas.map(
      (deltaY, index) =>
        classifier.classify(sample({ deltaY }), 'auto', index * frame).intent
    );
    expect(intents).toEqual(deltas.map(() => 'pan'));
  });

  it('keeps a mouse spin zooming through its slow opening and tail', () => {
    const classifier = new WheelGestureClassifier();
    // Accelerated notches: slow at first, fast in the middle, slow to stop.
    const deltas = [4, 12, 48, 96, 96, 40, 8, 4];
    let at = 0;
    const intents = deltas.map((deltaY) => {
      at += 40;
      return classifier.classify(sample({ deltaY }), 'auto', at).intent;
    });
    expect(intents).toEqual(deltas.map(() => 'zoom'));
    expect(classifier.learnedDevice).toBeNull();
  });

  it('learns a trackpad from a diagonal swipe and applies it next gesture', () => {
    const classifier = new WheelGestureClassifier();
    const first = classifier.classify(sample({ deltaY: 5 }), 'auto', 0);
    expect(first).toEqual({ intent: 'zoom', learned: null });
    // Off-axis mid-swipe: the burst keeps its intent, the device is noted.
    const second = classifier.classify(
      sample({ deltaX: 1, deltaY: 6 }),
      'auto',
      frame
    );
    expect(second).toEqual({ intent: 'zoom', learned: 'trackpad' });
    // Later in the same burst, still zoom, and no repeated report.
    const third = classifier.classify(sample({ deltaY: 9 }), 'auto', 2 * frame);
    expect(third).toEqual({ intent: 'zoom', learned: null });
    // The next gesture starts as a trackpad's.
    const next = classifier.classify(
      sample({ deltaY: 5 }),
      'auto',
      2 * frame + WHEEL_BURST_GAP_MS + 1
    );
    expect(next).toEqual({ intent: 'pan', learned: null });
    expect(classifier.learnedDevice).toBe('trackpad');
  });

  it('learns a trackpad from a pinch', () => {
    const classifier = new WheelGestureClassifier();
    const pinch = classifier.classify(
      sample({ deltaY: -3, ctrlKey: true, controlKeyHeld: false }),
      'auto',
      0
    );
    expect(pinch).toEqual({ intent: 'zoom', learned: 'trackpad' });
    const swipe = classifier.classify(
      sample({ deltaY: 5 }),
      'auto',
      WHEEL_BURST_GAP_MS + 1
    );
    expect(swipe.intent).toBe('pan');
  });

  it('lets a line-mode wheel take a remembered trackpad back', () => {
    const classifier = new WheelGestureClassifier({ device: 'trackpad' });
    const notch = classifier.classify(
      sample({ deltaY: 3, deltaMode: 1 }),
      'auto',
      0
    );
    expect(notch).toEqual({ intent: 'zoom', learned: 'mouse' });
  });

  it('never holds a pinch to a running pan burst', () => {
    const classifier = new WheelGestureClassifier({ device: 'trackpad' });
    expect(classifier.classify(sample({ deltaY: 5 }), 'auto', 0).intent).toBe(
      'pan'
    );
    const pinch = classifier.classify(
      sample({ deltaY: -2, ctrlKey: true, controlKeyHeld: false }),
      'auto',
      frame
    );
    expect(pinch.intent).toBe('zoom');
    // The pinch ended the burst; a vertical event right after starts afresh.
    expect(
      classifier.classify(sample({ deltaY: 5 }), 'auto', 2 * frame).intent
    ).toBe('pan');
  });

  it('starts a new gesture after the burst gap', () => {
    const classifier = new WheelGestureClassifier();
    // A horizontal-only opener pans this burst without proving a device.
    const tilt = classifier.classify(sample({ deltaX: 20 }), 'auto', 0);
    expect(tilt).toEqual({ intent: 'pan', learned: null });
    expect(
      classifier.classify(sample({ deltaY: 5 }), 'auto', WHEEL_BURST_GAP_MS)
        .intent
    ).toBe('pan');
    expect(
      classifier.classify(
        sample({ deltaY: 5 }),
        'auto',
        2 * WHEEL_BURST_GAP_MS + 1
      ).intent
    ).toBe('zoom');
  });

  it('neither learns nor holds a burst under an explicit preference', () => {
    const classifier = new WheelGestureClassifier();
    const diagonal = classifier.classify(
      sample({ deltaX: 3, deltaY: 8 }),
      'mouse',
      0
    );
    expect(diagonal).toEqual({ intent: 'zoom', learned: null });
    expect(classifier.learnedDevice).toBeNull();
    expect(
      classifier.classify(sample({ deltaY: 120 }), 'trackpad', frame).intent
    ).toBe('pan');
  });
});

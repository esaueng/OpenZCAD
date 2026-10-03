import { describe, expect, it } from 'vitest';
import {
  DUR_BASE_MS,
  MAX_ANIMATION_STEP_S,
  WAKE_STEP_S,
  animationStepSeconds,
  easeToward,
  hasSettled
} from './motion';

/**
 * Drives one fade the way the render loop does: the first frame wakes the
 * loop, every later one continues it, each `frameMs` apart on the clock.
 * Returns how many frames were drawn before the value arrived.
 */
function framesToSettle(frameMs: number, idleBeforeMs: number): number {
  let value = 0;
  let continuing = false;
  let frames = 0;
  let gapMs = idleBeforeMs;
  while (!hasSettled(value, 1)) {
    const dtS = animationStepSeconds(gapMs / 1000, continuing);
    value = easeToward(value, 1, dtS * 1000);
    frames += 1;
    continuing = !hasSettled(value, 1);
    gapMs = frameMs;
    if (frames > 1000) throw new Error('fade never settled');
  }
  return frames;
}

describe('animation step', () => {
  it('advances a running animation by the real frame gap', () => {
    expect(animationStepSeconds(0.016, true)).toBeCloseTo(0.016);
    expect(animationStepSeconds(0.2, true)).toBeCloseTo(0.2);
  });

  it('caps a running animation at the slowest motion in the vocabulary', () => {
    expect(animationStepSeconds(5, true)).toBe(MAX_ANIMATION_STEP_S);
  });

  it('gives the frame that wakes the loop one nominal step, not the idle gap', () => {
    expect(animationStepSeconds(12, false)).toBe(WAKE_STEP_S);
    expect(animationStepSeconds(0.01, false)).toBeCloseTo(0.01);
  });

  it('never steps backwards or by a non-number', () => {
    expect(animationStepSeconds(0, true)).toBe(0);
    expect(animationStepSeconds(-1, true)).toBe(0);
    expect(animationStepSeconds(Number.NaN, false)).toBe(0);
  });

  it('settles a fade in the same wall-clock time on a fast display', () => {
    // 60 Hz: the fade lands inside a few multiples of the base duration.
    const frames = framesToSettle(1000 / 60, 10_000);
    expect(frames * (1000 / 60)).toBeLessThan(DUR_BASE_MS * 2);
  });

  it('does not spend a fixed frame count on a fade when frames are slow', () => {
    // A software renderer drawing every 400 ms. The old 50 ms clamp made
    // this fade take seven frames — almost three seconds of a stalled
    // viewport — for a transition meant to last a fifth of a second.
    expect(framesToSettle(400, 10_000)).toBeLessThanOrEqual(2);
  });

  it('still shows a fade begin on the frame that wakes the loop', () => {
    let value = easeToward(0, 1, animationStepSeconds(30, false) * 1000);
    expect(value).toBeGreaterThan(0);
    expect(hasSettled(value, 1)).toBe(false);
    value = easeToward(value, 1, animationStepSeconds(0.4, true) * 1000);
    expect(hasSettled(value, 1)).toBe(true);
  });

  it('gives a fade created mid-animation a visible first step', () => {
    // An earlier fade keeps the loop awake on a 400 ms software-GL frame.
    // A hover arriving between frames installs a new fade at opacity zero;
    // the render loop marks that frame as woken, so the new fade takes the
    // wake step instead of the whole gap and is seen to begin.
    const woken = animationStepSeconds(0.4, false);
    const incoming = easeToward(0, 1, woken * 1000);
    expect(woken).toBe(WAKE_STEP_S);
    expect(hasSettled(incoming, 1)).toBe(false);
    // Without the wake, the same frame lands the fade outright.
    const continued = animationStepSeconds(0.4, true);
    expect(hasSettled(easeToward(0, 1, continued * 1000), 1)).toBe(true);
  });
});

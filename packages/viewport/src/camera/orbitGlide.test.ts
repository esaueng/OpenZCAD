import { describe, expect, it } from 'vitest';
import {
  ORBIT_GLIDE_MAX_MS,
  ORBIT_GLIDE_TAU_MS,
  orbitGlideFrameMs,
  orbitGlideProgress,
  orbitGlideStepFraction
} from './orbitGlide';

/** Replays the glide one frame at a time, as OrbitControls damping does. */
function playGlide(frameMs: number) {
  let residue = 1;
  let elapsed = 0;
  const steps: number[] = [];
  while (residue > 0 && steps.length < 1_000) {
    const next = elapsed + frameMs;
    const fraction = orbitGlideStepFraction(elapsed, next);
    steps.push(residue * fraction);
    residue *= 1 - fraction;
    elapsed = next;
  }
  return { steps, elapsed };
}

describe('orbit glide curve', () => {
  it('is capped near 200 ms with a 75 ms time constant', () => {
    expect(ORBIT_GLIDE_MAX_MS).toBeLessThanOrEqual(200);
    expect(ORBIT_GLIDE_MAX_MS).toBeGreaterThanOrEqual(150);
    expect(ORBIT_GLIDE_TAU_MS).toBe(75);
  });

  it('plays out the whole residue, monotone, landing at the cap', () => {
    expect(orbitGlideProgress(0)).toBe(0);
    expect(orbitGlideProgress(ORBIT_GLIDE_MAX_MS)).toBe(1);
    expect(orbitGlideProgress(ORBIT_GLIDE_MAX_MS * 4)).toBe(1);
    let previous = 0;
    for (let t = 1; t <= ORBIT_GLIDE_MAX_MS; t += 1) {
      const progress = orbitGlideProgress(t);
      expect(progress).toBeGreaterThan(previous);
      expect(progress).toBeLessThanOrEqual(1);
      previous = progress;
    }
  });

  it.each([30, 60, 120, 144])(
    'decelerates every frame and stops by the cap at %i Hz',
    (hz) => {
      const frameMs = 1000 / hz;
      const { steps, elapsed } = playGlide(frameMs);
      // Lands on the first frame at or past the cap, never later.
      expect(elapsed).toBeGreaterThanOrEqual(ORBIT_GLIDE_MAX_MS - 1e-9);
      expect(elapsed).toBeLessThan(ORBIT_GLIDE_MAX_MS + frameMs);
      expect(steps.reduce((sum, step) => sum + step, 0)).toBeCloseTo(1, 12);
      for (let index = 1; index < steps.length; index += 1) {
        expect(steps[index]).toBeGreaterThan(0);
        expect(steps[index]).toBeLessThan(steps[index - 1] ?? Infinity);
      }
    }
  );

  it('decays about 0.8× per 60 Hz frame', () => {
    const { steps } = playGlide(1000 / 60);
    const ratio = (steps[1] ?? 0) / (steps[0] ?? 1);
    expect(ratio).toBeCloseTo(Math.exp(-1000 / 60 / ORBIT_GLIDE_TAU_MS), 10);
  });

  it('times the first frame from the last drag frame, bounded', () => {
    expect(orbitGlideFrameMs(16, true)).toBe(16);
    expect(orbitGlideFrameMs(2_000, true)).toBe(50);
    expect(orbitGlideFrameMs(Number.NaN, true)).toBeCloseTo(1000 / 60, 10);
    expect(orbitGlideFrameMs(0, true)).toBeCloseTo(1000 / 60, 10);
    // A running glide takes the real gap, so a slow frame lands further on.
    expect(orbitGlideFrameMs(400, false)).toBe(400);
    expect(orbitGlideFrameMs(-3, false)).toBe(0);
  });
});

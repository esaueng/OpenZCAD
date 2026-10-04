import { describe, expect, it } from 'vitest';
import {
  ORBIT_GLIDE_MAX_MS,
  ORBIT_GLIDE_TAU_MS,
  orbitGlideElapsedMs,
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

  it.each([5, 10, 30, 60, 120, 144])(
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

  it('reads the first frame at least one step in, never zero', () => {
    // A frame timestamp can predate pointer-up; the release frame still moves.
    expect(orbitGlideElapsedMs(null, -3, 16)).toBe(16);
    expect(orbitGlideElapsedMs(null, 2, 2_000)).toBe(50);
    expect(orbitGlideElapsedMs(null, 0, Number.NaN)).toBeCloseTo(1000 / 60, 10);
    // Otherwise it is wall-clock time since release, and never runs back.
    expect(orbitGlideElapsedMs(null, 100, 100)).toBe(100);
    expect(orbitGlideElapsedMs(16, 400, 384)).toBe(400);
    expect(orbitGlideElapsedMs(20, 18, 0)).toBe(20);
  });

  it.each([
    [5, 200],
    [10, 100],
    [10, 37],
    [24, 5]
  ])(
    'lands on the first frame at or past 200 ms after release at %i Hz (first frame %i ms in)',
    (hz, firstFrameMs) => {
      const frameMs = 1000 / hz;
      let elapsed: number | null = null;
      let residue = 1;
      let landedAt = Number.NaN;
      for (let at = firstFrameMs; residue > 0; at += frameMs) {
        const from: number = elapsed ?? 0;
        elapsed = orbitGlideElapsedMs(elapsed, at, frameMs);
        residue *= 1 - orbitGlideStepFraction(from, elapsed);
        landedAt = at;
        expect(at).toBeLessThan(1_000);
      }
      expect(landedAt).toBeGreaterThanOrEqual(ORBIT_GLIDE_MAX_MS);
      expect(landedAt).toBeLessThan(ORBIT_GLIDE_MAX_MS + frameMs);
    }
  );
});

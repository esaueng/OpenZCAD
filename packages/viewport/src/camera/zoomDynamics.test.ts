import { describe, expect, it } from 'vitest';
import {
  initialZoomDynamics,
  stepZoomDynamics,
  wheelNotches,
  ZOOM_ACCEL_MAX,
  ZOOM_ACCEL_TAU_MS,
  ZOOM_BASE_SPEED
} from './zoomDynamics';

describe('wheelNotches', () => {
  it('normalises pixel, line, and page delta modes like OrbitControls', () => {
    expect(wheelNotches(100, 0)).toBe(1);
    expect(wheelNotches(-100, 0)).toBe(1);
    // Firefox line mode: ~3 lines per notch, 16 px per line.
    expect(wheelNotches(3, 1)).toBeCloseTo(0.48);
    expect(wheelNotches(1, 2)).toBe(1);
  });
});

describe('stepZoomDynamics', () => {
  it('gives an isolated notch the stock speed, however hard it lands', () => {
    const { speed } = stepZoomDynamics(initialZoomDynamics(), 1000, 5);
    expect(speed).toBe(ZOOM_BASE_SPEED);
  });

  it('accelerates a rapid spin and caps the multiplier', () => {
    let state = initialZoomDynamics();
    let speed: number;
    const speeds: number[] = [];
    for (let i = 0; i < 40; i++) {
      ({ state, speed } = stepZoomDynamics(state, i * 10, 1));
      speeds.push(speed);
    }
    expect(speeds[5]!).toBeGreaterThan(speeds[1]!);
    expect(speeds.at(-1)!).toBe(ZOOM_BASE_SPEED * ZOOM_ACCEL_MAX);
  });

  it('forgets the spin after a pause', () => {
    let state = initialZoomDynamics();
    for (let i = 0; i < 10; i++) {
      ({ state } = stepZoomDynamics(state, i * 30, 1));
    }
    const { speed } = stepZoomDynamics(
      state,
      10 * 30 + ZOOM_ACCEL_TAU_MS * 10,
      1
    );
    expect(speed).toBeCloseTo(ZOOM_BASE_SPEED, 3);
  });

  it('builds acceleration gently from small trackpad deltas', () => {
    let state = initialZoomDynamics();
    let speed = ZOOM_BASE_SPEED;
    // A steady two-finger glide: ~8 px every 16 ms.
    for (let i = 0; i < 40; i++) {
      ({ state, speed } = stepZoomDynamics(state, i * 16, wheelNotches(8, 0)));
    }
    expect(speed).toBeGreaterThan(ZOOM_BASE_SPEED);
    expect(speed).toBeLessThan(ZOOM_BASE_SPEED * 2);
  });
});

import { describe, expect, it } from 'vitest';
import {
  layoutMeasurementCallouts,
  type CalloutLayoutItem,
  type CalloutLayoutViewport
} from './calloutLayout';

const viewport: CalloutLayoutViewport = {
  width: 1200,
  height: 800,
  center: { x: 600, y: 400 },
  radius: 200
};

function pill(
  overrides: Partial<CalloutLayoutItem> &
    Pick<CalloutLayoutItem, 'anchor' | 'kind'>
): CalloutLayoutItem {
  return { width: 90, height: 24, ...overrides };
}

describe('layoutMeasurementCallouts', () => {
  it('pushes a point callout outside the projected silhouette', () => {
    const anchor = { x: 660, y: 360 };
    const [placed = { x: NaN, y: NaN, leader: false }] = layoutMeasurementCallouts(
      [pill({ anchor, kind: 'anchor' })],
      viewport
    );
    const fromCenter = Math.hypot(placed.x - 600, placed.y - 400);
    expect(fromCenter).toBeGreaterThan(viewport.radius);
    expect(placed.leader).toBe(true);
  });

  it('keeps the pill on a leash instead of chasing a huge silhouette', () => {
    const anchor = { x: 620, y: 380 };
    const [placed = { x: NaN, y: NaN, leader: false }] = layoutMeasurementCallouts(
      [pill({ anchor, kind: 'anchor' })],
      { ...viewport, radius: 4000 }
    );
    const fromAnchor = Math.hypot(placed.x - anchor.x, placed.y - anchor.y);
    expect(fromAnchor).toBeLessThanOrEqual(221);
  });

  it('lifts a span label off its dimension line, away from the model', () => {
    // Horizontal span across the top of the model: the label must move up
    // (away from the centre below it), not sit on the line.
    const anchor = { x: 600, y: 180 };
    const [placed = { x: NaN, y: NaN, leader: false }] = layoutMeasurementCallouts(
      [pill({ anchor, kind: 'span', spanDir: { x: 1, y: 0 } })],
      viewport
    );
    expect(placed.x).toBeCloseTo(600, 5);
    expect(placed.y).toBeLessThan(180);
  });

  it('separates callouts that share an anchor', () => {
    const anchor = { x: 700, y: 300 };
    const items = [
      pill({ anchor, kind: 'anchor' }),
      pill({ anchor, kind: 'anchor' }),
      pill({ anchor, kind: 'anchor' })
    ];
    const placed = layoutMeasurementCallouts(items, viewport);
    for (let a = 0; a < placed.length; a += 1) {
      for (let b = a + 1; b < placed.length; b += 1) {
        const clearX = Math.abs(placed[a]!.x - placed[b]!.x) >= 90;
        const clearY = Math.abs(placed[a]!.y - placed[b]!.y) >= 24;
        expect(clearX || clearY).toBe(true);
      }
    }
  });

  it('clamps placements inside the viewport', () => {
    const [placed = { x: NaN, y: NaN, leader: false }] = layoutMeasurementCallouts(
      [pill({ anchor: { x: 1195, y: 5 }, kind: 'anchor' })],
      viewport
    );
    expect(placed.x + 45).toBeLessThanOrEqual(viewport.width);
    expect(placed.y - 12).toBeGreaterThanOrEqual(0);
  });

  it('survives an anchor exactly on the model centre', () => {
    const [placed = { x: NaN, y: NaN, leader: false }] = layoutMeasurementCallouts(
      [pill({ anchor: { x: 600, y: 400 }, kind: 'anchor' })],
      viewport
    );
    expect(Number.isFinite(placed.x)).toBe(true);
    expect(Number.isFinite(placed.y)).toBe(true);
    const fromCenter = Math.hypot(placed.x - 600, placed.y - 400);
    expect(fromCenter).toBeGreaterThan(0);
  });

  it('leaves the leader off when the pill stays beside its anchor', () => {
    const [placed = { x: NaN, y: NaN, leader: false }] = layoutMeasurementCallouts(
      [
        pill({
          anchor: { x: 600, y: 180 },
          kind: 'span',
          spanDir: { x: 1, y: 0 }
        })
      ],
      viewport
    );
    expect(placed.leader).toBe(false);
  });

  it('handles a missing projected centre', () => {
    const [placed = { x: NaN, y: NaN, leader: false }] = layoutMeasurementCallouts(
      [pill({ anchor: { x: 300, y: 300 }, kind: 'arms' })],
      { ...viewport, center: null, radius: 0 }
    );
    expect(Number.isFinite(placed.x)).toBe(true);
    expect(Number.isFinite(placed.y)).toBe(true);
  });
});

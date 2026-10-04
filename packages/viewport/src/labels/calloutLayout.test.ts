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

  it('stands an area label just outside its own face, not the model', () => {
    // A face of a large model, right of centre: its label clears the face's
    // projected box and stops there, well inside the model's silhouette.
    const anchor = { x: 680, y: 400 };
    const bounds = { minX: 640, minY: 360, maxX: 720, maxY: 440 };
    const [placed = { x: NaN, y: NaN, leader: false }] =
      layoutMeasurementCallouts(
        [pill({ anchor, kind: 'anchor', bounds })],
        viewport
      );
    // Outward from the model centre is +x here: the pill's left edge sits
    // just past the face's right edge, and the pill stays level with it.
    expect(placed.x - 45).toBeGreaterThan(bounds.maxX);
    expect(placed.x - 45).toBeLessThanOrEqual(bounds.maxX + 12);
    expect(placed.y).toBeCloseTo(400, 5);
    expect(Math.hypot(placed.x - 600, placed.y - 400)).toBeLessThan(
      viewport.radius
    );
  });

  it('leaves a face by its nearest edge on the side away from the model', () => {
    // Down and right both face away from the centre; the face's bottom edge
    // is much the nearer, so the label hangs just below it.
    const anchor = { x: 650, y: 420 };
    const bounds = { minX: 560, minY: 300, maxX: 700, maxY: 440 };
    const [placed = { x: NaN, y: NaN, leader: false }] =
      layoutMeasurementCallouts(
        [pill({ anchor, kind: 'anchor', bounds })],
        viewport
      );
    expect(placed.x).toBeCloseTo(650, 5);
    expect(placed.y - 12).toBeGreaterThan(bounds.maxY);
    expect(placed.y - 12).toBeLessThanOrEqual(bounds.maxY + 12);
  });

  it('keeps an area label on a short leash beside a face filling the screen', () => {
    // No leash clears this face, so the label stays close rather than
    // running the whole leash out on a long leader over the face.
    const anchor = { x: 620, y: 380 };
    const [placed = { x: NaN, y: NaN, leader: false }] =
      layoutMeasurementCallouts(
        [
          pill({
            anchor,
            kind: 'anchor',
            bounds: { minX: -2000, minY: -2000, maxX: 3000, maxY: 3000 }
          })
        ],
        viewport
      );
    expect(
      Math.hypot(placed.x - anchor.x, placed.y - anchor.y)
    ).toBeLessThanOrEqual(121);
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

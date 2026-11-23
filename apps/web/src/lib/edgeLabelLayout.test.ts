import { describe, expect, it } from 'vitest';
import {
  edgeLabelPlacement,
  type EdgeLabelLayoutInput
} from './edgeLabelLayout';

const DIAGONAL = { x: Math.SQRT1_2, y: Math.SQRT1_2 };

function layout(overrides: Partial<EdgeLabelLayoutInput> = {}) {
  return edgeLabelPlacement({
    pin: { x: 400, y: 300 },
    along: { x: 1, y: 0 },
    reach: 40,
    size: { width: 64, height: 20 },
    gap: 6,
    margin: 8,
    right: 1000,
    bottom: 800,
    obstacles: [],
    ...overrides
  });
}

describe('edgeLabelPlacement', () => {
  it('stands out past the arrow head along the leader', () => {
    expect(layout()).toEqual({ x: 478, y: 300, side: 'out' });
  });

  it('lies back along the leader when the bottom lane takes the outward spot', () => {
    const placed = layout({ pin: { x: 400, y: 760 }, along: { x: 0, y: 1 } });
    expect(placed).toEqual({ x: 400, y: 682, side: 'back' });
  });

  it('lies back along the leader when a panel covers the outward spot', () => {
    const placed = layout({
      obstacles: [{ left: 450, top: 250, right: 600, bottom: 350 }]
    });
    expect(placed!.side).toBe('back');
    expect(placed!.x).toBe(322);
  });

  it('gives no tilted place in a corner where neither side has room', () => {
    // A 45° down-right arrow 32 px from the left edge and 30 px above the
    // bottom lane: back runs off the left edge, out into the lane. The
    // label then stays upright beside the arrow rather than leaving it.
    expect(
      layout({ pin: { x: 32, y: 770 }, along: DIAGONAL, bottom: 800 })
    ).toBeNull();
  });

  it('gives no tilted place when a rail covers the only side with room', () => {
    // Out runs into the bottom lane; back lies under a rail on the left.
    expect(
      layout({
        pin: { x: 120, y: 760 },
        along: { x: 0, y: 1 },
        obstacles: [{ left: 0, top: 600, right: 140, bottom: 760 }]
      })
    ).toBeNull();
  });
});

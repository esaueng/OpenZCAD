import { describe, expect, it } from 'vitest';
import {
  clampMenuOrigin,
  MARKING_DEAD_ZONE_PX,
  RING_ASPECT,
  sectorAnchor,
  sectorAngle,
  sectorForVector
} from './markingMenu';

describe('aiming at a sector', () => {
  const far = MARKING_DEAD_ZONE_PX * 3;

  it('takes straight up as the first sector', () => {
    expect(sectorForVector(0, -far, 8)).toBe(0);
  });

  it('runs clockwise from the top', () => {
    expect(sectorForVector(far, 0, 8)).toBe(2); // right
    expect(sectorForVector(0, far, 8)).toBe(4); // down
    expect(sectorForVector(-far, 0, 8)).toBe(6); // left
  });

  it('takes the diagonals', () => {
    expect(sectorForVector(far, -far, 8)).toBe(1); // up and right
    expect(sectorForVector(-far, far, 8)).toBe(5); // down and left
  });

  it('resolves an aim between two sectors to one of them', () => {
    // Landing on a boundary must pick a side; picking neither would read as
    // a dead spot in the ring.
    const between = sectorForVector(
      far * Math.cos(-1.1781),
      far * Math.sin(-1.1781),
      8
    );
    expect([0, 1]).toContain(between);
  });

  it('ignores the wobble between pressing and releasing', () => {
    expect(sectorForVector(3, -4, 8)).toBeNull();
    expect(sectorForVector(0, 0, 8)).toBeNull();
  });

  it('picks nothing until the pointer has left the dead zone', () => {
    expect(sectorForVector(0, -(MARKING_DEAD_ZONE_PX - 1), 8)).toBeNull();
    expect(sectorForVector(0, -(MARKING_DEAD_ZONE_PX + 1), 8)).toBe(0);
  });

  it('adapts to a ring that is not full', () => {
    expect(sectorForVector(0, -far, 3)).toBe(0);
    expect(sectorForVector(0, far, 4)).toBe(2);
    // Just clockwise of straight up on a ring of five is still the first
    // sector, which spans 36° either side of the top.
    expect(sectorForVector(far * Math.sin(0.5), -far * Math.cos(0.5), 5)).toBe(
      0
    );
    expect(sectorForVector(far * Math.sin(0.8), -far * Math.cos(0.8), 5)).toBe(
      1
    );
  });

  it('has no sector to aim at when there is nothing on the ring', () => {
    expect(sectorForVector(0, -far, 0)).toBeNull();
  });
});

describe('where the pills hang', () => {
  it('centres the first pill directly above the click point', () => {
    const at = sectorAnchor(0, 8, 100);
    expect(at).toEqual({ x: 0, y: -100, align: 'center' });
  });

  it('centres the pill straight below too', () => {
    expect(sectorAnchor(4, 8, 100)).toEqual({ x: 0, y: 100, align: 'center' });
  });

  it('hangs pills off the vertical outward from their anchor', () => {
    // Right of centre the pill's left edge sits on the anchor and the pill
    // grows rightward; mirrored on the left. Neighbours never grow toward
    // each other, whatever their labels.
    expect(sectorAnchor(2, 8, 100).align).toBe('start');
    expect(sectorAnchor(1, 8, 100).align).toBe('start');
    expect(sectorAnchor(6, 8, 100).align).toBe('end');
    expect(sectorAnchor(7, 8, 100).align).toBe('end');
  });

  it('stretches the ring sideways so the diagonals get their own row', () => {
    const at = sectorAnchor(2, 8, 100);
    expect(at.x).toBeCloseTo(100 * RING_ASPECT, 6);
    expect(at.y).toBe(0);
  });

  it('keeps a ring without diagonals round', () => {
    // Four pills have no diagonal row to make room for, so the side pills
    // sit as near the centre as the top and bottom ones.
    expect(sectorAnchor(1, 4, 100)).toEqual({ x: 100, y: 0, align: 'start' });
    expect(sectorAnchor(3, 4, 100)).toEqual({ x: -100, y: 0, align: 'end' });
  });

  it('anchors every pill inside the sector its aim points at', () => {
    // The stretch bends the anchor away from the sector's direction; it must
    // never bend it into the neighbour's, or the menu would show one thing
    // and pick another.
    for (const count of [3, 4, 5, 6, 7, 8]) {
      for (let index = 0; index < count; index += 1) {
        const at = sectorAnchor(index, count, 120);
        expect(sectorForVector(at.x, at.y, count)).toBe(index);
      }
    }
  });

  it('spaces the sectors evenly from straight up', () => {
    expect(sectorAngle(2, 8)).toBe(90);
    expect(sectorAngle(3, 4)).toBe(270);
  });
});

describe('keeping the ring on screen', () => {
  it('leaves a menu with room where it was summoned', () => {
    expect(clampMenuOrigin(500, 400, 1200, 800, 140)).toEqual({
      x: 500,
      y: 400
    });
  });

  it('pulls a menu in from the edges rather than clipping a sector', () => {
    // A sector off the edge still answers to its direction, so a flick would
    // commit to something invisible.
    expect(clampMenuOrigin(10, 790, 1200, 800, 140)).toEqual({
      x: 140,
      y: 660
    });
  });

  it('keeps a different amount clear on each side when asked', () => {
    // A pill hanging rightward needs more room on the right than the dial
    // needs on the left.
    expect(
      clampMenuOrigin(1150, 20, 1200, 800, {
        left: 60,
        right: 200,
        top: 50,
        bottom: 120
      })
    ).toEqual({ x: 1000, y: 50 });
  });

  it('centres itself when the window is too small for the ring', () => {
    expect(clampMenuOrigin(90, 40, 200, 100, 140)).toEqual({ x: 100, y: 50 });
  });
});

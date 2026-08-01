import { describe, expect, it } from 'vitest';
import {
  clampMenuOrigin,
  MARKING_DEAD_ZONE_PX,
  sectorForVector,
  sectorPosition
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
    const between = sectorForVector(far * Math.cos(-1.1781), far * Math.sin(-1.1781), 8);
    expect([0, 1]).toContain(between);
  });

  it('ignores the wobble between pressing and releasing', () => {
    expect(sectorForVector(3, -4, 8)).toBeNull();
    expect(sectorForVector(0, 0, 8)).toBeNull();
  });

  it('picks nothing while the pointer is still on the hub', () => {
    // The hub is drawn at the dead zone's radius, so anything it covers has
    // to be a release that chose nothing — otherwise the readout would name
    // an action the menu was not going to run.
    expect(sectorForVector(0, -(MARKING_DEAD_ZONE_PX - 1), 8)).toBeNull();
    expect(sectorForVector(0, -(MARKING_DEAD_ZONE_PX + 1), 8)).toBe(0);
  });

  it('adapts to a ring that is not full', () => {
    expect(sectorForVector(0, -far, 3)).toBe(0);
    expect(sectorForVector(0, far, 4)).toBe(2);
  });

  it('has no sector to aim at when there is nothing on the ring', () => {
    expect(sectorForVector(0, -far, 0)).toBeNull();
  });
});

describe('where the labels sit', () => {
  it('puts the first label directly above the centre', () => {
    const at = sectorPosition(0, 8, 100);
    expect(at.x).toBeCloseTo(0, 6);
    expect(at.y).toBeCloseTo(-100, 6);
  });

  it('places labels where the aim for that sector points', () => {
    // The two have to agree, or the menu shows one thing and picks another.
    for (let index = 0; index < 8; index += 1) {
      const at = sectorPosition(index, 8, 120);
      expect(sectorForVector(at.x, at.y, 8)).toBe(index);
    }
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

  it('centres itself when the window is too small for the ring', () => {
    expect(clampMenuOrigin(90, 40, 200, 100, 140)).toEqual({ x: 100, y: 50 });
  });
});

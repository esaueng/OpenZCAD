import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  bodiesInBox,
  boxSelectMode,
  isBoxSelectDrag,
  rectFromDrag,
  type BoxSelectCandidate
} from './boxSelect';

const SIZE = 200;

/** Looking down -Z at the origin, so world X/Y map straight to the screen. */
function camera() {
  const perspective = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  perspective.position.set(0, 0, 100);
  perspective.lookAt(0, 0, 0);
  perspective.updateMatrixWorld(true);
  return perspective;
}

const options = () => ({ camera: camera(), width: SIZE, height: SIZE });

/** A square of four vertices centred on (x, y) in the z = 0 plane. */
function square(
  bodyId: string,
  x: number,
  y: number,
  half: number
): BoxSelectCandidate {
  return {
    bodyId,
    positions: [
      x - half,
      y - half,
      0,
      x + half,
      y - half,
      0,
      x + half,
      y + half,
      0,
      x - half,
      y + half,
      0
    ],
    indices: [0, 1, 2, 0, 2, 3]
  };
}

/** The pixel a world point on the z = 0 plane lands on. */
function pixel(x: number, y: number) {
  const projected = new THREE.Vector3(x, y, 0).project(camera());
  return {
    x: ((projected.x + 1) / 2) * SIZE,
    y: ((1 - projected.y) / 2) * SIZE
  };
}

describe('the drag direction chooses the rule', () => {
  it('reads left to right as a window', () => {
    expect(boxSelectMode(10, 90)).toBe('window');
  });

  it('reads right to left as crossing', () => {
    expect(boxSelectMode(90, 10)).toBe('crossing');
  });

  it('treats a drag with no horizontal travel as the stricter window', () => {
    expect(boxSelectMode(50, 50)).toBe('window');
  });
});

describe('a drag has to be a rectangle', () => {
  it('ignores a drag that barely moved', () => {
    expect(isBoxSelectDrag(rectFromDrag(50, 50, 52, 51))).toBe(false);
  });

  it('accepts a drag that is long in only one direction', () => {
    // A thin sweep is a real gesture; only a near-still pointer is not.
    expect(isBoxSelectDrag(rectFromDrag(50, 50, 120, 51))).toBe(true);
  });

  it('normalizes a rectangle dragged up and to the left', () => {
    expect(rectFromDrag(90, 80, 10, 20)).toEqual({
      left: 10,
      right: 90,
      top: 20,
      bottom: 80
    });
  });
});

describe('window select takes only what is fully enclosed', () => {
  const inner = square('inner', 0, 0, 5);
  const outer = square('outer', 0, 0, 40);

  it('takes a body entirely inside the rectangle', () => {
    const corner = pixel(-20, 20);
    const far = pixel(20, -20);
    const rect = rectFromDrag(corner.x, corner.y, far.x, far.y);
    expect(bodiesInBox([inner], rect, 'window', options())).toEqual(['inner']);
  });

  it('leaves a body that only overlaps the rectangle', () => {
    const corner = pixel(-20, 20);
    const far = pixel(20, -20);
    const rect = rectFromDrag(corner.x, corner.y, far.x, far.y);
    expect(bodiesInBox([outer], rect, 'window', options())).toEqual([]);
  });

  it('takes the enclosed body and leaves the overlapping one together', () => {
    const corner = pixel(-20, 20);
    const far = pixel(20, -20);
    const rect = rectFromDrag(corner.x, corner.y, far.x, far.y);
    expect(bodiesInBox([inner, outer], rect, 'window', options())).toEqual([
      'inner'
    ]);
  });
});

describe('crossing select takes anything the rectangle touches', () => {
  it('takes a body the rectangle only clips', () => {
    const outer = square('outer', 0, 0, 40);
    const corner = pixel(-20, 20);
    const far = pixel(20, -20);
    const rect = rectFromDrag(corner.x, corner.y, far.x, far.y);
    expect(bodiesInBox([outer], rect, 'crossing', options())).toEqual([
      'outer'
    ]);
  });

  it('takes a body the rectangle sits entirely inside', () => {
    // No vertex is anywhere near the rectangle, which a vertex test alone
    // would read as a miss — dragging inside one broad face is common.
    const big = square('big', 0, 0, 60);
    const corner = pixel(-4, 4);
    const far = pixel(4, -4);
    const rect = rectFromDrag(corner.x, corner.y, far.x, far.y);
    expect(bodiesInBox([big], rect, 'crossing', options())).toEqual(['big']);
  });

  it('leaves a body the rectangle misses entirely', () => {
    const away = square('away', 60, 60, 5);
    const corner = pixel(-10, 10);
    const far = pixel(10, -10);
    const rect = rectFromDrag(corner.x, corner.y, far.x, far.y);
    expect(bodiesInBox([away], rect, 'crossing', options())).toEqual([]);
  });

  it('does not select empty space between disconnected pieces', () => {
    const pieces: BoxSelectCandidate = {
      bodyId: 'pieces',
      positions: [
        -50, -10, 0, -30, -10, 0, -30, 10, 0, -50, 10, 0, 30, -10, 0, 50, -10,
        0, 50, 10, 0, 30, 10, 0
      ],
      indices: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]
    };
    const corner = pixel(-4, 4);
    const far = pixel(4, -4);
    const rect = rectFromDrag(corner.x, corner.y, far.x, far.y);
    expect(bodiesInBox([pieces], rect, 'crossing', options())).toEqual([]);
  });
});

describe('things that are not really there', () => {
  it('ignores a body with no vertices', () => {
    const rect = rectFromDrag(0, 0, SIZE, SIZE);
    expect(
      bodiesInBox(
        [{ bodyId: 'empty', positions: [], indices: [] }],
        rect,
        'crossing',
        options()
      )
    ).toEqual([]);
  });

  it('does not select a body behind the camera', () => {
    // Projection is finite behind the viewer, so an unguarded test would
    // sweep up geometry nobody can see.
    const behind: BoxSelectCandidate = {
      bodyId: 'behind',
      positions: [-5, -5, 500, 5, -5, 500, 5, 5, 500, -5, 5, 500],
      indices: [0, 1, 2, 0, 2, 3]
    };
    const rect = rectFromDrag(0, 0, SIZE, SIZE);
    expect(bodiesInBox([behind], rect, 'crossing', options())).toEqual([]);
    expect(bodiesInBox([behind], rect, 'window', options())).toEqual([]);
  });
});

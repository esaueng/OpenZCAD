import { describe, expect, it } from 'vitest';
import {
  holePositionAxes,
  holePositionFieldOrder,
  holePositionFromPick,
  holePositionFromPoint,
  holePositionLabels,
  worldAxisName
} from './holePositionAxes';

describe('hole position axes', () => {
  it('runs U along −Y and V along +X on a top face, as the builder does', () => {
    const axes = holePositionAxes({ x: 0, y: 0, z: 1 })!;
    expect(worldAxisName(axes.u)).toBe('−Y');
    expect(worldAxisName(axes.v)).toBe('+X');
    expect(holePositionLabels({ x: 0, y: 0, z: 1 })).toEqual({
      u: 'U · along −Y',
      v: 'V · along +X'
    });
  });

  it('names the axes of side faces', () => {
    // Front face, outward −Y: reference +Z, U = Z × (−Y) = +X, V = −Y × X = +Z.
    expect(holePositionLabels({ x: 0, y: -1, z: 0 })).toEqual({
      u: 'U · along +X',
      v: 'V · along +Z'
    });
    expect(holePositionLabels({ x: 1, y: 0, z: 0 })).toEqual({
      u: 'U · along +Y',
      v: 'V · along +Z'
    });
  });

  it('keeps the bare letter for an oblique axis or an unknown normal', () => {
    // A face at 45° between +X and +Y: U runs diagonally, V stays vertical.
    expect(holePositionLabels({ x: 1, y: 1, z: 0 })).toEqual({
      u: 'U',
      v: 'V · along +Z'
    });
    expect(holePositionLabels(undefined)).toEqual({ u: 'U', v: 'V' });
  });
});

describe('hole position field order (G7)', () => {
  it('lists the X-like field first on top and bottom faces', () => {
    // Top: U along −Y, V along +X — the frame saved holes are stored in.
    expect(holePositionFieldOrder({ x: 0, y: 0, z: 1 })).toEqual(['v', 'u']);
    // Bottom: U along +Y, V along +X.
    expect(holePositionLabels({ x: 0, y: 0, z: -1 })).toEqual({
      u: 'U · along +Y',
      v: 'V · along +X'
    });
    expect(holePositionFieldOrder({ x: 0, y: 0, z: -1 })).toEqual(['v', 'u']);
  });

  it('keeps U first where it is already the horizontal axis', () => {
    expect(holePositionFieldOrder({ x: 0, y: -1, z: 0 })).toEqual(['u', 'v']);
    expect(holePositionFieldOrder({ x: 0, y: 1, z: 0 })).toEqual(['u', 'v']);
    expect(holePositionFieldOrder({ x: 1, y: 0, z: 0 })).toEqual(['u', 'v']);
    expect(holePositionFieldOrder({ x: -1, y: 0, z: 0 })).toEqual(['u', 'v']);
    expect(holePositionFieldOrder(undefined)).toEqual(['u', 'v']);
  });
});

describe('hole position from a picked point (G7)', () => {
  const up = { x: 0, y: 0, z: 1 };
  const centre = { x: 50, y: 30, z: 6 };

  it('projects the point into the face frame, relative to the anchor', () => {
    // +X is V and −Y is U on a top face.
    expect(
      holePositionFromPoint(up, centre, { x: 90, y: 30, z: 6 }, 1)
    ).toEqual({ u: '0', v: '40' });
    expect(
      holePositionFromPoint(up, centre, { x: 10, y: 45, z: 6 }, 1)
    ).toEqual({ u: '-15', v: '-40' });
    // On a front face (outward −Y), U is +X and V is +Z.
    expect(
      holePositionFromPoint(
        { x: 0, y: -1, z: 0 },
        { x: 50, y: 0, z: 3 },
        { x: 20, y: 0, z: 5 },
        1
      )
    ).toEqual({ u: '-30', v: '2' });
  });

  it('rounds to the snap increment without float noise', () => {
    const click = { x: 90.37, y: 29.38, z: 6 };
    expect(holePositionFromPoint(up, centre, click, 1)).toEqual({
      u: '1',
      v: '40'
    });
    expect(holePositionFromPoint(up, centre, click, 0.25)).toEqual({
      u: '0.5',
      v: '40.25'
    });
    expect(holePositionFromPoint(up, centre, click, 0.1)).toEqual({
      u: '0.6',
      v: '40.4'
    });
    // Snapping off: hundredths, never a long tail.
    expect(holePositionFromPoint(up, centre, click, null)).toEqual({
      u: '0.62',
      v: '40.37'
    });
    // Never "-0".
    expect(
      holePositionFromPoint(up, centre, { x: 50.2, y: 30.2, z: 6 }, 1)
    ).toEqual({ u: '0', v: '0' });
  });

  it('gives nothing for a face without a normal or its anchor', () => {
    expect(
      holePositionFromPick({ centroid: centre }, 'centroid', centre, 1)
    ).toBeNull();
    expect(
      holePositionFromPick(
        { normal: up, center: centre },
        'centroid',
        centre,
        1
      )
    ).toBeNull();
  });
});

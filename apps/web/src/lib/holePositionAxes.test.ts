import { describe, expect, it } from 'vitest';
import {
  holePositionAxes,
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

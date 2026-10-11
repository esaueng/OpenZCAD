import { describe, expect, it } from 'vitest';
import { primitiveGhostBounds, primitiveGhostFor } from './primitiveGhost';

const origin = { x: '0', y: '0', z: '0' };

describe('primitiveGhostFor', () => {
  it('resolves expressions against the parameters', () => {
    expect(
      primitiveGhostFor(
        'box',
        { width: 'w', height: '60', depth: 'w / 20' },
        { x: '-w/2', y: '0', z: '0' },
        { w: 100 }
      )
    ).toEqual({
      kind: 'box',
      dimensions: { width: 100, height: 60, depth: 5 },
      position: { x: -50, y: 0, z: 0 }
    });
  });

  it('draws nothing while a field does not build', () => {
    const box = { width: '10', height: '10', depth: '10' };
    expect(primitiveGhostFor('box', { ...box, width: '' }, origin, {})).toBe(
      null
    );
    expect(
      primitiveGhostFor('box', { ...box, width: 'unknown' }, origin, {})
    ).toBe(null);
    expect(primitiveGhostFor('box', { ...box, depth: '0' }, origin, {})).toBe(
      null
    );
    expect(primitiveGhostFor('box', box, { ...origin, x: 'nope' }, {})).toBe(
      null
    );
    expect(
      primitiveGhostFor('cylinder', { radius: '-1', height: '5' }, origin, {})
    ).toBe(null);
  });

  it('takes a cone to a point at one end, never both', () => {
    const cone = { bottomRadius: '6', topRadius: '0', height: '10' };
    expect(primitiveGhostFor('cone', cone, origin, {})).not.toBeNull();
    expect(
      primitiveGhostFor('cone', { ...cone, bottomRadius: '0' }, origin, {})
    ).toBeNull();
    expect(
      primitiveGhostFor('cone', { ...cone, topRadius: '-1' }, origin, {})
    ).toBeNull();
  });
});

describe('primitiveGhostBounds', () => {
  it('grows a box from its corner along +X, +Y, +Z', () => {
    expect(
      primitiveGhostBounds({
        kind: 'box',
        dimensions: { width: 100, height: 60, depth: 6 },
        position: { x: 10, y: 20, z: 30 }
      })
    ).toEqual({
      min: { x: 10, y: 20, z: 30 },
      max: { x: 110, y: 80, z: 36 }
    });
  });

  it('raises a cylinder along +Z from its base centre', () => {
    expect(
      primitiveGhostBounds({
        kind: 'cylinder',
        dimensions: { radius: 6, height: 28 },
        position: { x: 15, y: 9, z: 24 }
      })
    ).toEqual({
      min: { x: 9, y: 3, z: 24 },
      max: { x: 21, y: 15, z: 52 }
    });
  });

  it('centres a sphere and a torus, the torus flat in XY', () => {
    expect(
      primitiveGhostBounds({
        kind: 'sphere',
        dimensions: { radius: 5 },
        position: { x: 0, y: 0, z: 0 }
      })
    ).toEqual({ min: { x: -5, y: -5, z: -5 }, max: { x: 5, y: 5, z: 5 } });
    expect(
      primitiveGhostBounds({
        kind: 'torus',
        dimensions: { majorRadius: 6, minorRadius: 2 },
        position: { x: 0, y: 0, z: 0 }
      })
    ).toEqual({ min: { x: -8, y: -8, z: -2 }, max: { x: 8, y: 8, z: 2 } });
  });
});

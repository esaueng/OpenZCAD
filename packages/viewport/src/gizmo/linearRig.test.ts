import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildLinearHandle } from './linearRig';

function rig(value = 5, min?: number, max?: number) {
  return buildLinearHandle({
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: 2 },
    value,
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max })
  });
}

describe('the linear rig', () => {
  it('places the arrow at the value along its line', () => {
    const handle = rig(5);
    expect(handle.group.position.toArray()).toEqual([0, 0, 5]);
    handle.setValue(8);
    expect(handle.group.position.z).toBe(8);
    expect(handle.value()).toBe(8);
  });

  it('reads the value where a pointer ray passes closest to the line', () => {
    const handle = rig(5);
    const across = new THREE.Ray(
      new THREE.Vector3(10, 0, 7),
      new THREE.Vector3(-1, 0, 0)
    );
    expect(handle.valueFromRay?.(across, 5)).toBeCloseTo(7);
  });

  it('ignores a ray along the line', () => {
    const handle = rig(5);
    const along = new THREE.Ray(
      new THREE.Vector3(0, 0, 50),
      new THREE.Vector3(0, 0, -1)
    );
    expect(handle.valueFromRay?.(along, 5)).toBeNull();
  });

  it('clamps to its range', () => {
    const handle = rig(5, 1, 10);
    handle.setValue(-3);
    expect(handle.value()).toBe(1);
    const far = new THREE.Ray(
      new THREE.Vector3(10, 0, 40),
      new THREE.Vector3(-1, 0, 0)
    );
    expect(handle.valueFromRay?.(far, 5)).toBe(10);
  });

  it('snaps before it clamps, so a drag reaches an end that is no step', () => {
    // A thread's 12.04 face: a drag past it ends on 12.04, not 12.
    const handle = rig(5, 0, 12.04);
    const across = (z: number) =>
      new THREE.Ray(new THREE.Vector3(10, 0, z), new THREE.Vector3(-1, 0, 0));
    expect(handle.valueFromRay?.(across(12.3), 5, 0.1)).toBe(12.04);
    // Short of the end, tenths as before; with no step, the free value.
    expect(handle.valueFromRay?.(across(11.93), 5, 0.1)).toBeCloseTo(11.9, 9);
    expect(handle.valueFromRay?.(across(11.93), 5)).toBeCloseTo(11.93, 9);
    // The low end the same way.
    const low = rig(5, 0.37, 10);
    expect(low.valueFromRay?.(across(0.1), 5, 0.1)).toBe(0.37);
  });

  it('scales its value onto the line (a diameter at its radius)', () => {
    const handle = buildLinearHandle({
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      value: 6,
      scale: 0.5
    });
    expect(handle.group.position.x).toBe(3);
    const across = new THREE.Ray(
      new THREE.Vector3(4, 10, 0),
      new THREE.Vector3(0, -1, 0)
    );
    expect(handle.valueFromRay?.(across, 6)).toBeCloseTo(8);
  });

  it('rides its chip past the tip and frees itself', () => {
    const handle = rig(5);
    expect(handle.chipAnchor(1).z).toBeGreaterThan(5);
    handle.dispose();
    expect(handle.group.parent).toBeNull();
  });
});

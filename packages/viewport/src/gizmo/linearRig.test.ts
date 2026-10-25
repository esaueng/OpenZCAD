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

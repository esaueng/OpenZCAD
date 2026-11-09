import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildCoilHandle, COIL_RIG_KIND } from './coilRig';

/** A coil about +Z through the origin, starting out along +X: radius 10, 4 per turn. */
const PARAMS = {
  center: { x: 0, y: 0, z: 0 },
  axis: { x: 0, y: 0, z: 1 },
  startDirection: { x: 1, y: 0, z: 0 },
  radius: 10,
  pitch: 4,
  turns: 3
};

describe('coil end rig', () => {
  it('sits where the coil ends, a whole number of turns above its start', () => {
    const rig = buildCoilHandle(PARAMS);
    expect(rig.kind).toBe(COIL_RIG_KIND);
    expect(rig.group.position.x).toBeCloseTo(10);
    expect(rig.group.position.y).toBeCloseTo(0);
    expect(rig.group.position.z).toBeCloseTo(12);
    // A quarter turn more is a quarter of the way round, right-handed.
    rig.setValue(3.25);
    expect(rig.group.position.x).toBeCloseTo(0);
    expect(rig.group.position.y).toBeCloseTo(10);
    expect(rig.group.position.z).toBeCloseTo(13);
    rig.dispose();
  });

  it('winds on past a full turn from above, without jumping back', () => {
    const rig = buildCoilHandle(PARAMS);
    // Looking down the axis at the point a quarter turn on.
    const down = (x: number, y: number) =>
      new THREE.Ray(new THREE.Vector3(x, y, 100), new THREE.Vector3(0, 0, -1));
    expect(rig.valueFromRay!(down(0, 10), 3)).toBeCloseTo(3.25);
    // Just short of the start direction, coming from 3.9 turns: 3.95, not 0.95.
    const angle = -0.05 * Math.PI * 2;
    expect(
      rig.valueFromRay!(down(10 * Math.cos(angle), 10 * Math.sin(angle)), 3.9)
    ).toBeCloseTo(3.95);
    rig.dispose();
  });

  it('reads the height along the axis when seen from the side', () => {
    const rig = buildCoilHandle(PARAMS);
    const side = new THREE.Ray(
      new THREE.Vector3(-100, 0, 10),
      new THREE.Vector3(1, 0, 0)
    );
    // 10 up the axis at 4 per turn is two and a half turns.
    expect(rig.valueFromRay!(side, 3)).toBeCloseTo(2.5);
    rig.dispose();
  });

  it('reads a perspective ray through the end as the end, not past it', () => {
    const rig = buildCoilHandle(PARAMS);
    // A camera low and to one side, looking through the end at (10, 0, 12).
    const eye = new THREE.Vector3(60, -40, 20);
    const through = new THREE.Vector3(10, 0, 12).sub(eye).normalize();
    expect(through.z).toBeGreaterThan(-0.3);
    expect(rig.valueFromRay!(new THREE.Ray(eye, through), 3)).toBeCloseTo(3);
    rig.dispose();
  });
});

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  angleAboutAxisDeg,
  angleRigBasis,
  buildAngleHandle,
  unwrapSweepDeg
} from './angleRig';

const Z = new THREE.Vector3(0, 0, 1);

function rig(angleDeg = 360) {
  return buildAngleHandle({
    center: { x: 0, y: 0, z: 0 },
    axis: { x: 0, y: 0, z: 1 },
    startDirection: { x: 1, y: 0, z: 0 },
    radius: 10,
    angleDeg
  });
}

/** A ray straight down onto the XY plane at (x, y). */
function downAt(x: number, y: number): THREE.Ray {
  return new THREE.Ray(
    new THREE.Vector3(x, y, 50),
    new THREE.Vector3(0, 0, -1)
  );
}

describe('angle math is pure', () => {
  it('projects the seed off the axis into a right-handed basis', () => {
    const { u, v } = angleRigBasis(Z, new THREE.Vector3(2, 0, 5));
    expect(u.toArray()).toEqual([1, 0, 0]);
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBeCloseTo(1);
    expect(v.z).toBeCloseTo(0);
  });

  it('survives a seed along the axis', () => {
    const { u, v } = angleRigBasis(Z, new THREE.Vector3(0, 0, 3));
    expect(u.dot(Z)).toBeCloseTo(0);
    expect(v.dot(Z)).toBeCloseTo(0);
    expect(u.length()).toBeCloseTo(1);
  });

  it('measures right-handed angles about the axis', () => {
    const { u, v } = angleRigBasis(Z, new THREE.Vector3(1, 0, 0));
    const center = new THREE.Vector3();
    expect(
      angleAboutAxisDeg(center, u, v, new THREE.Vector3(0, 4, 0))
    ).toBeCloseTo(90);
    expect(
      angleAboutAxisDeg(center, u, v, new THREE.Vector3(0, -4, 0))
    ).toBeCloseTo(-90);
  });

  it('keeps the sweep continuous across the atan2 wrap', () => {
    // 179° → −179° (raw) is really 181°.
    expect(unwrapSweepDeg(179, -179, 1, 360)).toBeCloseTo(181);
    expect(unwrapSweepDeg(350, -10, 1, 360)).toBeCloseTo(350);
  });

  it('comes back in at the far end when dragged past a full turn', () => {
    // The ball is where the sweep ends: 5° past the start is a 5° sweep.
    expect(unwrapSweepDeg(360, 5, 1, 360)).toBe(5);
    expect(unwrapSweepDeg(360, -90, 1, 360)).toBe(270);
  });

  it('clamps when no turn fits a narrower range', () => {
    expect(unwrapSweepDeg(90, 45, 60, 120)).toBe(60);
    expect(unwrapSweepDeg(90, 200, 60, 120)).toBe(120);
  });
});

describe('the angle rig', () => {
  it('starts at the requested sweep and reads it back', () => {
    expect(rig(90).value()).toBe(90);
  });

  it('clamps an out-of-range start into its limits', () => {
    expect(rig(720).value()).toBe(360);
    expect(rig(0).value()).toBe(1);
  });

  it('places the handle at the end of the sweep', () => {
    const handle = rig(90);
    expect(handle.group.position.x).toBeCloseTo(0);
    expect(handle.group.position.y).toBeCloseTo(10);
    handle.setValue(180);
    expect(handle.group.position.x).toBeCloseTo(-10);
    expect(handle.group.position.y).toBeCloseTo(0);
  });

  it('turns its drag direction with the sweep (tangent at the end)', () => {
    const handle = rig(90);
    expect(handle.direction.x).toBeCloseTo(-1);
    expect(handle.direction.y).toBeCloseTo(0);
  });

  it('answers a pointer ray with a continuous sweep', () => {
    const handle = rig(90);
    expect(handle.valueFromRay?.(downAt(0, 5), 90)).toBeCloseTo(90);
    expect(handle.valueFromRay?.(downAt(-5, -0.01), 170)).toBeCloseTo(180.1, 0);
    expect(handle.valueFromRay?.(downAt(0, -5), 200)).toBeCloseTo(270);
  });

  it('ignores a ray parallel to its plane', () => {
    const handle = rig(90);
    const sideways = new THREE.Ray(
      new THREE.Vector3(0, -50, 1),
      new THREE.Vector3(0, 1, 0)
    );
    expect(handle.valueFromRay?.(sideways, 90)).toBeNull();
  });

  it('anchors the chip outside the circle at the end of the sweep', () => {
    const handle = rig(0.5 * 180);
    const anchor = handle.chipAnchor(1);
    expect(anchor.length()).toBeGreaterThan(10);
    expect(anchor.y).toBeGreaterThan(10);
  });

  it('frees its geometry on dispose', () => {
    const handle = rig();
    handle.dispose();
    expect(handle.group.parent).toBeNull();
  });
});

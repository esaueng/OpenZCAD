import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { frameForPlaneRef, newCanonicalPlaneRef } from '@openzcad/geometry';
import type { PlaneId } from '@openzcad/shared';
import {
  buildPlanePickerRig,
  ghostPlaneTakesPick,
  PLANE_PICKER_ORDER,
  preferredGhostHit
} from './planePickerRig';

describe('plane picker offsets', () => {
  it('moves every ghost to where the sketch it starts will land, at any screen scale', () => {
    const rig = buildPlanePickerRig();

    for (const worldPerPixel of [0.5, 1]) {
      rig.setScale(worldPerPixel);
      rig.setOffset(22);
      rig.group.updateMatrixWorld(true);

      for (const target of rig.targets()) {
        const plane = target.userData.pickPlane as PlaneId;
        const { origin } = frameForPlaneRef(
          newCanonicalPlaneRef(plane, 22),
          (value) => Number(value)
        );
        const position = target.getWorldPosition(new THREE.Vector3());
        expect(position.x).toBeCloseTo(origin.x, 10);
        expect(position.y).toBeCloseTo(origin.y, 10);
        expect(position.z).toBeCloseTo(origin.z, 10);

        const border = rig.group.getObjectByName(
          `plane-picker-border-${plane}`
        );
        expect(border?.getWorldPosition(new THREE.Vector3())).toEqual(position);
      }
    }

    expect(PLANE_PICKER_ORDER).toEqual(['XY', 'XZ', 'YZ']);
    rig.dispose();
  });
});

describe('plane picker panels', () => {
  it('covers only each plane’s positive quadrant, so the panels never cross', () => {
    const rig = buildPlanePickerRig();
    rig.setScale(0.1);
    rig.setOffset(0);
    rig.group.updateMatrixWorld(true);
    // The world axis each plane leaves out; every panel vertex is ≥ 0 on the
    // other two and 0 on this one.
    const normalAxis = { XY: 'z', XZ: 'y', YZ: 'x' } as const;
    for (const target of rig.targets()) {
      const plane = target.userData.pickPlane as PlaneId;
      const mesh = target as THREE.Mesh;
      const positions = mesh.geometry.getAttribute('position');
      const point = new THREE.Vector3();
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < positions.count; i++) {
        point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
        for (const axis of ['x', 'y', 'z'] as const) {
          if (axis === normalAxis[plane]) {
            expect(Math.abs(point[axis])).toBeLessThan(1e-9);
          } else {
            min = Math.min(min, point[axis]);
            max = Math.max(max, point[axis]);
          }
        }
      }
      // A gap off the axes, and 150 px across at 0.1 world units per pixel.
      expect(min).toBeGreaterThan(0);
      expect(max).toBeCloseTo(15, 9);
    }
    rig.dispose();
  });
});

describe('ghost plane picks', () => {
  it('wins through a face or body in front of it', () => {
    expect(ghostPlaneTakesPick(40, { kind: 'face', distance: 25 })).toBe(true);
    expect(ghostPlaneTakesPick(40, { kind: 'body', distance: 25 })).toBe(true);
    expect(ghostPlaneTakesPick(40, null)).toBe(true);
  });

  it('leaves a face lying in its own plane to the face', () => {
    expect(ghostPlaneTakesPick(40, { kind: 'face', distance: 40 })).toBe(false);
    expect(ghostPlaneTakesPick(40, { kind: 'face', distance: 40 + 1e-5 })).toBe(
      false
    );
  });

  it('never takes an edge, sketch or region in front of it', () => {
    for (const kind of ['edge', 'sketch', 'region']) {
      expect(ghostPlaneTakesPick(40, { kind, distance: 25 })).toBe(false);
      expect(ghostPlaneTakesPick(25, { kind, distance: 40 })).toBe(true);
    }
  });
});

describe('overlapping ghost planes', () => {
  // The default framing looks down on the origin from the front right, where
  // the upright XZ panel stands in front of much of XY.
  const eye = new THREE.Vector3(60, -80, 50);

  function hitsToward(
    rig: ReturnType<typeof buildPlanePickerRig>,
    at: THREE.Vector3
  ) {
    const raycaster = new THREE.Raycaster(eye, at.clone().sub(eye).normalize());
    return raycaster.intersectObjects(rig.targets(), false);
  }

  it('gives XY its centre back where XZ covers it', () => {
    const rig = buildPlanePickerRig();
    rig.setScale(0.1);
    rig.group.updateMatrixWorld(true);
    // XY's centre, 7.8 along X and Y (78 px at 0.1 world units per pixel).
    const hits = hitsToward(rig, new THREE.Vector3(7.8, 7.8, 0));
    // Precondition: XZ really is in front of XY here.
    expect(hits.map((hit) => hit.object.userData.pickPlane as string)).toEqual([
      'XZ',
      'XY'
    ]);
    expect(preferredGhostHit(hits)?.object.userData.pickPlane).toBe('XY');
    rig.dispose();
  });

  it('keeps XZ where the pointer is well inside it', () => {
    const rig = buildPlanePickerRig();
    rig.setScale(0.1);
    rig.group.updateMatrixWorld(true);
    const hits = hitsToward(rig, new THREE.Vector3(7.8, 0, 7.8));
    expect(hits[0]?.object.userData.pickPlane).toBe('XZ');
    expect(preferredGhostHit(hits)?.object.userData.pickPlane).toBe('XZ');
    rig.dispose();
  });

  it('takes the nearer of two equally deep hits', () => {
    const rig = buildPlanePickerRig();
    const [xy, xz] = rig.targets();
    const at = (object: THREE.Object3D, x: number, y: number) =>
      new THREE.Vector3(x, y, 0).applyMatrix4(object.matrixWorld);
    rig.group.updateMatrixWorld(true);
    const near = { object: xz!, point: at(xz!, 40, 40), distance: 1 };
    const far = { object: xy!, point: at(xy!, 40, 40), distance: 2 };
    expect(preferredGhostHit([near, far])).toBe(near);
    rig.dispose();
  });
});

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { frameForPlaneRef, newCanonicalPlaneRef } from '@openzcad/geometry';
import type { PlaneId } from '@openzcad/shared';
import {
  buildPlanePickerRig,
  ghostPlaneTakesPick,
  PLANE_PICKER_ORDER
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

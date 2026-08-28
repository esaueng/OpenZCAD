import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PLANE_BASES } from '@openzcad/geometry';
import type { PlaneId } from '@openzcad/shared';
import { buildPlanePickerRig, PLANE_PICKER_ORDER } from './planePickerRig';

describe('plane picker offsets', () => {
  it('moves every ghost along the canonical plane normal at any screen scale', () => {
    const rig = buildPlanePickerRig();

    for (const worldPerPixel of [0.5, 1]) {
      rig.setScale(worldPerPixel);
      rig.setOffset(22);
      rig.group.updateMatrixWorld(true);

      for (const target of rig.targets()) {
        const plane = target.userData.pickPlane as PlaneId;
        const normal = PLANE_BASES[plane].normal;
        const position = target.getWorldPosition(new THREE.Vector3());
        expect(position.x).toBeCloseTo(normal.x * 22, 10);
        expect(position.y).toBeCloseTo(normal.y * 22, 10);
        expect(position.z).toBeCloseTo(normal.z * 22, 10);

        const border = rig.group.getObjectByName(`plane-picker-border-${plane}`);
        expect(border?.getWorldPosition(new THREE.Vector3())).toEqual(position);
      }
    }

    expect(PLANE_PICKER_ORDER).toEqual(['XY', 'XZ', 'YZ']);
    rig.dispose();
  });
});

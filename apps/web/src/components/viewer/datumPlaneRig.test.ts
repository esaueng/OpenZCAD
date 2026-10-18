import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildDatumPlaneRig } from './datumPlaneRig';

const frame = (z: number) => ({
  origin: { x: 0, y: 0, z },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 }
});

describe('buildDatumPlaneRig', () => {
  it('sizes each plane by the pixel scale at its own origin', () => {
    const rig = buildDatumPlaneRig([
      { featureId: 'near', frame: frame(0), selected: false },
      { featureId: 'far', frame: frame(100), selected: true }
    ]);
    // Perspective: a world unit covers fewer pixels the farther it is.
    rig.setScale((point: THREE.Vector3) => 0.01 + point.z * 0.001);
    const scaleOf = (id: string) =>
      rig.group.children.find(
        (object) => object.userData.datumFeatureId === id
      )!.scale.x;
    expect(scaleOf('near')).toBeCloseTo(160 * 0.01);
    expect(scaleOf('far')).toBeCloseTo(160 * 0.11);
    // Presentation only: never a pick target.
    const hits: THREE.Intersection[] = [];
    rig.group.children[0]!.raycast(new THREE.Raycaster(), hits);
    expect(hits).toEqual([]);
    rig.dispose();
  });
});

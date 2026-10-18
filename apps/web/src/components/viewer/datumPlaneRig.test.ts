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
    rig.dispose();
  });

  it('offers only its fills as pick targets, each naming its datum', () => {
    const rig = buildDatumPlaneRig([
      { featureId: 'lid', frame: frame(10), selected: false }
    ]);
    rig.setScale(() => 0.1);
    rig.group.updateMatrixWorld(true);
    const targets = rig.targets();
    expect(targets).toHaveLength(1);
    expect(targets[0]!.userData.datumFeatureId).toBe('lid');
    // A ray straight down through the quad hits the fill…
    const ray = new THREE.Raycaster(
      new THREE.Vector3(0, 0, 50),
      new THREE.Vector3(0, 0, -1)
    );
    const hit = ray.intersectObjects(targets, false)[0];
    expect(hit?.object.userData.datumFeatureId).toBe('lid');
    expect(hit?.distance).toBeCloseTo(40);
    // …and never the border, which is not offered.
    const border = rig.group.children.find(
      (object) => object instanceof THREE.LineSegments
    )!;
    const borderHits: THREE.Intersection[] = [];
    border.raycast(ray, borderHits);
    expect(borderHits).toEqual([]);
    rig.dispose();
  });
});

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildDatumAxisRig } from './datumAxisRig';

describe('buildDatumAxisRig', () => {
  it('lays each axis along its direction through its origin', () => {
    const rig = buildDatumAxisRig([
      {
        featureId: 'post',
        axis: { origin: { x: 5, y: 5, z: 0 }, direction: { x: 0, y: 0, z: 1 } },
        selected: false
      }
    ]);
    rig.setScale(() => 0.1);
    rig.group.updateMatrixWorld(true);
    const line = rig.group.children[0]!;
    expect(line.userData.datumFeatureId).toBe('post');
    const end = new THREE.Vector3(0.5, 0, 0).applyMatrix4(line.matrixWorld);
    expect(end.x).toBeCloseTo(5);
    expect(end.y).toBeCloseTo(5);
    // 240 px at 0.1 world units per pixel: 24 long, 12 each side.
    expect(end.z).toBeCloseTo(12);
    rig.dispose();
  });

  it('is never a pick target', () => {
    const rig = buildDatumAxisRig([
      {
        featureId: 'x',
        axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } },
        selected: true
      }
    ]);
    rig.setScale(() => 1);
    rig.group.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(
      new THREE.Vector3(0, 0, 10),
      new THREE.Vector3(0, 0, -1)
    );
    expect(ray.intersectObject(rig.group, true)).toEqual([]);
    rig.dispose();
  });
});

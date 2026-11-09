import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { buildAxisPickerRig } from './axisPickerRig';

const candidates = [
  {
    id: 'sketch-horizontal',
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 }
  },
  {
    id: 'sketch-vertical',
    origin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: 3 }
  }
];

describe('axis picker rig', () => {
  it('exposes one tagged hit target per candidate', () => {
    const rig = buildAxisPickerRig(candidates);
    expect(rig.targets().map((t) => t.userData.pickAxis as string)).toEqual([
      'sketch-horizontal',
      'sketch-vertical'
    ]);
  });

  it('lets a ray along the screen hit the line it crosses', () => {
    const rig = buildAxisPickerRig(candidates);
    rig.setScale(() => 0.1);
    rig.group.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(0.2, -50, 20),
      new THREE.Vector3(0, 1, 0)
    );
    const hit = raycaster.intersectObjects(rig.targets(), false)[0];
    expect(hit?.object.userData.pickAxis).toBe('sketch-vertical');
  });

  it('misses a ray that passes wide of every line', () => {
    const rig = buildAxisPickerRig(candidates);
    rig.setScale(() => 0.1);
    rig.group.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(30, -50, 20),
      new THREE.Vector3(0, 1, 0)
    );
    expect(raycaster.intersectObjects(rig.targets(), false)).toHaveLength(0);
  });

  it('highlights only the hovered line: wider and solid', () => {
    const rig = buildAxisPickerRig(candidates);
    rig.setHover('sketch-vertical');
    const materials = rig.group.children.map(
      (holder) => (holder.children[0] as LineSegments2).material
    );
    expect(materials[1]!.linewidth).toBeGreaterThan(materials[0]!.linewidth);
    expect(materials.map((material) => material.dashed)).toEqual([true, false]);
    // The picked line turns its own colour.
    rig.setHover(null);
    rig.setSelected('sketch-horizontal');
    expect(materials[0]!.color.getHex()).not.toBe(materials[1]!.color.getHex());
    rig.dispose();
    expect(rig.group.children).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { buildDatumAxisRig } from './datumAxisRig';
import { DATUM_SELECTED_COLOR } from './datumStyle';

const materialsOf = (object: THREE.Object3D) =>
  object.children
    .filter((child): child is Line2 => child instanceof Line2)
    .map((line) => line.material);

describe('buildDatumAxisRig', () => {
  it('lays each axis along its direction through its origin', () => {
    const rig = buildDatumAxisRig([
      {
        featureId: 'post',
        name: 'Axis 1',
        axis: { origin: { x: 5, y: 5, z: 0 }, direction: { x: 0, y: 0, z: 1 } },
        selected: false
      }
    ]);
    rig.setScale(() => 0.1);
    rig.group.updateMatrixWorld(true);
    const holder = rig.group.children[0]!;
    expect(holder.userData.datumFeatureId).toBe('post');
    const end = new THREE.Vector3(0.5, 0, 0).applyMatrix4(holder.matrixWorld);
    expect(end.x).toBeCloseTo(5);
    expect(end.y).toBeCloseTo(5);
    // 250 px at 0.1 world units per pixel: 25 long, 12.5 each side.
    expect(end.z).toBeCloseTo(12.5);
    rig.dispose();
  });

  it('is never a pick target', () => {
    const rig = buildDatumAxisRig([
      {
        featureId: 'x',
        name: 'Axis 1',
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

  it('draws a solid 3 px line with a dashed continuation behind the part', () => {
    const rig = buildDatumAxisRig([
      {
        featureId: 'x',
        name: 'Axis 1',
        axis: { origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } },
        selected: false
      }
    ]);
    const materials = materialsOf(rig.group.children[0]!);
    const line = materials.find((material) => material.depthTest)!;
    const hidden = materials.find((material) => !material.depthTest)!;
    expect(line.linewidth).toBe(3);
    expect(line.dashed).toBe(false);
    expect(hidden.dashed).toBe(true);
    rig.dispose();
  });

  it('keeps a selected axis in the selection hue through a theme repaint', () => {
    const rig = buildDatumAxisRig(
      [
        {
          featureId: 'idle',
          name: 'Axis 1',
          axis: {
            origin: { x: 0, y: 0, z: 0 },
            direction: { x: 1, y: 0, z: 0 }
          },
          selected: false
        },
        {
          featureId: 'sel',
          name: 'Axis 2',
          axis: {
            origin: { x: 0, y: 0, z: 0 },
            direction: { x: 0, y: 1, z: 0 }
          },
          selected: true
        }
      ],
      { color: '#5d6a80' }
    );
    const [idle, sel] = rig.group.children;
    rig.setColor('#b3bed0');
    for (const material of materialsOf(idle!)) {
      expect(material.color.getHexString()).toBe('b3bed0');
    }
    for (const material of materialsOf(sel!)) {
      expect(material.color.getHexString()).toBe(DATUM_SELECTED_COLOR.slice(1));
    }
    const label = sel!.children.find(
      (child): child is CSS2DObject => child instanceof CSS2DObject
    )!;
    expect(label.element.textContent).toBe('Axis 2');
    expect(label.element.dataset.selected).toBe('true');
    rig.dispose();
  });
});

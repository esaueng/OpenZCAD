import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { buildDatumPlaneRig } from './datumPlaneRig';
import { DATUM_SELECTED_COLOR } from './datumStyle';

const frame = (z: number) => ({
  origin: { x: 0, y: 0, z },
  u: { x: 1, y: 0, z: 0 },
  v: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 }
});

const holderOf = (rig: { group: THREE.Group }, id: string) =>
  rig.group.children.find((object) => object.userData.datumFeatureId === id)!;
const linesOf = (object: THREE.Object3D) =>
  object.children.filter((child): child is Line2 => child instanceof Line2);
const labelOf = (object: THREE.Object3D) =>
  object.children.find(
    (child): child is CSS2DObject => child instanceof CSS2DObject
  )!;

describe('buildDatumPlaneRig', () => {
  it('sizes each plane by the pixel scale at its own origin', () => {
    const rig = buildDatumPlaneRig([
      { featureId: 'near', name: 'Plane 1', frame: frame(0), selected: false },
      { featureId: 'far', name: 'Plane 2', frame: frame(100), selected: true }
    ]);
    // Perspective: a world unit covers fewer pixels the farther it is.
    rig.setScale((point: THREE.Vector3) => 0.01 + point.z * 0.001);
    expect(holderOf(rig, 'near').scale.x).toBeCloseTo(170 * 0.01);
    expect(holderOf(rig, 'far').scale.x).toBeCloseTo(170 * 0.11);
    rig.dispose();
  });

  it('offers only its fills as pick targets, each naming its datum', () => {
    const rig = buildDatumPlaneRig([
      { featureId: 'lid', name: 'Lid', frame: frame(10), selected: false }
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
    // …and never an outline, which is not offered.
    const lines = linesOf(holderOf(rig, 'lid'));
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const hits: THREE.Intersection[] = [];
      line.raycast(ray, hits);
      expect(hits).toEqual([]);
    }
    rig.dispose();
  });

  it('draws a heavy border and a dashed outline that shows through the part', () => {
    const rig = buildDatumPlaneRig([
      { featureId: 'lid', name: 'Lid', frame: frame(10), selected: false }
    ]);
    const materials = linesOf(holderOf(rig, 'lid')).map(
      (line) => line.material
    );
    const border = materials.find((material) => material.depthTest)!;
    const hidden = materials.find((material) => !material.depthTest)!;
    expect(border.linewidth).toBe(2.5);
    expect(border.dashed).toBe(false);
    expect(hidden.dashed).toBe(true);
    expect(hidden.linewidth).toBeLessThan(border.linewidth);
    rig.dispose();
  });

  it('paints a selected plane in the selection hue, which a theme repaint keeps', () => {
    const rig = buildDatumPlaneRig(
      [
        {
          featureId: 'idle',
          name: 'Plane 1',
          frame: frame(0),
          selected: false
        },
        { featureId: 'sel', name: 'Plane 2', frame: frame(5), selected: true }
      ],
      { color: '#5d6a80' }
    );
    const fillColor = (id: string) =>
      (
        (holderOf(rig, id).children[0] as THREE.Mesh)
          .material as THREE.MeshBasicMaterial
      ).color.getHexString();
    expect(fillColor('idle')).toBe('5d6a80');
    expect(fillColor('sel')).toBe(DATUM_SELECTED_COLOR.slice(1));
    expect(labelOf(holderOf(rig, 'sel')).element.dataset.selected).toBe('true');
    expect(labelOf(holderOf(rig, 'idle')).element.dataset.selected).toBe(
      undefined
    );

    rig.setColor('#b3bed0');
    expect(fillColor('idle')).toBe('b3bed0');
    expect(fillColor('sel')).toBe(DATUM_SELECTED_COLOR.slice(1));
    for (const line of linesOf(holderOf(rig, 'idle'))) {
      expect(line.material.color.getHexString()).toBe('b3bed0');
    }
    rig.dispose();
  });

  it('labels each plane with its name and takes the label off the page on dispose', () => {
    const rig = buildDatumPlaneRig([
      { featureId: 'lid', name: 'Lid plane', frame: frame(0), selected: false }
    ]);
    const label = labelOf(holderOf(rig, 'lid'));
    expect(label.element.textContent).toBe('Lid plane');
    expect(label.element.className).toBe('viewport-datum-label');
    // The label renderer parents each element in its layer.
    document.body.appendChild(label.element);
    rig.dispose();
    expect(label.element.isConnected).toBe(false);
  });
});

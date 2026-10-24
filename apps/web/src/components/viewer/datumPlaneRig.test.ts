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

describe('buildDatumPlaneRig', () => {
  it('sizes each plane by the pixel scale at its own origin', () => {
    const rig = buildDatumPlaneRig([
      { featureId: 'near', frame: frame(0), selected: false },
      { featureId: 'far', frame: frame(100), selected: true }
    ]);
    // Perspective: a world unit covers fewer pixels the farther it is.
    rig.setScale((point: THREE.Vector3) => 0.01 + point.z * 0.001);
    expect(holderOf(rig, 'near').scale.x).toBeCloseTo(170 * 0.01);
    expect(holderOf(rig, 'far').scale.x).toBeCloseTo(170 * 0.11);
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
      { featureId: 'lid', frame: frame(10), selected: false }
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
          frame: frame(0),
          selected: false
        },
        { featureId: 'sel', frame: frame(5), selected: true }
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

    rig.setColor('#b3bed0');
    expect(fillColor('idle')).toBe('b3bed0');
    expect(fillColor('sel')).toBe(DATUM_SELECTED_COLOR.slice(1));
    for (const line of linesOf(holderOf(rig, 'idle'))) {
      expect(line.material.color.getHexString()).toBe('b3bed0');
    }
    rig.dispose();
  });

  it('pins no name label to the plane, selected or not', () => {
    const rig = buildDatumPlaneRig([
      { featureId: 'idle', frame: frame(0), selected: false },
      { featureId: 'sel', frame: frame(5), selected: true }
    ]);
    const labels: CSS2DObject[] = [];
    rig.group.traverse((node) => {
      if (node instanceof CSS2DObject) labels.push(node);
    });
    expect(labels).toEqual([]);
    rig.dispose();
  });
});

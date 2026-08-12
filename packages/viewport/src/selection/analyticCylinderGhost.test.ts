import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import {
  ANALYTIC_GHOST_COLOR,
  ANALYTIC_GHOST_OPACITY,
  createAnalyticCylinderGhost
} from './analyticCylinderGhost';
import { VIEWPORT_RENDER_ORDER } from '../render/scene';

describe('createAnalyticCylinderGhost', () => {
  it('builds a closed reference cylinder and dashed axis from exact geometry', () => {
    const ghost = createAnalyticCylinderGhost(
      {
        surfaceType: 'cylinder',
        radius: 2,
        axisStart: { x: 1, y: 2, z: 3 },
        axisEnd: { x: 1, y: 2, z: 13 }
      },
      { width: 900, height: 600 }
    );

    expect(ghost).not.toBeNull();
    const cylinder = ghost?.getObjectByName('analytic-cylinder-extent');
    expect(cylinder).toBeInstanceOf(THREE.Mesh);
    if (!(cylinder instanceof THREE.Mesh)) {
      throw new Error('Analytic cylinder mesh was not created.');
    }
    expect(cylinder.geometry).toBeInstanceOf(THREE.CylinderGeometry);
    expect(
      (cylinder.geometry as THREE.CylinderGeometry).parameters.openEnded
    ).toBe(false);
    const material = cylinder.material as THREE.MeshBasicMaterial;
    expect(material.color.getHex()).toBe(ANALYTIC_GHOST_COLOR);
    expect(material.opacity).toBe(ANALYTIC_GHOST_OPACITY);
    expect(material.depthWrite).toBe(false);
    expect(material.side).toBe(THREE.DoubleSide);
    expect(cylinder.renderOrder).toBe(
      VIEWPORT_RENDER_ORDER.HOVER_HIGHLIGHT - 1
    );

    const bounds = new THREE.Box3().setFromObject(cylinder);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    expect(center.toArray()).toEqual([1, 2, 8]);
    expect(size.x).toBeCloseTo(4, 5);
    expect(size.y).toBeCloseTo(4, 5);
    expect(size.z).toBeCloseTo(10, 5);

    const axis = ghost?.getObjectByName('analytic-cylinder-axis');
    expect(axis).toBeInstanceOf(Line2);
    if (!(axis instanceof Line2)) {
      throw new Error('Analytic cylinder axis was not created.');
    }
    expect(axis.material.dashed).toBe(true);
    expect(axis.material.depthTest).toBe(false);
    expect(axis.material.resolution.toArray()).toEqual([900, 600]);
  });

  it('refuses incomplete or degenerate analytic data', () => {
    expect(
      createAnalyticCylinderGhost({
        surfaceType: 'plane',
        radius: 2,
        axisStart: { x: 0, y: 0, z: 0 },
        axisEnd: { x: 0, y: 0, z: 10 }
      })
    ).toBeNull();
    expect(
      createAnalyticCylinderGhost({
        surfaceType: 'cylinder',
        radius: 2,
        axisStart: { x: 0, y: 0, z: 0 },
        axisEnd: { x: 0, y: 0, z: 0 }
      })
    ).toBeNull();
  });
});

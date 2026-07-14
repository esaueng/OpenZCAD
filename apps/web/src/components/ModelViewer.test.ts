import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
  configureEdgeRaycasting,
  createExtrudePreviewGeometry,
  directEditDirectionFromNormal,
  isViewerMesh,
  prioritizeVisibleEdgeHit,
  RightClickGestureTracker
} from './ModelViewer';

describe('model viewer mesh classification', () => {
  it('applies emissive highlighting only to standard-material body meshes', () => {
    const geometry = new THREE.BufferGeometry();
    const body = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: 0xffffff })
    );
    const faceOverlay = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color: 0x3b82f6 })
    );

    expect(isViewerMesh(body)).toBe(true);
    expect(isViewerMesh(faceOverlay)).toBe(false);
  });

  it('maps picked planar face normals to box dimensions and sides', () => {
    expect(
      directEditDirectionFromNormal(new THREE.Vector3(0.98, 0.1, 0.05))
    ).toEqual({
      axis: 'x',
      side: 1
    });
    expect(directEditDirectionFromNormal(new THREE.Vector3(0, -1, 0))).toEqual({
      axis: 'y',
      side: -1
    });
    expect(
      directEditDirectionFromNormal(new THREE.Vector3(0.1, 0.2, -0.9))
    ).toEqual({
      axis: 'z',
      side: -1
    });
  });

  it('builds a signed extrusion preview on either side of a sketch plane', () => {
    const sketch = {
      sketchId: 'sketch-1',
      name: 'Sketch 01',
      selected: true,
      profile: [
        { x: -5, y: -5 },
        { x: 5, y: -5 },
        { x: 5, y: 5 },
        { x: -5, y: 5 }
      ],
      normal: { x: 0, y: 0, z: 1 },
      points: [
        { x: -5, y: -5, z: 0 },
        { x: 5, y: -5, z: 0 },
        { x: 5, y: 5, z: 0 },
        { x: -5, y: 5, z: 0 }
      ]
    };

    const positive = createExtrudePreviewGeometry(sketch, 8);
    positive.computeBoundingBox();
    expect(positive.boundingBox?.min.z).toBe(0);
    expect(positive.boundingBox?.max.z).toBe(8);

    const opposite = createExtrudePreviewGeometry(sketch, -6);
    opposite.computeBoundingBox();
    expect(opposite.boundingBox?.min.z).toBe(-6);
    expect(opposite.boundingBox?.max.z).toBe(0);
    expect(opposite.getAttribute('position').count).toBe(8);
  });

  it('opens the context menu only for a stationary right-click', () => {
    const gesture = new RightClickGestureTracker();

    gesture.begin(1, 120, 80);
    gesture.move(1, 123, 82);
    expect(gesture.end(1, 123, 82)).toBe(true);
  });

  it('keeps a right-drag classified as a pan after returning to its origin', () => {
    const gesture = new RightClickGestureTracker();

    gesture.begin(1, 120, 80);
    gesture.move(1, 132, 90);
    gesture.move(1, 120, 80);
    expect(gesture.end(1, 120, 80)).toBe(false);
  });

  it('suppresses the menu when OrbitControls confirms a camera pan', () => {
    const gesture = new RightClickGestureTracker();

    gesture.begin(1, 120, 80);
    gesture.markDragged(1);
    expect(gesture.end(1, 120, 80)).toBe(false);
  });

  it('picks rendered edges using a camera-independent screen-space radius', () => {
    const geometry = new LineGeometry();
    geometry.setPositions([-1, 0, 0, 1, 0, 0]);
    const material = new LineMaterial({ linewidth: 2 });
    material.resolution.set(1000, 1000);
    const edge = new Line2(geometry, material);
    edge.computeLineDistances();
    edge.updateMatrixWorld(true);

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    const raycaster = new THREE.Raycaster();
    configureEdgeRaycasting(raycaster);

    raycaster.setFromCamera(new THREE.Vector2(0, (2.9 * 2) / 1000), camera);
    expect(raycaster.intersectObject(edge)).toHaveLength(1);

    raycaster.setFromCamera(new THREE.Vector2(0, (3.1 * 2) / 1000), camera);
    expect(raycaster.intersectObject(edge)).toHaveLength(0);
  });

  it('does not prioritize an edge hidden meaningfully behind a face', () => {
    const face = new THREE.Object3D();
    const edge = new THREE.Object3D();
    edge.userData.topologyKind = 'edge';

    const coplanar = prioritizeVisibleEdgeHit([
      { distance: 100, object: face },
      { distance: 100.005, object: edge }
    ]);
    expect(coplanar[0]?.object).toBe(edge);

    const occluded = prioritizeVisibleEdgeHit([
      { distance: 100, object: face },
      { distance: 100.02, object: edge }
    ]);
    expect(occluded[0]?.object).toBe(face);
  });
});

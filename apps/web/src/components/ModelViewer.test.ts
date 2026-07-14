import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
  chooseMoveSnapStep,
  chooseRotateSnapStep,
  composeMoveTransform,
  configureEdgeRaycasting,
  createExtrudePreviewGeometry,
  directEditDirectionFromNormal,
  isViewerMesh,
  moveEuler,
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

describe('move gizmo snapping', () => {
  it('coarsens the translation step as the camera zooms out', () => {
    // 1 world unit ≈ 1px → an 8px minimum needs a 10-unit step.
    expect(chooseMoveSnapStep(1)).toBe(10);
    // Typical mid zoom: 0.1 world/px → 1 unit spans 10px → 1 mm snapping.
    expect(chooseMoveSnapStep(0.1)).toBe(1);
    // Zoomed in: 0.01 world/px → 0.1 mm steps unlock.
    expect(chooseMoveSnapStep(0.01)).toBe(0.1);
    // Extreme zoom keeps the finest step instead of collapsing to zero.
    expect(chooseMoveSnapStep(0.00001)).toBe(0.01);
    // Extreme zoom-out clamps to the coarsest step.
    expect(chooseMoveSnapStep(1000)).toBe(100);
    expect(chooseMoveSnapStep(0)).toBe(1);
  });

  it('coarsens the rotation step as the ring shrinks on screen', () => {
    // Big ring: 10px per degree → 1° snapping.
    expect(chooseRotateSnapStep(10)).toBe(1);
    // Small ring: 1px per degree → 15° snapping.
    expect(chooseRotateSnapStep(1)).toBe(15);
    // Huge ring: 100px per degree → finest 0.1° step.
    expect(chooseRotateSnapStep(100)).toBe(0.1);
    expect(chooseRotateSnapStep(0)).toBe(15);
  });
});

describe('composeMoveTransform', () => {
  it('is the identity translation when there is no rotation', () => {
    const result = composeMoveTransform(
      { x: 15, y: 9, z: 12 },
      { x: 5, y: -2, z: 0 },
      { x: 0, y: 0, z: 0 }
    );
    expect(result).toEqual({ x: 5, y: -2, z: 0 });
  });

  it('keeps the pivot fixed under rotation about the body center', () => {
    const center = { x: 15, y: 9, z: 12 };
    const rotation = { x: 0, y: 90, z: 0 };
    const translation = composeMoveTransform(
      center,
      { x: 0, y: 0, z: 0 },
      rotation
    );
    // Rotating the center point by the same rotation and adding the computed
    // translation must land back on the center: c = R·c + T.
    const rotated = new THREE.Vector3(center.x, center.y, center.z).applyEuler(
      moveEuler(rotation)
    );
    expect(rotated.x + translation.x).toBeCloseTo(center.x, 9);
    expect(rotated.y + translation.y).toBeCloseTo(center.y, 9);
    expect(rotated.z + translation.z).toBeCloseTo(center.z, 9);
  });

  it('matches the exact kernel rotation order (X, then Y, then Z)', () => {
    // +Y rotated 90° about X first (→ +Z), then 90° about Y (→ +X):
    // Euler 'ZYX' composition v' = Rz(Ry(Rx v)) matches the kernel's order.
    const v = new THREE.Vector3(0, 1, 0);
    v.applyEuler(moveEuler({ x: 90, y: 90, z: 0 }));
    expect(v.x).toBeCloseTo(1, 9);
    expect(v.y).toBeCloseTo(0, 9);
    expect(v.z).toBeCloseTo(0, 9);
  });
});

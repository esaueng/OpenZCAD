import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
  applyMoveGizmoFocus,
  buildMoveGizmoParts,
  chooseMoveSnapStep,
  chooseRotateSnapStep,
  composeMoveTransform,
  configureEdgeRaycasting,
  createExtrudePreviewGeometry,
  dimensionLabelLayout,
  directEditDirectionFromNormal,
  isViewerMesh,
  moveGizmoHandleLabel,
  moveGizmoWorldScale,
  moveEuler,
  prioritizeVisibleEdgeHit,
  MAX_TWEEN_MS,
  MIN_TWEEN_MS,
  orbitPivotForPoint,
  tweenDurationFor,
  projectToScreen,
  RightClickGestureTracker,
  VIEW_DIRECTIONS
} from './index';

describe('model viewer mesh classification', () => {
  it('applies emissive highlighting only to lit body meshes', () => {
    const geometry = new THREE.BufferGeometry();
    const body = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ color: 0xffffff })
    );
    const phongBody = new THREE.Mesh(
      geometry,
      new THREE.MeshPhongMaterial({ color: 0xffffff })
    );
    const faceOverlay = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color: 0x3b82f6 })
    );

    expect(isViewerMesh(body)).toBe(true);
    expect(isViewerMesh(phongBody)).toBe(true);
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

  it('keeps dimension labels aligned, model-scaled, and flip-free', () => {
    const horizontal = dimensionLabelLayout(
      { x: 20, y: 40 },
      { x: 220, y: 40 },
      260
    );
    expect(horizontal.angleDeg).toBeCloseTo(0);
    expect(horizontal.scale).toBeCloseTo(0.72);

    const continued = dimensionLabelLayout(
      { x: 100, y: 200 },
      { x: 102, y: 0 },
      90,
      89
    );
    expect(continued.angleDeg).toBeGreaterThan(89);
    expect(continued.angleDeg).toBeLessThan(92);
    expect(continued.scale).toBe(0.72);

    const edgeOn = dimensionLabelLayout(
      { x: 100, y: 100 },
      { x: 102, y: 102 },
      1200,
      37
    );
    expect(edgeOn.angleDeg).toBe(37);
    expect(edgeOn.scale).toBe(1);
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
  it('keeps a constant screen-space size as camera zoom changes', () => {
    expect(moveGizmoWorldScale(1)).toBe(104);
    expect(moveGizmoWorldScale(0.1)).toBeCloseTo(10.4);
    expect(moveGizmoWorldScale(0.01)).toBeCloseTo(1.04);
    expect(moveGizmoWorldScale(0)).toBe(1);
  });

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

describe('move gizmo focus', () => {
  it('names translation, rotation, and free-move handles explicitly', () => {
    expect(moveGizmoHandleLabel('axis', 'x')).toBe('Move X axis');
    expect(moveGizmoHandleLabel('ring', 'z')).toBe('Rotate Z axis');
    expect(moveGizmoHandleLabel('center', 'y')).toBe('Move freely');
  });

  it('outlines the focused handle and dims competing handles', () => {
    const group = new THREE.Group();
    const focused = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xef6a6a,
        opacity: 0.6,
        transparent: true
      })
    );
    focused.userData = {
      moveHandleVisual: true,
      kind: 'ring',
      axis: 'x',
      baseColor: 0xef6a6a,
      baseOpacity: 0.6
    };
    const competing = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({
        color: 0x5f8fef,
        opacity: 0.95,
        transparent: true
      })
    );
    competing.userData = {
      moveHandleVisual: true,
      kind: 'axis',
      axis: 'z',
      baseColor: 0x5f8fef,
      baseOpacity: 0.95
    };
    const outline = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    outline.userData = {
      moveHandleFocus: true,
      kind: 'ring',
      axis: 'x'
    };
    outline.visible = false;
    group.add(focused, competing, outline);

    applyMoveGizmoFocus(group, { kind: 'ring', axis: 'x' });

    expect(outline.visible).toBe(true);
    expect(focused.material.opacity).toBe(1);
    expect(competing.material.opacity).toBeCloseTo(0.19);

    applyMoveGizmoFocus(group, null);
    expect(outline.visible).toBe(false);
    expect(focused.material.opacity).toBe(0.6);
    expect(competing.material.opacity).toBe(0.95);
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

describe('standard views are posed for a Z-up world', () => {
  const UP = new THREE.Vector3(0, 0, 1);

  it('looks down +Z for top, along +Y for front, and along -X for right', () => {
    // Directions point from the target toward the camera.
    expect(VIEW_DIRECTIONS.top.z).toBeGreaterThan(0.99);
    expect(VIEW_DIRECTIONS.front.y).toBeCloseTo(-1, 6);
    expect(VIEW_DIRECTIONS.right.x).toBeCloseTo(1, 6);
    // Iso sits above the model, on the right and in front of it.
    expect(VIEW_DIRECTIONS.iso.z).toBeGreaterThan(0);
    expect(VIEW_DIRECTIONS.iso.x).toBeGreaterThan(0);
    expect(VIEW_DIRECTIONS.iso.y).toBeLessThan(0);
  });

  it('keeps the top view off the up axis so OrbitControls cannot gimbal', () => {
    const parallel = Math.abs(VIEW_DIRECTIONS.top.dot(UP));
    expect(parallel).toBeLessThan(1);
    // ...but still essentially straight down.
    expect(parallel).toBeGreaterThan(0.999);
  });

  /** Screen basis of a camera parked along `direction` looking at the origin. */
  function screenBasis(direction: THREE.Vector3) {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 4000);
    camera.up.copy(UP);
    camera.position.copy(direction).multiplyScalar(100);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    return {
      right: new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0),
      up: new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1)
    };
  }

  it('puts +X right and +Y up in the top view, so an XY sketch reads unmirrored', () => {
    const { right, up } = screenBasis(VIEW_DIRECTIONS.top);
    expect(right.x).toBeCloseTo(1, 3);
    expect(up.y).toBeCloseTo(1, 3);
  });

  it('puts +Z up in the front and right views', () => {
    for (const view of ['front', 'right'] as const) {
      expect(screenBasis(VIEW_DIRECTIONS[view]).up.z).toBeCloseTo(1, 3);
    }
  });

  it('shows an XY sketch face-on rather than edge-on in the top view', () => {
    // The old Y-up mapping sent XY sketches to the front view, where the
    // profile collapsed to an invisible line.
    const normal = new THREE.Vector3(0, 0, 1); // PLANE_BASES.XY
    expect(Math.abs(VIEW_DIRECTIONS.top.dot(normal))).toBeGreaterThan(0.99);
    expect(Math.abs(VIEW_DIRECTIONS.front.dot(normal))).toBeLessThan(0.01);
  });
});

describe('the move gizmo is built to be picked and focused', () => {
  const parts = buildMoveGizmoParts(10);
  const tagged = (key: string) =>
    parts.filter((part) => part.userData[key] === true);

  it('gives every axis a translation arrow and a rotation ring', () => {
    // The visible parts are tagged pickable too, so the whole arrow responds
    // to the pointer rather than only its invisible hit volume.
    const kinds = new Set(
      tagged('moveHandle').map(
        (part) => `${part.userData.kind}:${part.userData.axis}`
      )
    );
    expect([...kinds].sort()).toEqual([
      'axis:x',
      'axis:y',
      'axis:z',
      'center:x',
      'ring:x',
      'ring:y',
      'ring:z'
    ]);
  });

  it('pairs every focus twin with a visual it can highlight', () => {
    // applyMoveGizmoFocus matches on kind+axis, so a focus part with no
    // corresponding visual would light up nothing.
    const visuals = new Set(
      tagged('moveHandleVisual').map(
        (part) => `${part.userData.kind}:${part.userData.axis}`
      )
    );
    for (const focus of tagged('moveHandleFocus')) {
      expect(visuals).toContain(
        `${focus.userData.kind}:${focus.userData.axis}`
      );
    }
  });

  it('starts with every focus twin hidden', () => {
    expect(tagged('moveHandleFocus').every((part) => !part.visible)).toBe(true);
  });

  it('offers a free-move centre handle', () => {
    const centre = tagged('moveHandleVisual').filter(
      (part) => part.userData.kind === 'center'
    );
    expect(centre).toHaveLength(1);
  });

  it('backs each axis arrow and ring with an invisible fat hit volume', () => {
    const invisible = tagged('moveHandle').filter(
      (part) =>
        !((part as THREE.Mesh).material as THREE.MeshBasicMaterial).visible
    );
    expect(invisible).toHaveLength(6);
    expect(
      new Set(invisible.map((part) => String(part.userData.kind)))
    ).toEqual(new Set(['axis', 'ring']));
  });

  it('scales its geometry with the requested size', () => {
    const small = buildMoveGizmoParts(1);
    const large = buildMoveGizmoParts(10);
    const reach = (list: THREE.Object3D[]) =>
      Math.max(...list.map((part) => part.position.length()));
    expect(reach(large)).toBeCloseTo(reach(small) * 10, 6);
  });
});

describe('projecting a world anchor to the screen', () => {
  function camera() {
    const perspective = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    perspective.position.set(0, 0, 10);
    perspective.lookAt(0, 0, 0);
    perspective.updateMatrixWorld(true);
    perspective.updateProjectionMatrix();
    return perspective;
  }

  it('puts a point on the view axis at the centre of the viewport', () => {
    const screen = projectToScreen(new THREE.Vector3(0, 0, 0), camera(), 800, 600);
    expect(screen?.x).toBeCloseTo(400, 6);
    expect(screen?.y).toBeCloseTo(300, 6);
  });

  it('grows y downward, matching CSS rather than clip space', () => {
    const above = projectToScreen(new THREE.Vector3(0, 1, 0), camera(), 800, 600);
    expect(above!.y).toBeLessThan(300);
  });

  it('reports nothing for a point behind the camera', () => {
    // An anchor that has swung behind the viewer must hide its chip rather
    // than reappear mirrored on the far side of the screen.
    expect(
      projectToScreen(new THREE.Vector3(0, 0, 200), camera(), 800, 600)
    ).toBeNull();
  });
});

describe('the orbit pivot follows what was picked', () => {
  const at = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  it('puts the pivot at the picked point when it is dead ahead', () => {
    const pivot = orbitPivotForPoint(at(0, 0, 10), at(0, 0, -1), at(0, 0, 4));
    expect(pivot!.toArray()).toEqual([0, 0, 4]);
  });

  it('keeps the pivot on the view axis for an off-axis pick', () => {
    // Projecting onto the axis is what stops the camera turning; the pivot
    // takes the point's depth without inheriting its sideways offset.
    const pivot = orbitPivotForPoint(at(0, 0, 10), at(0, 0, -1), at(7, -3, 4));
    expect(pivot!.toArray()).toEqual([0, 0, 4]);
  });

  it('measures depth along the view direction, not straight-line distance', () => {
    const pivot = orbitPivotForPoint(at(0, 0, 0), at(1, 0, 0), at(5, 12, 0));
    expect(pivot!.x).toBeCloseTo(5, 6);
    expect(pivot!.y).toBeCloseTo(0, 6);
  });

  it('normalises a view direction that is not already unit length', () => {
    const pivot = orbitPivotForPoint(at(0, 0, 0), at(0, 0, -4), at(0, 0, -9));
    expect(pivot!.z).toBeCloseTo(-9, 6);
  });

  it('declines a point behind the camera', () => {
    // Clicking through to something behind the viewer would put the pivot
    // at the camera's back and invert the orbit.
    expect(orbitPivotForPoint(at(0, 0, 10), at(0, 0, -1), at(0, 0, 20))).toBeNull();
  });

  it('declines a point on the camera plane, where there is no depth', () => {
    expect(orbitPivotForPoint(at(0, 0, 10), at(0, 0, -1), at(5, 5, 10))).toBeNull();
  });
});

describe('glide duration follows how far the camera travels', () => {
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // A camera 100 units from what it is looking at.
  const eye = v(0, 0, 100);
  const focus = v(0, 0, 0);

  it('keeps a small nudge short', () => {
    const near = tweenDurationFor(eye, v(2, 0, 100), focus, focus);
    expect(near).toBe(MIN_TWEEN_MS);
  });

  it('caps a long reorientation so it never drags', () => {
    const far = tweenDurationFor(eye, v(0, 0, -400), focus, focus);
    expect(far).toBe(MAX_TWEEN_MS);
  });

  it('gives a longer glide to a longer move', () => {
    const short = tweenDurationFor(eye, v(20, 0, 100), focus, focus);
    const long = tweenDurationFor(eye, v(90, 0, 100), focus, focus);
    expect(long).toBeGreaterThan(short);
  });

  it('is scale-invariant: the same relative move takes the same time', () => {
    // A bracket and a building should feel identical to fly around.
    const small = tweenDurationFor(v(0, 0, 10), v(6, 0, 10), v(0, 0, 0), v(0, 0, 0));
    const large = tweenDurationFor(
      v(0, 0, 10_000),
      v(6_000, 0, 10_000),
      v(0, 0, 0),
      v(0, 0, 0)
    );
    expect(large).toBeCloseTo(small, 6);
  });

  it('counts a pure pivot move, not just camera travel', () => {
    // Re-centring without moving the camera still has to be animated.
    const pivotOnly = tweenDurationFor(eye, eye, focus, v(0, 40, 0));
    expect(pivotOnly).toBeGreaterThan(MIN_TWEEN_MS);
  });

  it('falls back to a sane duration when the camera sits on its target', () => {
    const degenerate = tweenDurationFor(focus, v(1, 0, 0), focus, focus);
    expect(degenerate).toBeGreaterThanOrEqual(MIN_TWEEN_MS);
    expect(degenerate).toBeLessThanOrEqual(MAX_TWEEN_MS);
  });
});

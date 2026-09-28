import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { VIEW_DIRECTIONS } from '../camera/views';
import { screenDragAxis, screenDragValue } from './screenDragAxis';

/**
 * The face-offset arrow's drag sign, pinned against real three.js cameras in
 * the app's Z-up frame. A design review reported a screen-upward drag on the
 * demo bracket's base-plate top face reading −10 mm; these prove the mapping
 * itself reads that drag as a positive (outward) offset for a +Z face seen
 * from above, and that only a −Z face (the plate's underside, one depth-cycle
 * click behind the top face at the same pixel) reads it as negative.
 */

const VIEWPORT = { width: 1200, height: 800 };
// The bracket's base-plate top face: (0..80) × (0..32) at z = 8.
const TOP_FACE_POINT = new THREE.Vector3(41, 17.3, 8);
const UP = new THREE.Vector3(0, 0, 1);
const DOWN = new THREE.Vector3(0, 0, -1);

function perspectiveFrom(direction: THREE.Vector3): THREE.PerspectiveCamera {
  const target = new THREE.Vector3(40, 20, 20);
  const camera = new THREE.PerspectiveCamera(
    45,
    VIEWPORT.width / VIEWPORT.height,
    0.1,
    2000
  );
  camera.up.set(0, 0, 1);
  camera.position
    .copy(target)
    .addScaledVector(direction.clone().normalize(), 220);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  return camera;
}

function orthographicFrom(direction: THREE.Vector3): THREE.OrthographicCamera {
  const target = new THREE.Vector3(40, 20, 20);
  const camera = new THREE.OrthographicCamera(-75, 75, 50, -50, 0.1, 2000);
  camera.up.set(0, 0, 1);
  camera.position
    .copy(target)
    .addScaledVector(direction.clone().normalize(), 220);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  return camera;
}

function headOnScale(camera: THREE.Camera, point: THREE.Vector3): number {
  if (camera instanceof THREE.PerspectiveCamera) {
    const distance = camera.position.distanceTo(point);
    return (
      VIEWPORT.height /
      (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance)
    );
  }
  const ortho = camera as THREE.OrthographicCamera;
  return (VIEWPORT.height * ortho.zoom) / (ortho.top - ortho.bottom);
}

/** An upward pointer drag of 50 CSS pixels: clientY decreases. */
function upwardDrag(camera: THREE.Camera, normal: THREE.Vector3): number {
  const axis = screenDragAxis(
    TOP_FACE_POINT,
    normal,
    camera,
    VIEWPORT,
    headOnScale(camera, TOP_FACE_POINT)
  );
  return screenDragValue(axis, 0, -50);
}

describe('screenDragAxis', () => {
  const views: Array<[string, () => THREE.Camera]> = [
    [
      'perspective from the +X+Y+Z octant',
      () => perspectiveFrom(new THREE.Vector3(1, 1, 0.9))
    ],
    [
      'perspective from the home isometric',
      () => perspectiveFrom(VIEW_DIRECTIONS.iso)
    ],
    [
      'orthographic from the +X+Y+Z octant',
      () => orthographicFrom(new THREE.Vector3(1, 1, 0.9))
    ],
    [
      'orthographic from the home isometric',
      () => orthographicFrom(VIEW_DIRECTIONS.iso)
    ]
  ];

  it.each(views)(
    'reads an upward drag on a +Z face as an outward offset (%s)',
    (_name, make) => {
      const camera = make();
      const value = upwardDrag(camera, UP);
      expect(value).toBeGreaterThan(0);
      // And the axis points up the screen, so the arrow is drawn upward.
      const axis = screenDragAxis(
        TOP_FACE_POINT,
        UP,
        camera,
        VIEWPORT,
        headOnScale(camera, TOP_FACE_POINT)
      );
      expect(axis.directionY).toBeLessThan(-0.5);
    }
  );

  it.each(views)(
    'reads the same upward drag on a −Z face as an inward offset (%s)',
    (_name, make) => {
      expect(upwardDrag(make(), DOWN)).toBeLessThan(0);
    }
  );

  it('falls back to screen-up for a head-on normal', () => {
    const camera = perspectiveFrom(new THREE.Vector3(0, -0.0001, 1));
    const axis = screenDragAxis(
      TOP_FACE_POINT,
      UP,
      camera,
      VIEWPORT,
      headOnScale(camera, TOP_FACE_POINT)
    );
    expect(axis.directionX).toBe(0);
    expect(axis.directionY).toBe(-1);
    expect(screenDragValue(axis, 0, -50)).toBeGreaterThan(0);
  });

  it('never reads a foreshortened axis finer than 60% of head-on', () => {
    const camera = perspectiveFrom(new THREE.Vector3(1, 1, 0.9));
    const scale = headOnScale(camera, TOP_FACE_POINT);
    const axis = screenDragAxis(TOP_FACE_POINT, UP, camera, VIEWPORT, scale);
    expect(axis.pixelsPerUnit).toBeGreaterThanOrEqual(scale * 0.6);
    // 50 px at no less than 60% of the head-on scale.
    expect(screenDragValue(axis, 0, -50)).toBeLessThanOrEqual(
      50 / (scale * 0.6) + 1e-9
    );
  });
});

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { VIEW_DIRECTIONS } from '@openzcad/viewport';
import { createThumbnailCamera } from './partThumbnail';

function boxAround(
  center: THREE.Vector3,
  size: THREE.Vector3
): THREE.Box3 {
  return new THREE.Box3().setFromCenterAndSize(center, size);
}

/** Where a world point lands in the card, in normalised [-1, 1] device space. */
function project(
  camera: THREE.PerspectiveCamera,
  point: THREE.Vector3
): THREE.Vector3 {
  camera.updateMatrixWorld(true);
  return point.clone().project(camera);
}

function corners(bounds: THREE.Box3): THREE.Vector3[] {
  const { min, max } = bounds;
  return [min.x, max.x].flatMap((x) =>
    [min.y, max.y].flatMap((y) =>
      [min.z, max.z].map((z) => new THREE.Vector3(x, y, z))
    )
  );
}

describe('createThumbnailCamera', () => {
  it('keeps the model-space Z axis pointing up the card', () => {
    // The whole point of the fix: a Y-up camera rolls the part onto a corner,
    // so a tile shows an orientation the viewport never puts the part in.
    const camera = createThumbnailCamera(
      boxAround(new THREE.Vector3(), new THREE.Vector3(30, 18, 24))
    );

    expect(camera.up.toArray()).toEqual([0, 0, 1]);
    const bottom = project(camera, new THREE.Vector3(0, 0, -12));
    const top = project(camera, new THREE.Vector3(0, 0, 12));
    expect(top.y).toBeGreaterThan(bottom.y);
  });

  it('looks from the same iso direction as the viewport fit', () => {
    const center = new THREE.Vector3(40, -15, 8);
    const camera = createThumbnailCamera(
      boxAround(center, new THREE.Vector3(20, 20, 20))
    );

    const direction = camera.position.clone().sub(center).normalize();
    expect(direction.angleTo(VIEW_DIRECTIONS.iso)).toBeCloseTo(0, 5);
  });

  it('fits the whole part inside the card, sides included', () => {
    // A wide card clips horizontally long before it clips vertically, which a
    // vertical-only fit does not see.
    const bounds = boxAround(
      new THREE.Vector3(),
      new THREE.Vector3(200, 200, 6)
    );
    const camera = createThumbnailCamera(bounds);

    for (const corner of corners(bounds)) {
      const projected = project(camera, corner);
      expect(Math.abs(projected.x)).toBeLessThan(1);
      expect(Math.abs(projected.y)).toBeLessThan(1);
      expect(projected.z).toBeLessThan(1);
    }
  });

  it('frames a part that sits far from the origin', () => {
    const bounds = boxAround(
      new THREE.Vector3(1200, 800, -450),
      new THREE.Vector3(60, 12, 30)
    );
    const camera = createThumbnailCamera(bounds);

    for (const corner of corners(bounds)) {
      const projected = project(camera, corner);
      expect(Math.abs(projected.x)).toBeLessThan(1);
      expect(Math.abs(projected.y)).toBeLessThan(1);
      // Inside the near and far planes, not merely inside the cone.
      expect(projected.z).toBeGreaterThan(-1);
      expect(projected.z).toBeLessThan(1);
    }
  });

  it('produces a usable frustum for a degenerate part', () => {
    const camera = createThumbnailCamera(
      boxAround(new THREE.Vector3(), new THREE.Vector3(0, 0, 0))
    );

    expect(camera.near).toBeGreaterThan(0);
    expect(camera.far).toBeGreaterThan(camera.near);
    expect(Number.isFinite(camera.position.length())).toBe(true);
  });
});

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { faceDepthBehind } from './faceDepthBehind';

function block(
  size: [number, number, number],
  center: [number, number, number]
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size));
  mesh.position.set(...center);
  return mesh;
}

/**
 * Two 40 mm blocks 100 mm apart on a thin base plate: the holder whose right
 * block's outer face read "Total 181" — the whole body's reach — instead of
 * the block under the arrow.
 */
function twoLobedBody(): THREE.Group {
  const body = new THREE.Group();
  body.add(block([40, 40, 60], [20, 20, 30]));
  body.add(block([40, 40, 60], [160, 20, 30]));
  body.add(block([100, 40, 5], [90, 20, 2.5]));
  body.position.set(5, 0, 0);
  return body;
}

describe('faceDepthBehind', () => {
  it('reads the block under the arrow, not the whole body behind the plane', () => {
    const body = twoLobedBody();
    const depth = faceDepthBehind(
      body,
      new THREE.Vector3(185, 20, 40),
      new THREE.Vector3(1, 0, 0)
    );
    expect(depth).toBeCloseTo(40, 6);
  });

  it('reads the plate where the arrow stands on it', () => {
    const body = twoLobedBody();
    expect(
      faceDepthBehind(
        body,
        new THREE.Vector3(95, 20, 5),
        new THREE.Vector3(0, 0, 1)
      )
    ).toBeCloseTo(5, 6);
  });

  it('is null when the ray starts outside the material', () => {
    const body = twoLobedBody();
    // Above the gap: the first surface below is the plate's top, entered.
    expect(
      faceDepthBehind(
        body,
        new THREE.Vector3(95, 20, 60),
        new THREE.Vector3(0, 0, 1)
      )
    ).toBeNull();
    // An inward normal on the left block's inner wall casts across the gap
    // and enters the right block.
    expect(
      faceDepthBehind(
        body,
        new THREE.Vector3(45, 20, 40),
        new THREE.Vector3(-1, 0, 0)
      )
    ).toBeNull();
  });

  it('decides leaving from winding when the mesh has no normals', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10));
    mesh.geometry.deleteAttribute('normal');
    expect(
      faceDepthBehind(
        mesh,
        new THREE.Vector3(5, 1, 2),
        new THREE.Vector3(1, 0, 0)
      )
    ).toBeCloseTo(10, 6);
  });
});

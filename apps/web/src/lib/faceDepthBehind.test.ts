import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { faceDepthBehind, faceLift } from './faceDepthBehind';

/** What the viewer draws bodies in: section caps and overlays are not. */
const BODY = new THREE.MeshStandardMaterial();

function block(
  size: [number, number, number],
  center: [number, number, number]
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), BODY);
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

/**
 * The holder's side, as the second report drew it: one flat face over a
 * 140 mm deep base (z 0–40) and a 10 mm upright tab above it (z 40–70).
 */
function baseAndTab(): THREE.Group {
  const body = new THREE.Group();
  body.add(block([30, 140, 40], [15, 70, 20]));
  body.add(block([30, 10, 30], [15, 5, 55]));
  return body;
}

/**
 * A 30 × 18 × 24 box with a Ø6 vertical through hole 9 mm behind its front
 * (y = 0) face: the hole's wall is a reversed cylinder, facing its axis.
 */
function boxWithHole(): THREE.Group {
  const body = new THREE.Group();
  body.add(block([30, 18, 24], [15, 9, 12]));
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(3, 3, 24, 48, 1, true),
    BODY
  );
  // CylinderGeometry is Y-up; stand it along Z, then face it inward.
  wall.rotation.x = Math.PI / 2;
  wall.position.set(15, 9, 12);
  const normals = wall.geometry.getAttribute('normal') as THREE.BufferAttribute;
  for (let index = 0; index < normals.count; index += 1) {
    normals.setXYZ(
      index,
      -normals.getX(index),
      -normals.getY(index),
      -normals.getZ(index)
    );
  }
  body.add(wall);
  return body;
}

const RIGHT = new THREE.Vector3(1, 0, 0);
const FRONT = new THREE.Vector3(0, -1, 0);

describe('faceDepthBehind', () => {
  it('reads the block under the arrow, not the whole body behind the plane', () => {
    expect(
      faceDepthBehind(twoLobedBody(), new THREE.Vector3(185, 20, 40), RIGHT)
    ).toBeCloseTo(40, 6);
  });

  it('follows where on the face the pick lands', () => {
    const body = baseAndTab();
    // The same flat face: picked on the tab, then on the base below it.
    expect(
      faceDepthBehind(body, new THREE.Vector3(15, 0, 60), FRONT)
    ).toBeCloseTo(10, 6);
    expect(
      faceDepthBehind(body, new THREE.Vector3(15, 0, 20), FRONT)
    ).toBeCloseTo(140, 6);
  });

  it('ends the line at a hole straight behind the pick', () => {
    const body = boxWithHole();
    expect(
      faceDepthBehind(body, new THREE.Vector3(15, 0, 12), FRONT)
    ).toBeCloseTo(6, 3);
    // Beside the hole the line runs to the back face.
    expect(
      faceDepthBehind(body, new THREE.Vector3(5, 0, 12), FRONT)
    ).toBeCloseTo(18, 6);
  });

  it('reads through a section cap to the body behind it', () => {
    // A section view clips the 40 mm block at x = 165 and fills the cut
    // with a raster cap: display only, not where the material ends.
    const body = twoLobedBody();
    const cap = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 60),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
    );
    cap.userData.sectionCap = true;
    cap.rotation.y = -Math.PI / 2;
    cap.position.set(160, 20, 30);
    body.add(cap);
    expect(
      faceDepthBehind(body, new THREE.Vector3(185, 20, 40), RIGHT)
    ).toBeCloseTo(40, 6);
  });

  it('counts from the plane the gesture started on', () => {
    // A preview moved the +X face of a 10 mm block out by 2 (or in by 3)
    // before the rig re-armed: the 10 mm span still reads.
    const origin = new THREE.Vector3(5, 0, 0);
    const out = block([12, 10, 10], [1, 0, 0]);
    expect(faceDepthBehind(out, origin, RIGHT, 2)).toBeCloseTo(10, 6);
    const pushed = block([7, 10, 10], [-1.5, 0, 0]);
    expect(faceDepthBehind(pushed, origin, RIGHT, -3)).toBeCloseTo(10, 6);
  });

  it('is null when the line does not start inside material', () => {
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

  it('leaves wherever any surface level with the nearest hit leaves', () => {
    // Two solids touching at x = 10, the far one drawn first: at the same
    // distance the line meets the far one's entry face before the near
    // one's exit face. The exit still counts.
    const body = new THREE.Group();
    body.add(block([10, 10, 10], [15, 0, 0]));
    body.add(block([10, 10, 10], [5, 0, 0]));
    expect(
      faceDepthBehind(
        body,
        new THREE.Vector3(0, 1, 2),
        new THREE.Vector3(-1, 0, 0)
      )
    ).toBeCloseTo(10, 6);
  });

  it('decides leaving from winding when the mesh has no normals', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), BODY);
    mesh.geometry.deleteAttribute('normal');
    expect(
      faceDepthBehind(mesh, new THREE.Vector3(5, 1, 2), RIGHT)
    ).toBeCloseTo(10, 6);
  });
});

describe('faceLift', () => {
  it('reads how far the rendered face stands off the starting plane', () => {
    const mesh = block([12, 10, 10], [1, 0, 0]);
    // BoxGeometry's first two triangles are its +X side, now at x = 7.
    mesh.userData.topology = {
      faces: [{ topologyId: 'px', triangleStart: 0, triangleCount: 2 }]
    };
    const origin = new THREE.Vector3(5, 0, 0);
    expect(faceLift(mesh, 'px', origin, RIGHT)).toBeCloseTo(2, 9);
    expect(faceLift(mesh, 'missing', origin, RIGHT)).toBe(0);
  });
});

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  faceDepthBehind,
  faceSamples,
  type FaceSample
} from './faceDepthBehind';

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

/** Evenly weighted points on the rectangle `corner + s·along + t·across`. */
function grid(
  corner: THREE.Vector3,
  along: THREE.Vector3,
  across: THREE.Vector3,
  steps = 10
): FaceSample[] {
  const samples: FaceSample[] = [];
  for (let i = 0; i < steps; i += 1) {
    for (let j = 0; j < steps; j += 1) {
      samples.push({
        point: corner
          .clone()
          .addScaledVector(along, (i + 0.5) / steps)
          .addScaledVector(across, (j + 0.5) / steps),
        weight: 1
      });
    }
  }
  return samples;
}

/**
 * Two 40 mm blocks 100 mm apart on a thin base plate: the holder whose right
 * block's outer face read "Total 181" — the whole body's reach — instead of
 * the block the face belongs to.
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

describe('faceDepthBehind', () => {
  it('reads the block the face belongs to, not the whole body behind the plane', () => {
    const body = twoLobedBody();
    // The right block's whole outer face, plate strip included.
    const samples = grid(
      new THREE.Vector3(185, 0, 0),
      new THREE.Vector3(0, 40, 0),
      new THREE.Vector3(0, 0, 60)
    );
    expect(
      faceDepthBehind(body, new THREE.Vector3(185, 20, 30), RIGHT, samples)
    ).toBeCloseTo(40, 6);
  });

  it('is not decided by a hole behind part of the face', () => {
    // The CI box: the arrow stands right in front of the hole, whose wall is
    // 6 mm back; the box is 18 deep everywhere else.
    const body = boxWithHole();
    const front = new THREE.Vector3(0, -1, 0);
    const samples = grid(
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(30, 0, 0),
      new THREE.Vector3(0, 0, 24)
    );
    expect(
      faceDepthBehind(body, new THREE.Vector3(15, 0, 12), front, samples)
    ).toBeCloseTo(18, 6);
    // Only the ray through the hole's centre line reads its wall.
    expect(
      faceDepthBehind(body, new THREE.Vector3(15, 0, 12), front, [
        { point: new THREE.Vector3(15, 0, 12), weight: 1 }
      ])
    ).toBeCloseTo(6, 3);
  });

  it('counts from the plane the gesture started on', () => {
    // A preview moved the +X face of a 10 mm block out by 2 before the rig
    // re-armed: the moved face is sampled, the 10 mm span still reads.
    const moved = block([12, 10, 10], [1, 0, 0]);
    const samples = grid(
      new THREE.Vector3(7, -5, -5),
      new THREE.Vector3(0, 10, 0),
      new THREE.Vector3(0, 0, 10),
      4
    );
    expect(
      faceDepthBehind(moved, new THREE.Vector3(5, 0, 0), RIGHT, samples)
    ).toBeCloseTo(10, 6);
  });

  it('is null when the face has no material behind it', () => {
    const body = twoLobedBody();
    // Above the gap: the first surface below is the plate's top, entered.
    expect(
      faceDepthBehind(
        body,
        new THREE.Vector3(95, 20, 60),
        new THREE.Vector3(0, 0, 1),
        [{ point: new THREE.Vector3(95, 20, 60), weight: 1 }]
      )
    ).toBeNull();
    // An inward normal on the left block's inner wall casts across the gap
    // and enters the right block.
    const inner = grid(
      new THREE.Vector3(45, 0, 10),
      new THREE.Vector3(0, 40, 0),
      new THREE.Vector3(0, 0, 50)
    );
    expect(
      faceDepthBehind(
        body,
        new THREE.Vector3(45, 20, 40),
        new THREE.Vector3(-1, 0, 0),
        inner
      )
    ).toBeNull();
    expect(faceDepthBehind(body, new THREE.Vector3(), RIGHT, [])).toBeNull();
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
    const samples = grid(
      new THREE.Vector3(185, 0, 10),
      new THREE.Vector3(0, 40, 0),
      new THREE.Vector3(0, 0, 50)
    );
    expect(
      faceDepthBehind(body, new THREE.Vector3(185, 20, 30), RIGHT, samples)
    ).toBeCloseTo(40, 6);
  });

  it('decides leaving from winding when the mesh has no normals', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), BODY);
    mesh.geometry.deleteAttribute('normal');
    const point = new THREE.Vector3(5, 1, 2);
    expect(
      faceDepthBehind(mesh, point, RIGHT, [{ point, weight: 1 }])
    ).toBeCloseTo(10, 6);
  });
});

describe('faceSamples', () => {
  it('spreads area-weighted points over the face from the topology table', () => {
    const mesh = block([10, 20, 30], [5, 0, 0]);
    // BoxGeometry's first two triangles are its +X side.
    mesh.userData.topology = {
      faces: [{ topologyId: 'px', triangleStart: 0, triangleCount: 2 }]
    };
    const samples = faceSamples(mesh, 'px');
    expect(samples).toHaveLength(64);
    for (const { point } of samples) {
      expect(point.x).toBeCloseTo(10, 9);
      expect(Math.abs(point.y)).toBeLessThanOrEqual(10);
      expect(Math.abs(point.z)).toBeLessThanOrEqual(15);
    }
    const weight = samples.reduce((sum, sample) => sum + sample.weight, 0);
    expect(weight).toBeCloseTo(600, 6);
    expect(faceSamples(mesh, 'missing')).toEqual([]);
  });

  it('keeps to its ray budget on a finely tessellated face', () => {
    // 2 × 40 × 40 triangles on one face: one ray each would be 3200.
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(10, 10, 40, 40), BODY);
    const triangles = plane.geometry.getIndex()!.count / 3;
    plane.userData.topology = {
      faces: [
        { topologyId: 'fine', triangleStart: 0, triangleCount: triangles }
      ]
    };
    const samples = faceSamples(plane, 'fine');
    expect(samples).toHaveLength(64);
    const weight = samples.reduce((sum, sample) => sum + sample.weight, 0);
    expect(weight).toBeCloseTo(100, 6);
  });
});

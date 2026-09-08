import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { toBodyId, type BodyRepresentation } from '@openzcad/shared';
import {
  createObjectForBody,
  sameBodyProjection,
  updateObjectForBody
} from './scene';
import { disposeObject } from '../scene/objects';
import { createFaceHighlightGeometry } from '../selection/faceHighlightGeometry';

function cylinder(radius = 8, height = 12, segments = 16): BodyRepresentation {
  const mesh = new THREE.CylinderGeometry(radius, radius, height, segments, 1);
  const result: BodyRepresentation = {
    bodyId: toBodyId('body_test'),
    name: 'Cylinder',
    source: 'primitive',
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from(mesh.getAttribute('position').array),
      indices: Uint32Array.from(mesh.getIndex()!.array)
    },
    faceCount: 3,
    color: '#334455',
    consumed: false,
    exportableStep: true,
    volume: 1,
    bbox: {
      min: { x: -radius, y: -height / 2, z: -radius },
      max: { x: radius, y: height / 2, z: radius }
    },
    topology: {
      faces: mesh.groups.map((group, i) => ({
        topologyId: `face:${i}`,
        hash: i,
        triangleStart: group.start / 3,
        triangleCount: group.count / 3
      })),
      edges: [{ topologyId: 'edge:1', hash: 1, points: [0, 0, 0, 1, 0, 0] }]
    }
  };
  mesh.dispose();
  return result;
}

function expectSameGeometry(a: THREE.BufferGeometry, b: THREE.BufferGeometry) {
  expect(Array.from(a.getIndex()!.array)).toEqual(
    Array.from(b.getIndex()!.array)
  );
  for (const name of ['position', 'normal']) {
    const left = a.getAttribute(name).array;
    const right = b.getAttribute(name).array;
    expect(left.length).toBe(right.length);
    for (let i = 0; i < left.length; i += 1)
      expect(left[i]).toBeCloseTo(right[i]!, 5);
  }
}

describe('retained exact body buffers', () => {
  it('matches fresh smoothing after radius, height, and nonuniform deformations', () => {
    const object = createObjectForBody(cylinder()) as THREE.Mesh;
    const geometry = object.geometry;
    const material = object.material;
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const index = geometry.getIndex();
    object.matrixAutoUpdate = false;
    object.matrix.makeScale(2, 2, 1);
    for (const next of [cylinder(20, 12), cylinder(20, 30), cylinder(5, 9)]) {
      // Moving a vertex makes triangle angle weights change, so copying old
      // normals or substituting area weighting cannot pass this comparison.
      next.mesh.vertices[0] = next.mesh.vertices[0]! + 0.7;
      const fresh = createObjectForBody(next) as THREE.Mesh;
      expect(updateObjectForBody(object, next)).toBe(true);
      expect(object.geometry).toBe(geometry);
      expect(object.matrixAutoUpdate).toBe(true);
      expect(object.matrix.equals(new THREE.Matrix4())).toBe(true);
      expect(object.material).toBe(material);
      expect(geometry.getAttribute('position')).toBe(position);
      expect(geometry.getAttribute('normal')).toBe(normal);
      expect(geometry.getIndex()).toBe(index);
      expectSameGeometry(geometry, fresh.geometry);
      fresh.geometry.computeBoundingBox();
      expect(geometry.boundingBox).toEqual(fresh.geometry.boundingBox);
      disposeObject(fresh);
    }
    disposeObject(object);
  });

  it('refuses changed connectivity, face partitions, and missing topology without touching buffers', () => {
    const original = cylinder();
    const object = createObjectForBody(original) as THREE.Mesh;
    const before = Array.from(object.geometry.getAttribute('position').array);
    const connectivity = cylinder();
    connectivity.mesh.indices[0] = connectivity.mesh.indices[1]!;
    const partition = cylinder();
    partition.topology!.faces[0]!.triangleCount -= 1;
    const noTopology = cylinder();
    delete noTopology.topology;
    for (const next of [
      connectivity,
      partition,
      noTopology,
      cylinder(8, 12, 32)
    ]) {
      expect(updateObjectForBody(object, next)).toBe(false);
      expect(
        Array.from(object.geometry.getAttribute('position').array)
      ).toEqual(before);
    }
    disposeObject(object);
  });

  it('compares cloned unchanged projections but detects geometry and topology changes', () => {
    const a = cylinder();
    const b = structuredClone(a);
    expect(sameBodyProjection(a, b)).toBe(true);
    b.mesh.vertices[0] = b.mesh.vertices[0]! + 1;
    expect(sameBodyProjection(a, b)).toBe(false);
    const c = structuredClone(a);
    c.topology!.faces[0]!.hash += 1;
    expect(sameBodyProjection(a, c)).toBe(false);
  });

  it('releases highlight indices without deleting the body attributes it borrows', () => {
    const body = cylinder();
    const object = createObjectForBody(body) as THREE.Mesh;
    const highlight = createFaceHighlightGeometry(
      object,
      body.topology!.faces[0]!
    )!;
    const position = object.geometry.getAttribute('position');
    const normal = object.geometry.getAttribute('normal');
    const directHighlight = createFaceHighlightGeometry(
      object,
      body.topology!.faces[0]!
    )!;
    let borrowedAtDisposal = true;
    directHighlight.addEventListener('dispose', () => {
      borrowedAtDisposal = directHighlight.hasAttribute('position');
    });
    directHighlight.dispose();
    expect(borrowedAtDisposal).toBe(false);
    const overlay = new THREE.Mesh(highlight, new THREE.MeshBasicMaterial());
    disposeObject(overlay);
    expect(highlight.hasAttribute('position')).toBe(false);
    expect(highlight.hasAttribute('normal')).toBe(false);
    expect(object.geometry.getAttribute('position')).toBe(position);
    expect(object.geometry.getAttribute('normal')).toBe(normal);
    expect(updateObjectForBody(object, cylinder(12, 15))).toBe(true);
    disposeObject(object);
  });
});

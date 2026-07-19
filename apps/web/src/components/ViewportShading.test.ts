import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  createBodyMaterial,
  createObjectForBody,
  createStudioHemisphereLight
} from '@openzcad/viewport';
import {
  toBodyId,
  type BodyRepresentation,
  type BodyTopology,
  type MeshGeometry
} from '@openzcad/shared';

function bodyWithMesh(
  mesh: MeshGeometry,
  topology?: BodyTopology,
  source: BodyRepresentation['source'] = 'primitive'
): BodyRepresentation {
  return {
    bodyId: toBodyId('body_shading_test'),
    name: 'Shading test',
    source,
    mesh,
    faceCount: 2,
    color: '#356dff',
    exportableStep: true,
    consumed: false,
    volume: 1,
    bbox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 }
    },
    topology
  };
}

function renderedGeometry(
  mesh: MeshGeometry,
  topology?: BodyTopology
): THREE.BufferGeometry {
  return (createObjectForBody(bodyWithMesh(mesh, topology)) as THREE.Mesh)
    .geometry;
}

describe('CAD viewport shading', () => {
  it('splits normals across hard face boundaries', () => {
    const geometry = renderedGeometry({
      kind: 'mesh',
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      indices: [0, 1, 2, 0, 3, 1]
    });
    const normals = geometry.getAttribute('normal');
    const renderedIndices = Array.from(geometry.getIndex()!.array);

    expect(normals.count).toBe(6);
    expect(renderedIndices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(
      new THREE.Vector3().fromBufferAttribute(normals, 0).toArray()
    ).toEqual([0, 0, 1]);
    expect(
      new THREE.Vector3().fromBufferAttribute(normals, 3).toArray()
    ).toEqual([0, 1, 0]);
  });

  it('keeps shallow curved tessellation visually smooth', () => {
    const angle = THREE.MathUtils.degToRad(20);
    const geometry = renderedGeometry({
      kind: 'mesh',
      vertices: [
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
        0,
        0,
        Math.cos(angle),
        Math.sin(angle)
      ],
      indices: [0, 1, 2, 0, 1, 3]
    });
    const normals = geometry.getAttribute('normal');
    const renderedIndices = Array.from(geometry.getIndex()!.array);
    const firstSharedNormal = new THREE.Vector3().fromBufferAttribute(
      normals,
      0
    );
    const secondSharedNormal = new THREE.Vector3().fromBufferAttribute(
      normals,
      1
    );

    expect(normals.count).toBe(4);
    expect(renderedIndices).toEqual([0, 1, 2, 0, 1, 3]);
    expect(firstSharedNormal.x).toBeCloseTo(0, 6);
    expect(firstSharedNormal.y).toBeCloseTo(-Math.sin(angle / 2), 6);
    expect(firstSharedNormal.z).toBeCloseTo(Math.cos(angle / 2), 6);
    expect(secondSharedNormal.toArray()).toEqual(firstSharedNormal.toArray());
  });

  it('uses exact B-rep face boundaries as shading creases', () => {
    const angle = THREE.MathUtils.degToRad(20);
    const mesh: MeshGeometry = {
      kind: 'mesh',
      vertices: [
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        1,
        0,
        0,
        Math.cos(angle),
        Math.sin(angle)
      ],
      indices: [0, 1, 2, 0, 1, 3]
    };
    const geometry = renderedGeometry(mesh, {
      faces: [
        {
          topologyId: 'face:1',
          hash: 1,
          triangleStart: 0,
          triangleCount: 1
        },
        {
          topologyId: 'face:2',
          hash: 2,
          triangleStart: 1,
          triangleCount: 1
        }
      ],
      edges: []
    });

    expect(geometry.getAttribute('normal').count).toBe(6);
    expect(Array.from(geometry.getIndex()!.array)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('uses a classic technical material for CAD solids', () => {
    const body = bodyWithMesh({ kind: 'mesh', vertices: [], indices: [] });
    const material = createBodyMaterial(body);
    const object = createObjectForBody(body) as THREE.Mesh;

    expect(material).toBeInstanceOf(THREE.MeshPhongMaterial);
    expect(material.shininess).toBe(38);
    expect(material.specular.getHex()).toBe(0x667487);
    expect(material.side).toBe(THREE.FrontSide);
    expect(object.castShadow).toBe(true);
    expect(object.receiveShadow).toBe(false);
  });

  it('keeps mixed-winding imported STEP faces shaded', () => {
    const material = createBodyMaterial(
      bodyWithMesh(
        {
          kind: 'mesh',
          vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          indices: [0, 2, 1]
        },
        undefined,
        'imported-step'
      )
    );

    expect(material.side).toBe(THREE.DoubleSide);
  });

  it('uses a visible ground bounce for downward-facing surfaces', () => {
    const light = createStudioHemisphereLight();

    expect(light.color.getHex()).toBe(0xd7e6f7);
    expect(light.groundColor.getHex()).toBe(0xe2e8f0);
    expect(light.intensity).toBe(0.45);
    expect(light.position.toArray()).toEqual([0, 0, 1]);
  });
});

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { directEditDirectionFromNormal, isViewerMesh } from './ModelViewer';

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
});

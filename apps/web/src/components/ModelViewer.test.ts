import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { isViewerMesh } from './ModelViewer';

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
});

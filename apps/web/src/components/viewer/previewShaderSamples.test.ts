import * as THREE from 'three';
import { expect, it } from 'vitest';
import { previewShaderSamples } from './previewShaderSamples';

it('samples real ghost and clipped pull programs without copying model geometry', () => {
  const source = new THREE.MeshPhongMaterial();
  const compile = source.onBeforeCompile;
  const key = () => 'body-test';
  source.customProgramCacheKey = key;
  const samples: {
    name: string;
    planes: number;
    normals: boolean;
    material: THREE.Material;
  }[] = [];
  previewShaderSamples(source, (mesh) => {
    const material = (mesh.material as THREE.Material).clone();
    samples.push({
      name: mesh.name,
      planes: material.clippingPlanes?.length ?? 0,
      normals: mesh.geometry.hasAttribute('normal'),
      material
    });
    expect(mesh.geometry.getAttribute('position').count).toBeLessThan(100);
    if (mesh.name === '') {
      expect((mesh.material as THREE.Material).onBeforeCompile).toBe(compile);
      expect((mesh.material as THREE.Material).customProgramCacheKey).toBe(key);
    }
  });
  expect(
    samples.some((s) => s.name === 'offset-body-ghost-shell' && s.planes === 0)
  ).toBe(true);
  expect(
    samples.some(
      (s) => s.name === 'offset-body-ghost-veil-fill' && s.planes === 1
    )
  ).toBe(true);
  expect(samples.some((s) => s.name === '' && s.planes === 1)).toBe(true);
  expect(
    samples.some(
      (s) => s.name === 'offset-body-ghost-face-outline' && !s.normals
    )
  ).toBe(true);
  expect(source.clippingPlanes).toBeNull();
  for (const sample of samples) sample.material.dispose();
  source.dispose();
});

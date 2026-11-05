import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { tuneShadowFrustum } from './scene';

describe('tuneShadowFrustum', () => {
  it('keeps the tuned 3072 map by default and takes a smaller one when asked', () => {
    const desktop = new THREE.DirectionalLight();
    tuneShadowFrustum(desktop, 50);
    expect(desktop.shadow.mapSize.toArray()).toEqual([3072, 3072]);

    const touch = new THREE.DirectionalLight();
    tuneShadowFrustum(touch, 50, 2048);
    expect(touch.shadow.mapSize.toArray()).toEqual([2048, 2048]);
    // The frustum does not depend on the map size.
    expect(touch.shadow.camera.right).toBe(desktop.shadow.camera.right);
  });
});

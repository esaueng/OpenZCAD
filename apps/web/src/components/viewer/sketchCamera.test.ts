import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { alreadyFacesSketch, sketchReturnUp } from './sketchCamera';

describe('sketch camera continuity', () => {
  it('keeps a face-on view regardless of its roll, but aligns an oblique view', () => {
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 0, 100);
    camera.up.set(1, 0, 0);
    camera.lookAt(0, 0, 0);
    expect(alreadyFacesSketch(camera, { x: 0, y: 0, z: 1 })).toBe(true);
    expect(
      sketchReturnUp(camera).distanceTo(new THREE.Vector3(1, 0, 0))
    ).toBeLessThan(1e-9);
    camera.position.set(0, -10, 100);
    camera.lookAt(0, 0, 0);
    expect(alreadyFacesSketch(camera, { x: 0, y: 0, z: 1 })).toBe(false);
    expect(alreadyFacesSketch(camera, { x: 0, y: 0, z: -1 })).toBe(false);
    expect(alreadyFacesSketch(camera, { x: 0, y: 0, z: 0 })).toBe(false);
  });
});

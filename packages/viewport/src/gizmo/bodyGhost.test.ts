import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createFatLineSegments } from '../render/scene';
import { createBodyGhost } from './bodyGhost';

function body() {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2));
  const edges = createFatLineSegments([0, 0, 0, 1, 0, 0], {
    color: 0,
    linewidth: 1
  });
  edges.name = 'body-edge';
  mesh.add(edges);
  return mesh;
}

function materials(object: THREE.Object3D) {
  const found: THREE.Material[] = [];
  object.traverse((child) => {
    const material = (child as THREE.Mesh).material;
    if (material)
      found.push(...(Array.isArray(material) ? material : [material]));
  });
  return found;
}

describe('the offset body ghost', () => {
  it('copies the body with its edges and the dragged face, all behind the solid', () => {
    const source = body();
    const ghost = createBodyGhost(source, {
      faceRange: { triangleStart: 0, triangleCount: 2 }
    });
    const names = ghost.object.children.map((child) => child.name);
    expect(names).toEqual([
      'offset-body-ghost-shell',
      'offset-body-ghost-face',
      'offset-body-ghost-edges'
    ]);
    // A copy, not a share: deforming the body later must not move the ghost.
    const shell = ghost.object.children[0] as THREE.Mesh;
    expect(shell.geometry.getAttribute('position')).not.toBe(
      source.geometry.getAttribute('position')
    );
    // Every part is pushed behind coincident solid surfaces, edges included,
    // and none writes depth.
    for (const material of materials(ghost.object)) {
      expect(material.polygonOffset).toBe(true);
      expect(material.polygonOffsetUnits).toBeGreaterThan(0);
      expect(material.depthWrite).toBe(false);
    }
    ghost.dispose();
  });

  it('is cut by the active section like the body it copies', () => {
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const ghost = createBodyGhost(body(), {
      faceRange: { triangleStart: 0, triangleCount: 2 },
      clippingPlane: plane
    });
    for (const material of materials(ghost.object))
      expect(material.clippingPlanes).toEqual([plane]);
    // A section that moves or closes under a kept ghost takes it along.
    const moved = new THREE.Plane(new THREE.Vector3(0, 0, 1), 1);
    ghost.setClippingPlane(moved);
    for (const material of materials(ghost.object))
      expect(material.clippingPlanes).toEqual([moved]);
    ghost.setClippingPlane(null);
    for (const material of materials(ghost.object))
      expect(material.clippingPlanes).toBeNull();
    const uncut = createBodyGhost(body());
    for (const material of materials(uncut.object))
      expect(material.clippingPlanes ?? null).toBeNull();
    ghost.dispose();
    uncut.dispose();
  });
});

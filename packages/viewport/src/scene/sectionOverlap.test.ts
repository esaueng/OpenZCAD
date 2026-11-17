import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applySectionPlane, sectionClippingPlane } from './objects';
import { SECTION_OVERLAP, clipConvex, sectionOverlaps } from './sectionOverlap';
import type { ViewerMesh } from '../pick/meshes';

/** A 10 mm cube body centred at (x, 0, 0), tagged as the viewport tags one. */
function body(bodyId: string, x: number, parent: THREE.Object3D) {
  const group = new THREE.Group();
  group.userData.bodyId = bodyId;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(10, 10, 10),
    new THREE.MeshStandardMaterial()
  ) as ViewerMesh;
  mesh.position.set(x, 0, 0);
  group.add(mesh);
  parent.add(group);
  return { group, mesh };
}

function scene(...xs: number[]) {
  const root = new THREE.Group();
  const bodies = xs.map((x, index) => body(`body_${index + 1}`, x, root));
  root.updateWorldMatrix(true, true);
  return { root, bodies, meshes: bodies.map((b) => b.mesh) };
}

const cut = () => sectionClippingPlane({ plane: 'XY', offset: 0 });

function overlays(root: THREE.Object3D) {
  const found: THREE.Mesh[] = [];
  root.traverse((child) => {
    if (child.name === SECTION_OVERLAP) found.push(child as THREE.Mesh);
  });
  return found;
}

describe('section overlap (M09 display-only first slice)', () => {
  it('reports two cubes overlapping in the cut, with the overlap area', () => {
    const { meshes } = scene(0, 5);
    const { pairs } = sectionOverlaps(meshes, cut());
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a: 'body_1', b: 'body_2' });
    // A 5 × 10 strip of the cutting plane.
    expect(pairs[0]!.area).toBeCloseTo(50, 6);
  });

  it('does not report cubes that only touch, or stand apart', () => {
    expect(sectionOverlaps(scene(0, 10).meshes, cut()).pairs).toEqual([]);
    expect(sectionOverlaps(scene(0, 12).meshes, cut()).pairs).toEqual([]);
  });

  it('ignores a hidden body', () => {
    const { meshes, bodies } = scene(0, 5);
    bodies[1]!.group.visible = false;
    expect(sectionOverlaps(meshes, cut()).pairs).toEqual([]);
  });

  it('follows each body’s placement, as an assembly pose moves it', () => {
    const { meshes, bodies, root } = scene(0, 30);
    expect(sectionOverlaps(meshes, cut()).pairs).toEqual([]);
    bodies[1]!.group.position.set(-28, 0, 0);
    root.updateWorldMatrix(true, true);
    expect(sectionOverlaps(meshes, cut()).pairs[0]!.area).toBeCloseTo(80, 6);
  });

  it('is computed by the section pass, drawn on the cut, and cleared with it', () => {
    const { root, bodies } = scene(0, 5, 40);
    const pairs = applySectionPlane(root, cut());
    expect(pairs.map(({ a, b }) => [a, b])).toEqual([['body_1', 'body_2']]);
    expect(pairs[0]!.area).toBeCloseTo(50, 6);
    const drawn = overlays(root);
    expect(drawn).toHaveLength(1);
    // It hangs on the first body, never on the body group itself.
    expect(drawn[0]!.parent).toBe(bodies[0]!.mesh);
    // It lies in the cutting plane, so the cut must not clip it away.
    const material = drawn[0]!.material as THREE.Material;
    expect(material.clippingPlanes ?? null).toBeNull();
    // Re-applying replaces it rather than stacking a second one.
    applySectionPlane(root, cut());
    expect(overlays(root)).toHaveLength(1);
    expect(applySectionPlane(root, null)).toEqual([]);
    expect(overlays(root)).toEqual([]);
  });

  it('clips a triangle to the part another covers', () => {
    const piece = clipConvex(
      [
        [0, 0],
        [4, 0],
        [0, 4]
      ],
      [
        [1, -1],
        [5, -1],
        [5, 5],
        [1, 5]
      ]
    );
    let area = 0;
    for (let i = 0, j = piece.length - 1; i < piece.length; j = i++)
      area += piece[j]![0] * piece[i]![1] - piece[i]![0] * piece[j]![1];
    // The triangle right of x = 1: (3 × 3) / 2.
    expect(Math.abs(area / 2)).toBeCloseTo(4.5, 9);
  });
});

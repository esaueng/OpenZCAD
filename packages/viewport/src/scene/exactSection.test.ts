import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { EXACT_SECTION, applyExactSection } from './exactSection';
import { SECTION_CAP } from './sectionCaps';
import { applyDisplayMode, applySectionPlane, sectionClippingPlane } from './objects';
import { isViewerMesh } from '../pick/meshes';

/** One square region in the z = 1 plane, as the adapter would hand it over. */
const region = () => ({
  positions: Float32Array.of(-5, -5, 1, 5, -5, 1, 5, 5, 1, -5, 5, 1),
  indices: Uint32Array.of(0, 1, 2, 0, 2, 3),
  loops: [
    {
      points: [
        [-5, -5, 1],
        [5, -5, 1],
        [5, 5, 1],
        [-5, 5, 1]
      ] as const
    }
  ]
});

function body() {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(10, 10, 10),
    new THREE.MeshPhongMaterial()
  );
  group.add(mesh);
  return { group, mesh };
}

describe('exact section geometry in the viewport', () => {
  it('draws the cut surface and its boundary curves', () => {
    const root = new THREE.Group();
    applyExactSection(root, [region()]);
    const section = root.getObjectByName(EXACT_SECTION)!;
    expect(section).toBeDefined();
    const fills = section.children.filter((child) => child instanceof THREE.Mesh);
    const curves = section.children.filter(
      (child) => child instanceof THREE.LineLoop
    );
    expect(fills).toHaveLength(1);
    expect(curves).toHaveLength(1);
    for (const child of section.children) {
      expect(child.userData.exactSection).toBe(true);
    }
  });

  it('replaces the previous section rather than stacking one on it', () => {
    const root = new THREE.Group();
    applyExactSection(root, [region()]);
    applyExactSection(root, [region()]);
    expect(
      root.children.filter((child) => child.name === EXACT_SECTION)
    ).toHaveLength(1);
    applyExactSection(root, null);
    expect(root.getObjectByName(EXACT_SECTION)).toBeUndefined();
  });

  it('takes the place of the display cap, and gives it back', () => {
    const { group, mesh } = body();
    const plane = sectionClippingPlane({ plane: 'XY', offset: 1 });
    applySectionPlane(group, plane);
    expect(mesh.getObjectByName(SECTION_CAP)).toBeDefined();
    expect(group.getObjectByName(EXACT_SECTION)).toBeUndefined();

    applySectionPlane(group, plane, [region()]);
    expect(mesh.getObjectByName(SECTION_CAP)).toBeUndefined();
    expect(group.getObjectByName(EXACT_SECTION)).toBeDefined();

    // Moving the plane again drops back to the approximation for that cut.
    applySectionPlane(group, sectionClippingPlane({ plane: 'XY', offset: 2 }));
    expect(mesh.getObjectByName(SECTION_CAP)).toBeDefined();
    expect(group.getObjectByName(EXACT_SECTION)).toBeUndefined();
  });

  it('is never clipped, never picked, and never a body mesh', () => {
    const { group } = body();
    const plane = sectionClippingPlane({ plane: 'XY', offset: 1 });
    applySectionPlane(group, plane, [region()]);
    const section = group.getObjectByName(EXACT_SECTION)!;
    for (const child of section.children) {
      const material = (child as THREE.Mesh).material as THREE.Material;
      expect(material.clippingPlanes).toBeNull();
      expect(isViewerMesh(child)).toBe(false);
      const hits: THREE.Intersection[] = [];
      child.raycast(
        new THREE.Raycaster(
          new THREE.Vector3(0, 0, 20),
          new THREE.Vector3(0, 0, -1)
        ),
        hits
      );
      expect(hits).toHaveLength(0);
    }
  });

  it('hides the cut surface in wireframe without touching its curves', () => {
    const { group } = body();
    applySectionPlane(
      group,
      sectionClippingPlane({ plane: 'XY', offset: 1 }),
      [region()]
    );
    const section = group.getObjectByName(EXACT_SECTION)!;
    const curve = section.children.find(
      (child) => child instanceof THREE.LineLoop
    ) as THREE.LineLoop;
    const fill = section.children.find(
      (child) => child instanceof THREE.Mesh
    ) as THREE.Mesh;
    applyDisplayMode(group, 'wireframe');
    expect((fill.material as THREE.Material).visible).toBe(false);
    expect(curve.visible).toBe(true);
    expect((curve.material as THREE.LineBasicMaterial).color.getHex()).toBe(
      0x2b1a08
    );
    applyDisplayMode(group, 'shaded');
    expect((fill.material as THREE.Material).visible).toBe(true);
    expect(curve.visible).toBe(true);
  });
});

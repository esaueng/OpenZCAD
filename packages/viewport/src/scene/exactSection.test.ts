import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  EXACT_SECTION,
  applyExactSection,
  exactSectionSnapshot,
  type ExactSectionRegionDisplay
} from './exactSection';
import { SECTION_CAP } from './sectionCaps';
import { applyDisplayMode, applySectionPlane, sectionClippingPlane } from './objects';
import { isViewerMesh } from '../pick/meshes';

/** One square region in the z = 1 plane, as the adapter would hand it over. */
const region = (bodyId = 'body_1') => ({
  bodyId,
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

/** The ordinary case: a section arriving while the viewport is shaded. */
const shaded = (regions: readonly ExactSectionRegionDisplay[]) => ({
  regions,
  displayMode: 'shaded' as const
});

function body(bodyId = 'body_1') {
  const group = new THREE.Group();
  const object = new THREE.Group();
  object.userData.bodyId = bodyId;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(10, 10, 10),
    new THREE.MeshPhongMaterial()
  );
  object.add(mesh);
  group.add(object);
  return { group, mesh };
}

describe('exact section geometry in the viewport', () => {
  it('draws the cut surface and its boundary curves', () => {
    const root = new THREE.Group();
    applyExactSection(root, shaded([region()]));
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
    applyExactSection(root, shaded([region()]));
    applyExactSection(root, shaded([region()]));
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

    applySectionPlane(group, plane, shaded([region()]));
    expect(mesh.getObjectByName(SECTION_CAP)).toBeUndefined();
    expect(group.getObjectByName(EXACT_SECTION)).toBeDefined();

    // Moving the plane again drops back to the approximation for that cut.
    applySectionPlane(group, sectionClippingPlane({ plane: 'XY', offset: 2 }));
    expect(mesh.getObjectByName(SECTION_CAP)).toBeDefined();
    expect(group.getObjectByName(EXACT_SECTION)).toBeUndefined();
  });

  it('leaves the cap on a body the kernel could not section', () => {
    const root = new THREE.Group();
    const cut = body('body_cut');
    const uncut = body('body_uncut');
    root.add(cut.group, uncut.group);
    const plane = sectionClippingPlane({ plane: 'XY', offset: 1 });
    applySectionPlane(root, plane, shaded([region('body_cut')]));
    // One body has section curves; the other would render as an open shell
    // if its approximate cap went away with them.
    expect(cut.mesh.getObjectByName(SECTION_CAP)).toBeUndefined();
    expect(uncut.mesh.getObjectByName(SECTION_CAP)).toBeDefined();
  });

  it('is never clipped, never picked, and never a body mesh', () => {
    const { group } = body();
    const plane = sectionClippingPlane({ plane: 'XY', offset: 1 });
    applySectionPlane(group, plane, shaded([region()]));
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
      shaded([region()])
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
    // The curve's MATERIAL is what the display pass writes; asserting the
    // object's own `visible` flag would pass whatever the pass did, because
    // nothing ever writes it.
    expect((curve.material as THREE.Material).visible).toBe(true);
    expect(curve.visible).toBe(true);
    expect((curve.material as THREE.LineBasicMaterial).color.getHex()).toBe(
      0x14293c
    );
    applyDisplayMode(group, 'shaded');
    expect((fill.material as THREE.Material).visible).toBe(true);
    expect((curve.material as THREE.Material).visible).toBe(true);
    expect(curve.visible).toBe(true);
  });

  it('arrives hidden when the viewport is ALREADY in wireframe', () => {
    const { group } = body();
    // The order that broke it: the mode is set first, then the kernel's
    // answer lands. The display-mode pass depends on the mode, so it does
    // not re-run for a section; the fill's material is built here and would
    // default to visible, showing the slate cut surface in wireframe until
    // the mode was cycled.
    applyDisplayMode(group, 'wireframe');
    applySectionPlane(
      group,
      sectionClippingPlane({ plane: 'XY', offset: 1 }),
      { regions: [region()], displayMode: 'wireframe' }
    );
    const section = group.getObjectByName(EXACT_SECTION)!;
    const fill = section.children.find(
      (child) => child instanceof THREE.Mesh
    ) as THREE.Mesh;
    const curve = section.children.find(
      (child) => child instanceof THREE.LineLoop
    ) as THREE.LineLoop;
    expect((fill.material as THREE.Material).visible).toBe(false);
    // The outline is what wireframe is for; it stays.
    expect((curve.material as THREE.Material).visible).toBe(true);

    // And cycling back out of wireframe still shows it.
    applyDisplayMode(group, 'shaded-edges');
    expect((fill.material as THREE.Material).visible).toBe(true);
  });
});

/** A square region with a square hole, i.e. an outer loop and one inner. */
const boredRegion = (bodyId = 'body_2') => ({
  bodyId,
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
    },
    {
      points: [
        [-1, -1, 1],
        [1, -1, 1],
        [1, 1, 1],
        [-1, 1, 1]
      ] as const
    }
  ]
});

describe('the exact section render-policy snapshot', () => {
  it('reports each region against its OWN boundary curves', () => {
    const root = new THREE.Group();
    applyExactSection(root, shaded([region('body_1'), boredRegion('body_2')]));
    const snapshot = exactSectionSnapshot(root);
    expect(snapshot).toHaveLength(2);
    // A one-loop body reports one curve even beside a bored one; counting
    // the whole group would report 3 against both.
    expect(snapshot.map((entry) => entry.curves)).toEqual([1, 2]);
    expect(snapshot.map((entry) => entry.triangles)).toEqual([2, 2]);
    for (const entry of snapshot) {
      expect(entry.bounds.min[2]).toBeCloseTo(1);
      expect(entry.bounds.max[2]).toBeCloseTo(1);
    }
  });

  it('reports nothing when no exact section is on screen', () => {
    const root = new THREE.Group();
    expect(exactSectionSnapshot(root)).toEqual([]);
    applyExactSection(root, shaded([region()]));
    applyExactSection(root, null);
    expect(exactSectionSnapshot(root)).toEqual([]);
  });
});

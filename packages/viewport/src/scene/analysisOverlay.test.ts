import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  applyDisplayMode,
  applySectionPlane,
  sectionClippingPlane
} from './objects';
import {
  ANALYSIS_OVERLAY,
  applyAnalysisOverlay,
  clearAnalysisOverlay,
  syncAnalysisOverlay,
  type AnalysisOverlayDisplay
} from './analysisOverlay';
import { forEachMesh, type ViewerMesh } from '../pick/meshes';

function body(bodyId: string, parent: THREE.Object3D) {
  const group = new THREE.Group();
  group.userData.bodyId = bodyId;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(10, 10, 10),
    new THREE.MeshStandardMaterial()
  ) as ViewerMesh;
  group.add(mesh);
  parent.add(group);
  return { group, mesh };
}

/** One triangle per body, coloured red. */
function display(...bodyIds: string[]): AnalysisOverlayDisplay {
  return {
    bodies: bodyIds.map((bodyId) => ({
      bodyId,
      positions: new Float32Array([0, 0, 5, 1, 0, 5, 0, 1, 5]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      colors: new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0])
    }))
  };
}

function overlays(root: THREE.Object3D) {
  const found: THREE.Mesh[] = [];
  root.traverse((child) => {
    if (child.name === ANALYSIS_OVERLAY) found.push(child as THREE.Mesh);
  });
  return found;
}

describe('analysis overlay (M09)', () => {
  it('draws each analysed body on screen as a child of its mesh', () => {
    const root = new THREE.Group();
    const a = body('body_a', root);
    body('body_b', root);
    const drawn = applyAnalysisOverlay(root, display('body_a', 'body_hidden'));
    // A body not on screen gets no overlay.
    expect(drawn).toEqual(['body_a']);
    const [overlay] = overlays(root);
    expect(overlay!.parent).toBe(a.mesh);
    const geometry = overlay!.geometry;
    expect(geometry.getAttribute('color').count).toBe(3);
    expect(geometry.getAttribute('normal').count).toBe(3);
    expect(geometry.getIndex()!.count).toBe(3);
    const material = overlay!.material as THREE.MeshLambertMaterial;
    expect(material.vertexColors).toBe(true);
    expect(material.polygonOffset).toBe(true);
  });

  it('is never picked and never treated as a body mesh', () => {
    const root = new THREE.Group();
    body('body_a', root);
    applyAnalysisOverlay(root, display('body_a'));
    const meshes: ViewerMesh[] = [];
    forEachMesh(root, (mesh) => meshes.push(mesh));
    expect(meshes.some((mesh) => mesh.name === ANALYSIS_OVERLAY)).toBe(false);
    const hits: THREE.Intersection[] = [];
    overlays(root)[0]!.raycast(new THREE.Raycaster(), hits);
    expect(hits).toEqual([]);
  });

  it('replaces the previous overlay and clears with null', () => {
    const root = new THREE.Group();
    body('body_a', root);
    body('body_b', root);
    applyAnalysisOverlay(root, display('body_a'));
    applyAnalysisOverlay(root, display('body_a', 'body_b'));
    expect(overlays(root)).toHaveLength(2);
    applyAnalysisOverlay(root, null);
    expect(overlays(root)).toHaveLength(0);
    applyAnalysisOverlay(root, display('body_b'));
    clearAnalysisOverlay(root);
    expect(overlays(root)).toHaveLength(0);
  });

  it('syncs only when the display changed or a rebuilt body lost its overlay', () => {
    const root = new THREE.Group();
    const a = body('body_a', root);
    const shown = display('body_a');
    expect(syncAnalysisOverlay(root, shown)).toBe(true);
    // Unchanged: nothing redrawn.
    expect(syncAnalysisOverlay(root, shown)).toBe(false);
    const first = overlays(root)[0];
    // A rebuild replaces the body's mesh, taking the overlay with it.
    root.remove(a.group);
    const rebuilt = body('body_a', root);
    expect(syncAnalysisOverlay(root, shown)).toBe(true);
    const [second] = overlays(root);
    expect(second).not.toBe(first);
    expect(second!.parent).toBe(rebuilt.mesh);
    // A new display redraws; null clears.
    expect(syncAnalysisOverlay(root, display('body_a'))).toBe(true);
    expect(syncAnalysisOverlay(root, null)).toBe(true);
    expect(overlays(root)).toHaveLength(0);
    expect(syncAnalysisOverlay(root, null)).toBe(false);
  });

  it('follows the section cut, applied before or after', () => {
    const root = new THREE.Group();
    body('body_a', root);
    const plane = sectionClippingPlane({ plane: 'XY', offset: 0 });
    applyAnalysisOverlay(root, display('body_a'));
    applySectionPlane(root, plane);
    expect(
      (overlays(root)[0]!.material as THREE.Material).clippingPlanes
    ).toHaveLength(1);
    // Drawn while the cut is already on, it takes the body's planes.
    applyAnalysisOverlay(root, display('body_a'));
    expect(
      (overlays(root)[0]!.material as THREE.Material).clippingPlanes
    ).toHaveLength(1);
    applySectionPlane(root, null);
    expect(
      (overlays(root)[0]!.material as THREE.Material).clippingPlanes ?? []
    ).toHaveLength(0);
  });

  it("stands in for the body's faces, which come back when it goes", () => {
    const root = new THREE.Group();
    const a = body('body_a', root);
    const b = body('body_b', root);
    applyAnalysisOverlay(root, {
      bodies: [
        display('body_a').bodies[0]!,
        // A face the kernel could not mesh: the body keeps its faces.
        { ...display('body_b').bodies[0]!, covers: false }
      ]
    });
    expect(a.mesh.material.visible).toBe(false);
    expect(b.mesh.material.visible).toBe(true);
    // Wireframe hides the faces, and the overlay with them; shaded brings
    // the overlay back, never the covered faces.
    applyDisplayMode(root, 'wireframe');
    const overlayOf = (mesh: THREE.Object3D) =>
      mesh.children.find((child) => child.name === ANALYSIS_OVERLAY)!;
    expect(overlayOf(a.mesh).visible).toBe(false);
    expect(a.mesh.material.visible).toBe(false);
    applyDisplayMode(root, 'shaded-edges');
    expect(overlayOf(a.mesh).visible).toBe(true);
    expect(a.mesh.material.visible).toBe(false);
    // Cleared in wireframe: the faces return as wireframe wants them.
    applyDisplayMode(root, 'wireframe');
    applyAnalysisOverlay(root, null);
    expect(a.mesh.material.visible).toBe(false);
    applyDisplayMode(root, 'shaded-edges');
    expect(a.mesh.material.visible).toBe(true);
    // Cleared in a shaded mode: straight back.
    applyAnalysisOverlay(root, display('body_a'));
    expect(a.mesh.material.visible).toBe(false);
    clearAnalysisOverlay(root);
    expect(a.mesh.material.visible).toBe(true);
    expect(b.mesh.material.visible).toBe(true);
  });

  it('leaves the section cap of a covered body showing', () => {
    const root = new THREE.Group();
    const a = body('body_a', root);
    root.updateWorldMatrix(true, true);
    applyAnalysisOverlay(root, display('body_a'));
    // The display-cap fallback (no exact section yet) copies the body's
    // material, which the overlay has switched off.
    applySectionPlane(root, sectionClippingPlane({ plane: 'XY', offset: 0 }));
    const cap = a.mesh.children.find(
      (child) => child.userData.sectionCap === true
    ) as THREE.Mesh | undefined;
    expect(cap).toBeDefined();
    expect((cap!.material as THREE.Material).visible).toBe(true);
    expect(a.mesh.material.visible).toBe(false);
  });

  it('draws zebra stripes with a clipped shader over the exact normals', () => {
    const root = new THREE.Group();
    body('body_a', root);
    applyAnalysisOverlay(root, {
      ...display('body_a'),
      shading: { kind: 'zebra', stripes: 16 }
    });
    const material = overlays(root)[0]!.material as THREE.ShaderMaterial;
    expect(material).toBeInstanceOf(THREE.ShaderMaterial);
    expect(material.uniforms.stripes!.value).toBe(16);
    expect(material.vertexColors).toBe(true);
    expect(material.clipping).toBe(true);
    expect(material.fragmentShader).toContain('reflect(');
    // Parallel rays in an orthographic view: no stripes across a flat face.
    expect(material.fragmentShader).toContain('isOrthographic ?');
    // A sample with no exact normal is drawn plain, never striped.
    expect(material.fragmentShader).toContain(
      'mix(vZebraColor, shade, evaluated)'
    );
    applySectionPlane(root, sectionClippingPlane({ plane: 'XY', offset: 0 }));
    expect(material.clippingPlanes).toHaveLength(1);
  });
});

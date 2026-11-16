import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { applySectionPlane, sectionClippingPlane } from './objects';
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
});

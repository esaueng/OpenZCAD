import * as THREE from 'three';
import { findBodyId, forEachMesh, type ViewerMesh } from '../pick/meshes';

/**
 * M09 analysis overlays in the scene: one mesh per analysed body, drawn over
 * the body with the colours the app computed from the exact kernel's
 * samples. The overlay is a child of the body's own mesh, so it follows the
 * body's pose (Assemble) and its section cut; it is never picked (picks go
 * through to the body) and never counted as a viewer mesh, so selection
 * highlighting never tints it.
 *
 * Positions are in the body's model coordinates, which is the frame of its
 * display mesh.
 */
export const ANALYSIS_OVERLAY = 'm09-analysis-overlay';

export interface AnalysisOverlayBody {
  bodyId: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Linear RGB in [0, 1], three per vertex. */
  colors: Float32Array;
}

export interface AnalysisOverlayDisplay {
  bodies: readonly AnalysisOverlayBody[];
}

/** Removes every analysis overlay under `root` and frees its GPU memory. */
export function clearAnalysisOverlay(root: THREE.Object3D) {
  const previous: THREE.Object3D[] = [];
  root.traverse((child) => {
    if (child.userData.analysisOverlay === true) previous.push(child);
  });
  // Removing during traverse would skip siblings.
  for (const child of previous) {
    child.parent?.remove(child);
    const mesh = child as THREE.Mesh;
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }
}

/**
 * Replaces the analysis overlay under `root` with `display` (or clears it).
 * Returns the ids of the bodies that received an overlay: a body not on
 * screen (hidden, or not yet drawn) gets none.
 */
export function applyAnalysisOverlay(
  root: THREE.Object3D,
  display: AnalysisOverlayDisplay | null
): string[] {
  clearAnalysisOverlay(root);
  if (!display || display.bodies.length === 0) return [];
  const hosts = new Map<string, ViewerMesh>();
  forEachMesh(root, (mesh) => {
    const bodyId = findBodyId(mesh);
    if (bodyId && !hosts.has(bodyId)) hosts.set(bodyId, mesh);
  });
  const drawn: string[] = [];
  for (const body of display.bodies) {
    const host = hosts.get(body.bodyId);
    if (!host || body.indices.length === 0) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(body.positions, 3)
    );
    geometry.setAttribute('normal', new THREE.BufferAttribute(body.normals, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(body.colors, 3));
    geometry.setIndex(new THREE.BufferAttribute(body.indices, 1));
    geometry.computeBoundingSphere();
    const material = new THREE.MeshLambertMaterial({
      vertexColors: true,
      side: THREE.FrontSide,
      // Drawn over the body's own faces, which lie on the same surfaces.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      // Follow the body's cut, as its own material does.
      clippingPlanes: hostClippingPlanes(host)
    });
    const overlay = new THREE.Mesh(geometry, material);
    overlay.name = ANALYSIS_OVERLAY;
    overlay.userData.analysisOverlay = true;
    overlay.userData.analysisBodyId = body.bodyId;
    overlay.userData.analysisDisplay = display;
    overlay.raycast = () => undefined;
    overlay.renderOrder = 5;
    host.add(overlay);
    drawn.push(body.bodyId);
  }
  return drawn;
}

/**
 * Applies `display` only where the scene does not already show it: after a
 * rebuild replaced a body's mesh (taking its overlay with it), or when the
 * display itself changed. Cheap when nothing changed, so it can run on every
 * scene pass. Returns whether it redrew.
 */
export function syncAnalysisOverlay(
  root: THREE.Object3D,
  display: AnalysisOverlayDisplay | null
): boolean {
  const wanted = new Set(display?.bodies.map((body) => body.bodyId) ?? []);
  let current = true;
  const drawnOn = new Map<string, THREE.Object3D>();
  root.traverse((child) => {
    if (child.userData.analysisOverlay !== true) return;
    if (child.userData.analysisDisplay !== display) current = false;
    drawnOn.set(child.userData.analysisBodyId as string, child.parent!);
  });
  if (current) {
    forEachMesh(root, (mesh) => {
      const bodyId = findBodyId(mesh);
      if (!bodyId || !wanted.has(bodyId)) return;
      // A body on screen without its overlay (its mesh was rebuilt).
      if (!drawnOn.has(bodyId)) current = false;
    });
  }
  if (current) return false;
  applyAnalysisOverlay(root, display);
  return true;
}

function hostClippingPlanes(host: ViewerMesh): THREE.Plane[] | null {
  const planes = host.material.clippingPlanes;
  return planes && planes.length > 0 ? planes : null;
}

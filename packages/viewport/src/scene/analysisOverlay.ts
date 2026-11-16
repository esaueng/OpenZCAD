import * as THREE from 'three';
import { findBodyId, forEachMesh, type ViewerMesh } from '../pick/meshes';

/**
 * M09 analysis overlays in the scene: one mesh per analysed body, drawn as
 * the body's surface with the colours the app computed from the exact
 * kernel's samples. The overlay is a child of the body's own mesh, so it
 * follows the body's pose (Assemble) and its section cut; it is never picked
 * (picks go through to the body) and never counted as a viewer mesh, so
 * selection highlighting never tints it.
 *
 * The overlay stands IN FOR the body's shaded faces rather than over them.
 * It is sampled more coarsely than the display mesh, so on a convex face its
 * triangles lie slightly inside the display's; drawn over the body, the
 * body's own faces would win the depth test across their interiors and the
 * colours would show in patches at any zoom. While an overlay covers a body
 * (every face meshed), the body's face material is switched off and the
 * overlay writes depth in its place, so other bodies still hide it and it
 * hides them. A body with a face the kernel could not mesh keeps its own
 * faces drawn under the overlay, so no hole opens in it. Edges, section caps
 * and selection fills are separate objects and stay as they are.
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
  /**
   * Whether the overlay meshes every face of the body, so it can stand in
   * for the body's faces. Absent means true.
   */
  covers?: boolean;
}

export interface AnalysisOverlayDisplay {
  bodies: readonly AnalysisOverlayBody[];
}

/**
 * Marks `host` as covered by an overlay: its faces stop drawing, and the
 * visibility the display mode wants for them is kept aside until the
 * overlay goes (`applyDisplayMode` keeps it current meanwhile).
 */
function coverHost(host: ViewerMesh) {
  if (host.userData.analysisCovered === true) return;
  host.userData.analysisCovered = true;
  host.userData.analysisFacesVisible = host.material.visible;
  host.material.visible = false;
}

function uncoverHost(host: THREE.Object3D) {
  if (host.userData.analysisCovered !== true) return;
  const visible = host.userData.analysisFacesVisible !== false;
  delete host.userData.analysisCovered;
  delete host.userData.analysisFacesVisible;
  const material = (host as ViewerMesh).material as THREE.Material | undefined;
  if (material) material.visible = visible;
}

/** Removes every analysis overlay under `root` and frees its GPU memory. */
export function clearAnalysisOverlay(root: THREE.Object3D) {
  const previous: THREE.Object3D[] = [];
  const covered: THREE.Object3D[] = [];
  root.traverse((child) => {
    if (child.userData.analysisOverlay === true) previous.push(child);
    if (child.userData.analysisCovered === true) covered.push(child);
  });
  // Removing during traverse would skip siblings.
  for (const child of previous) {
    child.parent?.remove(child);
    const mesh = child as THREE.Mesh;
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }
  for (const host of covered) uncoverHost(host);
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
    if (body.covers !== false) coverHost(host);
    // Shown where the body's faces would be: not in wireframe.
    overlay.visible =
      host.userData.analysisCovered === true
        ? host.userData.analysisFacesVisible !== false
        : host.material.visible;
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

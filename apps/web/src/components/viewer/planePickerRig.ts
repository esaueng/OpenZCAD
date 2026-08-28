import * as THREE from 'three';
import { VIEWPORT_RENDER_ORDER } from '@openzcad/viewport';
import type { PlaneId } from '@openzcad/shared';

/**
 * Scene-side rig for picking a sketch plane in the viewport: three ghost
 * quads at the origin, one per principal plane, hover-highlighted and
 * clickable. Armed while the Sketch tool is waiting for a plane, so the
 * common case — "sketch on XY" — is a click in the model rather than a trip
 * to a dialog. Picking a planar face still works; the rig is raycast
 * alongside the bodies and the nearer hit wins.
 */

/**
 * Quad half-size in world units. Big enough to read as a plane at the
 * default framing, small enough not to swallow the model behind it; the
 * viewer rescales it per frame against the camera distance.
 */
const BASE_HALF_EXTENT = 30;
const IDLE_OPACITY = 0.16;
const HOVER_OPACITY = 0.34;

/** Axis colors, matching the viewport's origin axes. */
const PLANE_COLOR: Record<PlaneId, number> = {
  XY: 0x4da3ff,
  XZ: 0x4ade80,
  YZ: 0xf87171
};

/** Rotation from a +Z-facing quad onto each principal plane. */
const PLANE_EULER: Record<PlaneId, THREE.Euler> = {
  XY: new THREE.Euler(0, 0, 0),
  XZ: new THREE.Euler(Math.PI / 2, 0, 0),
  YZ: new THREE.Euler(0, Math.PI / 2, 0)
};

export const PLANE_PICKER_ORDER: readonly PlaneId[] = ['XY', 'XZ', 'YZ'];

export interface PlanePickerRig {
  group: THREE.Group;
  /** Quads to raycast; the hit object carries `userData.pickPlane`. */
  targets(): THREE.Object3D[];
  /** Highlights one plane, or clears the highlight with null. */
  setHover(plane: PlaneId | null): void;
  /**
   * Keeps the quads a stable size on screen. `worldPerPixel` is measured at
   * the origin, so the rig reads the same at any zoom — the same trick the
   * gizmos use.
   */
  setScale(worldPerPixel: number): void;
  /**
   * Slides each quad along its own normal, so the ghost sits where the sketch
   * it starts will actually land rather than always at the origin.
   */
  setOffset(offset: number): void;
  dispose(): void;
}

export function buildPlanePickerRig(): PlanePickerRig {
  const group = new THREE.Group();
  group.name = 'plane-picker';
  // Above body faces so a plane crossing the model stays readable, below the
  // selection overlays that answer "what did I just pick".
  group.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_FILL;

  const geometry = new THREE.PlaneGeometry(1, 1);
  const meshes = new Map<PlaneId, THREE.Mesh>();
  const materials: THREE.MeshBasicMaterial[] = [];
  const edges: THREE.LineSegments[] = [];
  const borderByPlane = new Map<PlaneId, THREE.LineSegments>();

  for (const plane of PLANE_PICKER_ORDER) {
    const material = new THREE.MeshBasicMaterial({
      color: PLANE_COLOR[plane],
      transparent: true,
      opacity: IDLE_OPACITY,
      // Depth-written ghosts would occlude each other at the shared origin
      // edges and flicker as the camera turns; these read as overlays.
      depthWrite: false,
      side: THREE.DoubleSide
    });
    materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `plane-picker-${plane}`;
    mesh.userData.pickPlane = plane;
    mesh.rotation.copy(PLANE_EULER[plane]);
    mesh.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_FILL;
    group.add(mesh);
    meshes.set(plane, mesh);

    // A border makes the quad legible where it is edge-on and its fill
    // collapses to nothing.
    const border = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({
        color: PLANE_COLOR[plane],
        transparent: true,
        opacity: 0.5,
        depthWrite: false
      })
    );
    border.raycast = () => undefined;
    border.name = `plane-picker-border-${plane}`;
    border.rotation.copy(PLANE_EULER[plane]);
    border.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_CURVE;
    group.add(border);
    edges.push(border);
    borderByPlane.set(plane, border);
  }

  let hovered: PlaneId | null = null;
  let offsetDistance = 0;
  // Normals match PLANE_EULER: XY faces +Z, XZ faces -Y, YZ faces +X.
  const PLANE_NORMAL: Record<PlaneId, THREE.Vector3> = {
    XY: new THREE.Vector3(0, 0, 1),
    XZ: new THREE.Vector3(0, -1, 0),
    YZ: new THREE.Vector3(1, 0, 0)
  };

  /**
   * Places each quad at the current offset. The group carries the screen-size
   * scale, so the world offset is divided back out of the child positions —
   * and because that scale changes every frame, this has to re-run whenever
   * either input moves, not once when the offset is set.
   */
  const applyOffset = () => {
    const scale = group.scale.x || 1;
    for (const [plane, mesh] of meshes) {
      mesh.position
        .copy(PLANE_NORMAL[plane])
        .multiplyScalar(offsetDistance / scale);
      borderByPlane.get(plane)?.position.copy(mesh.position);
    }
  };

  return {
    group,
    targets: () => [...meshes.values()],
    setHover(plane) {
      if (plane === hovered) {
        return;
      }
      hovered = plane;
      for (const [id, mesh] of meshes) {
        const material = mesh.material as THREE.MeshBasicMaterial;
        material.opacity = id === plane ? HOVER_OPACITY : IDLE_OPACITY;
      }
    },
    setOffset(offset) {
      offsetDistance = Number.isFinite(offset) ? offset : 0;
      applyOffset();
    },
    setScale(worldPerPixel) {
      // 220 CSS pixels across at any zoom: the quads stay a target, not a
      // backdrop that hides the part behind them.
      const size = Math.max(worldPerPixel * 220, BASE_HALF_EXTENT * 0.05);
      group.scale.setScalar(size);
      applyOffset();
    },
    dispose() {
      geometry.dispose();
      for (const material of materials) {
        material.dispose();
      }
      for (const border of edges) {
        border.geometry.dispose();
        (border.material as THREE.Material).dispose();
      }
      group.clear();
    }
  };
}

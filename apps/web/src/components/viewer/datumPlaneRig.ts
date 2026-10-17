import * as THREE from 'three';
import { VIEWPORT_RENDER_ORDER } from '@openzcad/viewport';
import type { DatumFrame } from '@openzcad/shared';

/**
 * Scene-side rig for committed R01 datum planes: one translucent quad and
 * border per plane, laid on the frame the exact build resolved. The quad is
 * presentation only — every consumer uses the infinite plane — so it is not
 * raycast, adds nothing to the model's bounds, and holds a steady size on
 * screen rather than claiming a world extent it does not have.
 */

export interface DatumPlaneRigInput {
  featureId: string;
  frame: DatumFrame;
  selected: boolean;
}

export interface DatumPlaneRig {
  group: THREE.Group;
  /**
   * Keeps every quad about 160 CSS pixels across at any zoom, each measured
   * at its own origin: under perspective a plane far from the world origin
   * would otherwise balloon near the camera or vanish far from it.
   */
  setScale(worldPerPixelAt: (point: THREE.Vector3) => number): void;
  dispose(): void;
}

const IDLE_COLOR = 0x9aa5b8;
const SELECTED_COLOR = 0x8b9cff;
const IDLE_OPACITY = 0.1;
const SELECTED_OPACITY = 0.22;
const SCREEN_EXTENT_PX = 160;

export function buildDatumPlaneRig(
  planes: readonly DatumPlaneRigInput[]
): DatumPlaneRig {
  const group = new THREE.Group();
  group.name = 'datum-planes';
  const geometry = new THREE.PlaneGeometry(1, 1);
  const borderGeometry = new THREE.EdgesGeometry(geometry);
  const disposables: { dispose(): void }[] = [geometry, borderGeometry];
  const scaled: THREE.Object3D[] = [];
  for (const plane of planes) {
    const { origin, u, v, normal } = plane.frame;
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(u.x, u.y, u.z),
      new THREE.Vector3(v.x, v.y, v.z),
      new THREE.Vector3(normal.x, normal.y, normal.z)
    );
    const color = plane.selected ? SELECTED_COLOR : IDLE_COLOR;
    const fillMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: plane.selected ? SELECTED_OPACITY : IDLE_OPACITY,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const borderMaterial = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: plane.selected ? 0.9 : 0.55,
      depthWrite: false
    });
    disposables.push(fillMaterial, borderMaterial);
    const fill = new THREE.Mesh(geometry, fillMaterial);
    const border = new THREE.LineSegments(borderGeometry, borderMaterial);
    fill.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_FILL;
    border.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_CURVE;
    for (const object of [fill, border]) {
      object.name = `datum-plane-${plane.featureId}`;
      object.userData.datumFeatureId = plane.featureId;
      // Presentation only: never a pick target, never in the fit bounds.
      object.raycast = () => undefined;
      object.quaternion.setFromRotationMatrix(basis);
      object.position.set(origin.x, origin.y, origin.z);
      group.add(object);
      scaled.push(object);
    }
  }
  return {
    group,
    setScale(worldPerPixelAt) {
      for (const object of scaled) {
        const size = Math.max(
          worldPerPixelAt(object.position) * SCREEN_EXTENT_PX,
          1e-3
        );
        object.scale.setScalar(size);
      }
    },
    dispose() {
      for (const item of disposables) item.dispose();
      group.clear();
    }
  };
}

import * as THREE from 'three';
import { VIEWPORT_RENDER_ORDER } from '@openzcad/viewport';
import type { Vector3 } from '@openzcad/shared';

/**
 * Scene-side rig for picking an axis in the viewport: one long line per
 * candidate, hover-highlighted and clickable. Armed while an in-place
 * command (Revolve first) waits for its axis slot, so "turn it about the
 * sketch's vertical axis" is a click on that line rather than a dropdown.
 * Like the plane picker it is raycast alongside the model and the nearer
 * hit wins, so a body edge in front of a candidate still gets its click.
 */

export interface AxisPickerCandidate {
  id: string;
  origin: Vector3;
  direction: Vector3;
}

export interface AxisPickerRig {
  group: THREE.Group;
  /** Meshes to raycast; the hit object carries `userData.pickAxis`. */
  targets(): THREE.Object3D[];
  setHover(id: string | null): void;
  /** Draws the picked axis solid and bright, the others stay dashed. */
  setSelected(id: string | null): void;
  /**
   * Keeps the lines long and their hit tubes a steady width on screen.
   * Measured at each line's own origin: a datum axis can sit far from the
   * sketch's, and one scale for both would make one of them a sliver.
   */
  setScale(worldPerPixelAt: (point: THREE.Vector3) => number): void;
  dispose(): void;
}

const IDLE_COLOR = 0xb5a8ff;
const HOVER_COLOR = 0xffffff;
const SELECTED_COLOR = 0xffb547;
const IDLE_OPACITY = 0.7;
const HOVER_OPACITY = 1;
/** Half-length of each line, in CSS pixels at the line's origin. */
const HALF_LENGTH_PX = 900;
/** Hit tube radius in CSS pixels: generous, so aiming is not precision work. */
const HIT_RADIUS_PX = 7;

export function buildAxisPickerRig(
  candidates: readonly AxisPickerCandidate[]
): AxisPickerRig {
  const group = new THREE.Group();
  group.name = 'axis-picker';
  const up = new THREE.Vector3(0, 1, 0);
  const parts = candidates.map((candidate) => {
    const direction = new THREE.Vector3(
      candidate.direction.x,
      candidate.direction.y,
      candidate.direction.z
    ).normalize();
    const holder = new THREE.Group();
    holder.position.set(
      candidate.origin.x,
      candidate.origin.y,
      candidate.origin.z
    );
    holder.quaternion.setFromUnitVectors(up, direction);
    const lineGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, -1, 0),
      new THREE.Vector3(0, 1, 0)
    ]);
    const material = new THREE.LineDashedMaterial({
      color: IDLE_COLOR,
      transparent: true,
      opacity: IDLE_OPACITY,
      // Line distances are measured in the unit line's own space, which the
      // per-frame scale stretches to HALF_LENGTH_PX, so dashes stay ~8 px.
      dashSize: 8 / HALF_LENGTH_PX,
      gapSize: 5 / HALF_LENGTH_PX,
      depthTest: false,
      depthWrite: false
    });
    const line = new THREE.Line(lineGeometry, material);
    line.computeLineDistances();
    line.raycast = () => undefined;
    line.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_CURVE;
    const hit = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 2, 8, 1, true),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    hit.userData.pickAxis = candidate.id;
    holder.add(line, hit);
    group.add(holder);
    return { id: candidate.id, holder, line, hit, material };
  });

  let hovered: string | null = null;
  let selected: string | null = null;
  const paint = () => {
    for (const part of parts) {
      const isSelected = part.id === selected;
      const isHovered = part.id === hovered;
      part.material.color.setHex(
        isSelected ? SELECTED_COLOR : isHovered ? HOVER_COLOR : IDLE_COLOR
      );
      part.material.opacity =
        isSelected || isHovered ? HOVER_OPACITY : IDLE_OPACITY;
      // A picked axis reads as a solid line: one long dash.
      part.material.dashSize = isSelected ? 2 : 8 / HALF_LENGTH_PX;
      part.material.gapSize = isSelected ? 0 : 5 / HALF_LENGTH_PX;
    }
  };
  return {
    group,
    targets: () => parts.map((part) => part.hit),
    setHover(id) {
      if (id === hovered) return;
      hovered = id;
      paint();
    },
    setSelected(id) {
      if (id === selected) return;
      selected = id;
      paint();
    },
    setScale(worldPerPixelAt) {
      for (const part of parts) {
        const worldPerPixel = worldPerPixelAt(part.holder.position);
        const halfLength = Math.max(worldPerPixel * HALF_LENGTH_PX, 1e-3);
        const radius = Math.max(worldPerPixel * HIT_RADIUS_PX, 1e-4);
        part.line.scale.set(1, halfLength, 1);
        part.hit.scale.set(radius, halfLength, radius);
      }
    },
    dispose() {
      for (const part of parts) {
        part.line.geometry.dispose();
        part.material.dispose();
        part.hit.geometry.dispose();
        (part.hit.material as THREE.Material).dispose();
      }
      group.clear();
    }
  };
}

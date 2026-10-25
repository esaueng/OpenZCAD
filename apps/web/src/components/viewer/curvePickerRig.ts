import * as THREE from 'three';
import { VIEWPORT_RENDER_ORDER } from '@openzcad/viewport';
import type { Vector3 } from '@openzcad/shared';

/**
 * Scene-side rig for picking sketch curves outside sketch mode: a sweep's
 * path, one curve at a time. Sketch curves are drawn for display only and
 * never raycast, so a command that wants them arms this rig over them: each
 * candidate is a polyline that brightens on hover and stays lit once picked.
 * Its hit test is a line threshold measured in screen pixels, so a thin
 * curve is as easy to catch zoomed out as zoomed in.
 */

export interface CurvePickerCandidate {
  id: string;
  points: readonly Vector3[];
}

export interface CurvePickerRig {
  group: THREE.Group;
  /** The candidate under `ray`, within `thresholdWorld` of it, or null. */
  pick(ray: THREE.Ray, thresholdWorld: number): string | null;
  setHover(id: string | null): void;
  setSelected(ids: readonly string[]): void;
  dispose(): void;
}

const IDLE_COLOR = 0x8fb6ff;
const HOVER_COLOR = 0xffffff;
const SELECTED_COLOR = 0xffb547;

export function buildCurvePickerRig(
  candidates: readonly CurvePickerCandidate[]
): CurvePickerRig {
  const group = new THREE.Group();
  group.name = 'curve-picker';
  const parts = candidates
    .filter((candidate) => candidate.points.length >= 2)
    .map((candidate) => {
      const geometry = new THREE.BufferGeometry().setFromPoints(
        candidate.points.map((point) => new THREE.Vector3(point.x, point.y, point.z))
      );
      const material = new THREE.LineBasicMaterial({
        color: IDLE_COLOR,
        transparent: true,
        opacity: 0.55,
        depthTest: false,
        depthWrite: false
      });
      const line = new THREE.Line(geometry, material);
      line.userData.pickCurve = candidate.id;
      line.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_CURVE;
      group.add(line);
      return { id: candidate.id, line, material };
    });

  let hovered: string | null = null;
  let selected = new Set<string>();
  const paint = () => {
    for (const part of parts) {
      const isSelected = selected.has(part.id);
      const isHovered = part.id === hovered;
      part.material.color.setHex(
        isSelected ? SELECTED_COLOR : isHovered ? HOVER_COLOR : IDLE_COLOR
      );
      part.material.opacity = isSelected || isHovered ? 1 : 0.55;
    }
  };
  const raycaster = new THREE.Raycaster();

  return {
    group,
    pick(ray, thresholdWorld) {
      group.updateMatrixWorld(true);
      raycaster.ray.copy(ray);
      raycaster.params.Line = { threshold: thresholdWorld };
      const hit = raycaster.intersectObjects(
        parts.map((part) => part.line),
        false
      )[0];
      return (hit?.object.userData.pickCurve as string | undefined) ?? null;
    },
    setHover(id) {
      if (id === hovered) return;
      hovered = id;
      paint();
    },
    setSelected(ids) {
      selected = new Set(ids);
      paint();
    },
    dispose() {
      for (const part of parts) {
        part.line.geometry.dispose();
        part.material.dispose();
      }
      group.clear();
    }
  };
}

import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { keepProgram } from './DragRig';
import { SELECTION_SEMANTICS } from '../render/semantics';

const CHANGE = SELECTION_SEMANTICS.change;

const LEVEL_RING_RADIUS = 0.22;
const LEVEL_RING_SEGMENTS = 40;

export interface LevelRing {
  /** Screen-scaled like the pin: position, orient and scale it as a unit. */
  readonly object: THREE.Group;
  setColor(color: THREE.ColorRepresentation): void;
}

/**
 * The dashed ring that marks a face's old level on the drag axis: where the
 * change arrow starts, the reference the offset is measured from. It lies in
 * the face plane (the group's local XZ plane, its +Y on the normal).
 */
export function createLevelRing(): LevelRing {
  const object = new THREE.Group();
  object.name = 'offset-old-level';
  const points: number[] = [];
  for (let k = 0; k <= LEVEL_RING_SEGMENTS; k += 1) {
    const angle = (k / LEVEL_RING_SEGMENTS) * Math.PI * 2;
    points.push(
      Math.cos(angle) * LEVEL_RING_RADIUS,
      0,
      Math.sin(angle) * LEVEL_RING_RADIUS
    );
  }
  const geometry = new LineGeometry();
  geometry.setPositions(points);
  const material = keepProgram(
    new LineMaterial({
      color: CHANGE.oldLevel,
      linewidth: 1.4,
      dashed: true,
      dashSize: 0.06,
      gapSize: 0.06,
      transparent: true,
      opacity: 0.85,
      depthTest: false
    })
  );
  const ring = new Line2(geometry, material);
  ring.computeLineDistances();
  ring.renderOrder = 29;
  object.add(ring);
  object.visible = false;
  return {
    object,
    setColor(color) {
      material.color.set(color);
    }
  };
}

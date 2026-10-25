import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
  HANDLE_COLOR,
  HANDLE_RENDER_ORDER,
  addHandleParts,
  createHitMesh,
  disposeRigGroups,
  handleMaterial,
  keepProgram,
  toVector3,
  type DragRig,
  type HandleVec3
} from './DragRig';
import { closestAxisT } from './move';
import { SELECTION_SEMANTICS } from '../render/semantics';

/**
 * A length handle: an arrow that slides along a line, its value the distance
 * from where the line starts.
 *
 * The face offset rig carries a face's ghost and band; this one carries
 * nothing but the measurement, for an in-place command's plain lengths — a
 * helix's radius or pitch, a pattern's spacing, a shell's wall. Like the
 * angle rig it answers `valueFromRay`: the value is where the pointer's ray
 * passes closest to the line, so a drag reads the same from any view.
 */
export interface LinearRigParams {
  /** Where the measurement starts (value 0). */
  origin: HandleVec3;
  /** Unit direction a positive value travels. */
  direction: HandleVec3;
  /** The value represented when the gesture begins. */
  value: number;
  min?: number;
  max?: number;
  /**
   * World distance per unit of value; 0.5 puts a diameter's handle on the
   * circle, at its radius. Defaults to 1.
   */
  scale?: number;
}

export const LINEAR_RIG_KIND = 'command-length';
const HEAD_RADIUS = 0.16;
const HEAD_LENGTH = 0.36;
const HIT_RADIUS = 0.55;
const HANDLE_HOT_COLOR = SELECTION_SEMANTICS.handle.hot;

/** The value along the line that a pointer ray names, before clamping. */
export function linearValueFromRay(
  ray: THREE.Ray,
  origin: THREE.Vector3,
  direction: THREE.Vector3
): number | null {
  return closestAxisT(ray, origin, direction);
}

export function buildLinearHandle(params: LinearRigParams): DragRig {
  const kind = LINEAR_RIG_KIND;
  const origin = toVector3(params.origin);
  const direction = toVector3(params.direction).normalize();
  const min = params.min ?? -Infinity;
  const max = params.max ?? Infinity;
  const clamp = (value: number) => Math.min(max, Math.max(min, value));
  const scale = params.scale && params.scale > 0 ? params.scale : 1;
  let current = clamp(params.value);

  // Screen-constant part: a cone pointing along the line, and its hit volume.
  const group = new THREE.Group();
  group.name = `${kind}-handle`;
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const headMaterial = handleMaterial();
  const head = new THREE.Mesh(
    new THREE.ConeGeometry(HEAD_RADIUS, HEAD_LENGTH, 20),
    headMaterial
  );
  const hit = createHitMesh(new THREE.SphereGeometry(HIT_RADIUS, 12, 8), kind);
  addHandleParts(group, [head, hit]);

  // World part: a dashed measurement line from the start to the handle.
  const worldGroup = new THREE.Group();
  worldGroup.name = `${kind}-handle-world`;
  const lineMaterial = keepProgram(
    new LineMaterial({
      color: HANDLE_COLOR,
      linewidth: 1.2,
      dashed: true,
      dashSize: 0.6,
      gapSize: 0.4,
      transparent: true,
      opacity: 0.75,
      depthTest: false
    })
  );
  let line: Line2 | null = null;

  const update = () => {
    const tip = origin.clone().addScaledVector(direction, current * scale);
    group.position.copy(tip);
    if (line) {
      line.removeFromParent();
      line.geometry.dispose();
    }
    const geometry = new LineGeometry();
    geometry.setPositions([origin.x, origin.y, origin.z, tip.x, tip.y, tip.z]);
    line = new Line2(geometry, lineMaterial);
    line.computeLineDistances();
    line.renderOrder = HANDLE_RENDER_ORDER - 1;
    worldGroup.add(line);
  };
  update();

  let hot = false;
  return {
    kind,
    group,
    worldGroup,
    origin,
    direction,
    setValue(value: number) {
      current = clamp(value);
      update();
    },
    value() {
      return current;
    },
    valueFromRay(ray: THREE.Ray) {
      const t = linearValueFromRay(ray, origin, direction);
      return t === null ? null : clamp(t / scale);
    },
    setWarning(warning: boolean) {
      headMaterial.color.set(
        warning ? SELECTION_SEMANTICS.handle.invalid : HANDLE_COLOR
      );
    },
    setHot(next: boolean) {
      if (next === hot) return;
      hot = next;
      headMaterial.color.set(hot ? HANDLE_HOT_COLOR : HANDLE_COLOR);
    },
    chipAnchor(gizmoScale: number) {
      // Beside the arrow, a little past its tip along the line.
      return origin
        .clone()
        .addScaledVector(direction, current * scale)
        .addScaledVector(direction, 0.9 * gizmoScale);
    },
    chipLine() {
      return {
        start: origin.clone(),
        end: origin.clone().addScaledVector(direction, current * scale)
      };
    },
    dispose() {
      lineMaterial.dispose();
      disposeRigGroups(group, worldGroup);
    }
  };
}

import * as THREE from 'three';
import { VIEWPORT_RENDER_ORDER } from '@openzcad/viewport';
import type { DatumAxisLine } from '@openzcad/shared';

/**
 * Scene-side rig for committed R01 datum axes: one dashed line per axis,
 * centred on the origin the exact build resolved and running along its
 * direction. Like a datum plane's quad it is presentation only — every
 * consumer turns about the infinite line — so it holds a steady length on
 * screen, adds nothing to the model's bounds and is never a pick target.
 */

export interface DatumAxisRigInput {
  featureId: string;
  axis: DatumAxisLine;
  selected: boolean;
}

export interface DatumAxisRig {
  group: THREE.Group;
  /** Keeps every line about 240 CSS pixels long at any zoom. */
  setScale(worldPerPixelAt: (point: THREE.Vector3) => number): void;
  dispose(): void;
}

const IDLE_COLOR = 0x9aa5b8;
const SELECTED_COLOR = 0x8b9cff;
const SCREEN_LENGTH_PX = 240;

export function buildDatumAxisRig(
  axes: readonly DatumAxisRigInput[]
): DatumAxisRig {
  const group = new THREE.Group();
  group.name = 'datum-axes';
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-0.5, 0, 0),
    new THREE.Vector3(0.5, 0, 0)
  ]);
  const disposables: { dispose(): void }[] = [geometry];
  const lines: THREE.Line[] = [];
  const along = new THREE.Vector3(1, 0, 0);
  for (const entry of axes) {
    const { origin, direction } = entry.axis;
    const material = new THREE.LineDashedMaterial({
      color: entry.selected ? SELECTED_COLOR : IDLE_COLOR,
      transparent: true,
      opacity: entry.selected ? 0.95 : 0.7,
      depthWrite: false,
      dashSize: 0.04,
      gapSize: 0.025
    });
    disposables.push(material);
    const line = new THREE.Line(geometry, material);
    line.computeLineDistances();
    line.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_CURVE;
    line.raycast = () => undefined;
    line.name = `datum-axis-${entry.featureId}`;
    line.userData.datumFeatureId = entry.featureId;
    line.quaternion.setFromUnitVectors(
      along,
      new THREE.Vector3(direction.x, direction.y, direction.z).normalize()
    );
    line.position.set(origin.x, origin.y, origin.z);
    group.add(line);
    lines.push(line);
  }
  return {
    group,
    setScale(worldPerPixelAt) {
      for (const line of lines) {
        line.scale.setScalar(
          Math.max(worldPerPixelAt(line.position) * SCREEN_LENGTH_PX, 1e-3)
        );
      }
    },
    dispose() {
      for (const item of disposables) item.dispose();
      group.clear();
    }
  };
}

import * as THREE from 'three';
import {
  createFatLine,
  VIEWPORT_RENDER_ORDER,
  type FatLineResolution
} from '@openzcad/viewport';
import type { DatumAxisLine } from '@openzcad/shared';
import {
  DATUM_HIDDEN_DASHED,
  DATUM_HIDDEN_WIDTH_PX,
  DATUM_IDLE_COLOR,
  DATUM_SELECTED_COLOR
} from './datumStyle';

/**
 * Scene-side rig for committed R01 datum axes, in the "solid frame" look: one
 * heavy solid line per axis with plain ends, a dashed continuation where the
 * part hides it. Each line is centred on the
 * origin the exact build resolved and runs along its direction. Like a datum
 * plane's quad it is presentation only — every consumer turns about the
 * infinite line — so it holds a steady length on screen, adds nothing to the
 * model's bounds and is never a pick target.
 */

export interface DatumAxisRigInput {
  featureId: string;
  axis: DatumAxisLine;
  selected: boolean;
}

export interface DatumAxisRigOptions {
  /** The theme's datum colour; selected axes always take the selection hue. */
  color?: THREE.ColorRepresentation;
  resolution?: FatLineResolution;
}

export interface DatumAxisRig {
  group: THREE.Group;
  /** Keeps every line about 250 CSS pixels long at any zoom. */
  setScale(worldPerPixelAt: (point: THREE.Vector3) => number): void;
  /** Repaints the unselected axes, for a theme change. */
  setColor(color: THREE.ColorRepresentation): void;
  dispose(): void;
}

const LINE_WIDTH_PX = 3;
const LINE_OPACITY = 0.95;
const HIDDEN_OPACITY = 0.3;
const SCREEN_LENGTH_PX = 250;

const SEGMENT = [new THREE.Vector3(-0.5, 0, 0), new THREE.Vector3(0.5, 0, 0)];

export function buildDatumAxisRig(
  axes: readonly DatumAxisRigInput[],
  options: DatumAxisRigOptions = {}
): DatumAxisRig {
  const group = new THREE.Group();
  group.name = 'datum-axes';
  const disposables: { dispose(): void }[] = [];
  const holders: THREE.Group[] = [];
  const idle: { color: THREE.Color }[] = [];
  const along = new THREE.Vector3(1, 0, 0);
  for (const entry of axes) {
    const { origin, direction } = entry.axis;
    const color = entry.selected
      ? DATUM_SELECTED_COLOR
      : (options.color ?? DATUM_IDLE_COLOR);
    const holder = new THREE.Group();
    holder.name = `datum-axis-${entry.featureId}`;
    holder.userData.datumFeatureId = entry.featureId;
    holder.quaternion.setFromUnitVectors(
      along,
      new THREE.Vector3(direction.x, direction.y, direction.z).normalize()
    );
    holder.position.set(origin.x, origin.y, origin.z);

    const line = createFatLine(SEGMENT, {
      color,
      linewidth: LINE_WIDTH_PX,
      opacity: entry.selected ? 1 : LINE_OPACITY,
      resolution: options.resolution
    });
    line.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_CURVE;
    const hidden = createFatLine(SEGMENT, {
      color,
      linewidth: DATUM_HIDDEN_WIDTH_PX,
      opacity: HIDDEN_OPACITY,
      depthTest: false,
      resolution: options.resolution
    });
    Object.assign(hidden.material, DATUM_HIDDEN_DASHED);
    hidden.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_FILL;
    for (const part of [line, hidden]) {
      part.raycast = () => undefined;
      part.frustumCulled = false;
      disposables.push(part.geometry, part.material);
      if (!entry.selected) idle.push(part.material);
    }

    holder.add(hidden, line);
    group.add(holder);
    holders.push(holder);
  }
  return {
    group,
    setScale(worldPerPixelAt) {
      for (const holder of holders) {
        holder.scale.setScalar(
          Math.max(worldPerPixelAt(holder.position) * SCREEN_LENGTH_PX, 1e-3)
        );
      }
    },
    setColor(color) {
      for (const material of idle) material.color.set(color);
    },
    dispose() {
      for (const item of disposables) item.dispose();
      group.clear();
    }
  };
}

import * as THREE from 'three';
import {
  createFatLine,
  VIEWPORT_RENDER_ORDER,
  type FatLineResolution
} from '@openzcad/viewport';
import type { DatumCsysFrame, Vector3 } from '@openzcad/shared';
import { DATUM_IDLE_COLOR, DATUM_SELECTED_COLOR } from './datumStyle';

/**
 * Scene-side rig for committed R01 (schema v99) datum points and coordinate
 * systems. A point is a small three-axis cross; a system is a triad of its X,
 * Y and Z axes from its origin, drawn in the conventional red, green and
 * blue (the selection hue when selected). Like datum planes and axes it is
 * presentation only: it keeps a steady size on screen, adds nothing to the
 * model's bounds and is never a pick target.
 */

export interface DatumPointRigInput {
  featureId: string;
  point: Vector3;
  selected: boolean;
}

export interface DatumCsysRigInput {
  featureId: string;
  frame: DatumCsysFrame;
  selected: boolean;
}

export interface DatumMarkerRig {
  group: THREE.Group;
  /** Keeps every marker a steady size on screen at any zoom. */
  setScale(worldPerPixelAt: (point: THREE.Vector3) => number): void;
  /** Repaints the unselected points, for a theme change. */
  setColor(color: THREE.ColorRepresentation): void;
  dispose(): void;
}

const LINE_WIDTH_PX = 3;
const POINT_SCREEN_PX = 14;
const TRIAD_SCREEN_PX = 70;
const AXIS_COLORS = ['#e5484d', '#46a758', '#3e63dd'] as const;

const UNIT_AXES = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1)
];

export function buildDatumMarkerRig(
  points: readonly DatumPointRigInput[],
  systems: readonly DatumCsysRigInput[],
  options: {
    color?: THREE.ColorRepresentation;
    resolution?: FatLineResolution;
  } = {}
): DatumMarkerRig {
  const group = new THREE.Group();
  group.name = 'datum-markers';
  const disposables: { dispose(): void }[] = [];
  const idle: { color: THREE.Color }[] = [];
  const scaled: { holder: THREE.Group; px: number }[] = [];
  const line = (
    from: THREE.Vector3,
    to: THREE.Vector3,
    color: THREE.ColorRepresentation
  ) => {
    const part = createFatLine([from, to], {
      color,
      linewidth: LINE_WIDTH_PX,
      opacity: 1,
      resolution: options.resolution
    });
    part.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_CURVE;
    part.raycast = () => undefined;
    part.frustumCulled = false;
    disposables.push(part.geometry, part.material);
    return part;
  };

  for (const entry of points) {
    const holder = new THREE.Group();
    holder.name = `datum-point-${entry.featureId}`;
    holder.userData.datumFeatureId = entry.featureId;
    holder.position.set(entry.point.x, entry.point.y, entry.point.z);
    const color = entry.selected
      ? DATUM_SELECTED_COLOR
      : (options.color ?? DATUM_IDLE_COLOR);
    for (const axis of UNIT_AXES) {
      const part = line(
        axis.clone().multiplyScalar(-0.5),
        axis.clone().multiplyScalar(0.5),
        color
      );
      if (!entry.selected) idle.push(part.material);
      holder.add(part);
    }
    group.add(holder);
    scaled.push({ holder, px: POINT_SCREEN_PX });
  }

  for (const entry of systems) {
    const { origin, x, y, z } = entry.frame;
    const holder = new THREE.Group();
    holder.name = `datum-csys-${entry.featureId}`;
    holder.userData.datumFeatureId = entry.featureId;
    holder.position.set(origin.x, origin.y, origin.z);
    holder.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(
        new THREE.Vector3(x.x, x.y, x.z),
        new THREE.Vector3(y.x, y.y, y.z),
        new THREE.Vector3(z.x, z.y, z.z)
      )
    );
    UNIT_AXES.forEach((axis, index) => {
      holder.add(
        line(
          new THREE.Vector3(0, 0, 0),
          axis.clone(),
          entry.selected ? DATUM_SELECTED_COLOR : AXIS_COLORS[index]!
        )
      );
    });
    group.add(holder);
    scaled.push({ holder, px: TRIAD_SCREEN_PX });
  }

  return {
    group,
    setScale(worldPerPixelAt) {
      for (const { holder, px } of scaled) {
        holder.scale.setScalar(
          Math.max(worldPerPixelAt(holder.position) * px, 1e-3)
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

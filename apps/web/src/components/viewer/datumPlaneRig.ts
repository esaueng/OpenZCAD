import * as THREE from 'three';
import type { Line2 } from 'three/examples/jsm/lines/Line2.js';
import {
  createFatLine,
  VIEWPORT_RENDER_ORDER,
  type FatLineResolution
} from '@openzcad/viewport';
import type { DatumFrame } from '@openzcad/shared';
import {
  buildDatumLabel,
  DATUM_HIDDEN_DASHED,
  DATUM_HIDDEN_WIDTH_PX,
  DATUM_IDLE_COLOR,
  DATUM_SELECTED_COLOR,
  removeDatumLabels
} from './datumStyle';

/**
 * Scene-side rig for committed R01 datum planes, in the "solid frame" look:
 * a flat fill, a heavy square border, a dashed continuation where the part
 * hides the plane, and the plane's name boxed at its corner. Everything sits
 * on the frame the exact build resolved. The quad is presentation only —
 * every consumer uses the infinite plane — so it adds nothing to the model's
 * bounds and holds a steady size on screen rather than claiming a world
 * extent it does not have. The fill is a pick target only through
 * `targets()`, which the click path asks when nothing in the model is under
 * the pointer; no other raycast walks this group.
 */

export interface DatumPlaneRigInput {
  featureId: string;
  name: string;
  frame: DatumFrame;
  selected: boolean;
}

export interface DatumPlaneRigOptions {
  /** The theme's datum colour; selected planes always take the selection hue. */
  color?: THREE.ColorRepresentation;
  resolution?: FatLineResolution;
}

export interface DatumPlaneRig {
  group: THREE.Group;
  /**
   * Keeps every quad about 170 CSS pixels across at any zoom, each measured
   * at its own origin: under perspective a plane far from the world origin
   * would otherwise balloon near the camera or vanish far from it.
   */
  setScale(worldPerPixelAt: (point: THREE.Vector3) => number): void;
  /** Repaints the unselected planes, for a theme change. */
  setColor(color: THREE.ColorRepresentation): void;
  /** The fill quads, carrying `userData.datumFeatureId`, for a pick ray. */
  targets(): THREE.Object3D[];
  dispose(): void;
}

const FILL_OPACITY = 0.32;
const SELECTED_FILL_OPACITY = 0.45;
const BORDER_WIDTH_PX = 2.5;
const BORDER_OPACITY = 0.9;
const HIDDEN_OPACITY = 0.35;
const SCREEN_EXTENT_PX = 170;

/** The unit quad's outline, closed by repeating its first corner. */
const OUTLINE = [
  new THREE.Vector3(-0.5, -0.5, 0),
  new THREE.Vector3(0.5, -0.5, 0),
  new THREE.Vector3(0.5, 0.5, 0),
  new THREE.Vector3(-0.5, 0.5, 0),
  new THREE.Vector3(-0.5, -0.5, 0)
];

export function buildDatumPlaneRig(
  planes: readonly DatumPlaneRigInput[],
  options: DatumPlaneRigOptions = {}
): DatumPlaneRig {
  const group = new THREE.Group();
  group.name = 'datum-planes';
  const geometry = new THREE.PlaneGeometry(1, 1);
  const disposables: { dispose(): void }[] = [geometry];
  const scaled: THREE.Object3D[] = [];
  const fills: THREE.Mesh[] = [];
  /** Materials painted in the idle colour, for setColor. */
  const idle: { color: THREE.Color }[] = [];
  const resolution = options.resolution;
  for (const plane of planes) {
    const { origin, u, v, normal } = plane.frame;
    const color = plane.selected
      ? DATUM_SELECTED_COLOR
      : (options.color ?? DATUM_IDLE_COLOR);
    const holder = new THREE.Group();
    holder.name = `datum-plane-${plane.featureId}`;
    holder.userData.datumFeatureId = plane.featureId;
    holder.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(
        new THREE.Vector3(u.x, u.y, u.z),
        new THREE.Vector3(v.x, v.y, v.z),
        new THREE.Vector3(normal.x, normal.y, normal.z)
      )
    );
    holder.position.set(origin.x, origin.y, origin.z);

    const fillMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: plane.selected ? SELECTED_FILL_OPACITY : FILL_OPACITY,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const fill = new THREE.Mesh(geometry, fillMaterial);
    fill.name = holder.name;
    fill.userData.datumFeatureId = plane.featureId;
    fill.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_FILL;
    fills.push(fill);

    const border = createFatLine(OUTLINE, {
      color,
      linewidth: BORDER_WIDTH_PX,
      opacity: plane.selected ? 1 : BORDER_OPACITY,
      resolution
    });
    border.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_CURVE;
    // Behind the part: the same outline, thin, dashed and depth-blind. The
    // solid border covers it wherever the plane is in plain view.
    const hidden = createFatLine(OUTLINE, {
      color,
      linewidth: DATUM_HIDDEN_WIDTH_PX,
      opacity: HIDDEN_OPACITY,
      depthTest: false,
      resolution
    });
    Object.assign(hidden.material, DATUM_HIDDEN_DASHED);
    hidden.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_FILL;
    const lines: Line2[] = [border, hidden];
    for (const line of lines) {
      // Only the fill is ever picked, and only via targets().
      line.raycast = () => undefined;
      line.frustumCulled = false;
      disposables.push(line.geometry, line.material);
    }
    disposables.push(fillMaterial);
    if (!plane.selected) {
      idle.push(fillMaterial, border.material, hidden.material);
    }

    const label = buildDatumLabel(plane.name, plane.selected);
    label.position.set(0.5, 0.5, 0);

    holder.add(fill, hidden, border, label);
    group.add(holder);
    scaled.push(holder);
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
    setColor(color) {
      for (const material of idle) material.color.set(color);
    },
    targets() {
      return fills;
    },
    dispose() {
      removeDatumLabels(group);
      for (const item of disposables) item.dispose();
      group.clear();
    }
  };
}

import * as THREE from 'three';
import type { Line2 } from 'three/examples/jsm/lines/Line2.js';
import {
  CURRENT_CANONICAL_BASIS_REVISION,
  canonicalPlaneBasis
} from '@openzcad/geometry';
import {
  createFatLine,
  VIEWPORT_RENDER_ORDER,
  type FatLineResolution
} from '@openzcad/viewport';
import type { PlaneId } from '@openzcad/shared';
import { DATUM_HIDDEN_DASHED, DATUM_HIDDEN_WIDTH_PX } from './datumStyle';

/**
 * Scene-side rig for picking a sketch plane in the viewport: one panel per
 * principal plane, each covering only that plane's positive quadrant, so the
 * three meet along the positive axes like the inside corner of a box instead
 * of crossing. Each panel has chamfered, slightly filleted corners and its
 * name lying flat in the outer corner. Armed while the Sketch tool (or an
 * in-place command) is waiting for a plane.
 *
 * A part built at the origin fills those same quadrants, so the panels draw
 * through it: the fill and label ignore depth, and the border's hidden part
 * is the datum rig's thin dashed line. Picking goes through the part too —
 * see `ghostPlaneTakesPick`.
 */

/**
 * Panel geometry in CSS pixels; the group's scale (world units per pixel)
 * turns it into world units, so the panels hold their size on screen.
 */
const EXTENT_PX = 150;
/** Keeps the fills off the axis lines so the axes stay crisp. */
const GAP_PX = 6;
/** 45° chamfer leg at each corner. */
const CHAMFER_PX = 16;
/** Trim of the small fillet on each chamfer vertex; under half a chamfer edge. */
const FILLET_PX = 5;
const FILLET_SEGMENTS = 4;
/** Height of the label's ink (cap height of the two letters). */
const LABEL_INK_PX = 13;
/**
 * Inset of the label's ink box from the two outer edges, chosen so its gap to
 * the chamfer equals its gap to the edges: (2m − c)/√2 = m.
 */
const LABEL_INSET_PX = CHAMFER_PX / (2 - Math.SQRT2);
/** Floor on the world size of one pixel, so a far-zoomed rig stays a target. */
const MIN_WORLD_PER_PIXEL = 1.5 / 220;

/** Screen size of a committed datum plane's unit quad (datumPlaneRig). */
const DATUM_SCREEN_EXTENT_PX = 170;

const BORDER_WIDTH_PX = 1.5;
const HOVER_BORDER_WIDTH_PX = 2.5;

interface PanelLook {
  fill: number;
  border: number;
  label: number;
}
/** Idle, hovered, and the other two while one is hovered. */
const IDLE: PanelLook = { fill: 0.09, border: 0.6, label: 0.95 };
const HOVER: PanelLook = { fill: 0.3, border: 1, label: 1 };
const DIMMED: PanelLook = { fill: 0.04, border: 0.22, label: 0.3 };
/** Hidden border opacity relative to the visible one. */
const HIDDEN_BORDER_SCALE = 0.45;

/** Axis colors, matching the viewport's origin axes. */
const PLANE_COLOR: Record<PlaneId, number> = {
  XY: 0x4da3ff,
  XZ: 0x4ade80,
  YZ: 0xf87171
};

/**
 * The world axes spanning each panel's positive quadrant, as the label reads
 * them: `right` then `up`, seen from the side `right × up` points to (Top
 * from +Z, Front from −Y, Right from +X).
 */
const PLANE_AXES: Record<PlaneId, { right: THREE.Vector3; up: THREE.Vector3 }> =
  {
    XY: { right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0) },
    XZ: { right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0, 1) },
    YZ: { right: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, 1) }
  };

export const PLANE_PICKER_ORDER: readonly PlaneId[] = ['XY', 'XZ', 'YZ'];

export interface PlanePickerRigOptions {
  resolution?: FatLineResolution;
}

export interface PlanePickerRig {
  group: THREE.Group;
  /** Panels to raycast; the hit object carries `userData.pickPlane`. */
  targets(): THREE.Object3D[];
  /** Highlights one plane and dims the others, or clears it with null. */
  setHover(plane: PlaneId | null): void;
  /**
   * Keeps the panels a stable size on screen. `worldPerPixel` is measured at
   * the origin, so the rig reads the same at any zoom — the same trick the
   * gizmos use.
   */
  setScale(worldPerPixel: number): void;
  /**
   * Slides each panel along its own normal, so the ghost sits where the
   * sketch it starts will actually land rather than always at the origin.
   */
  setOffset(offset: number): void;
  /**
   * A world point on a panel that a ray from `camera` reaches before any
   * other panel, or null if another panel covers all of it. Searched from the
   * outer corner inward. For tests that click a ghost plane.
   */
  exposedPoint(plane: PlaneId, camera: THREE.Camera): THREE.Vector3 | null;
  dispose(): void;
}

/**
 * Whether a ghost-plane hit takes the click (or hover) from the model pick
 * under the same pointer. The panels sit where a part at the origin usually
 * is, so they win through faces (or whole-body hits) in front of them.
 * They do not win over edges, vertices, axes or sketch regions, which are
 * thin targets a click means precisely, nor over a face lying in the
 * ghost's own plane: that face is the same plane with real lineage, so it is
 * the better pick.
 */
export function ghostPlaneTakesPick(
  ghostDistance: number,
  model: { kind: string; distance: number } | null | undefined
): boolean {
  if (!model) return true;
  // A whole-body hit is a surface hit too (what a body-level filter returns).
  if (model.kind !== 'face' && model.kind !== 'body') {
    return ghostDistance < model.distance;
  }
  // Coplanar: both rays end on the same point. Relative tolerance, since the
  // distance is in world units and the pick depth buffer is not exact.
  const tolerance = Math.max(1e-6, 1e-4 * ghostDistance);
  return Math.abs(model.distance - ghostDistance) > tolerance;
}

/** The panel outline in its own (right, up) pixel coordinates, CCW, closed. */
function panelOutline(): THREE.Vector2[] {
  const lo = GAP_PX;
  const hi = EXTENT_PX;
  const c = CHAMFER_PX;
  const corners: [number, number][] = [
    [lo + c, lo],
    [hi - c, lo],
    [hi, lo + c],
    [hi, hi - c],
    [hi - c, hi],
    [lo + c, hi],
    [lo, hi - c],
    [lo, lo + c]
  ];
  const outline: THREE.Vector2[] = [];
  const n = corners.length;
  for (let i = 0; i < n; i++) {
    const p = new THREE.Vector2(...corners[i]!);
    const a = new THREE.Vector2(...corners[(i + n - 1) % n]!);
    const b = new THREE.Vector2(...corners[(i + 1) % n]!);
    const start = p.clone().add(a.sub(p).setLength(FILLET_PX));
    const end = p.clone().add(b.sub(p).setLength(FILLET_PX));
    const curve = new THREE.QuadraticBezierCurve(start, p, end);
    outline.push(...curve.getPoints(FILLET_SEGMENTS));
  }
  return outline;
}

/** Ink box of the label text, centred on its canvas, as a texture. */
function labelTexture(plane: PlaneId): {
  texture: THREE.CanvasTexture;
  aspect: number;
  inkWidth: number;
  inkHeight: number;
} | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  let context: CanvasRenderingContext2D | null;
  try {
    context = canvas.getContext('2d');
  } catch {
    // jsdom-style environments throw instead of returning null.
    context = null;
  }
  if (!context || typeof context.measureText !== 'function') return null;
  const g = context;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const font = '700 88px "Geist Mono", ui-monospace, Menlo, monospace';
  const result = { texture, aspect: 2, inkWidth: 0.5, inkHeight: 0.55 };
  const draw = () => {
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.font = font;
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    const m = g.measureText(plane);
    const left = m.actualBoundingBoxLeft ?? 0;
    const right = m.actualBoundingBoxRight ?? m.width;
    const ascent = m.actualBoundingBoxAscent ?? 64;
    const descent = m.actualBoundingBoxDescent ?? 0;
    const x = canvas.width / 2 - (right - left) / 2;
    const y = canvas.height / 2 + (ascent - descent) / 2;
    g.lineJoin = 'round';
    g.lineWidth = 14;
    g.strokeStyle = 'rgba(15, 18, 22, 0.85)';
    g.strokeText(plane, x, y);
    g.fillStyle = `#${PLANE_COLOR[plane].toString(16).padStart(6, '0')}`;
    g.fillText(plane, x, y);
    result.inkWidth = (left + right) / canvas.width;
    result.inkHeight = (ascent + descent) / canvas.height;
    texture.needsUpdate = true;
  };
  draw();
  // Repaint once the web font arrives; the first pass may use the fallback.
  void document.fonts?.load?.(font).then(draw, () => undefined);
  return result;
}

export function buildPlanePickerRig(
  options: PlanePickerRigOptions = {}
): PlanePickerRig {
  const group = new THREE.Group();
  group.name = 'plane-picker';
  group.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_FILL;

  const outline = panelOutline();
  const fillGeometry = new THREE.ShapeGeometry(new THREE.Shape(outline));
  const outline3 = outline.map((p) => new THREE.Vector3(p.x, p.y, 0));
  const disposables: { dispose(): void }[] = [fillGeometry];

  interface Panel {
    holder: THREE.Group;
    fill: THREE.Mesh;
    fillMaterial: THREE.MeshBasicMaterial;
    border: Line2;
    hidden: Line2;
    labelMaterial: THREE.MeshBasicMaterial | null;
  }
  const panels = new Map<PlaneId, Panel>();

  for (const plane of PLANE_PICKER_ORDER) {
    const { right, up } = PLANE_AXES[plane];
    const holder = new THREE.Group();
    holder.name = `plane-picker-panel-${plane}`;
    holder.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(
        right,
        up,
        new THREE.Vector3().crossVectors(right, up)
      )
    );

    const fillMaterial = new THREE.MeshBasicMaterial({
      color: PLANE_COLOR[plane],
      transparent: true,
      opacity: IDLE.fill,
      // Through the part: the panels sit where a part at the origin usually
      // is. Depth-written ghosts would also occlude each other at the shared
      // axes and flicker as the camera turns.
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const fill = new THREE.Mesh(fillGeometry, fillMaterial);
    fill.name = `plane-picker-${plane}`;
    fill.userData.pickPlane = plane;
    fill.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_FILL;

    const border = createFatLine(outline3, {
      color: PLANE_COLOR[plane],
      linewidth: BORDER_WIDTH_PX,
      opacity: IDLE.border,
      resolution: options.resolution
    });
    border.name = `plane-picker-border-${plane}`;
    border.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_CURVE;
    // Behind the part: the same outline, thin, dashed and depth-blind, as on
    // committed datum planes. The solid border covers it where in plain view.
    const hidden = createFatLine(outline3, {
      color: PLANE_COLOR[plane],
      linewidth: DATUM_HIDDEN_WIDTH_PX,
      opacity: IDLE.border * HIDDEN_BORDER_SCALE,
      depthTest: false,
      resolution: options.resolution
    });
    // The datum dash is sized on a unit quad drawn 170 px across; this
    // outline is already in pixels, so the same dash is that much longer.
    Object.assign(hidden.material, {
      dashed: true,
      dashSize: DATUM_HIDDEN_DASHED.dashSize * DATUM_SCREEN_EXTENT_PX,
      gapSize: DATUM_HIDDEN_DASHED.gapSize * DATUM_SCREEN_EXTENT_PX
    });
    hidden.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_FILL;
    for (const line of [border, hidden]) {
      line.raycast = () => undefined;
      line.frustumCulled = false;
      disposables.push(line.geometry, line.material);
    }
    disposables.push(fillMaterial);
    holder.add(fill, hidden, border);

    let labelMaterial: THREE.MeshBasicMaterial | null = null;
    const label = labelTexture(plane);
    if (label) {
      labelMaterial = new THREE.MeshBasicMaterial({
        map: label.texture,
        transparent: true,
        opacity: IDLE.label,
        depthTest: false,
        depthWrite: false
      });
      // The quad is sized so the ink is LABEL_INK_PX tall; the ink box is
      // centred on the canvas, so the quad's centre is the ink's centre.
      const height = LABEL_INK_PX / label.inkHeight;
      const quad = new THREE.PlaneGeometry(height * label.aspect, height);
      disposables.push(label.texture, labelMaterial, quad);
      const inkHalfWidth = (height * label.aspect * label.inkWidth) / 2;
      const position = new THREE.Vector3(
        EXTENT_PX - LABEL_INSET_PX - inkHalfWidth,
        EXTENT_PX - LABEL_INSET_PX - LABEL_INK_PX / 2,
        0
      );
      // Front face reads from the panel's front; a twin turned about the
      // panel's up axis reads correctly from behind. Both cull their back.
      for (const turned of [false, true]) {
        const mesh = new THREE.Mesh(quad, labelMaterial);
        mesh.name = `plane-picker-label-${plane}`;
        mesh.position.copy(position);
        if (turned) mesh.rotation.y = Math.PI;
        mesh.renderOrder = VIEWPORT_RENDER_ORDER.SKETCH_CURVE;
        mesh.raycast = () => undefined;
        holder.add(mesh);
      }
    }

    group.add(holder);
    panels.set(plane, {
      holder,
      fill,
      fillMaterial,
      border,
      hidden,
      labelMaterial
    });
  }

  let hovered: PlaneId | null = null;
  let offsetDistance = 0;

  /**
   * Places each panel at the current offset. The group carries the
   * screen-size scale, so the world offset is divided back out of the child
   * positions — and because that scale changes every frame, this has to
   * re-run whenever either input moves, not once when the offset is set.
   */
  const applyOffset = () => {
    const scale = group.scale.x || 1;
    for (const [plane, panel] of panels) {
      // The basis a sketch started here is written with, so the offset
      // ghost lands where that sketch will.
      const normal = canonicalPlaneBasis(
        plane,
        CURRENT_CANONICAL_BASIS_REVISION
      ).normal;
      panel.holder.position
        .set(normal.x, normal.y, normal.z)
        .multiplyScalar(offsetDistance / scale);
    }
  };

  const paint = () => {
    for (const [plane, panel] of panels) {
      const look = hovered === null ? IDLE : hovered === plane ? HOVER : DIMMED;
      panel.fillMaterial.opacity = look.fill;
      panel.border.material.opacity = look.border;
      panel.border.material.linewidth =
        hovered === plane ? HOVER_BORDER_WIDTH_PX : BORDER_WIDTH_PX;
      panel.hidden.material.opacity = look.border * HIDDEN_BORDER_SCALE;
      if (panel.labelMaterial) panel.labelMaterial.opacity = look.label;
    }
  };

  return {
    group,
    targets: () => [...panels.values()].map((panel) => panel.fill),
    setHover(plane) {
      if (plane === hovered) {
        return;
      }
      hovered = plane;
      paint();
    },
    setOffset(offset) {
      offsetDistance = Number.isFinite(offset) ? offset : 0;
      applyOffset();
    },
    setScale(worldPerPixel) {
      group.scale.setScalar(Math.max(worldPerPixel, MIN_WORLD_PER_PIXEL));
      applyOffset();
    },
    exposedPoint(plane, camera) {
      const panel = panels.get(plane)!;
      const fills = [...panels.values()].map((candidate) => candidate.fill);
      group.updateMatrixWorld(true);
      camera.updateMatrixWorld();
      const raycaster = new THREE.Raycaster();
      const eye = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
      const orthographic = (camera as THREE.OrthographicCamera)
        .isOrthographicCamera;
      const forward = camera.getWorldDirection(new THREE.Vector3());
      // Inset from the chamfer and the gap; 12 px steps from the outer corner.
      const outer = EXTENT_PX - CHAMFER_PX;
      const inner = GAP_PX + 4;
      for (let a = outer; a >= inner; a -= 12) {
        for (let b = outer; b >= inner; b -= 12) {
          const point = new THREE.Vector3(a, b, 0).applyMatrix4(
            panel.holder.matrixWorld
          );
          if (orthographic) {
            raycaster.set(
              point.clone().addScaledVector(forward, -1e6),
              forward
            );
          } else {
            raycaster.set(eye, point.clone().sub(eye).normalize());
          }
          const hit = raycaster.intersectObjects(fills, false)[0];
          if (hit?.object === panel.fill) return point;
        }
      }
      return null;
    },
    dispose() {
      for (const item of disposables) {
        item.dispose();
      }
      group.clear();
    }
  };
}

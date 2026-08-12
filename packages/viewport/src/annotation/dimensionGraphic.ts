import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { FatLineResolution } from '../render/scene';

/**
 * A drawing's dimension, drawn in the scene.
 *
 * This was written once already, inline inside the cylinder-radius drag rig,
 * where it is the thing that says "this gesture edits a radius" rather than
 * merely where the delta went. It is extracted here rather than written a
 * second time for the measurement tape: two dimension renderers would drift,
 * and the one that already ships has the sizes and the screen-space behaviour
 * that were tuned against a real viewport.
 *
 * What it draws, and why each part is there:
 *
 *   witness lines   short ticks standing off the geometry, so the dimension
 *                   line does not sit on top of the edge it measures
 *   dimension line  dashed, between the two witness ticks
 *   arrowheads      cones whose TIPS land on the measured points, not their
 *                   centres — an arrow that overshoots reads as a longer part
 *
 * Everything sized in pixels is scaled per frame by the caller, which is the
 * only way a dimension stays legible across a zoom range that spans a bolt and
 * a beam.
 */

/** The near-white of a drawing's linework, matched to the drag rigs. */
export const DIMENSION_LINE_COLOR = 0xf4f7fb;

/**
 * Cone size in world units at unit scale, kept identical to the rig's shipped
 * values so the two graphics cannot diverge visually.
 */
export const DIMENSION_ARROW_RADIUS = 0.055;
export const DIMENSION_ARROW_LENGTH = 0.22;

/**
 * How far the witness ticks stand off the measured points, as a multiple of
 * the arrow length. Zero puts the dimension line through the geometry, which
 * is what makes a CAD screenshot look like a wireframe rather than a drawing.
 */
const WITNESS_STANDOFF = 1.4;
/** How far past the dimension line the witness ticks continue. */
const WITNESS_OVERSHOOT = 0.6;

export interface DimensionGraphicOptions {
  /** Draw the short ticks that stand the dimension off the geometry. */
  witnessLines?: boolean;
  /** Shared line/arrow color; defaults to drawing white. */
  color?: THREE.ColorRepresentation;
  linewidth?: number;
  opacity?: number;
  depthTest?: boolean;
  /** Render order for the line; arrowheads take this plus one. */
  renderOrder?: number;
}

export interface DimensionGraphic {
  /** Add this to a world-space group. */
  readonly object: THREE.Group;
  /**
   * Re-place the graphic between two world points.
   *
   * `pixelScale` is world-units-per-pixel-ish, the same number the viewer
   * already stamps on gizmo groups. It is applied on every call rather than
   * cached against the camera: a wheel-zoom changes it without changing the
   * camera's orientation, so a guard keyed on rotation would freeze the
   * arrowheads at their pre-zoom size.
   */
  update(start: THREE.Vector3, end: THREE.Vector3, pixelScale: number): void;
  /** Changes linework and arrowheads in place without rebuilding geometry. */
  setColor(color: THREE.ColorRepresentation): void;
  /** A point on the dimension line, for hanging the value label from. */
  labelAnchor(): THREE.Vector3;
  dispose(): void;
}

export interface DimensionLineMaterialOptions {
  color?: THREE.ColorRepresentation;
  linewidth?: number;
  opacity?: number;
  depthTest?: boolean;
  resolution?: FatLineResolution;
}

/** Shared dashed drawing line used by dimensions and analytic references. */
export function createDimensionLineMaterial(
  options: DimensionLineMaterialOptions = {}
): LineMaterial {
  const material = new LineMaterial({
    color: options.color ?? DIMENSION_LINE_COLOR,
    linewidth: options.linewidth ?? 1.5,
    dashed: true,
    dashSize: 2,
    gapSize: 1.5,
    transparent: true,
    opacity: options.opacity ?? 0.9,
    // Dimensions read through the part, the way they do on paper. A dimension
    // hidden by the very geometry it measures is worse than no dimension.
    depthTest: options.depthTest ?? false
  });
  material.resolution.set(
    Math.max(options.resolution?.width ?? 1, 1),
    Math.max(options.resolution?.height ?? 1, 1)
  );
  return material;
}

export function createDimensionGraphic(
  options: DimensionGraphicOptions = {}
): DimensionGraphic {
  const renderOrder = options.renderOrder ?? 29;
  const color = options.color ?? DIMENSION_LINE_COLOR;
  const opacity = options.opacity ?? 0.9;
  const depthTest = options.depthTest ?? false;
  const object = new THREE.Group();
  object.name = 'dimension-graphic';

  const lineGeometry = new LineGeometry();
  lineGeometry.setPositions([0, 0, 0, 0, 0, 0]);
  const line = new Line2(
    lineGeometry,
    createDimensionLineMaterial({
      color,
      ...(options.linewidth === undefined
        ? {}
        : { linewidth: options.linewidth }),
      opacity,
      depthTest
    })
  );
  line.computeLineDistances();
  line.renderOrder = renderOrder;
  object.add(line);

  const arrowMaterial = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: Math.min(opacity + 0.05, 1),
    depthTest
  });
  // One cone geometry shared by both heads: they are the same shape, and the
  // second allocation would be freed by the same dispose anyway.
  const coneGeometry = new THREE.ConeGeometry(
    DIMENSION_ARROW_RADIUS,
    DIMENSION_ARROW_LENGTH,
    12
  );
  const makeHead = () => {
    const head = new THREE.Mesh(coneGeometry, arrowMaterial);
    head.renderOrder = renderOrder + 1;
    object.add(head);
    return head;
  };
  const startHead = makeHead();
  const endHead = makeHead();

  const witnessGeometries: LineGeometry[] = [];
  const witnesses: Line2[] = [];
  if (options.witnessLines) {
    for (let index = 0; index < 2; index += 1) {
      const geometry = new LineGeometry();
      geometry.setPositions([0, 0, 0, 0, 0, 0]);
      const witness = new Line2(
        geometry,
        new LineMaterial({
          color,
          linewidth: 1,
          transparent: true,
          opacity: opacity * 0.61,
          depthTest
        })
      );
      witness.renderOrder = renderOrder;
      witnessGeometries.push(geometry);
      witnesses.push(witness);
      object.add(witness);
    }
  }

  const anchor = new THREE.Vector3();
  const axis = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  return {
    object,
    update(start, end, pixelScale) {
      // A clamp at 1, matching the rig: without it the graphic collapses to
      // nothing at extreme zoom-in, where `pixelScale` goes to zero and the
      // arrowheads would vanish exactly when they are most readable.
      const scale = Math.max(pixelScale, 1);
      axis.subVectors(end, start);
      const length = axis.length();
      if (length <= 1e-9) {
        // A zero-length dimension has no direction to orient anything by.
        // Collapsing to a hidden graphic beats drawing a NaN.
        object.visible = false;
        return;
      }
      object.visible = true;
      axis.divideScalar(length);

      lineGeometry.setPositions([
        start.x,
        start.y,
        start.z,
        end.x,
        end.y,
        end.z
      ]);
      line.computeLineDistances();

      startHead.scale.setScalar(scale);
      endHead.scale.setScalar(scale);
      startHead.quaternion.setFromUnitVectors(up, axis.clone().negate());
      endHead.quaternion.setFromUnitVectors(up, axis);
      // Half a cone back from each end, so the TIP lands on the measured
      // point. Centring the cone there would overstate the measurement by
      // half an arrowhead at each end.
      startHead.position
        .copy(start)
        .addScaledVector(axis, (DIMENSION_ARROW_LENGTH / 2) * scale);
      endHead.position
        .copy(end)
        .addScaledVector(axis, (-DIMENSION_ARROW_LENGTH / 2) * scale);

      if (witnesses.length === 2) {
        // Ticks run perpendicular to the dimension, in whichever direction is
        // least degenerate against the axis.
        const reference =
          Math.abs(axis.y) > 0.9
            ? new THREE.Vector3(1, 0, 0)
            : new THREE.Vector3(0, 1, 0);
        const across = new THREE.Vector3()
          .crossVectors(axis, reference)
          .normalize();
        const back = DIMENSION_ARROW_LENGTH * WITNESS_STANDOFF * scale;
        const over = DIMENSION_ARROW_LENGTH * WITNESS_OVERSHOOT * scale;
        const ends: [THREE.Vector3, THREE.Vector3] = [start, end];
        ends.forEach((point, index) => {
          const from = point.clone().addScaledVector(across, -back);
          const to = point.clone().addScaledVector(across, over);
          witnessGeometries[index]!.setPositions([
            from.x,
            from.y,
            from.z,
            to.x,
            to.y,
            to.z
          ]);
          witnesses[index]!.computeLineDistances();
        });
      }

      // 45% along, matching the radius rig's inline callout placement rather
      // than the midpoint: dead centre collides with the dimension line's own
      // dash pattern more often than not.
      anchor.copy(start).addScaledVector(axis, length * 0.45);
    },
    setColor(nextColor) {
      line.material.color.set(nextColor);
      arrowMaterial.color.set(nextColor);
      for (const witness of witnesses) {
        witness.material.color.set(nextColor);
      }
    },
    labelAnchor() {
      return anchor.clone();
    },
    dispose() {
      lineGeometry.dispose();
      line.material.dispose();
      coneGeometry.dispose();
      arrowMaterial.dispose();
      for (const geometry of witnessGeometries) {
        geometry.dispose();
      }
      for (const witness of witnesses) {
        witness.material.dispose();
      }
      object.clear();
    }
  };
}

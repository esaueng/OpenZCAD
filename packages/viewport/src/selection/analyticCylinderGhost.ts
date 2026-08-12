import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import type { FaceGeometry } from '@openzcad/shared';
import { createDimensionLineMaterial } from '../annotation/dimensionGraphic';
import { VIEWPORT_RENDER_ORDER, type FatLineResolution } from '../render/scene';

export const ANALYTIC_GHOST_COLOR = 0x78998a;
export const ANALYTIC_GHOST_OPACITY = 0.18;

type CylinderGeometry = Pick<
  FaceGeometry,
  'surfaceType' | 'axisStart' | 'axisEnd' | 'radius'
>;

/** Full analytic cylinder extent for a selected cylindrical face. */
export function createAnalyticCylinderGhost(
  geometry: CylinderGeometry,
  resolution?: FatLineResolution
): THREE.Group | null {
  const { axisStart, axisEnd, radius } = geometry;
  if (
    geometry.surfaceType !== 'cylinder' ||
    !axisStart ||
    !axisEnd ||
    radius === undefined ||
    !Number.isFinite(radius) ||
    radius <= 0
  ) {
    return null;
  }
  const start = new THREE.Vector3(axisStart.x, axisStart.y, axisStart.z);
  const end = new THREE.Vector3(axisEnd.x, axisEnd.y, axisEnd.z);
  if (![...start, ...end].every(Number.isFinite)) {
    return null;
  }
  const axis = end.clone().sub(start);
  const length = axis.length();
  if (!Number.isFinite(length) || length <= 1e-9) {
    return null;
  }
  axis.divideScalar(length);

  const group = new THREE.Group();
  group.name = 'analytic-cylinder-ghost';
  group.userData.selectionOverlay = true;

  const cylinder = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, length, 64, 1, false),
    new THREE.MeshBasicMaterial({
      color: ANALYTIC_GHOST_COLOR,
      toneMapped: false,
      transparent: true,
      opacity: ANALYTIC_GHOST_OPACITY,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  );
  cylinder.name = 'analytic-cylinder-extent';
  cylinder.position.copy(start).lerp(end, 0.5);
  cylinder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  cylinder.renderOrder = VIEWPORT_RENDER_ORDER.HOVER_HIGHLIGHT - 1;
  cylinder.userData.selectionOverlay = true;
  cylinder.raycast = () => undefined;
  group.add(cylinder);

  const axisGeometry = new LineGeometry();
  axisGeometry.setPositions([start.x, start.y, start.z, end.x, end.y, end.z]);
  const axisLine = new Line2(
    axisGeometry,
    createDimensionLineMaterial({
      color: ANALYTIC_GHOST_COLOR,
      linewidth: 1,
      opacity: 0.78,
      depthTest: false,
      resolution
    })
  );
  axisLine.name = 'analytic-cylinder-axis';
  axisLine.computeLineDistances();
  axisLine.renderOrder = VIEWPORT_RENDER_ORDER.HOVER_HIGHLIGHT - 1;
  axisLine.userData.selectionOverlay = true;
  axisLine.raycast = () => undefined;
  group.add(axisLine);

  return group;
}

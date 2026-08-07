import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
  CHIP_ANCHOR_LOCAL_DISTANCE,
  HANDLE_COLOR,
  addHandleParts,
  createHitMesh,
  disposeRigGroups,
  handleMaterial,
  toVector3,
  type DragRig,
  type HandleVec3
} from './DragRig';
import { createDimensionGraphic } from '../annotation/dimensionGraphic';

const ARROW_SHAFT_RADIUS = 0.05;
const ARROW_HEAD_RADIUS = 0.14;
const ARROW_HEAD_LENGTH = 0.3;
const ARROW_HALF_LENGTH = 0.75;
const ARROW_HIT_RADIUS = 0.34;
const GHOST_OPACITY = 0.28;

/**
 * The shared drag-arrow affordance: a double-headed arrow centered on the
 * pick point, saying "this adjusts in either direction".
 */
function doubleArrowParts(kind: string): THREE.Mesh[] {
  const solid = handleMaterial();
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(
      ARROW_SHAFT_RADIUS,
      ARROW_SHAFT_RADIUS,
      2 * (ARROW_HALF_LENGTH - ARROW_HEAD_LENGTH),
      12
    ),
    solid
  );
  const headOut = new THREE.Mesh(
    new THREE.ConeGeometry(ARROW_HEAD_RADIUS, ARROW_HEAD_LENGTH, 16),
    solid
  );
  headOut.position.y = ARROW_HALF_LENGTH - ARROW_HEAD_LENGTH / 2;
  const headIn = new THREE.Mesh(
    new THREE.ConeGeometry(ARROW_HEAD_RADIUS, ARROW_HEAD_LENGTH, 16),
    solid
  );
  headIn.rotation.z = Math.PI;
  headIn.position.y = -(ARROW_HALF_LENGTH - ARROW_HEAD_LENGTH / 2);
  const hit = createHitMesh(
    new THREE.CylinderGeometry(
      ARROW_HIT_RADIUS,
      ARROW_HIT_RADIUS,
      2 * ARROW_HALF_LENGTH + 0.3,
      8
    ),
    kind
  );
  return [shaft, headOut, headIn, hit];
}

const EDGE_HANDLE_RADIUS = 0.16;
const EDGE_HIT_RADIUS = 0.65;

/** Pure: where the offset arrow sits and points for a face pick. */
export function offsetHandlePlacement(
  point: HandleVec3,
  normal: HandleVec3
): { origin: HandleVec3; direction: HandleVec3 } {
  const magnitude = Math.hypot(normal.x, normal.y, normal.z) || 1;
  return {
    origin: { x: point.x, y: point.y, z: point.z },
    direction: {
      x: normal.x / magnitude,
      y: normal.y / magnitude,
      z: normal.z / magnitude
    }
  };
}

/** Pure: sphere placement for an edge polyline (xyz-interleaved samples). */
export function edgeHandlePlacement(
  points: number[],
  bodyCenter: HandleVec3
): { origin: HandleVec3; direction: HandleVec3 } | null {
  if (points.length < 6) {
    return null;
  }
  const middle = Math.floor(points.length / 3 / 2) * 3;
  const origin = {
    x: points[middle]!,
    y: points[middle + 1]!,
    z: points[middle + 2]!
  };
  const outward = {
    x: origin.x - bodyCenter.x,
    y: origin.y - bodyCenter.y,
    z: origin.z - bodyCenter.z
  };
  const magnitude = Math.hypot(outward.x, outward.y, outward.z);
  if (magnitude < 1e-9) {
    return { origin, direction: { x: 0, y: 0, z: 1 } };
  }
  return {
    origin,
    direction: {
      x: outward.x / magnitude,
      y: outward.y / magnitude,
      z: outward.z / magnitude
    }
  };
}

export interface OffsetFaceRigParams {
  origin: HandleVec3;
  direction: HandleVec3;
  /** World-space triangles of the face, for the drag ghost (owned by rig). */
  ghostGeometry: THREE.BufferGeometry | null;
}

/**
 * An arrow anchored at the click point on a face, pointing along the face
 * normal, with a dashed leader back to the original position and a
 * translucent ghost of the face carried along during the drag.
 */
export function buildOffsetFaceHandle(params: OffsetFaceRigParams): DragRig {
  const kind = 'offset-face';
  const origin = toVector3(params.origin);
  const direction = toVector3(params.direction).normalize();

  const group = new THREE.Group();
  group.name = `${kind}-handle`;
  group.position.copy(origin);
  group.quaternion.copy(
    new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction
    )
  );

  addHandleParts(group, doubleArrowParts(kind));

  const worldGroup = new THREE.Group();
  worldGroup.name = `${kind}-handle-world`;

  const leaderGeometry = new LineGeometry();
  leaderGeometry.setPositions([
    origin.x,
    origin.y,
    origin.z,
    origin.x,
    origin.y,
    origin.z
  ]);
  const leader = new Line2(
    leaderGeometry,
    new LineMaterial({
      color: HANDLE_COLOR,
      linewidth: 1.5,
      dashed: true,
      dashSize: 2,
      gapSize: 1.5,
      transparent: true,
      opacity: 0.85,
      depthTest: false
    })
  );
  leader.computeLineDistances();
  leader.renderOrder = 29;
  leader.visible = false;
  worldGroup.add(leader);

  let ghost: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null =
    null;
  if (params.ghostGeometry) {
    ghost = new THREE.Mesh(
      params.ghostGeometry,
      new THREE.MeshBasicMaterial({
        color: HANDLE_COLOR,
        transparent: true,
        opacity: GHOST_OPACITY,
        depthTest: false,
        side: THREE.DoubleSide
      })
    );
    ghost.renderOrder = 28;
    ghost.visible = false;
    worldGroup.add(ghost);
  }

  let current = 0;

  return {
    kind,
    group,
    worldGroup,
    origin,
    direction,
    setValue(value: number) {
      current = value;
      const tip = origin.clone().addScaledVector(direction, value);
      group.position.copy(tip);
      const engaged = Math.abs(value) > 1e-9;
      leader.visible = engaged;
      if (engaged) {
        leaderGeometry.setPositions([
          origin.x,
          origin.y,
          origin.z,
          tip.x,
          tip.y,
          tip.z
        ]);
        leader.computeLineDistances();
      }
      if (ghost) {
        ghost.visible = engaged;
        ghost.position.set(
          direction.x * value,
          direction.y * value,
          direction.z * value
        );
      }
    },
    value() {
      return current;
    },
    chipAnchor(gizmoScale: number) {
      // The chip rides just past the arrow head, which has already travelled
      // by `current`.
      const reach =
        current + CHIP_ANCHOR_LOCAL_DISTANCE * Math.max(gizmoScale, 0);
      return origin.clone().addScaledVector(direction, reach);
    },
    dispose() {
      disposeRigGroups(group, worldGroup);
    }
  };
}

export interface CylinderRadiusRigParams {
  /** Pick point on the original cylindrical wall. */
  origin: HandleVec3;
  /** Outward radial unit direction at the pick point. */
  direction: HandleVec3;
  /** Absolute radius represented when the gesture begins. */
  originalRadius: number;
}

/**
 * A dedicated radial-radius handle.
 *
 * Unlike the planar offset rig, this carries no translated face ghost. The
 * exact preview owns the cylinder geometry; this affordance only moves the
 * handle by `newRadius - originalRadius` along the picked radial direction.
 */
export function buildCylinderRadiusHandle(
  params: CylinderRadiusRigParams
): DragRig {
  const kind = 'cylinder-radius';
  const origin = toVector3(params.origin);
  const direction = toVector3(params.direction).normalize();
  const originalRadius = params.originalRadius;

  const group = new THREE.Group();
  group.name = `${kind}-handle`;
  group.position.copy(origin);
  group.quaternion.copy(
    new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction
    )
  );

  addHandleParts(group, doubleArrowParts(kind));

  // The measurement graphic is a radius callout: a dashed line from the axis
  // out to the handle on the wall, with a small arrowhead at each end. It is
  // visible for the whole gesture — the line is what says "this drag edits a
  // radius", not just where the delta went.
  //
  // Shared with the measurement tape rather than written twice. Witness lines
  // are off here: a radius is measured from an axis that has no edge to stand
  // a tick off, and drawing one would invent geometry.
  const worldGroup = new THREE.Group();
  worldGroup.name = `${kind}-handle-world`;
  const axisCenter = origin.clone().addScaledVector(direction, -originalRadius);
  const dimension = createDimensionGraphic();
  worldGroup.add(dimension.object);

  let currentRadius = originalRadius;
  const updateGraphic = () => {
    const radialDelta = currentRadius - originalRadius;
    const tip = origin.clone().addScaledVector(direction, radialDelta);
    group.position.copy(tip);
    // Match the screen-space sizing of the handle, whose scale the viewer
    // stamps on the group each frame.
    const scale = (group.userData.gizmoScale as number | undefined) ?? 1;
    dimension.update(axisCenter, tip, scale);
  };
  updateGraphic();

  return {
    kind,
    group,
    worldGroup,
    origin,
    direction,
    setValue(radius: number) {
      currentRadius = radius;
      updateGraphic();
    },
    value() {
      return currentRadius;
    },
    chipAnchor() {
      // The chip rides the dimension line itself, partway between the axis
      // and the wall, like a drawing's inline radius callout.
      return axisCenter
        .clone()
        .addScaledVector(direction, currentRadius * 0.45);
    },
    dispose() {
      dimension.dispose();
      disposeRigGroups(group, worldGroup);
    }
  };
}

/**
 * A sphere at the reference edge's midpoint. Unlike the offset arrow the
 * visual does not travel: the blend radius grows around the edge, so moving
 * the handle away from it would misreport where the material goes.
 */
export function buildEdgeRadiusHandle(params: {
  origin: HandleVec3;
  direction: HandleVec3;
}): DragRig {
  const kind = 'edge-radius';
  const origin = toVector3(params.origin);
  const direction = toVector3(params.direction).normalize();

  const group = new THREE.Group();
  group.name = `${kind}-handle`;
  group.position.copy(origin);
  // Empty, but still part of the contract: consumers add both groups to the
  // scene, so both have to come back out on dispose.
  const worldGroup = new THREE.Group();
  worldGroup.name = `${kind}-handle-world`;

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(EDGE_HANDLE_RADIUS, 20, 14),
    handleMaterial()
  );
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(EDGE_HANDLE_RADIUS * 1.7, 0.02, 8, 32),
    handleMaterial(0.55)
  );
  const hit = createHitMesh(
    new THREE.SphereGeometry(EDGE_HIT_RADIUS, 8, 6),
    kind
  );
  addHandleParts(group, [sphere, ring, hit]);

  let current = 0;

  return {
    kind,
    group,
    worldGroup,
    origin,
    direction,
    setValue(value: number) {
      current = value;
    },
    value() {
      return current;
    },
    chipAnchor() {
      return origin.clone();
    },
    dispose() {
      disposeRigGroups(group, worldGroup);
    }
  };
}

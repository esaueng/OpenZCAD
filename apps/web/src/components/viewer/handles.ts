import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

/**
 * Selection-first drag handles. The offset rig is an arrow anchored at the
 * click point on a face, pointing along the face normal, with a dashed leader
 * back to the original position and a translucent ghost of the face carried
 * along during the drag.
 *
 * The rig is split into two sibling groups: `group` holds the arrow and is
 * rescaled every frame to stay screen-constant (its position is the world
 * anchor, children are in local pixel-ish units, exactly like the move
 * gizmo); `worldGroup` holds the leader and face ghost, which are true
 * world-space geometry and must never be rescaled. The invisible fat hit
 * mesh inside `group` is what pointer picks test against, tagged
 * `userData.directHandle`.
 */

export interface HandleVec3 {
  x: number;
  y: number;
  z: number;
}

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

export const OFFSET_HANDLE_COLOR = 0x4da3ff;
const ARROW_SHAFT_RADIUS = 0.035;
const ARROW_HEAD_RADIUS = 0.11;
const ARROW_HEAD_LENGTH = 0.3;
const HIT_RADIUS = 0.34;
const GHOST_OPACITY = 0.28;
/** Local distance past the arrow head where the value chip floats. */
export const CHIP_ANCHOR_LOCAL_DISTANCE = 1.3;

export interface OffsetHandleRig {
  /** Screen-constant part (arrow + hit target); rescale this per frame. */
  group: THREE.Group;
  /** World-space part (dashed leader + face ghost); never rescaled. */
  worldGroup: THREE.Group;
  /** Unit drag direction in world space. */
  direction: THREE.Vector3;
  /** Original click point in world space. */
  origin: THREE.Vector3;
  /** Moves the arrow + ghost to the given offset along the normal. */
  setOffset(offset: number): void;
  offset(): number;
  dispose(): void;
}

export interface OffsetHandleParams {
  origin: HandleVec3;
  direction: HandleVec3;
  /** World-space triangles of the face, for the drag ghost (owned by rig). */
  ghostGeometry: THREE.BufferGeometry | null;
}

export function buildOffsetFaceHandle(
  params: OffsetHandleParams
): OffsetHandleRig {
  const origin = new THREE.Vector3(
    params.origin.x,
    params.origin.y,
    params.origin.z
  );
  const direction = new THREE.Vector3(
    params.direction.x,
    params.direction.y,
    params.direction.z
  ).normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction
  );

  const group = new THREE.Group();
  group.name = 'offset-face-handle';
  group.position.copy(origin);
  group.quaternion.copy(quaternion);

  const solid = new THREE.MeshBasicMaterial({
    color: OFFSET_HANDLE_COLOR,
    transparent: true,
    opacity: 0.95,
    depthTest: false
  });
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(
      ARROW_SHAFT_RADIUS,
      ARROW_SHAFT_RADIUS,
      1 - ARROW_HEAD_LENGTH,
      12
    ),
    solid
  );
  shaft.position.y = (1 - ARROW_HEAD_LENGTH) / 2;
  const head = new THREE.Mesh(
    new THREE.ConeGeometry(ARROW_HEAD_RADIUS, ARROW_HEAD_LENGTH, 16),
    solid
  );
  head.position.y = 1 - ARROW_HEAD_LENGTH / 2;
  const hit = new THREE.Mesh(
    new THREE.CylinderGeometry(HIT_RADIUS, HIT_RADIUS, 1.8, 8),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hit.position.y = 0.7;
  hit.userData.directHandle = true;
  hit.userData.handleKind = 'offset-face';
  for (const mesh of [shaft, head, hit]) {
    mesh.renderOrder = 30;
    group.add(mesh);
  }

  const worldGroup = new THREE.Group();
  worldGroup.name = 'offset-face-handle-world';

  const leaderMaterial = new LineMaterial({
    color: OFFSET_HANDLE_COLOR,
    linewidth: 1.5,
    dashed: true,
    dashSize: 2,
    gapSize: 1.5,
    transparent: true,
    opacity: 0.85,
    depthTest: false
  });
  const leaderGeometry = new LineGeometry();
  leaderGeometry.setPositions([
    origin.x,
    origin.y,
    origin.z,
    origin.x,
    origin.y,
    origin.z
  ]);
  const leader = new Line2(leaderGeometry, leaderMaterial);
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
        color: OFFSET_HANDLE_COLOR,
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

  let currentOffset = 0;

  return {
    group,
    worldGroup,
    direction,
    origin,
    setOffset(offset: number) {
      currentOffset = offset;
      const tip = origin.clone().addScaledVector(direction, offset);
      group.position.copy(tip);
      const engagedVisible = Math.abs(offset) > 1e-9;
      leader.visible = engagedVisible;
      if (engagedVisible) {
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
        ghost.visible = engagedVisible;
        ghost.position.set(
          direction.x * offset,
          direction.y * offset,
          direction.z * offset
        );
      }
    },
    offset() {
      return currentOffset;
    },
    dispose() {
      group.removeFromParent();
      worldGroup.removeFromParent();
      for (const container of [group, worldGroup]) {
        container.traverse((child) => {
          if (child instanceof THREE.Mesh || child instanceof Line2) {
            (child.geometry as THREE.BufferGeometry).dispose();
            (child.material as THREE.Material).dispose();
          }
        });
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Edge radius handle
// ---------------------------------------------------------------------------

const EDGE_HANDLE_RADIUS = 0.16;
const EDGE_HIT_RADIUS = 0.65;

export interface EdgeHandleRig {
  /** Screen-constant sphere + hit target; rescaled per frame. */
  group: THREE.Group;
  /** Sphere position: the reference edge's midpoint. */
  origin: THREE.Vector3;
  /** World direction a drag increases the radius along (radially out). */
  direction: THREE.Vector3;
  setValue(value: number): void;
  value(): number;
  dispose(): void;
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

export function buildEdgeRadiusHandle(params: {
  origin: HandleVec3;
  direction: HandleVec3;
}): EdgeHandleRig {
  const origin = new THREE.Vector3(
    params.origin.x,
    params.origin.y,
    params.origin.z
  );
  const direction = new THREE.Vector3(
    params.direction.x,
    params.direction.y,
    params.direction.z
  ).normalize();

  const group = new THREE.Group();
  group.name = 'edge-radius-handle';
  group.position.copy(origin);

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(EDGE_HANDLE_RADIUS, 20, 14),
    new THREE.MeshBasicMaterial({
      color: OFFSET_HANDLE_COLOR,
      transparent: true,
      opacity: 0.95,
      depthTest: false
    })
  );
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(EDGE_HANDLE_RADIUS * 1.7, 0.02, 8, 32),
    new THREE.MeshBasicMaterial({
      color: OFFSET_HANDLE_COLOR,
      transparent: true,
      opacity: 0.55,
      depthTest: false
    })
  );
  const hit = new THREE.Mesh(
    new THREE.SphereGeometry(EDGE_HIT_RADIUS, 8, 6),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  hit.userData.directHandle = true;
  hit.userData.handleKind = 'edge-radius';
  for (const mesh of [sphere, ring, hit]) {
    mesh.renderOrder = 30;
    group.add(mesh);
  }
  // The ring faces the camera-ish: leave it screen-billboarded by lookAt in
  // the render loop if desired; a static orientation reads fine at this size.

  let current = 0;
  return {
    group,
    origin,
    direction,
    setValue(value: number) {
      current = value;
    },
    value() {
      return current;
    },
    dispose() {
      group.removeFromParent();
      group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          (child.geometry as THREE.BufferGeometry).dispose();
          (child.material as THREE.Material).dispose();
        }
      });
    }
  };
}

/** Pure: the world point the value chip should track. */
export function offsetChipAnchor(
  origin: HandleVec3,
  direction: HandleVec3,
  offset: number,
  gizmoScale: number
): HandleVec3 {
  const reach = offset + CHIP_ANCHOR_LOCAL_DISTANCE * Math.max(gizmoScale, 0);
  return {
    x: origin.x + direction.x * reach,
    y: origin.y + direction.y * reach,
    z: origin.z + direction.z * reach
  };
}

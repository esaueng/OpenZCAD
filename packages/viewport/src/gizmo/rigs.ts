import * as THREE from 'three';
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
import { ANALYTIC_GHOST_COLOR } from '../selection/analyticCylinderGhost';
import { easeToward, hasSettled } from '../motion';
import { SELECTION_SEMANTICS } from '../render/semantics';

const ARROW_SHAFT_RADIUS = 0.05;
const ARROW_HEAD_RADIUS = 0.14;
const ARROW_HEAD_LENGTH = 0.3;
const ARROW_HALF_LENGTH = 0.75;
const ARROW_HIT_RADIUS = 0.34;
const GHOST_OPACITY = 0.28;
export const HANDLE_WARNING_COLOR = SELECTION_SEMANTICS.handle.invalid;
/** The handle under the pointer, so "grabbable" is visible before pressing. */
const HANDLE_HOT_COLOR = SELECTION_SEMANTICS.handle.hot;
/**
 * The eased presence and hover state every drag rig shares.
 *
 * A rig used to appear at full strength on the frame it armed, and looked
 * identical whether or not the pointer was over it — so nothing said it could
 * be grabbed until it was already being dragged. Both are ramps now, stepped
 * by the render loop.
 *
 * The entrance is opacity only. Scaling a rig in would also scale its hit
 * mesh, so the handle's grab target would be smaller than it looks for the
 * length of the animation — a press landing just outside it would do nothing,
 * or worse, select the face behind it.
 */
function createRigPresence(roots: readonly THREE.Object3D[]) {
  const materials = new Map<THREE.Material, number>();
  for (const root of roots) {
    root.traverse((child) => {
      const material = (child as THREE.Mesh).material;
      if (material && !Array.isArray(material)) {
        if (!materials.has(material)) {
          material.transparent = true;
          materials.set(material, material.opacity);
        }
      }
    });
  }
  let presence = 0;
  let presenceTarget = 1;
  let hot = 0;
  let hotTarget = 0;
  const apply = () => {
    for (const [material, baseOpacity] of materials) {
      material.opacity = baseOpacity * presence;
    }
  };
  apply();
  return {
    /** Advances both ramps. True while either is still moving. */
    step(dtMs: number): boolean {
      const moving =
        !hasSettled(presence, presenceTarget) || !hasSettled(hot, hotTarget);
      if (!moving) {
        return false;
      }
      presence = easeToward(presence, presenceTarget, dtMs);
      hot = easeToward(hot, hotTarget, dtMs);
      apply();
      return true;
    },
    /** Starts the rig leaving; it stops being hot on the way out. */
    beginExit() {
      presenceTarget = 0;
      hotTarget = 0;
    },
    /** True once an exiting rig has finished leaving and can be disposed. */
    isGone(): boolean {
      return presenceTarget === 0 && hasSettled(presence, 0);
    },
    setHot(next: boolean) {
      hotTarget = next ? 1 : 0;
    },
    hotness(): number {
      return hot;
    },
    /** Re-reads base opacities after a material's own opacity changed. */
    rebase(material: THREE.Material, opacity: number) {
      materials.set(material, opacity);
    }
  };
}

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
  /** World-space triangles of the face, kept as the original-position reference. */
  ghostGeometry: THREE.BufferGeometry | null;
  /**
   * A profile to sweep along the drag direction instead of a flat ghost. The
   * rig extrudes it by the current value every frame, so the volume the
   * gesture adds or removes tracks the hand while the exact kernel catches up.
   */
  sweep?: SweepGhostParams;
}

export interface SweepGhostParams {
  /** World-space cap triangulation lying on the profile's plane. */
  cap: { positions: ArrayLike<number>; indices: ArrayLike<number> };
  /**
   * World-space boundary loops — outer first, then holes — each an ordered
   * closed polyline without a repeated end point. They become the walls.
   */
  loops: HandleVec3[][];
}

/**
 * Pure: vertex layout for a swept profile. Base copies first, then every
 * vertex again for the moving end, so an update only rewrites the top half.
 */
export function sweepGhostLayout(params: SweepGhostParams): {
  base: Float32Array;
  indices: number[];
  /** For each moving vertex, its index and the index of the base vertex it follows. */
  moving: Array<{ top: number; base: number }>;
} {
  const capCount = Math.floor(params.cap.positions.length / 3);
  const ringTotal = params.loops.reduce((sum, loop) => sum + loop.length, 0);
  const vertexCount = capCount * 2 + ringTotal * 2;
  const base = new Float32Array(vertexCount * 3);
  const indices: number[] = [];
  const moving: Array<{ top: number; base: number }> = [];

  for (let i = 0; i < capCount * 3; i += 1) {
    base[i] = params.cap.positions[i] ?? 0;
    base[capCount * 3 + i] = params.cap.positions[i] ?? 0;
  }
  for (let i = 0; i < capCount; i += 1) {
    moving.push({ top: capCount + i, base: i });
  }
  for (let i = 0; i < params.cap.indices.length; i += 1) {
    indices.push(params.cap.indices[i] ?? 0);
  }
  for (let i = 0; i < params.cap.indices.length; i += 1) {
    indices.push((params.cap.indices[i] ?? 0) + capCount);
  }

  let cursor = capCount * 2;
  for (const loop of params.loops) {
    const count = loop.length;
    if (count < 2) {
      continue;
    }
    for (let k = 0; k < count; k += 1) {
      const point = loop[k]!;
      const baseIndex = cursor + k;
      const topIndex = cursor + count + k;
      base[baseIndex * 3] = point.x;
      base[baseIndex * 3 + 1] = point.y;
      base[baseIndex * 3 + 2] = point.z;
      base[topIndex * 3] = point.x;
      base[topIndex * 3 + 1] = point.y;
      base[topIndex * 3 + 2] = point.z;
      moving.push({ top: topIndex, base: baseIndex });
    }
    for (let k = 0; k < count; k += 1) {
      const a = cursor + k;
      const b = cursor + ((k + 1) % count);
      const c = cursor + count + k;
      const d = cursor + count + ((k + 1) % count);
      indices.push(a, b, d, a, d, c);
    }
    cursor += count * 2;
  }
  return { base, indices, moving };
}

function createSweepGhost(
  params: SweepGhostParams,
  direction: THREE.Vector3
): {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  update(value: number): void;
} {
  const layout = sweepGhostLayout(params);
  const positions = new Float32Array(layout.base);
  const attribute = new THREE.BufferAttribute(positions, 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', attribute);
  geometry.setIndex(layout.indices);
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: ANALYTIC_GHOST_COLOR,
      transparent: true,
      opacity: GHOST_OPACITY,
      depthTest: false,
      side: THREE.DoubleSide
    })
  );
  // The bounding sphere would need recomputing every frame; the ghost is
  // small and short-lived, so skip culling instead.
  mesh.frustumCulled = false;
  mesh.renderOrder = 28;
  mesh.visible = false;
  return {
    mesh,
    update(value: number) {
      for (const { top, base } of layout.moving) {
        positions[top * 3] = layout.base[base * 3]! + direction.x * value;
        positions[top * 3 + 1] = layout.base[base * 3 + 1]! + direction.y * value;
        positions[top * 3 + 2] = layout.base[base * 3 + 2]! + direction.z * value;
      }
      attribute.needsUpdate = true;
    }
  };
}

/**
 * An arrow anchored at the click point on a face, pointing along the face
 * normal, with a dashed leader back to the original position and a
 * translucent ghost that marks the face's original position during the drag.
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

  const arrowParts = doubleArrowParts(kind);
  addHandleParts(group, arrowParts);

  const worldGroup = new THREE.Group();
  worldGroup.name = `${kind}-handle-world`;

  const dimension = createDimensionGraphic({
    color: HANDLE_COLOR,
    linewidth: 1.5,
    opacity: 0.85,
    renderOrder: 29
  });
  dimension.object.visible = false;
  worldGroup.add(dimension.object);

  const sweep = params.sweep ? createSweepGhost(params.sweep, direction) : null;
  if (sweep) {
    worldGroup.add(sweep.mesh);
  }

  let ghost: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null =
    null;
  if (params.ghostGeometry) {
    ghost = new THREE.Mesh(
      params.ghostGeometry,
      new THREE.MeshBasicMaterial({
        color: ANALYTIC_GHOST_COLOR,
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
  let warned = false;
  const presence = createRigPresence([group, worldGroup]);

  /**
   * Warning wins over hover: a value the kernel will refuse must not be
   * softened into looking merely interactive.
   */
  const paintArrows = () => {
    const color = warned
      ? new THREE.Color(HANDLE_WARNING_COLOR)
      : new THREE.Color(HANDLE_COLOR).lerp(
          new THREE.Color(HANDLE_HOT_COLOR),
          presence.hotness()
        );
    for (const part of arrowParts) {
      if (
        part.material instanceof THREE.MeshBasicMaterial &&
        part.material.visible
      ) {
        part.material.color.copy(color);
      }
    }
    return color;
  };

  return {
    kind,
    group,
    worldGroup,
    origin,
    direction,
    step(dtMs: number) {
      if (!presence.step(dtMs)) {
        return false;
      }
      paintArrows();
      return true;
    },
    setHot(hot: boolean) {
      presence.setHot(hot);
    },
    beginExit() {
      presence.beginExit();
    },
    isGone() {
      return presence.isGone();
    },
    setValue(value: number) {
      current = value;
      const tip = origin.clone().addScaledVector(direction, value);
      group.position.copy(tip);
      const engaged = Math.abs(value) > 1e-9;
      dimension.object.visible = engaged;
      if (engaged) {
        const scale = (group.userData.gizmoScale as number | undefined) ?? 1;
        dimension.update(origin, tip, scale);
      }
      if (ghost) {
        ghost.visible = engaged;
      }
      if (sweep) {
        sweep.mesh.visible = engaged;
        if (engaged) {
          sweep.update(value);
        }
      }
    },
    value() {
      return current;
    },
    setWarning(warning) {
      warned = warning;
      dimension.setColor(paintArrows().getHex());
      group.userData.previewWarning = warning;
    },
    chipAnchor(gizmoScale: number) {
      // The chip rides just past the arrow head, which has already travelled
      // by `current`.
      const reach =
        current + CHIP_ANCHOR_LOCAL_DISTANCE * Math.max(gizmoScale, 0);
      return origin.clone().addScaledVector(direction, reach);
    },
    dispose() {
      dimension.dispose();
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

  const cylinderArrowParts = doubleArrowParts(kind);
  addHandleParts(group, cylinderArrowParts);

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
  const presence = createRigPresence([group, worldGroup]);
  const paintParts = () => {
    const color = new THREE.Color(HANDLE_COLOR).lerp(
      new THREE.Color(HANDLE_HOT_COLOR),
      presence.hotness()
    );
    for (const part of cylinderArrowParts) {
      if (
        part.material instanceof THREE.MeshBasicMaterial &&
        part.material.visible
      ) {
        part.material.color.copy(color);
      }
    }
  };

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
    step(dtMs: number) {
      if (!presence.step(dtMs)) {
        return false;
      }
      paintParts();
      return true;
    },
    setHot(hot: boolean) {
      presence.setHot(hot);
    },
    beginExit() {
      presence.beginExit();
    },
    isGone() {
      return presence.isGone();
    },
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
  ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
  const hit = createHitMesh(
    new THREE.SphereGeometry(EDGE_HIT_RADIUS, 8, 6),
    kind
  );
  addHandleParts(group, [sphere, ring, hit]);

  const presence = createRigPresence([group, worldGroup]);
  let warned = false;
  // Warning wins over hover, as on the offset rig: a radius the kernel refuses
  // must not read as merely interactive while the hand is still on it.
  const paintParts = () => {
    const color = warned
      ? new THREE.Color(HANDLE_WARNING_COLOR)
      : new THREE.Color(HANDLE_COLOR).lerp(
          new THREE.Color(HANDLE_HOT_COLOR),
          presence.hotness()
        );
    for (const part of [sphere, ring]) {
      if (
        part.material instanceof THREE.MeshBasicMaterial &&
        part.material.visible
      ) {
        part.material.color.copy(color);
      }
    }
  };

  let current = 0;

  return {
    kind,
    group,
    worldGroup,
    origin,
    direction,
    step(dtMs: number) {
      if (!presence.step(dtMs)) {
        return false;
      }
      paintParts();
      return true;
    },
    setHot(hot: boolean) {
      presence.setHot(hot);
    },
    beginExit() {
      presence.beginExit();
    },
    isGone() {
      return presence.isGone();
    },
    setValue(value: number) {
      current = value;
    },
    value() {
      return current;
    },
    setWarning(warning) {
      warned = warning;
      paintParts();
      group.userData.previewWarning = warning;
    },
    chipAnchor() {
      return origin.clone();
    },
    dispose() {
      disposeRigGroups(group, worldGroup);
    }
  };
}

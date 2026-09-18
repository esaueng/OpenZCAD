import * as THREE from 'three';
import {
  HANDLE_COLOR,
  HANDLE_RENDER_ORDER,
  addHandleParts,
  createHitMesh,
  disposeRigGroups,
  handleMaterial,
  toVector3,
  type DragRig,
  type HandleVec3
} from './DragRig';
import {
  DIMENSION_LINE_COLOR,
  createDimensionGraphic
} from '../annotation/dimensionGraphic';
import { ANALYTIC_GHOST_COLOR } from '../selection/analyticCylinderGhost';
import { easeToward, hasSettled } from '../motion';
import { SELECTION_SEMANTICS } from '../render/semantics';

const ARROW_HEAD_LENGTH = 0.22;
const ARROW_HALF_LENGTH = 0.5;
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
    /**
     * Re-reads a material's base opacity and applies it at the current
     * presence at once, so a change made between animation frames shows.
     */
    rebase(material: THREE.Material, opacity: number) {
      materials.set(material, opacity);
      material.opacity = opacity * presence;
    }
  };
}

const PIN_HALO_OPACITY = 0.16;
/**
 * How far short of the handle's centre a dimension line stops, in rig
 * units: the arrow's half-length plus a little air, so the line's own white
 * head never sits under the blue arrow.
 */
const DIMENSION_CLEARANCE = ARROW_HALF_LENGTH + 0.18;
/** Solid arrow proportions, in rig units the viewer rescales per frame. */
const PIN_SHAFT_RADIUS = 0.05;
const PIN_HEAD_RADIUS = 0.17;
/** The ring lying in the face plane around the pick point. */
const PIN_RING_INNER = 0.13;
const PIN_RING_OUTER = 0.17;
const PIN_RING_OPACITY = 0.95;
/**
 * The ring fades in as the view turns to look down the normal: below this
 * much of the normal lying across the screen it is fully shown, and it is
 * gone once twice this much lies across.
 */
const PIN_RING_FADE_START = 0.25;

/** The lit lavender every handle shares; shading does the outlining. */
function pinMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: HANDLE_COLOR,
    emissive: HANDLE_COLOR,
    emissiveIntensity: 0.18,
    roughness: 0.55,
    metalness: 0.05,
    transparent: true,
    opacity: 1,
    depthTest: false
  });
}

/**
 * The pin: a solid double-headed arrow standing on the face normal — a
 * shaft with a cone at each end, lit by the scene so it reads as an object
 * from any angle without an outline — and a ring lying in the face plane
 * that fades in as the view turns to look down the normal, where the arrow
 * is only a cone tip.
 *
 * It draws over the model (no depth test), so its three solids are ordered
 * by distance to the camera every frame (`orderByDepth`): the far cone must
 * not paint over the near end of the shaft.
 */
function solidPinParts(kind: string): {
  arrow: THREE.Mesh[];
  /** The shaft and the two cones, for per-frame depth ordering. */
  solids: THREE.Mesh[];
  halo: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  ringMaterial: THREE.MeshBasicMaterial;
  hit: THREE.Mesh;
} {
  const material = pinMaterial();
  const shaftLength = 2 * (ARROW_HALF_LENGTH - ARROW_HEAD_LENGTH);
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(
      PIN_SHAFT_RADIUS,
      PIN_SHAFT_RADIUS,
      shaftLength,
      24
    ),
    material
  );
  const headOut = new THREE.Mesh(
    new THREE.ConeGeometry(PIN_HEAD_RADIUS, ARROW_HEAD_LENGTH, 32),
    material
  );
  headOut.position.y = ARROW_HALF_LENGTH - ARROW_HEAD_LENGTH / 2;
  const headIn = new THREE.Mesh(
    new THREE.ConeGeometry(PIN_HEAD_RADIUS, ARROW_HEAD_LENGTH, 32),
    material
  );
  headIn.rotation.z = Math.PI;
  headIn.position.y = -(ARROW_HALF_LENGTH - ARROW_HEAD_LENGTH / 2);
  // Local +Y is the normal, so the face plane is local XZ. The ring has its
  // own material because it fades with the view angle while the arrow does
  // not; it starts hidden and the rig's `orient` brings it up.
  const ringMaterial = handleMaterial(PIN_RING_OPACITY);
  ringMaterial.side = THREE.DoubleSide;
  ringMaterial.opacity = 0;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(PIN_RING_INNER, PIN_RING_OUTER, 40),
    ringMaterial
  );
  ring.rotation.x = -Math.PI / 2;
  const halo = new THREE.Mesh(
    new THREE.CircleGeometry(0.5, 32),
    new THREE.MeshBasicMaterial({
      color: HANDLE_HOT_COLOR,
      transparent: true,
      opacity: 0,
      depthTest: false,
      side: THREE.DoubleSide
    })
  );
  const hit = createHitMesh(
    new THREE.CylinderGeometry(
      ARROW_HIT_RADIUS,
      ARROW_HIT_RADIUS,
      2 * ARROW_HALF_LENGTH + 0.3,
      8
    ),
    kind
  );
  return {
    arrow: [shaft, headOut, headIn, ring],
    solids: [shaft, headOut, headIn],
    halo,
    ringMaterial,
    hit
  };
}

/**
 * Draws the farthest solid first. Without a depth test the draw order is
 * the only thing keeping a cone behind the shaft from painting over it.
 */
function orderByDepth(solids: THREE.Mesh[], camera: THREE.Camera): void {
  const position = new THREE.Vector3();
  const byDistance = solids
    .map((mesh) => ({
      mesh,
      distance: mesh.getWorldPosition(position).distanceTo(camera.position)
    }))
    .sort((a, b) => b.distance - a.distance);
  byDistance.forEach(({ mesh }, index) => {
    mesh.renderOrder = HANDLE_RENDER_ORDER + index;
  });
}

/**
 * Keeps local +Y on `direction` and rolls the pin about it so its flat face
 * turns toward the camera. The arrow therefore stays on the face normal from
 * every viewpoint; only its roll follows the view. Looking straight down the
 * normal there is no roll to prefer, and any one will do: the arrow is a
 * point then and the ring carries the affordance.
 *
 * Returns how much of the normal lies across the screen, 0 when the view
 * looks straight down it and 1 when it lies flat in the screen plane.
 */
function orientPin(
  group: THREE.Group,
  direction: THREE.Vector3,
  camera: THREE.Camera
): number {
  const toCamera = new THREE.Vector3();
  if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    camera.getWorldDirection(toCamera).negate();
  } else {
    toCamera.copy(camera.position).sub(group.position).normalize();
  }
  const up = direction.clone().normalize();
  const facing = toCamera.clone().addScaledVector(up, -up.dot(toCamera));
  const across = facing.length();
  if (across < 1e-3) {
    const seed =
      Math.abs(up.z) < 0.9
        ? new THREE.Vector3(0, 0, 1)
        : new THREE.Vector3(1, 0, 0);
    facing.crossVectors(up, seed);
  }
  facing.normalize();
  const right = new THREE.Vector3().crossVectors(up, facing).normalize();
  group.quaternion.setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(right, up, facing)
  );
  return across;
}

/** 1 looking down the normal, 0 once it lies well across the screen. */
function ringPresenceFor(across: number): number {
  return THREE.MathUtils.clamp(
    (2 * PIN_RING_FADE_START - across) / PIN_RING_FADE_START,
    0,
    1
  );
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
   * How far the body reaches behind the face along the normal. With it the
   * rig draws its dimension for the whole span, far side to handle, from
   * the moment it arms — the height this face sets — rather than only the
   * delta of a drag in progress.
   */
  extentBehind?: number;
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
        positions[top * 3 + 1] =
          layout.base[base * 3 + 1]! + direction.y * value;
        positions[top * 3 + 2] =
          layout.base[base * 3 + 2]! + direction.z * value;
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

  const pin = solidPinParts(kind);
  const arrowParts = [...pin.arrow, pin.hit];
  addHandleParts(group, arrowParts);
  addHandleParts(group, [pin.halo]);
  pin.halo.renderOrder = HANDLE_RENDER_ORDER - 1;

  const worldGroup = new THREE.Group();
  worldGroup.name = `${kind}-handle-world`;

  // Drawing white, like every other dimension: the handle is the coloured
  // thing, the measurement is the annotation.
  const dimension = createDimensionGraphic({
    color: DIMENSION_LINE_COLOR,
    linewidth: 1.5,
    opacity: 0.9,
    renderOrder: 29
  });
  dimension.object.visible = false;
  worldGroup.add(dimension.object);
  const extentBehind =
    params.extentBehind !== undefined &&
    Number.isFinite(params.extentBehind) &&
    params.extentBehind > 1e-9
      ? params.extentBehind
      : null;
  const farPoint =
    extentBehind === null
      ? null
      : origin.clone().addScaledVector(direction, -extentBehind);

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
      if (part.material instanceof THREE.MeshStandardMaterial) {
        part.material.color.copy(color);
        part.material.emissive.copy(color);
      } else if (
        part.material instanceof THREE.MeshBasicMaterial &&
        part.material.visible
      ) {
        part.material.color.copy(color);
      }
    }
    return color;
  };

  const rig: DragRig = {
    kind,
    group,
    worldGroup,
    origin,
    direction,
    step(dtMs: number) {
      if (!presence.step(dtMs)) {
        return false;
      }
      // The halo is hover feedback only: it grows with hotness and the
      // presence ramp then scales it with everything else.
      presence.rebase(pin.halo.material, PIN_HALO_OPACITY * presence.hotness());
      paintArrows();
      return true;
    },
    setHot(hot: boolean) {
      presence.setHot(hot);
    },
    orient(camera: THREE.Camera) {
      const across = orientPin(group, direction, camera);
      presence.rebase(
        pin.ringMaterial,
        PIN_RING_OPACITY * ringPresenceFor(across)
      );
      orderByDepth(pin.solids, camera);
      dimension.orient(camera);
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
      const scale = (group.userData.gizmoScale as number | undefined) ?? 1;
      // The line ends short of the handle, its head pointing at the arrow
      // rather than sitting under it.
      const lineEnd = tip
        .clone()
        .addScaledVector(direction, -DIMENSION_CLEARANCE * scale);
      if (farPoint) {
        // The whole span, drawn from the moment the rig arms, as long as
        // there is still room for the line once it clears the handle.
        const room = lineEnd.clone().sub(farPoint).dot(direction) > 0;
        dimension.object.visible = room;
        if (room) {
          dimension.update(farPoint, lineEnd, scale);
        }
      } else {
        // The delta of a drag in progress, once it is longer than the gap.
        const room =
          engaged &&
          lineEnd.clone().sub(origin).dot(direction) * Math.sign(value) > 0;
        dimension.object.visible = room;
        if (room) {
          dimension.update(origin, lineEnd, scale);
        }
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
      paintArrows();
      dimension.setColor(warning ? HANDLE_WARNING_COLOR : DIMENSION_LINE_COLOR);
      group.userData.previewWarning = warning;
    },
    chipAnchor() {
      const tip = origin.clone().addScaledVector(direction, current);
      if (farPoint) {
        // Midway along the span, like a drawing's dimension text.
        return farPoint.clone().lerp(tip, 0.5);
      }
      // The pin's own centre: the viewport offsets the chip beside it in
      // screen pixels, so a foreshortened direction can never fold the chip
      // back onto the arrow head.
      return tip;
    },
    chipLine() {
      if (!farPoint) {
        return null;
      }
      return {
        start: farPoint.clone(),
        end: origin.clone().addScaledVector(direction, current)
      };
    },
    dispose() {
      dimension.dispose();
      disposeRigGroups(group, worldGroup);
    }
  };
  // Lay out the resting state now: with a known span the dimension is part
  // of the handle from the first frame, not something a drag reveals.
  rig.setValue(0);
  return rig;
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

  // The same flat pin as the offset rig, pointing along the radial direction
  // and turned to face the camera each frame.
  const pin = solidPinParts(kind);
  const cylinderArrowParts = [...pin.arrow, pin.hit];
  addHandleParts(group, cylinderArrowParts);
  addHandleParts(group, [pin.halo]);
  pin.halo.renderOrder = HANDLE_RENDER_ORDER - 1;

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
      if (part.material instanceof THREE.MeshStandardMaterial) {
        part.material.color.copy(color);
        part.material.emissive.copy(color);
      } else if (
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
    // Stops short of the handle so the line's head stays clear of the arrow.
    const lineEnd = tip
      .clone()
      .addScaledVector(direction, -DIMENSION_CLEARANCE * scale);
    const room = lineEnd.clone().sub(axisCenter).dot(direction) > 0;
    dimension.object.visible = room;
    if (room) {
      dimension.update(axisCenter, lineEnd, scale);
    }
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
      presence.rebase(pin.halo.material, PIN_HALO_OPACITY * presence.hotness());
      paintParts();
      return true;
    },
    setHot(hot: boolean) {
      presence.setHot(hot);
    },
    orient(camera: THREE.Camera) {
      const across = orientPin(group, direction, camera);
      presence.rebase(
        pin.ringMaterial,
        PIN_RING_OPACITY * ringPresenceFor(across)
      );
      orderByDepth(pin.solids, camera);
      dimension.orient(camera);
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
    chipLine() {
      return {
        start: axisCenter.clone(),
        end: axisCenter.clone().addScaledVector(direction, currentRadius)
      };
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

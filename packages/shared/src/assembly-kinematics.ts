import type { Vector3 } from './index';
import {
  ASSEMBLY_JOINT_DOFS,
  type AssemblyDofLimit,
  type AssemblyEasing,
  type AssemblyFrame,
  type AssemblyJoint,
  type AssemblyJointKind,
  type AssemblyMotionStudy,
  type AssemblyPlacement,
  type AssemblyPlayback,
  type AssemblyQuaternion,
  type AssemblySet,
  type AssemblyTrack
} from './assembly';
import { coupledDofLimit, coupledJointValues } from './assembly-coupling';

/**
 * Assembly kinematics (AS02/AS06/AS07). Exact forward kinematics over a
 * spanning tree of the joint graph, rooted at the grounded components:
 *
 *   pose(child) = pose(parent) · F_parent · M(values) · F_child⁻¹
 *
 * where F is a joint end's frame and M the joint's motion in the parent
 * frame. A joint that would close a loop is reported, never silently
 * dropped; closed-loop solving is a later, separate solver (AS09).
 * Coupled joint values (meshed gears, schema v55) are settled first, as
 * plain numbers, so the tree is then placed exactly as before.
 * Everything here is deterministic: traversal follows the stored orders.
 */

export interface RigidTransform {
  /** Translation, mm. */
  t: Vector3;
  /** Unit rotation. */
  q: AssemblyQuaternion;
}

const DEG = Math.PI / 180;

export const IDENTITY_QUATERNION: AssemblyQuaternion = {
  x: 0,
  y: 0,
  z: 0,
  w: 1
};
export const IDENTITY_TRANSFORM: RigidTransform = {
  t: { x: 0, y: 0, z: 0 },
  q: IDENTITY_QUATERNION
};

/** Two joint frames count as coincident within these (mm, and 1 − |cos|). */
export const ASSEMBLY_COINCIDENT_LINEAR_TOLERANCE = 1e-3;
export const ASSEMBLY_COINCIDENT_ANGULAR_TOLERANCE = 1e-9;

// ── Vectors and quaternions ─────────────────────────────────────────────

function vec(x: number, y: number, z: number): Vector3 {
  return { x, y, z };
}

export function dot3(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross3(a: Vector3, b: Vector3): Vector3 {
  return vec(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x
  );
}

function add3(a: Vector3, b: Vector3): Vector3 {
  return vec(a.x + b.x, a.y + b.y, a.z + b.z);
}

function sub3(a: Vector3, b: Vector3): Vector3 {
  return vec(a.x - b.x, a.y - b.y, a.z - b.z);
}

function scale3(a: Vector3, s: number): Vector3 {
  return vec(a.x * s, a.y * s, a.z * s);
}

function normalize3(a: Vector3): Vector3 | null {
  const length = Math.hypot(a.x, a.y, a.z);
  if (!(length > 1e-12) || !Number.isFinite(length)) return null;
  return scale3(a, 1 / length);
}

export function multiplyQuaternions(
  a: AssemblyQuaternion,
  b: AssemblyQuaternion
): AssemblyQuaternion {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  };
}

function conjugate(q: AssemblyQuaternion): AssemblyQuaternion {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** Unit length with w ≥ 0, so one rotation has one stored form. */
export function normalizeQuaternion(q: AssemblyQuaternion): AssemblyQuaternion {
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  if (!(length > 1e-12)) return IDENTITY_QUATERNION;
  const s = (q.w < 0 ? -1 : 1) / length;
  return { x: q.x * s, y: q.y * s, z: q.z * s, w: q.w * s };
}

export function rotateVector(q: AssemblyQuaternion, v: Vector3): Vector3 {
  // v' = v + 2w(u × v) + 2u × (u × v), u the vector part.
  const u = vec(q.x, q.y, q.z);
  const uv = cross3(u, v);
  const uuv = cross3(u, uv);
  return add3(v, add3(scale3(uv, 2 * q.w), scale3(uuv, 2)));
}

export function axisAngleQuaternion(
  axis: Vector3,
  angleRad: number
): AssemblyQuaternion {
  const unit = normalize3(axis);
  if (!unit) return IDENTITY_QUATERNION;
  const s = Math.sin(angleRad / 2);
  return {
    x: unit.x * s,
    y: unit.y * s,
    z: unit.z * s,
    w: Math.cos(angleRad / 2)
  };
}

/** Rotation whose columns are the given orthonormal axes. */
function quaternionFromAxes(
  x: Vector3,
  y: Vector3,
  z: Vector3
): AssemblyQuaternion {
  const m00 = x.x,
    m01 = y.x,
    m02 = z.x;
  const m10 = x.y,
    m11 = y.y,
    m12 = z.y;
  const m20 = x.z,
    m21 = y.z,
    m22 = z.z;
  const trace = m00 + m11 + m22;
  let q: AssemblyQuaternion;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = {
      w: 0.25 / s,
      x: (m21 - m12) * s,
      y: (m02 - m20) * s,
      z: (m10 - m01) * s
    };
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = {
      w: (m21 - m12) / s,
      x: 0.25 * s,
      y: (m01 + m10) / s,
      z: (m02 + m20) / s
    };
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = {
      w: (m02 - m20) / s,
      x: (m01 + m10) / s,
      y: 0.25 * s,
      z: (m12 + m21) / s
    };
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = {
      w: (m10 - m01) / s,
      x: (m02 + m20) / s,
      y: (m12 + m21) / s,
      z: 0.25 * s
    };
  }
  return normalizeQuaternion(q);
}

// ── Rigid transforms ────────────────────────────────────────────────────

export function composeTransforms(
  a: RigidTransform,
  b: RigidTransform
): RigidTransform {
  return {
    q: normalizeQuaternion(multiplyQuaternions(a.q, b.q)),
    t: add3(a.t, rotateVector(a.q, b.t))
  };
}

export function invertTransform(a: RigidTransform): RigidTransform {
  const q = conjugate(a.q);
  return { q, t: scale3(rotateVector(q, a.t), -1) };
}

export function transformPoint(a: RigidTransform, p: Vector3): Vector3 {
  return add3(a.t, rotateVector(a.q, p));
}

export function placementToTransform(
  placement: AssemblyPlacement
): RigidTransform {
  return {
    t: placement.translation,
    q: normalizeQuaternion(placement.rotation)
  };
}

export function transformToPlacement(
  transform: RigidTransform
): AssemblyPlacement {
  return {
    translation: { ...transform.t },
    rotation: normalizeQuaternion(transform.q)
  };
}

export const IDENTITY_PLACEMENT: AssemblyPlacement =
  transformToPlacement(IDENTITY_TRANSFORM);

/** Column-major 4×4, as three.js `Matrix4.fromArray` reads it. */
export function transformToMatrix4(a: RigidTransform): number[] {
  const { x, y, z, w } = a.q;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y + z * w),
    2 * (x * z - y * w),
    0,
    2 * (x * y - z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z + x * w),
    0,
    2 * (x * z + y * w),
    2 * (y * z - x * w),
    1 - 2 * (x * x + y * y),
    0,
    a.t.x,
    a.t.y,
    a.t.z,
    1
  ];
}

export function isIdentityTransform(
  a: RigidTransform,
  tolerance = 1e-9
): boolean {
  return (
    Math.hypot(a.t.x, a.t.y, a.t.z) <= tolerance &&
    Math.hypot(a.q.x, a.q.y, a.q.z) <= tolerance
  );
}

// ── Frames ──────────────────────────────────────────────────────────────

export function frameYAxis(frame: AssemblyFrame): Vector3 {
  return cross3(frame.zAxis, frame.xAxis);
}

export function frameToTransform(frame: AssemblyFrame): RigidTransform {
  return {
    t: frame.origin,
    q: quaternionFromAxes(frame.xAxis, frameYAxis(frame), frame.zAxis)
  };
}

export function transformToFrame(transform: RigidTransform): AssemblyFrame {
  return {
    origin: { ...transform.t },
    zAxis: rotateVector(transform.q, vec(0, 0, 1)),
    xAxis: rotateVector(transform.q, vec(1, 0, 0))
  };
}

/**
 * An orthonormal frame on an axis. X follows the hint projected off Z;
 * without a usable hint it is the world axis least aligned with Z (ties in
 * X, Y, Z order), so the same picked geometry always yields the same frame.
 * Null when Z has no direction.
 */
export function frameFromAxis(
  origin: Vector3,
  zAxis: Vector3,
  xHint?: Vector3
): AssemblyFrame | null {
  const z = normalize3(zAxis);
  if (!z) return null;
  const candidates: Vector3[] = [];
  if (xHint) candidates.push(xHint);
  const world = [vec(1, 0, 0), vec(0, 1, 0), vec(0, 0, 1)];
  world.sort((a, b) => Math.abs(dot3(a, z)) - Math.abs(dot3(b, z)));
  candidates.push(...world);
  for (const candidate of candidates) {
    const x = normalize3(sub3(candidate, scale3(z, dot3(candidate, z))));
    if (x && Math.abs(dot3(normalize3(candidate) ?? x, z)) < 1 - 1e-9) {
      return { origin: { ...origin }, zAxis: z, xAxis: x };
    }
  }
  return null;
}

/** The same frame turned half a turn about X: Z reversed. */
export function flipFrame(frame: AssemblyFrame): AssemblyFrame {
  return {
    origin: { ...frame.origin },
    zAxis: scale3(frame.zAxis, -1),
    xAxis: { ...frame.xAxis }
  };
}

/** The same frame turned a quarter turn about Z. */
export function quarterTurnFrame(frame: AssemblyFrame): AssemblyFrame {
  return {
    origin: { ...frame.origin },
    zAxis: { ...frame.zAxis },
    xAxis: frameYAxis(frame)
  };
}

export function frameInWorld(
  pose: RigidTransform,
  frame: AssemblyFrame
): AssemblyFrame {
  return transformToFrame(composeTransforms(pose, frameToTransform(frame)));
}

export function frameInLocal(
  pose: RigidTransform,
  worldFrame: AssemblyFrame
): AssemblyFrame {
  return transformToFrame(
    composeTransforms(invertTransform(pose), frameToTransform(worldFrame))
  );
}

/**
 * Whether two world frames share an origin and an axis line: 'same' when Z
 * agrees, 'opposite' when it is reversed, null otherwise.
 */
export function framesCoincide(
  a: AssemblyFrame,
  b: AssemblyFrame,
  linearTolerance = ASSEMBLY_COINCIDENT_LINEAR_TOLERANCE
): 'same' | 'opposite' | null {
  const gap = Math.hypot(
    a.origin.x - b.origin.x,
    a.origin.y - b.origin.y,
    a.origin.z - b.origin.z
  );
  if (gap > linearTolerance) return null;
  const cos = dot3(a.zAxis, b.zAxis);
  if (cos >= 1 - ASSEMBLY_COINCIDENT_ANGULAR_TOLERANCE) return 'same';
  if (cos <= -1 + ASSEMBLY_COINCIDENT_ANGULAR_TOLERANCE) return 'opposite';
  return null;
}

// ── Joint motion ────────────────────────────────────────────────────────

export function jointDofCount(kind: AssemblyJointKind): number {
  return ASSEMBLY_JOINT_DOFS[kind].length;
}

export function zeroJointValues(kind: AssemblyJointKind): number[] {
  return ASSEMBLY_JOINT_DOFS[kind].map(() => 0);
}

function rotationAbout(axis: Vector3, deg: number): RigidTransform {
  return { t: vec(0, 0, 0), q: axisAngleQuaternion(axis, deg * DEG) };
}

function translation(x: number, y: number, z: number): RigidTransform {
  return { t: vec(x, y, z), q: IDENTITY_QUATERNION };
}

/** The joint's motion in its parent frame for the given values. */
export function jointMotion(
  kind: AssemblyJointKind,
  values: readonly number[]
): RigidTransform {
  const v = (index: number) => values[index] ?? 0;
  const X = vec(1, 0, 0);
  const Y = vec(0, 1, 0);
  const Z = vec(0, 0, 1);
  switch (kind) {
    case 'rigid':
      return IDENTITY_TRANSFORM;
    case 'revolute':
      return rotationAbout(Z, v(0));
    case 'slider':
      return translation(0, 0, v(0));
    case 'cylindrical':
      return composeTransforms(translation(0, 0, v(1)), rotationAbout(Z, v(0)));
    case 'ball':
      return composeTransforms(
        composeTransforms(rotationAbout(Z, v(0)), rotationAbout(Y, v(1))),
        rotationAbout(X, v(2))
      );
    case 'planar':
      return composeTransforms(
        translation(v(0), v(1), 0),
        rotationAbout(Z, v(2))
      );
  }
}

export function clampToLimit(
  value: number,
  limit: AssemblyDofLimit | null | undefined
): number {
  if (!limit) return value;
  return Math.min(limit.max, Math.max(limit.min, value));
}

/** Values of the right length, each clamped into its limit. */
export function clampJointValues(
  joint: Pick<AssemblyJoint, 'kind' | 'limits'>,
  values: readonly number[]
): number[] {
  return ASSEMBLY_JOINT_DOFS[joint.kind].map((_, index) => {
    const raw = values[index];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    return clampToLimit(value, joint.limits[index]);
  });
}

/**
 * The child frame that keeps both components where they are now with the
 * joint at `values` (as-built joints): F_c = pose_c⁻¹ · pose_p · F_p · M.
 */
export function asBuiltChildFrame(
  parentPose: RigidTransform,
  parentFrame: AssemblyFrame,
  childPose: RigidTransform,
  kind: AssemblyJointKind,
  values: readonly number[] = zeroJointValues(kind)
): AssemblyFrame {
  return transformToFrame(
    composeTransforms(
      composeTransforms(
        composeTransforms(invertTransform(childPose), parentPose),
        frameToTransform(parentFrame)
      ),
      jointMotion(kind, values)
    )
  );
}

// ── Solving ─────────────────────────────────────────────────────────────

export type AssemblyComponentRole =
  /** Fixed in place by the user. */
  | 'grounded'
  /** Placed through joints from a grounded or free component. */
  | 'driven'
  /** Not reachable from a grounded component: it keeps its placement. */
  | 'free';

export type AssemblyUnsolvedReason =
  /** Both ends were already placed: the joint closes a loop (AS09). */
  | 'loop'
  /** Both ends are grounded, so the joint can never move. */
  | 'grounded-both';

export interface AssemblyTreeLink {
  jointId: string;
  /** True when the traversal went parent → child (the joint's own sense). */
  forward: boolean;
}

export interface AssemblySolution {
  poses: Map<string, RigidTransform>;
  roles: Map<string, AssemblyComponentRole>;
  /** How each driven component was reached. */
  links: Map<string, AssemblyTreeLink>;
  /** Clamped values every joint was solved with. */
  values: Map<string, number[]>;
  unsolved: Map<string, AssemblyUnsolvedReason>;
  /** Free motions left: tree joints' values plus 6 per free root. */
  dof: number;
  grounded: number;
}

export function solveAssembly(
  set: AssemblySet,
  overrides?: ReadonlyMap<string, readonly number[]>
): AssemblySolution {
  const poses = new Map<string, RigidTransform>();
  const roles = new Map<string, AssemblyComponentRole>();
  const links = new Map<string, AssemblyTreeLink>();
  // Limits clamp, and coupled values follow the one that was moved.
  const values = coupledJointValues(set, overrides);
  const unsolved = new Map<string, AssemblyUnsolvedReason>();
  const components = new Map(set.components.map((c) => [c.id, c]));

  // Spanning forest in joint order (Kruskal over a ground super-node), so
  // the joint that closes a loop is the one added last, whatever the
  // traversal order. Grounded components all count as one fixed body.
  const GROUND = '\u0000ground';
  const parentOf = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parentOf.has(root) && parentOf.get(root) !== root)
      root = parentOf.get(root) as string;
    parentOf.set(id, root);
    return root;
  };
  for (const c of set.components)
    parentOf.set(c.id, c.grounded ? GROUND : c.id);
  parentOf.set(GROUND, GROUND);
  const adjacency = new Map<string, AssemblyJoint[]>();
  for (const joint of set.joints) {
    const a = joint.parent.componentId;
    const b = joint.child.componentId;
    if (!components.has(a) || !components.has(b)) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) {
      const bothGrounded =
        components.get(a)?.grounded && components.get(b)?.grounded;
      unsolved.set(joint.id, bothGrounded ? 'grounded-both' : 'loop');
      continue;
    }
    parentOf.set(ra === GROUND ? rb : ra, ra === GROUND ? ra : rb);
    for (const end of [a, b]) {
      const list = adjacency.get(end) ?? [];
      list.push(joint);
      adjacency.set(end, list);
    }
  }

  const used = new Set<string>();
  let dof = 0;
  const queue: string[] = [];
  const visit = (start: string[]) => {
    queue.push(...start);
    while (queue.length > 0) {
      const id = queue.shift() as string;
      const pose = poses.get(id) as RigidTransform;
      for (const joint of adjacency.get(id) ?? []) {
        if (used.has(joint.id) || unsolved.has(joint.id)) continue;
        const forward = joint.parent.componentId === id;
        const otherId = forward
          ? joint.child.componentId
          : joint.parent.componentId;
        if (!components.has(otherId)) continue;
        // The forest has no cycles, so the far end is never placed yet.
        if (poses.has(otherId)) continue;
        used.add(joint.id);
        const motion = jointMotion(joint.kind, values.get(joint.id) ?? []);
        const fp = frameToTransform(joint.parent.frame);
        const fc = frameToTransform(joint.child.frame);
        const otherPose = forward
          ? composeTransforms(
              composeTransforms(composeTransforms(pose, fp), motion),
              invertTransform(fc)
            )
          : composeTransforms(
              composeTransforms(
                composeTransforms(pose, fc),
                invertTransform(motion)
              ),
              invertTransform(fp)
            );
        poses.set(otherId, otherPose);
        roles.set(otherId, 'driven');
        links.set(otherId, { jointId: joint.id, forward });
        dof += jointDofCount(joint.kind);
        queue.push(otherId);
      }
    }
  };

  const grounded = set.components.filter((c) => c.grounded);
  for (const component of grounded) {
    poses.set(component.id, placementToTransform(component.placement));
    roles.set(component.id, 'grounded');
  }
  visit(grounded.map((c) => c.id));
  for (const component of set.components) {
    if (poses.has(component.id)) continue;
    poses.set(component.id, placementToTransform(component.placement));
    roles.set(component.id, 'free');
    dof += 6;
    visit([component.id]);
  }
  return {
    poses,
    roles,
    links,
    values,
    unsolved,
    dof,
    grounded: grounded.length
  };
}

/** A joint end's frame in world coordinates under a solution. */
export function jointWorldFrames(
  solution: AssemblySolution,
  joint: AssemblyJoint
): { parent: AssemblyFrame; child: AssemblyFrame } | null {
  const parentPose = solution.poses.get(joint.parent.componentId);
  const childPose = solution.poses.get(joint.child.componentId);
  if (!parentPose || !childPose) return null;
  return {
    parent: frameInWorld(parentPose, joint.parent.frame),
    child: frameInWorld(childPose, joint.child.frame)
  };
}

export interface AssemblyDragSpec {
  jointId: string;
  /** Which of the joint's values the drag changes. */
  dof: number;
  unit: 'deg' | 'mm';
  /**
   * The world frame that stays still during the drag (the upstream end's
   * frame). Turns are about its Z axis through its origin; slides are along
   * its Z axis, or X/Y for planar slides.
   */
  axisFrame: AssemblyFrame;
  /** World axis the value is measured about or along. */
  axis: Vector3;
  /**
   * +1 when turning or sliding the dragged component positively about
   * `axis` raises the value; −1 when the joint is reached from its child
   * side, which reverses the sense.
   */
  direction: 1 | -1;
  startValue: number;
  /** The joint's limit, narrowed by the limits of motions coupled to it. */
  limit: AssemblyDofLimit | null;
}

/**
 * The joint a drag on a component moves: the nearest joint with a free
 * motion between the component and its root. Null for grounded components,
 * free roots (they move with the Move tool) and rigid-only chains.
 */
export function dragSpecFor(
  set: AssemblySet,
  solution: AssemblySolution,
  componentId: string
): AssemblyDragSpec | null {
  const joints = new Map(set.joints.map((j) => [j.id, j]));
  const seen = new Set<string>();
  for (let at = componentId; !seen.has(at);) {
    seen.add(at);
    const link = solution.links.get(at);
    if (!link) return null;
    const joint = joints.get(link.jointId);
    if (!joint) return null;
    const upstreamId = link.forward
      ? joint.parent.componentId
      : joint.child.componentId;
    if (jointDofCount(joint.kind) > 0) {
      const upstreamPose = solution.poses.get(upstreamId);
      if (!upstreamPose) return null;
      const upstreamFrame = link.forward
        ? joint.parent.frame
        : joint.child.frame;
      const axisFrame = frameInWorld(upstreamPose, upstreamFrame);
      const dof = 0;
      const unit = ASSEMBLY_JOINT_DOFS[joint.kind][dof] as 'deg' | 'mm';
      // A planar slide runs along the parent frame's X. Seen from the child
      // side that axis is the child frame's X turned back by the joint's turn.
      const turn = (solution.values.get(joint.id) ?? [])[2] ?? 0;
      const axis =
        joint.kind === 'planar'
          ? rotateVector(
              axisAngleQuaternion(
                axisFrame.zAxis,
                link.forward ? 0 : -turn * DEG
              ),
              axisFrame.xAxis
            )
          : axisFrame.zAxis;
      return {
        jointId: joint.id,
        dof,
        unit,
        axisFrame,
        axis,
        direction: link.forward ? 1 : -1,
        startValue: (solution.values.get(joint.id) ?? [])[dof] ?? 0,
        limit: coupledDofLimit(set, joint.id, dof)
      };
    }
    at = upstreamId;
  }
  return null;
}

// ── Motion: joint sweeps and motion studies ─────────────────────────────

export function easeProgress(u: number, easing: AssemblyEasing): number {
  const c = Math.min(1, Math.max(0, u));
  return easing === 'ease' ? c * c * (3 - 2 * c) : c;
}

/**
 * Where playback stands `elapsedS` after starting: once stops at the end,
 * loop wraps, ping-pong runs back and forth. Pure in elapsed time, so a
 * frame drop never changes where the motion is.
 */
export function playbackTime(
  mode: AssemblyPlayback,
  elapsedS: number,
  durationS: number
): { t: number; done: boolean } {
  if (!(durationS > 0)) return { t: 0, done: true };
  const elapsed = Math.max(0, elapsedS);
  if (mode === 'once') {
    return { t: Math.min(elapsed, durationS), done: elapsed >= durationS };
  }
  if (mode === 'loop') return { t: elapsed % durationS, done: false };
  const p = elapsed % (2 * durationS);
  return { t: p <= durationS ? p : 2 * durationS - p, done: false };
}

/**
 * The range an Animate sweep covers for one of a joint's values: its
 * limits, else a full turn for an unlimited angle. Null for an unlimited
 * length: there is no natural range to sweep.
 */
export function jointSweepRange(
  joint: Pick<AssemblyJoint, 'kind' | 'limits'>,
  dof: number
): AssemblyDofLimit | null {
  const unit = ASSEMBLY_JOINT_DOFS[joint.kind][dof];
  if (!unit) return null;
  const limit = joint.limits[dof];
  if (limit) return limit.max > limit.min ? limit : null;
  return unit === 'deg' ? { min: 0, max: 360 } : null;
}

/** The value an Animate sweep shows `elapsedS` into a sweep of `sweepS`. */
export function jointSweepValue(
  range: AssemblyDofLimit,
  mode: AssemblyPlayback,
  sweepS: number,
  elapsedS: number
): { value: number; done: boolean } {
  const { t, done } = playbackTime(mode, elapsedS, sweepS);
  const u = easeProgress(sweepS > 0 ? t / sweepS : 1, 'ease');
  return { value: range.min + (range.max - range.min) * u, done };
}

export function evaluateTrack(track: AssemblyTrack, t: number): number {
  const keys = track.keys;
  const first = keys[0];
  if (!first) return 0;
  if (t <= first.t) return first.value;
  for (let index = 1; index < keys.length; index += 1) {
    const to = keys[index] as (typeof keys)[number];
    if (t <= to.t) {
      const from = keys[index - 1] as (typeof keys)[number];
      const u = easeProgress((t - from.t) / (to.t - from.t), to.easing);
      return from.value + (to.value - from.value) * u;
    }
  }
  return (keys[keys.length - 1] as (typeof keys)[number]).value;
}

/**
 * Every joint's values at time `t` of a study: tracked motions follow their
 * keys, everything else keeps its current value. Feed it to
 * {@link solveAssembly} as overrides; limits clamp there.
 */
export function motionStudyValues(
  set: AssemblySet,
  study: AssemblyMotionStudy,
  t: number
): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const joint of set.joints) result.set(joint.id, [...joint.values]);
  for (const track of study.tracks) {
    const values = result.get(track.jointId);
    if (!values || track.dof >= values.length) continue;
    values[track.dof] = evaluateTrack(track, t);
  }
  return result;
}

// ── Editing checks ──────────────────────────────────────────────────────

/** Why two components cannot take a new joint, or null when they can. */
export function jointAddError(
  set: AssemblySet,
  parentComponentId: string,
  childComponentId: string
): string | null {
  const ids = new Set(set.components.map((c) => c.id));
  if (!ids.has(parentComponentId) || !ids.has(childComponentId))
    return 'Both ends of a joint must be components of this assembly.';
  if (parentComponentId === childComponentId)
    return 'A joint needs two different components.';
  const existing = set.joints.find(
    (j) =>
      (j.parent.componentId === parentComponentId &&
        j.child.componentId === childComponentId) ||
      (j.parent.componentId === childComponentId &&
        j.child.componentId === parentComponentId)
  );
  if (existing)
    return `These components are already joined by ${existing.name}.`;
  return null;
}

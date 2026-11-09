import * as THREE from 'three';
import {
  HANDLE_COLOR,
  addHandleParts,
  createHitMesh,
  disposeRigGroups,
  handleMaterial,
  toVector3,
  type DragRig,
  type HandleVec3
} from './DragRig';
import { angleAboutAxisDeg, angleRigBasis, unwrapSweepDeg } from './angleRig';
import { SELECTION_SEMANTICS } from '../render/semantics';

/**
 * A coil's free end: a ball where the coil stops, dragged along the coil to
 * wind more turns on or take them off at the same spacing. Its value is the
 * number of turns, so a half turn is a value of 0.5.
 *
 * The pointer is read two ways, whichever the view can answer. Seen from
 * along the axis, its angle round the axis (kept continuous past each full
 * turn, as the angle rig does) is how far the coil winds. Seen from the side,
 * where going round reads as going back and forth, its height along the axis
 * divided by the pitch is.
 */
export interface CoilRigParams {
  /** The axis point level with where the coil starts. */
  center: HandleVec3;
  /** Unit axis the coil climbs along; turns run right-handed about it. */
  axis: HandleVec3;
  /** From the centre toward where the coil starts. */
  startDirection: HandleVec3;
  /** How far the coil's path is from the axis. */
  radius: number;
  /** How far one turn climbs along `axis` (positive). */
  pitch: number;
  /** The turns the coil has when the gesture begins. */
  turns: number;
  /** Fewest turns a drag can reach. */
  minTurns?: number;
  /** Most turns a drag can reach. */
  maxTurns?: number;
}

export const COIL_RIG_KIND = 'coil-end';
const HANDLE_RADIUS = 0.18;
const HIT_RADIUS = 0.6;
const HANDLE_HOT_COLOR = SELECTION_SEMANTICS.handle.hot;
/**
 * Below this |cos| between the view ray and the axis the plane round the
 * axis is seen too nearly edge-on to read an angle from: the height is read.
 */
const EDGE_ON_COS = 0.3;

/** The point on the coil's path `turns` turns from its start. */
export function coilPoint(
  center: THREE.Vector3,
  axis: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
  radius: number,
  pitch: number,
  turns: number
): THREE.Vector3 {
  const angle = turns * Math.PI * 2;
  return center
    .clone()
    .addScaledVector(u, Math.cos(angle) * radius)
    .addScaledVector(v, Math.sin(angle) * radius)
    .addScaledVector(axis, pitch * turns);
}

export function buildCoilHandle(params: CoilRigParams): DragRig {
  const kind = COIL_RIG_KIND;
  const center = toVector3(params.center);
  const axis = toVector3(params.axis).normalize();
  const { u, v } = angleRigBasis(axis, toVector3(params.startDirection));
  const radius = params.radius;
  const pitch = Math.abs(params.pitch);
  const minTurns = params.minTurns ?? 0.05;
  const maxTurns = params.maxTurns ?? 100;
  let current = Math.min(maxTurns, Math.max(minTurns, params.turns));

  const pointAt = (turns: number) =>
    coilPoint(center, axis, u, v, radius, pitch, turns);
  /** The coil's direction of travel at `turns`. */
  const tangentAt = (turns: number) => {
    const angle = turns * Math.PI * 2;
    return u
      .clone()
      .multiplyScalar(-Math.sin(angle) * Math.PI * 2 * radius)
      .addScaledVector(v, Math.cos(angle) * Math.PI * 2 * radius)
      .addScaledVector(axis, pitch)
      .normalize();
  };

  // Screen-constant part only: the ball and its hit volume. The coil itself
  // is the preview, so there is no track to draw.
  const group = new THREE.Group();
  group.name = `${kind}-handle`;
  const worldGroup = new THREE.Group();
  worldGroup.name = `${kind}-handle-world`;
  const ballMaterial = handleMaterial();
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(HANDLE_RADIUS, 20, 14),
    ballMaterial
  );
  const hit = createHitMesh(new THREE.SphereGeometry(HIT_RADIUS, 12, 8), kind);
  addHandleParts(group, [ball, hit]);

  const origin = pointAt(current);
  const direction = tangentAt(current);
  const update = () => {
    group.position.copy(pointAt(current));
    direction.copy(tangentAt(current));
  };
  update();

  let hot = false;
  return {
    kind,
    group,
    worldGroup,
    origin,
    direction,
    setValue(turns: number) {
      current = Math.min(maxTurns, Math.max(minTurns, turns));
      update();
    },
    value() {
      return current;
    },
    valueFromRay(ray: THREE.Ray, previous: number) {
      const along = Math.abs(ray.direction.clone().normalize().dot(axis));
      if (along >= EDGE_ON_COS || pitch <= 0) {
        // Round the axis, on the plane level with the coil's end now.
        const level = center
          .clone()
          .addScaledVector(axis, pitch * Math.max(previous, 0));
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
          axis,
          level
        );
        const point = new THREE.Vector3();
        if (!ray.intersectPlane(plane, point)) return null;
        const raw = angleAboutAxisDeg(level, u, v, point);
        return (
          unwrapSweepDeg(previous * 360, raw, minTurns * 360, maxTurns * 360) /
          360
        );
      }
      // From the side: the height up a line through the coil's end, parallel
      // to the axis, where the ray passes closest to it — as a linear rig
      // reads its arrow. (The axis itself sits behind the coil: in
      // perspective the ray's nearest point on it is not level with the
      // pointer.)
      const end = pointAt(previous);
      const onLine = new THREE.Vector3();
      ray.distanceSqToSegment(
        end.clone().addScaledVector(axis, -pitch * (maxTurns + 1)),
        end.clone().addScaledVector(axis, pitch * (maxTurns + 1)),
        undefined,
        onLine
      );
      const height = onLine.clone().sub(center).dot(axis);
      return Math.min(maxTurns, Math.max(minTurns, height / pitch));
    },
    setWarning(warning: boolean) {
      ballMaterial.color.set(
        warning ? SELECTION_SEMANTICS.handle.invalid : HANDLE_COLOR
      );
    },
    setHot(next: boolean) {
      if (next === hot) return;
      hot = next;
      ballMaterial.color.set(hot ? HANDLE_HOT_COLOR : HANDLE_COLOR);
    },
    chipAnchor(gizmoScale: number) {
      // Just outside the coil at its end, clear of the ball being held.
      const end = pointAt(current);
      const level = center.clone().addScaledVector(axis, pitch * current);
      const outward = end.clone().sub(level).normalize();
      return end.addScaledVector(outward, 0.9 * gizmoScale);
    },
    chipLine() {
      return null;
    },
    dispose() {
      disposeRigGroups(group, worldGroup);
    }
  };
}

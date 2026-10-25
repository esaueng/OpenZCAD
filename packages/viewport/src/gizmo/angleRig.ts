import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
  HANDLE_COLOR,
  HANDLE_RENDER_ORDER,
  addHandleParts,
  createHitMesh,
  disposeRigGroups,
  handleMaterial,
  keepProgram,
  toVector3,
  type DragRig,
  type HandleVec3
} from './DragRig';
import { SELECTION_SEMANTICS } from '../render/semantics';

/**
 * An angle handle: a sweep about an axis, dragged round a dashed circle.
 *
 * Built for the in-place Revolve, and shaped so a draft, a circular pattern
 * or a rotate-about-axis can take it unchanged: the rig knows a centre, an
 * axis, where the sweep starts and how far out to draw, nothing about the
 * feature it drives. Unlike the linear rigs, its value is not a distance
 * along `direction`, so it answers `valueFromRay` and the viewport asks that
 * instead of projecting the pointer onto a line.
 */
export interface AngleRigParams {
  /** A point on the axis, in the plane the sweep is drawn in. */
  center: HandleVec3;
  /** Unit axis; positive angles turn right-handed about it. */
  axis: HandleVec3;
  /** Where zero degrees points from the centre (projected off the axis). */
  startDirection: HandleVec3;
  /** World radius of the drawn circle. */
  radius: number;
  /** The sweep represented when the gesture begins, in degrees. */
  angleDeg: number;
  /** Smallest sweep a drag can reach. */
  minDeg?: number;
  /** Largest sweep a drag can reach. */
  maxDeg?: number;
}

export const ANGLE_RIG_KIND = 'sweep-angle';
const ARC_SEGMENTS = 96;
const HANDLE_RADIUS = 0.16;
const HIT_RADIUS = 0.6;
const HANDLE_HOT_COLOR = SELECTION_SEMANTICS.handle.hot;

/** Orthonormal in-plane basis whose `u` is `seed` projected off `axis`. */
export function angleRigBasis(
  axis: THREE.Vector3,
  seed: THREE.Vector3
): { u: THREE.Vector3; v: THREE.Vector3 } {
  const n = axis.clone().normalize();
  let u = seed.clone().addScaledVector(n, -seed.dot(n));
  if (u.lengthSq() < 1e-12) {
    // A seed along the axis has no in-plane part; any perpendicular will do.
    const fallback =
      Math.abs(n.x) < 0.9
        ? new THREE.Vector3(1, 0, 0)
        : new THREE.Vector3(0, 1, 0);
    u = fallback.addScaledVector(n, -fallback.dot(n));
  }
  u.normalize();
  const v = new THREE.Vector3().crossVectors(n, u);
  return { u, v };
}

/** Signed angle in degrees of `point` about the axis, measured from `u`. */
export function angleAboutAxisDeg(
  center: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
  point: THREE.Vector3
): number {
  const offset = point.clone().sub(center);
  return THREE.MathUtils.radToDeg(Math.atan2(offset.dot(v), offset.dot(u)));
}

/**
 * The sweep `rawDeg` names that lies nearest `previousDeg` within the range.
 *
 * `atan2` wraps at ±180°, so a drag past the half turn would jump from 179°
 * to −179°. Of the turns `rawDeg + k·360` that fit the range, the one closest
 * to the previous value wins, which keeps the sweep continuous all the way
 * round; from a full turn, a drag past the start comes back in at the far end
 * rather than sticking at 360°, so the ball always sits where the sweep ends.
 * Clamped only when no turn fits a range narrower than a full circle.
 */
export function unwrapSweepDeg(
  previousDeg: number,
  rawDeg: number,
  minDeg: number,
  maxDeg: number
): number {
  let best: number | null = null;
  const first = Math.ceil((minDeg - rawDeg) / 360);
  const last = Math.floor((maxDeg - rawDeg) / 360);
  for (let k = first; k <= last; k += 1) {
    const candidate = rawDeg + k * 360;
    if (
      best === null ||
      Math.abs(candidate - previousDeg) < Math.abs(best - previousDeg)
    ) {
      best = candidate;
    }
  }
  if (best !== null) return best;
  const nearest = rawDeg + Math.round((previousDeg - rawDeg) / 360) * 360;
  return Math.min(maxDeg, Math.max(minDeg, nearest));
}

function arcPositions(
  center: THREE.Vector3,
  u: THREE.Vector3,
  v: THREE.Vector3,
  radius: number,
  fromDeg: number,
  toDeg: number,
  segments: number
): number[] {
  const positions: number[] = [];
  const count = Math.max(2, segments);
  for (let k = 0; k <= count; k += 1) {
    const angle = THREE.MathUtils.degToRad(
      fromDeg + ((toDeg - fromDeg) * k) / count
    );
    const point = center
      .clone()
      .addScaledVector(u, Math.cos(angle) * radius)
      .addScaledVector(v, Math.sin(angle) * radius);
    positions.push(point.x, point.y, point.z);
  }
  return positions;
}

function fatLine(
  positions: number[],
  options: { color: number; width: number; dashed: boolean; opacity: number }
): Line2 {
  const geometry = new LineGeometry();
  geometry.setPositions(positions);
  const material = keepProgram(
    new LineMaterial({
      color: options.color,
      linewidth: options.width,
      dashed: options.dashed,
      dashSize: 0.8,
      gapSize: 0.6,
      transparent: true,
      opacity: options.opacity,
      depthTest: false
    })
  );
  const line = new Line2(geometry, material);
  line.computeLineDistances();
  line.renderOrder = HANDLE_RENDER_ORDER - 1;
  return line;
}

export function buildAngleHandle(params: AngleRigParams): DragRig {
  const kind = ANGLE_RIG_KIND;
  const center = toVector3(params.center);
  const axis = toVector3(params.axis).normalize();
  const { u, v } = angleRigBasis(axis, toVector3(params.startDirection));
  const radius = params.radius;
  const minDeg = params.minDeg ?? 1;
  const maxDeg = params.maxDeg ?? 360;
  let current = Math.min(maxDeg, Math.max(minDeg, params.angleDeg));

  const pointAt = (deg: number) => {
    const angle = THREE.MathUtils.degToRad(deg);
    return center
      .clone()
      .addScaledVector(u, Math.cos(angle) * radius)
      .addScaledVector(v, Math.sin(angle) * radius);
  };
  const tangentAt = (deg: number) => {
    const angle = THREE.MathUtils.degToRad(deg);
    return u
      .clone()
      .multiplyScalar(-Math.sin(angle))
      .addScaledVector(v, Math.cos(angle))
      .normalize();
  };

  // World part: the full turn dashed, the swept arc solid, and a spoke to
  // each end of the sweep so it reads as an angle rather than a circle.
  const worldGroup = new THREE.Group();
  worldGroup.name = `${kind}-handle-world`;
  const circle = fatLine(
    arcPositions(center, u, v, radius, 0, 360, ARC_SEGMENTS),
    {
      color: HANDLE_COLOR,
      width: 1.2,
      dashed: true,
      opacity: 0.7
    }
  );
  worldGroup.add(circle);
  let arc: Line2 | null = null;
  let spokes: Line2 | null = null;

  // Screen-constant part: a ball at the end of the sweep and its hit volume.
  const group = new THREE.Group();
  group.name = `${kind}-handle`;
  const ballMaterial = handleMaterial();
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(HANDLE_RADIUS, 20, 14),
    ballMaterial
  );
  const hit = createHitMesh(new THREE.SphereGeometry(HIT_RADIUS, 12, 8), kind);
  addHandleParts(group, [ball, hit]);

  const direction = tangentAt(current);
  const origin = pointAt(current);

  const replaceLine = (line: Line2 | null, next: Line2): Line2 => {
    if (line) {
      line.removeFromParent();
      line.geometry.dispose();
      line.material.dispose();
    }
    worldGroup.add(next);
    return next;
  };

  const update = () => {
    arc = replaceLine(
      arc,
      fatLine(
        arcPositions(
          center,
          u,
          v,
          radius,
          0,
          current,
          Math.ceil((ARC_SEGMENTS * current) / 360)
        ),
        { color: HANDLE_COLOR, width: 2.4, dashed: false, opacity: 0.95 }
      )
    );
    const end = pointAt(current);
    const start = pointAt(0);
    spokes = replaceLine(
      spokes,
      fatLine(
        [
          start.x,
          start.y,
          start.z,
          center.x,
          center.y,
          center.z,
          end.x,
          end.y,
          end.z
        ],
        { color: HANDLE_COLOR, width: 1, dashed: true, opacity: 0.6 }
      )
    );
    group.position.copy(end);
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
    setValue(deg: number) {
      current = Math.min(maxDeg, Math.max(minDeg, deg));
      update();
    },
    value() {
      return current;
    },
    valueFromRay(ray: THREE.Ray, previous: number) {
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(
        axis,
        center
      );
      const point = new THREE.Vector3();
      if (!ray.intersectPlane(plane, point)) {
        return null;
      }
      const raw = angleAboutAxisDeg(center, u, v, point);
      return unwrapSweepDeg(previous, raw, minDeg, maxDeg);
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
      // Just outside the circle at the end of the sweep, so the chip never
      // sits on the ball the pointer is holding.
      const end = pointAt(current);
      const outward = end.clone().sub(center).normalize();
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

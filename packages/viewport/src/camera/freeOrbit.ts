import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * Unlimited orbiting. OrbitControls keeps the camera on a sphere described by
 * polar and azimuth angles about a fixed up axis, and clamps the polar angle
 * just short of each pole: a vertical drag stops dead at the top and bottom
 * views and can never carry the camera over them. Here, the rotation step is
 * taken over:
 *
 * - a vertical drag turns the camera about its own screen-right axis, with no
 *   limit, so one long drag tumbles straight over the top and keeps going;
 * - a horizontal drag still turns it about world Z — a turntable, so the
 *   model never picks up roll — with the sense flipped while the view is
 *   upside down, so the model keeps moving the way the hand does.
 *
 * Neither rotation introduces roll, so world Z always lies in the plane of
 * the view direction and the screen's vertical, and `lookAt` can rebuild the
 * orientation from up = ±Z everywhere except exactly on a pole.
 */

const WORLD_Z = new THREE.Vector3(0, 0, 1);

/**
 * How close to vertical the view direction may come before world ±Z is too
 * close to parallel to it for `lookAt` to derive the roll from: about 4.5 µrad,
 * which still covers the pose OrbitControls' `makeSafe` nudges a pole to
 * (1 µrad), while the standard top and bottom views (100 µrad off the pole)
 * stay on world up exactly as before. Inside this cone the camera holds its
 * actual screen up instead.
 */
const VERTICAL_COS = 1 - 1e-11;

/**
 * The `up` to hand `lookAt` for a roll-free view: world +Z while the view is
 * right way up, world −Z while it is upside down, so `lookAt` reproduces the
 * orientation exactly; looking straight up or down, where ±Z is the view axis
 * itself, the screen up as it stands.
 */
export function orbitUpFor(
  viewDirection: THREE.Vector3,
  screenUp: THREE.Vector3
): THREE.Vector3 {
  const vertical = Math.abs(viewDirection.dot(WORLD_Z)) >= VERTICAL_COS;
  if (vertical) {
    return screenUp.clone().normalize();
  }
  return new THREE.Vector3(0, 0, screenUp.z < 0 ? -1 : 1);
}

/** The camera's screen up and view direction, read from its quaternion. */
export function cameraScreenFrame(camera: THREE.Camera): {
  viewDirection: THREE.Vector3;
  screenUp: THREE.Vector3;
} {
  return {
    viewDirection: new THREE.Vector3(0, 0, -1).applyQuaternion(
      camera.quaternion
    ),
    screenUp: new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
  };
}

export interface FreeOrbitStep {
  /** Camera position after the step. */
  position: THREE.Vector3;
  /** Screen up after the step. */
  screenUp: THREE.Vector3;
  /** The turntable sense used, kept for the next step (see `yawSign`). */
  yawSign: 1 | -1;
}

/**
 * One rotation step about `target`. `yaw` and `pitch` are OrbitControls'
 * azimuth and polar deltas (its `rotateLeft` / `rotateUp` subtract the drag
 * angle from them), so a drag reads exactly as it did with the stock
 * controls while the view is right way up.
 *
 * `screenUp` must be perpendicular to the view; `yawSign` is the turntable
 * sense the previous step used, held while the view is so close to a pole
 * that the screen up has no vertical component to choose one from.
 */
export function freeOrbitStep(
  position: THREE.Vector3,
  target: THREE.Vector3,
  screenUp: THREE.Vector3,
  yaw: number,
  pitch: number,
  yawSign: 1 | -1
): FreeOrbitStep {
  const offset = position.clone().sub(target);
  const distance = offset.length();
  if (!(distance > 0) || !Number.isFinite(distance)) {
    return { position: position.clone(), screenUp: screenUp.clone(), yawSign };
  }
  const back = offset.clone().divideScalar(distance);
  // Re-square the up against the view so rounding cannot accumulate roll.
  const up = screenUp
    .clone()
    .addScaledVector(back, -screenUp.dot(back))
    .normalize();
  const sign: 1 | -1 = up.z > 1e-9 ? 1 : up.z < -1e-9 ? -1 : yawSign;
  // Camera right = up × back (three's camera basis: x = y × z).
  const right = new THREE.Vector3().crossVectors(up, back).normalize();
  // A positive pitch turns the offset toward −up (Rx(α) maps +z toward −y),
  // matching OrbitControls, where a smaller polar angle climbs toward up.
  const rotation = new THREE.Quaternion()
    .setFromAxisAngle(WORLD_Z, sign * yaw)
    .multiply(new THREE.Quaternion().setFromAxisAngle(right, pitch));
  return {
    position: target.clone().add(offset.applyQuaternion(rotation)),
    screenUp: up.applyQuaternion(rotation).normalize(),
    yawSign: sign
  };
}

/** The OrbitControls internals this takes over; not in the published typings. */
interface OrbitInternals {
  _sphericalDelta: THREE.Spherical;
}

/**
 * Replaces the rotation half of `orbit.update()` with `freeOrbitStep`, leaving
 * pan, dolly, damping and change events to the stock controls. The rotation
 * deltas OrbitControls accumulates are consumed here with its own damping
 * rule — the factor's share applied this frame, the rest decayed — and hidden
 * from the stock update, which then only re-derives the pose it is handed.
 *
 * `setUp` receives the `up` the camera must hold for `lookAt` to reproduce
 * the rotated view (see `orbitUpFor`); the caller copies it onto every camera
 * that shares the pose.
 *
 * `enabled` is read on every update: while it returns false the stock
 * turntable rotation runs untouched, polar clamp included, so the orbit mode
 * preference can change without rebuilding the controls.
 */
export function installFreeOrbit(
  orbit: OrbitControls<THREE.Camera>,
  setUp: (up: THREE.Vector3) => void,
  enabled: () => boolean = () => true
) {
  const internals = orbit as unknown as OrbitInternals;
  const stockUpdate = orbit.update.bind(orbit);
  let yawSign: 1 | -1 = 1;
  orbit.update = (deltaTime?: number | null) => {
    const delta = internals._sphericalDelta;
    const yawPending = delta.theta;
    const pitchPending = delta.phi;
    if ((yawPending !== 0 || pitchPending !== 0) && enabled()) {
      const share = orbit.enableDamping ? orbit.dampingFactor : 1;
      const camera = orbit.object;
      const { screenUp } = cameraScreenFrame(camera);
      const step = freeOrbitStep(
        camera.position,
        orbit.target,
        screenUp,
        yawPending * share,
        pitchPending * share,
        yawSign
      );
      yawSign = step.yawSign;
      camera.position.copy(step.position);
      const viewDirection = orbit.target.clone().sub(step.position).normalize();
      setUp(orbitUpFor(viewDirection, step.screenUp));
      delta.theta = 0;
      delta.phi = 0;
      try {
        return stockUpdate(deltaTime);
      } finally {
        const keep = orbit.enableDamping ? 1 - share : 0;
        delta.theta = yawPending * keep;
        delta.phi = pitchPending * keep;
      }
    }
    return stockUpdate(deltaTime);
  };
}

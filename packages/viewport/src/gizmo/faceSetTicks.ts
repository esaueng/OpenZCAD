import * as THREE from 'three';
import { keepProgram } from './DragRig';
import { disposeMaterial } from '../render/programRetention';
import { SELECTION_SEMANTICS } from '../render/semantics';

type Vec3 = { x: number; y: number; z: number };

/** A face of an armed face set: its centre and outward unit normal. */
export interface FaceSetTickFace {
  point: Vec3;
  normal: Vec3;
}

/** Where one face's tick stands and which way it points. */
export interface FaceSetTickPose {
  /** The face's centre carried by the offset along its own normal. */
  origin: Vec3;
  /** The way the face moves: its normal, flipped for a negative offset. */
  direction: Vec3;
}

/** Screen length of a tick, in pixels. */
export const FACE_SET_TICK_PX = 26;

function unit(vector: Vec3): Vec3 {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  return length > 1e-12
    ? { x: vector.x / length, y: vector.y / length, z: vector.z / length }
    : { x: 0, y: 0, z: 1 };
}

/**
 * M07: the direction tick of each face of an armed face set offset. Every
 * face moves along its own normal by the one shared distance, so a tick
 * stands at the face's centre carried that far and points the way the face
 * is moving: outward for a positive offset (and at rest), inward for a
 * negative one.
 */
export function faceSetTickPoses(
  faces: readonly FaceSetTickFace[],
  offset: number
): FaceSetTickPose[] {
  const value = Number.isFinite(offset) ? offset : 0;
  const sense = value < 0 ? -1 : 1;
  return faces.map((face) => {
    const normal = unit(face.normal);
    return {
      origin: {
        x: face.point.x + normal.x * value,
        y: face.point.y + normal.y * value,
        z: face.point.z + normal.z * value
      },
      // `+ 0` keeps a flipped zero component +0, not -0.
      direction: {
        x: normal.x * sense + 0,
        y: normal.y * sense + 0,
        z: normal.z * sense + 0
      }
    };
  });
}

/** The ticks of one armed face set, drawn over the model. */
export interface FaceSetTicks {
  readonly object: THREE.Group;
  readonly count: number;
  /**
   * Places every tick for `offset`, each `FACE_SET_TICK_PX` long on screen
   * at its own depth.
   */
  update(
    offset: number,
    worldPerPixelAt: (point: THREE.Vector3) => number
  ): void;
  dispose(): void;
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * One small arrow per face of an armed face set. Each is a unit shaft and
 * head along local +Y, scaled to a screen length every frame.
 */
export function createFaceSetTicks(
  faces: readonly FaceSetTickFace[]
): FaceSetTicks {
  const object = new THREE.Group();
  object.name = 'offset-face-set-ticks';
  const shaft = new THREE.CylinderGeometry(0.05, 0.05, 0.7, 8);
  shaft.translate(0, 0.35, 0);
  const head = new THREE.ConeGeometry(0.16, 0.3, 12);
  head.translate(0, 0.85, 0);
  const material = keepProgram(
    new THREE.MeshBasicMaterial({
      color: SELECTION_SEMANTICS.change.arrow,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false
    })
  );
  const ticks = faces.map(() => {
    const tick = new THREE.Group();
    const shaftMesh = new THREE.Mesh(shaft, material);
    const headMesh = new THREE.Mesh(head, material);
    shaftMesh.renderOrder = 29;
    headMesh.renderOrder = 29;
    // Overlays: never a pick target.
    shaftMesh.raycast = () => {};
    headMesh.raycast = () => {};
    tick.add(shaftMesh, headMesh);
    object.add(tick);
    return tick;
  });
  const direction = new THREE.Vector3();
  return {
    object,
    count: faces.length,
    update(offset, worldPerPixelAt) {
      const poses = faceSetTickPoses(faces, offset);
      poses.forEach((pose, index) => {
        const tick = ticks[index]!;
        tick.position.set(pose.origin.x, pose.origin.y, pose.origin.z);
        direction.set(pose.direction.x, pose.direction.y, pose.direction.z);
        tick.quaternion.setFromUnitVectors(UP, direction);
        tick.scale.setScalar(
          Math.max(worldPerPixelAt(tick.position), 1e-9) * FACE_SET_TICK_PX
        );
      });
    },
    dispose() {
      object.removeFromParent();
      shaft.dispose();
      head.dispose();
      disposeMaterial(material);
    }
  };
}

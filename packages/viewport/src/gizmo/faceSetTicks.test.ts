import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  FACE_SET_TICK_PX,
  createFaceSetTicks,
  faceSetTickPoses
} from './faceSetTicks';

// A slotted block's top beside the slot, and the slot's floor 5 below it.
const top = { point: { x: 7.5, y: 10, z: 10 }, normal: { x: 0, y: 0, z: 1 } };
const floor = { point: { x: 20, y: 10, z: 5 }, normal: { x: 0, y: 0, z: 2 } };

describe('faceSetTickPoses', () => {
  it('carries each face along its own normal and points the way it moves', () => {
    expect(faceSetTickPoses([top, floor], 2)).toEqual([
      { origin: { x: 7.5, y: 10, z: 12 }, direction: { x: 0, y: 0, z: 1 } },
      // Its normal is not unit length: the move is still the offset.
      { origin: { x: 20, y: 10, z: 7 }, direction: { x: 0, y: 0, z: 1 } }
    ]);
  });

  it('points inward for a negative offset and outward at rest', () => {
    const [cut] = faceSetTickPoses([top], -1.5);
    expect(cut).toEqual({
      origin: { x: 7.5, y: 10, z: 8.5 },
      direction: { x: 0, y: 0, z: -1 }
    });
    const [rest] = faceSetTickPoses([top], 0);
    expect(rest?.origin).toEqual(top.point);
    expect(rest?.direction).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('keeps faces facing a tilted way on their own normal', () => {
    const tilted = {
      point: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 3, z: 4 }
    };
    const [pose] = faceSetTickPoses([tilted], 5);
    expect(pose?.origin.y).toBeCloseTo(3, 12);
    expect(pose?.origin.z).toBeCloseTo(4, 12);
    expect(pose?.direction.y).toBeCloseTo(0.6, 12);
    expect(pose?.direction.z).toBeCloseTo(0.8, 12);
  });
});

describe('createFaceSetTicks', () => {
  it('draws one screen-sized tick per face, never a pick target', () => {
    const ticks = createFaceSetTicks([top, floor]);
    expect(ticks.count).toBe(2);
    ticks.update(2, () => 0.1);
    const [first, second] = ticks.object.children;
    expect(first?.position.toArray()).toEqual([7.5, 10, 12]);
    expect(second?.position.toArray()).toEqual([20, 10, 7]);
    expect(first?.scale.x).toBeCloseTo(0.1 * FACE_SET_TICK_PX, 12);
    // Local +Y is turned onto the face's direction of travel.
    const along = new THREE.Vector3(0, 1, 0).applyQuaternion(first!.quaternion);
    expect(along.z).toBeCloseTo(1, 12);
    const hits: THREE.Intersection[] = [];
    first!.children[0]!.raycast(new THREE.Raycaster(), hits);
    expect(hits).toEqual([]);
    ticks.dispose();
    expect(ticks.object.parent).toBeNull();
  });
});

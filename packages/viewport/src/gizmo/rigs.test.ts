import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CHIP_ANCHOR_LOCAL_DISTANCE, type DragRig } from './DragRig';
import {
  buildCylinderRadiusHandle,
  buildEdgeRadiusHandle,
  buildOffsetFaceHandle,
  edgeHandlePlacement,
  offsetHandlePlacement
} from './rigs';

function offsetRig(direction = { x: 0, y: 0, z: 1 }): DragRig {
  return buildOffsetFaceHandle({
    origin: { x: 1, y: 2, z: 3 },
    direction,
    ghostGeometry: null
  });
}

describe('placement is pure', () => {
  it('normalizes the face normal into a unit drag direction', () => {
    const { origin, direction } = offsetHandlePlacement(
      { x: 5, y: 6, z: 7 },
      { x: 0, y: 0, z: 4 }
    );
    expect(origin).toEqual({ x: 5, y: 6, z: 7 });
    expect(direction).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('survives a degenerate normal instead of producing NaN', () => {
    const { direction } = offsetHandlePlacement(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 }
    );
    expect(Number.isNaN(direction.x)).toBe(false);
    expect(Number.isNaN(direction.z)).toBe(false);
  });

  it('anchors an edge handle at the polyline midpoint, pointing outward', () => {
    const placement = edgeHandlePlacement(
      [0, 0, 0, 10, 0, 0, 20, 0, 0],
      { x: 10, y: 0, z: -5 }
    );
    expect(placement?.origin).toEqual({ x: 10, y: 0, z: 0 });
    expect(placement?.direction).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('rejects a polyline too short to have a midpoint', () => {
    expect(edgeHandlePlacement([0, 0, 0], { x: 0, y: 0, z: 0 })).toBeNull();
  });

  it('falls back to +Z when the edge sits on the body centre', () => {
    const placement = edgeHandlePlacement(
      [0, 0, 0, 1, 0, 0, 2, 0, 0],
      { x: 1, y: 0, z: 0 }
    );
    expect(placement?.direction).toEqual({ x: 0, y: 0, z: 1 });
  });
});

describe('the offset-face rig', () => {
  it('travels along its direction as the value changes', () => {
    const rig = offsetRig();
    rig.setValue(4);
    expect(rig.value()).toBe(4);
    expect(rig.group.position.z).toBeCloseTo(7, 6);
    // The anchor and direction describe the gesture, not the current pose.
    expect(rig.origin.z).toBe(3);
  });

  it('travels backwards for a negative value', () => {
    const rig = offsetRig();
    rig.setValue(-2);
    expect(rig.group.position.z).toBeCloseTo(1, 6);
  });

  it('floats its chip past the arrow head, scaled with the frame', () => {
    const rig = offsetRig();
    rig.setValue(5);
    const anchor = rig.chipAnchor(2);
    expect(anchor.z).toBeCloseTo(3 + 5 + CHIP_ANCHOR_LOCAL_DISTANCE * 2, 6);
  });

  it('keeps world-space parts out of the rescaled group', () => {
    const rig = buildOffsetFaceHandle({
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      ghostGeometry: new THREE.BufferGeometry()
    });
    // The leader and ghost are true world geometry: rescaling `group` for the
    // screen-constant arrow must never reach them.
    expect(rig.worldGroup.children.length).toBe(2);
    expect(rig.group.children).not.toContain(rig.worldGroup.children[0]);
  });

  it('hides the leader until the drag actually engages', () => {
    const rig = offsetRig();
    const leader = rig.worldGroup.children[0]!;
    expect(leader.visible).toBe(false);
    rig.setValue(1);
    expect(leader.visible).toBe(true);
    rig.setValue(0);
    expect(leader.visible).toBe(false);
  });
});

describe('the edge-radius rig', () => {
  it('records its value without moving the sphere off the edge', () => {
    const rig = buildEdgeRadiusHandle({
      origin: { x: 4, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 }
    });
    rig.setValue(3);
    expect(rig.value()).toBe(3);
    // A blend grows around the edge, so the handle stays on it.
    expect(rig.group.position.x).toBe(4);
    expect(rig.chipAnchor(2).x).toBe(4);
  });
});

describe('the cylinder-radius rig', () => {
  it('tracks an absolute radius while moving only by the radial delta', () => {
    const rig = buildCylinderRadiusHandle({
      origin: { x: 14, y: 0, z: 8 },
      direction: { x: 1, y: 0, z: 0 },
      originalRadius: 14
    });
    expect(rig.value()).toBe(14);
    rig.setValue(18);
    expect(rig.value()).toBe(18);
    expect(rig.group.position).toMatchObject({ x: 18, y: 0, z: 8 });
    expect(rig.origin).toMatchObject({ x: 14, y: 0, z: 8 });
  });

  it('does not create a translated face ghost', () => {
    const rig = buildCylinderRadiusHandle({
      origin: { x: 0, y: 5, z: 0 },
      direction: { x: 0, y: 1, z: 0 },
      originalRadius: 5
    });
    expect(rig.worldGroup.children).toHaveLength(1);
    expect(rig.worldGroup.children[0]?.type).toBe('Line2');
  });
});

describe('every rig honours the shared contract', () => {
  const rigs: [string, () => DragRig][] = [
    ['offset-face', () => offsetRig()],
    [
      'edge-radius',
      () =>
        buildEdgeRadiusHandle({
          origin: { x: 0, y: 0, z: 0 },
          direction: { x: 0, y: 0, z: 1 }
        })
    ],
    [
      'cylinder-radius',
      () =>
        buildCylinderRadiusHandle({
          origin: { x: 1, y: 0, z: 0 },
          direction: { x: 1, y: 0, z: 0 },
          originalRadius: 0
        })
    ]
  ];

  for (const [kind, make] of rigs) {
    it(`${kind}: exposes a pickable hit target tagged with its kind`, () => {
      const rig = make();
      expect(rig.kind).toBe(kind);
      const hits: THREE.Object3D[] = [];
      rig.group.traverse((child) => {
        if (child.userData.directHandle === true) {
          hits.push(child);
        }
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]!.userData.handleKind).toBe(kind);
    });

    it(`${kind}: starts at zero and reports what it is set to`, () => {
      const rig = make();
      expect(rig.value()).toBe(0);
      rig.setValue(2.5);
      expect(rig.value()).toBe(2.5);
    });

    it(`${kind}: detaches both groups on dispose`, () => {
      const rig = make();
      const scene = new THREE.Scene();
      scene.add(rig.group, rig.worldGroup);
      rig.dispose();
      expect(rig.group.parent).toBeNull();
      expect(rig.worldGroup.parent).toBeNull();
    });
  }
});

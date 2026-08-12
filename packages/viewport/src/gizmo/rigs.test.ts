import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CHIP_ANCHOR_LOCAL_DISTANCE, type DragRig } from './DragRig';
import {
  HANDLE_WARNING_COLOR,
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
    const placement = edgeHandlePlacement([0, 0, 0, 10, 0, 0, 20, 0, 0], {
      x: 10,
      y: 0,
      z: -5
    });
    expect(placement?.origin).toEqual({ x: 10, y: 0, z: 0 });
    expect(placement?.direction).toEqual({ x: 0, y: 0, z: 1 });
  });

  it('rejects a polyline too short to have a midpoint', () => {
    expect(edgeHandlePlacement([0, 0, 0], { x: 0, y: 0, z: 0 })).toBeNull();
  });

  it('falls back to +Z when the edge sits on the body centre', () => {
    const placement = edgeHandlePlacement([0, 0, 0, 1, 0, 0, 2, 0, 0], {
      x: 1,
      y: 0,
      z: 0
    });
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
    const ghost = rig.worldGroup.children[1]!;
    rig.setValue(4);
    expect(ghost.visible).toBe(true);
    expect(ghost.position).toMatchObject({ x: 0, y: 0, z: 0 });
  });

  it('uses the shared dashed dimension through the geometry while engaged', () => {
    const rig = offsetRig();
    const dimension = rig.worldGroup.children[0]!;
    expect(dimension.name).toBe('dimension-graphic');
    expect(dimension.children.map((child) => child.type)).toEqual([
      'Line2',
      'Mesh',
      'Mesh'
    ]);
    expect(dimension.visible).toBe(false);
    rig.setValue(1);
    expect(dimension.visible).toBe(true);
    rig.setValue(0);
    expect(dimension.visible).toBe(false);
  });

  it('separates reference ghost styling from invalid-preview warning styling', () => {
    const rig = buildOffsetFaceHandle({
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      ghostGeometry: new THREE.BufferGeometry()
    });
    const ghost = rig.worldGroup.children[1] as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshBasicMaterial
    >;
    const ghostColor = ghost.material.color.getHex();
    rig.setWarning?.(true);
    const visibleArrow = rig.group.children.find(
      (child) =>
        child instanceof THREE.Mesh &&
        child.material instanceof THREE.MeshBasicMaterial &&
        child.material.visible
    ) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    const dimensionLine = rig.worldGroup.children[0]!.children[0] as THREE.Object3D & {
      material: { color: THREE.Color };
    };
    expect(visibleArrow.material.color.getHex()).toBe(HANDLE_WARNING_COLOR);
    expect(dimensionLine.material.color.getHex()).toBe(HANDLE_WARNING_COLOR);
    expect(ghost.material.color.getHex()).toBe(ghostColor);
    expect(rig.group.userData.previewWarning).toBe(true);
    rig.setWarning?.(false);
    expect(rig.group.userData.previewWarning).toBe(false);
    rig.dispose();
  });
});

describe('the edge-radius rig', () => {
  it('orients its radius ring in the supplied blend radial plane', () => {
    const rig = buildEdgeRadiusHandle({
      origin: { x: 1, y: 2, z: 3 },
      direction: { x: 1, y: 0, z: 0 }
    });
    const ring = rig.group.children[1]!;
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(ring.quaternion);
    expect(normal.x).toBeCloseTo(1, 12);
    expect(normal.y).toBeCloseTo(0, 12);
    expect(normal.z).toBeCloseTo(0, 12);
    rig.dispose();
  });
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

  it('carries a radius dimension line with two arrowheads, no face ghost', () => {
    const rig = buildCylinderRadiusHandle({
      origin: { x: 0, y: 5, z: 0 },
      direction: { x: 0, y: 1, z: 0 },
      originalRadius: 5
    });
    // One nested graphic rather than three loose children: the renderer moved
    // out so the measurement tape draws the same dimension rather than a
    // second one that would drift from this.
    expect(rig.worldGroup.children).toHaveLength(1);
    const dimension = rig.worldGroup.children[0]!;
    expect(dimension.name).toBe('dimension-graphic');
    // Still a dashed line and two arrowheads, and still no face ghost.
    expect(dimension.children.map((child) => child.type)).toEqual([
      'Line2',
      'Mesh',
      'Mesh'
    ]);
  });

  it('anchors the value chip on the dimension line inside the cylinder', () => {
    const rig = buildCylinderRadiusHandle({
      origin: { x: 14, y: 0, z: 8 },
      direction: { x: 1, y: 0, z: 0 },
      originalRadius: 14
    });
    // Axis centre is at x = 0; the chip rides partway back out to the wall.
    const anchor = rig.chipAnchor(1);
    expect(anchor.x).toBeCloseTo(14 * 0.45, 6);
    expect(anchor.y).toBeCloseTo(0, 6);
    expect(anchor.z).toBeCloseTo(8, 6);
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

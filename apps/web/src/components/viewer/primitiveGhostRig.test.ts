import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  primitiveGhostBounds,
  type PrimitiveGhost
} from '../../lib/primitiveGhost';
import { buildPrimitiveGhostRig } from './primitiveGhostRig';

function fillBox(group: THREE.Group): THREE.Box3 {
  const fill = group.getObjectByName('primitive-ghost-fill');
  if (!fill) throw new Error('no fill');
  group.updateWorldMatrix(true, true);
  return new THREE.Box3().setFromObject(fill);
}

function expectBounds(actual: THREE.Box3, ghost: PrimitiveGhost) {
  const expected = primitiveGhostBounds(ghost);
  for (const key of ['x', 'y', 'z'] as const) {
    expect(actual.min[key]).toBeCloseTo(expected.min[key], 6);
    expect(actual.max[key]).toBeCloseTo(expected.max[key], 6);
  }
}

describe('buildPrimitiveGhostRig', () => {
  it('draws a box from its corner, where the kernel builds it', () => {
    const ghost: PrimitiveGhost = {
      kind: 'box',
      dimensions: { width: 100, height: 60, depth: 6 },
      position: { x: 5, y: -10, z: 2 }
    };
    const rig = buildPrimitiveGhostRig(ghost, 0x6798ff);
    expectBounds(fillBox(rig.group), ghost);
    // Twelve sharp edges, drawn solid and again dashed for the hidden ones.
    const edges = rig.group.getObjectByName(
      'primitive-ghost-edges'
    ) as THREE.LineSegments;
    expect(edges.geometry.getAttribute('position').count).toBe(24);
    expect(
      rig.group.getObjectByName('primitive-ghost-edges-hidden')
    ).toBeDefined();
    rig.dispose();
  });

  it('raises a cylinder and a cone along +Z from the base centre', () => {
    const ghosts: PrimitiveGhost[] = [
      {
        kind: 'cylinder',
        dimensions: { radius: 6, height: 28 },
        position: { x: 15, y: 9, z: 24 }
      },
      {
        kind: 'cone',
        dimensions: { bottomRadius: 6, topRadius: 2, height: 10 },
        position: { x: 0, y: 0, z: 0 }
      }
    ];
    for (const ghost of ghosts) {
      const rig = buildPrimitiveGhostRig(ghost, 0x6798ff);
      expectBounds(fillBox(rig.group), ghost);
      rig.dispose();
    }
    // The cone's wide end is its base: the ring at the top is the narrow one.
    const cone = buildPrimitiveGhostRig(ghosts[1]!, 0x6798ff);
    const positions = (
      cone.group.getObjectByName('primitive-ghost-fill') as THREE.Mesh
    ).geometry.getAttribute('position');
    let topReach = 0;
    for (let index = 0; index < positions.count; index += 1) {
      if (Math.abs(positions.getZ(index) - 10) < 1e-9) {
        topReach = Math.max(
          topReach,
          Math.hypot(positions.getX(index), positions.getY(index))
        );
      }
    }
    expect(topReach).toBeCloseTo(2, 6);
    cone.dispose();
  });

  it('centres a sphere and lays a torus flat in XY', () => {
    const ghosts: PrimitiveGhost[] = [
      {
        kind: 'sphere',
        dimensions: { radius: 5 },
        position: { x: 1, y: 2, z: 3 }
      },
      {
        kind: 'torus',
        dimensions: { majorRadius: 6, minorRadius: 2 },
        position: { x: 0, y: 0, z: 0 }
      }
    ];
    for (const ghost of ghosts) {
      const rig = buildPrimitiveGhostRig(ghost, 0x6798ff);
      expectBounds(fillBox(rig.group), ghost);
      rig.dispose();
    }
  });

  it('is never hit by a pick', () => {
    const rig = buildPrimitiveGhostRig(
      {
        kind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 },
        position: { x: 0, y: 0, z: 0 }
      },
      0x6798ff
    );
    rig.group.updateWorldMatrix(true, true);
    const raycaster = new THREE.Raycaster(
      new THREE.Vector3(5, 5, 50),
      new THREE.Vector3(0, 0, -1)
    );
    expect(raycaster.intersectObject(rig.group, true)).toEqual([]);
    rig.dispose();
  });
});

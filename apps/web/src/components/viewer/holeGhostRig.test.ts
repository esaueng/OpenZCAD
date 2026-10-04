import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  buildHoleGhostRig,
  HOLE_GHOST_HIDDEN_OPACITY,
  HOLE_GHOST_VISIBLE_OPACITY
} from './holeGhostRig';

/** A Ø6 bore drilled down 24 from the top face of a 24-tall box. */
const ghost = {
  entry: { x: 15, y: 9, z: 24 },
  axis: { x: 0, y: 0, z: -1 },
  radius: 3,
  depth: 24
};

function part(group: THREE.Group, name: string): THREE.Object3D {
  const object = group.getObjectByName(name);
  if (!object) throw new Error(`no ${name}`);
  return object;
}

function worldBox(object: THREE.Object3D): THREE.Box3 {
  object.updateWorldMatrix(true, true);
  return new THREE.Box3().setFromObject(object);
}

describe('buildHoleGhostRig', () => {
  it('runs the bore from the entry face into the body, never above it', () => {
    const rig = buildHoleGhostRig(ghost, 0x6798ff);
    for (const name of ['hole-ghost-barrel', 'hole-ghost-barrel-hidden']) {
      const box = worldBox(part(rig.group, name));
      expect(box.max.z).toBeCloseTo(24, 6);
      expect(box.min.z).toBeCloseTo(0, 6);
      expect(box.max.x - box.min.x).toBeCloseTo(6, 1);
    }
    rig.dispose();
  });

  it('marks the opening on the entry face, facing out of the body', () => {
    const rig = buildHoleGhostRig(ghost, 0x6798ff);
    const opening = part(rig.group, 'hole-ghost-opening') as THREE.Mesh;
    expect(opening.position.toArray()).toEqual([15, 9, 24]);
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(
      opening.quaternion
    );
    expect(normal.z).toBeCloseTo(1, 6);
    // Depth-tested, so the body hides it from behind, as it hides a hole.
    expect((opening.material as THREE.Material).depthTest).toBe(true);
    rig.dispose();
  });

  it('draws the barrel faint where the body hides it, stronger in the open', () => {
    const rig = buildHoleGhostRig(ghost, 0x6798ff);
    const hidden = (part(rig.group, 'hole-ghost-barrel-hidden') as THREE.Mesh)
      .material as THREE.MeshBasicMaterial;
    const visible = (part(rig.group, 'hole-ghost-barrel') as THREE.Mesh)
      .material as THREE.MeshBasicMaterial;
    expect(hidden.depthFunc).toBe(THREE.GreaterDepth);
    expect(hidden.opacity).toBe(HOLE_GHOST_HIDDEN_OPACITY);
    expect(visible.depthFunc).toBe(THREE.LessEqualDepth);
    expect(visible.opacity).toBe(HOLE_GHOST_VISIBLE_OPACITY);
    expect(hidden.opacity).toBeLessThan(visible.opacity);
    rig.dispose();
  });

  it('dashes the far rim as a hidden line', () => {
    const rig = buildHoleGhostRig(ghost, 0x6798ff);
    const exit = part(rig.group, 'hole-ghost-exit-rim') as THREE.Line;
    expect(exit.material).toBeInstanceOf(THREE.LineDashedMaterial);
    expect(exit.position.z).toBeCloseTo(0, 6);
    // A closed Line, not a LineLoop: no closing chord whose distance jumps
    // from the full circumference back to 0.
    expect(exit).not.toBeInstanceOf(THREE.LineLoop);
    const positions = exit.geometry.getAttribute('position');
    const first = new THREE.Vector3().fromBufferAttribute(positions, 0);
    const last = new THREE.Vector3().fromBufferAttribute(
      positions,
      positions.count - 1
    );
    expect(last.distanceTo(first)).toBeCloseTo(0, 9);
    const distances = Array.from(
      exit.geometry.getAttribute('lineDistance').array
    );
    expect(distances[0]).toBe(0);
    for (let index = 1; index < distances.length; index += 1) {
      expect(distances[index]!).toBeGreaterThan(distances[index - 1]!);
    }
    // Ends at the rim's full length (the 64-gon's perimeter, ~2πr).
    expect(distances.at(-1)!).toBeCloseTo(
      64 * 2 * 3 * Math.sin(Math.PI / 64),
      4
    );
    expect(distances.at(-1)!).toBeCloseTo(2 * Math.PI * 3, 1);
    rig.dispose();
  });
});

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildCurvePickerRig } from './curvePickerRig';

const candidates = [
  {
    id: 'path:a',
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 }
    ]
  },
  {
    id: 'path:b',
    points: [
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 10, z: 0 }
    ]
  }
];

/** A ray straight down onto the XY plane at (x, y). */
function downAt(x: number, y: number): THREE.Ray {
  return new THREE.Ray(new THREE.Vector3(x, y, 20), new THREE.Vector3(0, 0, -1));
}

describe('curve picker rig', () => {
  it('names the curve a ray passes within the threshold of', () => {
    const rig = buildCurvePickerRig(candidates);
    expect(rig.pick(downAt(5, 0.2), 0.5)).toBe('path:a');
    expect(rig.pick(downAt(10.3, 6), 0.5)).toBe('path:b');
  });

  it('misses outside the threshold', () => {
    const rig = buildCurvePickerRig(candidates);
    expect(rig.pick(downAt(5, 3), 0.5)).toBeNull();
  });

  it('skips a candidate with fewer than two points', () => {
    const rig = buildCurvePickerRig([
      ...candidates,
      { id: 'dot', points: [{ x: 50, y: 0, z: 0 }] }
    ]);
    expect(rig.group.children).toHaveLength(2);
  });

  it('lights picked and hovered curves and frees itself', () => {
    const rig = buildCurvePickerRig(candidates);
    rig.setSelected(['path:a']);
    rig.setHover('path:b');
    const colors = rig.group.children.map((child) =>
      ((child as THREE.Line).material as THREE.LineBasicMaterial).color.getHex()
    );
    expect(new Set(colors).size).toBe(2);
    rig.dispose();
    expect(rig.group.children).toHaveLength(0);
  });
});

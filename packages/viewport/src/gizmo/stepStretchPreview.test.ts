import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  createStepStretchPreview,
  stepPreviewKey,
  type StepPreviewProfile
} from './stepStretchPreview';

// One planar face in z = 0: A(0,0) B(1,0.5) M(5,3) Q(0,3), triangulated as
// ABM + AMQ. M moves along +x. ABM is a sliver against M's path: it folds
// once M has moved 1, though the outline stays a simple polygon throughout.
const corners = [0, 0, 0, 1, 0.5, 0, 5, 3, 0, 0, 3, 0];
const triangles = [0, 1, 2, 0, 2, 3];
const origin = { x: 0, y: 0, z: 0 };
const quantum = 1e-3;

function face() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(corners, 3)
  );
  geometry.setIndex(triangles);
  return new THREE.Mesh(geometry);
}

const profile: StepPreviewProfile = {
  normal: { x: 1, y: 0, z: 0 },
  origin,
  quantum,
  movingKeys: new Set([stepPreviewKey(5, 3, 0, origin, quantum)]),
  span: 20,
  reach: Infinity,
  planarFaces: [
    {
      triangleStart: 0,
      triangleCount: 2,
      normal: { x: 0, y: 0, z: 1 },
      push: 5,
      pull: 1
    }
  ]
};

/** Signed z-areas of the drawn triangles. */
function areas(mesh: THREE.Mesh) {
  const position = mesh.geometry.getAttribute('position');
  const index = mesh.geometry.index!;
  const result: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
    const ux = position.getX(b) - position.getX(a),
      uy = position.getY(b) - position.getY(a);
    const vx = position.getX(c) - position.getX(a),
      vy = position.getY(c) - position.getY(a);
    result.push((ux * vy - uy * vx) / 2);
  }
  return result;
}

describe('step stretch preview', () => {
  it('moves only the region and triangulates a folding planar face afresh', () => {
    const mesh = face();
    const preview = createStepStretchPreview(mesh, profile)!;
    expect(preview).not.toBeNull();

    expect(preview.apply(0.5)).toBe(true);
    // Before the fold the original triangles still tile the face.
    expect(Array.from(mesh.geometry.index!.array)).toEqual(triangles);
    expect(mesh.geometry.getAttribute('position').getX(2)).toBeCloseTo(5.5);
    expect(mesh.geometry.getAttribute('position').getX(1)).toBeCloseTo(1);

    expect(preview.apply(3)).toBe(true);
    const drawn = areas(mesh);
    expect(drawn.every((area) => area >= 0)).toBe(true);
    // A(0,0) B(1,0.5) M(8,3) Q(0,3), by the shoelace formula.
    expect(drawn.reduce((sum, area) => sum + area, 0)).toBeCloseTo(11.5, 5);

    preview.restore();
    expect(Array.from(mesh.geometry.index!.array)).toEqual(triangles);
    expect(mesh.geometry.getAttribute('position').getX(2)).toBeCloseTo(5);
  });

  it('refuses a push whose outline would cross itself and leaves the mesh as it was', () => {
    const mesh = face();
    const preview = createStepStretchPreview(mesh, profile)!;
    // M at x = -1 puts the edge B-M across Q-A.
    expect(preview.apply(-6)).toBe(false);
    expect(Array.from(mesh.geometry.index!.array)).toEqual(triangles);
    expect(mesh.geometry.getAttribute('position').getX(2)).toBeCloseTo(5);
    // Short of the crossing it still previews.
    expect(preview.apply(-4.5)).toBe(true);
  });

  it('honours the profile limits', () => {
    const preview = createStepStretchPreview(face(), {
      ...profile,
      span: 2,
      reach: 4
    })!;
    expect(preview.apply(-2)).toBe(false);
    expect(preview.apply(4)).toBe(false);
    expect(preview.apply(3.9)).toBe(true);
  });
});

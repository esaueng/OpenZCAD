import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createFatLineSegments } from '../render/scene';
import { createCylinderProfilePreview } from './cylinderProfilePreview';

const profile = {
  axisStart: { x: 0, y: 0, z: 2 },
  axisEnd: { x: 0, y: 0, z: 20 },
  radius: 28,
  coreRadius: 26
};

function objectAtPoints(points: number[]) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(points, 3)
  );
  return new THREE.Mesh(geometry);
}

// Two round rims, wall, and cap interior. Every rim point lies on a circle
// of radius two about its own section center (26, 2) or (26, 20).
const points = [
  0, 0, 0, 13, 0, 0, 26, 0, 0, 27.414213562, 0, 0.585786438, 28, 0, 2, 28, 0,
  11, 28, 0, 20, 27.414213562, 0, 21.414213562, 26, 0, 22, 0, 0, 22
];

function coordinates(object: THREE.Mesh) {
  return Array.from(object.geometry.getAttribute('position').array);
}

describe('cylinder profile preview', () => {
  it.each(['radius', 'height'] as const)(
    'preserves rim sections, cap planes and exact cancellation for %s',
    (dimension) => {
      const object = objectAtPoints(points);
      const original = coordinates(object);
      const preview = createCylinderProfilePreview(object, profile, dimension)!;
      for (const delta of [10, -8, 4]) {
        expect(preview.apply(delta)).toBe(true);
        const p = object.geometry.getAttribute('position');
        const dr = dimension === 'radius' ? delta : 0;
        const dz = dimension === 'height' ? delta : 0;
        expect(p.getX(0)).toBe(0);
        expect(p.getZ(0)).toBe(0);
        expect(p.getZ(9)).toBeCloseTo(22 + dz, 5);
        expect(p.getX(5)).toBeCloseTo(28 + dr, 5);
        expect(p.getZ(5)).toBeCloseTo(11 + dz / 2, 5);
        for (const i of [2, 3, 4, 6, 7, 8]) {
          const centerZ = i < 5 ? 2 : 20 + dz;
          expect(
            Math.hypot(p.getX(i) - (26 + dr), p.getZ(i) - centerZ)
          ).toBeCloseTo(2, 5);
        }
        expect(object.geometry.boundingBox!.max.z).toBeCloseTo(22 + dz, 5);
      }
      const latest = coordinates(object);
      for (const delta of [NaN, Infinity, -28])
        expect(preview.apply(delta)).toBe(false);
      expect(coordinates(object)).toEqual(latest);
      preview.restore();
      expect(coordinates(object)).toEqual(original);
    }
  );

  it('moves shared face buffers once and fat-line endpoints without deforming their quad', () => {
    const object = objectAtPoints(points);
    const highlight = new THREE.Mesh(new THREE.BufferGeometry());
    highlight.geometry.setAttribute(
      'position',
      object.geometry.getAttribute('position')
    );
    object.add(highlight);
    const line = createFatLineSegments([28, 0, 2, 28, 0, 20], {
      color: '#ffffff',
      linewidth: 1
    });
    object.add(line);
    const quad = Array.from(line.geometry.getAttribute('position').array);
    const originalPosition = object.geometry.getAttribute('position');
    const preview = createCylinderProfilePreview(object, profile, 'radius')!;
    expect(preview.cachedBytes).toBe((points.length + 6) * 8);
    for (let i = 0; i < 100; i += 1) preview.apply(i / 10);
    expect(object.geometry.getAttribute('position')).toBe(originalPosition);
    expect(line.geometry.getAttribute('instanceStart').getX(0)).toBeCloseTo(
      37.9,
      4
    );
    expect(line.geometry.getAttribute('instanceEnd').getX(0)).toBeCloseTo(
      37.9,
      4
    );
    expect(Array.from(line.geometry.getAttribute('position').array)).toEqual(
      quad
    );
    preview.restore();
    expect(line.geometry.getAttribute('instanceStart').getX(0)).toBe(28);
  });

  it.each(['radius', 'height'] as const)(
    'works about a translated and tilted axis for %s',
    (dimension) => {
      const object = objectAtPoints(points);
      const transform = new THREE.Matrix4()
        .makeRotationY(0.7)
        .setPosition(120, -30, 8);
      object.geometry.applyMatrix4(transform);
      const transformed = {
        ...profile,
        axisStart: new THREE.Vector3()
          .copy(profile.axisStart)
          .applyMatrix4(transform),
        axisEnd: new THREE.Vector3()
          .copy(profile.axisEnd)
          .applyMatrix4(transform)
      };
      const reference = objectAtPoints(points);
      createCylinderProfilePreview(reference, profile, dimension)!.apply(8);
      reference.geometry.applyMatrix4(transform);
      createCylinderProfilePreview(object, transformed, dimension)!.apply(8);
      coordinates(object).forEach((value, index) =>
        expect(value).toBeCloseTo(coordinates(reference)[index]!, 4)
      );
    }
  );

  it('refuses oversized preview caches without changing the installed geometry', () => {
    const object = objectAtPoints(Array.from({ length: 300_000 }, () => 28));
    const version = (
      object.geometry.getAttribute('position') as THREE.BufferAttribute
    ).version;
    expect(createCylinderProfilePreview(object, profile, 'radius')).toBeNull();
    expect(
      (object.geometry.getAttribute('position') as THREE.BufferAttribute)
        .version
    ).toBe(version);
  });
});

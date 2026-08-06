import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { cylinderRadiusPreviewMatrix } from './cylinderRadiusPreview';

function expectPoint(
  actual: THREE.Vector3,
  expected: { x: number; y: number; z: number }
) {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
  expect(actual.z).toBeCloseTo(expected.z, 10);
}

describe('cylinder radius viewport preview', () => {
  it('scales radial distance while preserving the axis and cap planes', () => {
    const matrix = cylinderRadiusPreviewMatrix(
      { x: 10, y: -5, z: 3 },
      { x: 10, y: -5, z: 31 },
      2
    );

    expect(matrix).not.toBeNull();
    expectPoint(new THREE.Vector3(17, -5, 3).applyMatrix4(matrix!), {
      x: 24,
      y: -5,
      z: 3
    });
    expectPoint(new THREE.Vector3(10, 2, 31).applyMatrix4(matrix!), {
      x: 10,
      y: 9,
      z: 31
    });
    expectPoint(new THREE.Vector3(10, -5, 17).applyMatrix4(matrix!), {
      x: 10,
      y: -5,
      z: 17
    });
  });

  it('works around a translated diagonal axis', () => {
    const start = new THREE.Vector3(4, -3, 8);
    const end = new THREE.Vector3(14, 7, 18);
    const axis = end.clone().sub(start).normalize();
    const radial = new THREE.Vector3(1, -1, 0)
      .sub(axis.clone().multiplyScalar(axis.dot(new THREE.Vector3(1, -1, 0))))
      .normalize();
    const point = start
      .clone()
      .addScaledVector(axis, 6)
      .addScaledVector(radial, 5);
    const matrix = cylinderRadiusPreviewMatrix(start, end, 0.4);

    expect(matrix).not.toBeNull();
    const transformed = point.clone().applyMatrix4(matrix!);
    const fromStart = transformed.clone().sub(start);
    expect(fromStart.dot(axis)).toBeCloseTo(6, 10);
    expect(fromStart.addScaledVector(axis, -6).length()).toBeCloseTo(2, 10);
  });

  it('rejects invalid scales and degenerate axes', () => {
    expect(
      cylinderRadiusPreviewMatrix({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, 0)
    ).toBeNull();
    expect(
      cylinderRadiusPreviewMatrix({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 }, 2)
    ).toBeNull();
  });
});

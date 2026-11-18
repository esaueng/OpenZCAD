import { describe, expect, it } from 'vitest';
import type { PlaneBasis } from '@openzcad/geometry';
import { OrthographicCamera } from 'three';
import {
  buildRegionMesh,
  regionsInBox,
  triangulateRegionGeometry
} from './regionOverlay';

const rotatedBasis: PlaneBasis = {
  origin: { x: 5, y: -2, z: 9 },
  u: { x: 0, y: 1, z: 0 },
  v: { x: 0, y: 0, z: 1 },
  normal: { x: 1, y: 0, z: 0 }
};

describe('triangulateRegionGeometry', () => {
  it('triangulates a hole without filling its interior on a rotated plane', () => {
    const outer = [
      { x: -5, y: -5 },
      { x: 5, y: -5 },
      { x: 5, y: 5 },
      { x: -5, y: 5 }
    ];
    const hole = [
      { x: -2, y: -2 },
      { x: -2, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: -2 }
    ];
    const result = triangulateRegionGeometry(outer, [hole], rotatedBasis);
    let triangleArea = 0;
    for (let index = 0; index < result.indices.length; index += 3) {
      const a = result.indices[index]!;
      const b = result.indices[index + 1]!;
      const c = result.indices[index + 2]!;
      const ay = result.positions[a * 3 + 1]!;
      const az = result.positions[a * 3 + 2]!;
      const by = result.positions[b * 3 + 1]!;
      const bz = result.positions[b * 3 + 2]!;
      const cy = result.positions[c * 3 + 1]!;
      const cz = result.positions[c * 3 + 2]!;
      triangleArea +=
        Math.abs((by - ay) * (cz - az) - (bz - az) * (cy - ay)) / 2;
      expect(result.positions[a * 3]).toBeCloseTo(rotatedBasis.origin.x, 6);
    }
    expect(triangleArea).toBeCloseTo(100 - 16, 6);
  });
});

it('selects the filled region by window and crossing, leaving the hole empty', () => {
  const outer = [
    { x: -5, y: -5 },
    { x: 5, y: -5 },
    { x: 5, y: 5 },
    { x: -5, y: 5 }
  ];
  const holes = [
    [
      { x: -2, y: -2 },
      { x: -2, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: -2 }
    ]
  ];
  const pick = {
    sketchId: 'sketch',
    profileId: 'ring',
    regionFingerprint: 1,
    samplePoint: { x: 4, y: 0 },
    centroid: { x: 0, y: 0 },
    boundingBox: { min: { x: -5, y: -5 }, max: { x: 5, y: 5 } },
    sourceEntityIds: [],
    area: 84
  };
  const camera = new OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  camera.position.set(20, -2, 9);
  camera.up.set(0, 0, 1);
  camera.lookAt(5, -2, 9);
  camera.updateMatrixWorld();
  const projection = { camera, width: 200, height: 200 };
  const object = buildRegionMesh(outer, holes, rotatedBasis, pick);
  const targets = [{ object, pick, basis: rotatedBasis, outer, holes }];
  const all = { left: 40, right: 160, top: 40, bottom: 160 };
  const part = { left: 95, right: 105, top: 55, bottom: 65 };
  const empty = { left: 95, right: 105, top: 95, bottom: 105 };

  expect(regionsInBox(targets, all, 'window', projection)).toEqual([pick]);
  expect(regionsInBox(targets, part, 'window', projection)).toEqual([]);
  expect(regionsInBox(targets, part, 'crossing', projection)).toEqual([pick]);
  expect(regionsInBox(targets, empty, 'crossing', projection)).toEqual([]);
  object.visible = false;
  expect(regionsInBox(targets, all, 'crossing', projection)).toEqual([]);
  object.geometry.dispose();
  object.material.dispose();
});

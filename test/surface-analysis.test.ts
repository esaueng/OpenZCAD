import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  draftVerdict,
  toUserId,
  type BodyId,
  type PrimitiveKind,
  type ProjectDocument,
  type CurvatureMeasure,
  type SurfaceAnalysisBody,
  type SurfaceAnalysisRequest
} from '@openzcad/shared';

/**
 * M09 draft analysis on the real kernel, through the adapter's
 * `surfaceAnalysis` (the worker's path). Read-only and unsaved: no schema
 * change. Every value is the kernel's exact draft at a sample on the face's
 * own surface; a plane's range is exact, a curved face's is its samples'.
 */
const owner = toUserId('user_surface_analysis');

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 120_000);
afterAll(() => adapter.dispose());

function documentWith(
  ...bodies: { kind: PrimitiveKind; dimensions: Record<string, number> }[]
): ProjectDocument {
  let document = createProjectDocument('Analysis', owner);
  for (const [index, body] of bodies.entries()) {
    document = addPrimitiveFeature(document, {
      name: `Body ${index + 1}`,
      primitiveKind: body.kind,
      dimensions: body.dimensions
    });
  }
  return document;
}

const draftUp = (minimumDegrees = 1): SurfaceAnalysisRequest => ({
  kind: 'draft',
  pull: { x: 0, y: 0, z: 1 },
  minimumDegrees
});

async function analyse(
  document: ProjectDocument,
  request: SurfaceAnalysisRequest,
  bodyIds = [...document.bodyOrder] as BodyId[]
) {
  await adapter.syncDocument(document);
  return adapter.surfaceAnalysis(document, bodyIds, request);
}

function sortedRanges(body: SurfaceAnalysisBody) {
  return body.faces
    .map((face) => [
      face.surface,
      Math.round(face.min * 1e6) / 1e6,
      Math.round(face.max * 1e6) / 1e6,
      face.exact
    ])
    .sort((a, b) => (a[1] as number) - (b[1] as number));
}

describe('draft analysis', () => {
  it('reads a box exactly: top +90°, bottom −90°, walls 0°', async () => {
    const document = documentWith({
      kind: 'box',
      dimensions: { width: 10, height: 20, depth: 30 }
    });
    const report = await analyse(document, draftUp());
    expect(report.missing).toEqual([]);
    expect(report.unsupported).toEqual([]);
    const [body] = report.bodies;
    expect(body!.bodyId).toBe(document.bodyOrder[0]);
    expect(sortedRanges(body!)).toEqual([
      ['plane', -90, -90, true],
      ['plane', 0, 0, true],
      ['plane', 0, 0, true],
      ['plane', 0, 0, true],
      ['plane', 0, 0, true],
      ['plane', 90, 90, true]
    ]);
    const verdicts = body!.faces
      .map((face) => draftVerdict(face.min, face.max, 1))
      .sort();
    expect(verdicts).toEqual([
      'insufficient',
      'insufficient',
      'insufficient',
      'insufficient',
      'negative',
      'positive'
    ]);
    // One value and one exact outward normal per overlay vertex.
    const vertices = body!.positions.length / 3;
    expect(body!.values).toHaveLength(vertices);
    expect(body!.normals).toHaveLength(vertices * 3);
    expect(body!.indices.length % 3).toBe(0);
    expect(Math.max(...body!.indices)).toBeLessThan(vertices);
    // Each sample's value agrees with its normal: draft = asin(n · pull).
    for (let index = 0; index < vertices; index += 1) {
      const nz = body!.normals[index * 3 + 2]!;
      expect(body!.values[index]).toBeCloseTo(
        (Math.asin(nz) * 180) / Math.PI,
        3
      );
    }
  });

  it('follows the pull direction, which need not be unit length', async () => {
    const document = documentWith({
      kind: 'box',
      dimensions: { width: 10, height: 20, depth: 30 }
    });
    const report = await analyse(document, {
      kind: 'draft',
      pull: { x: 5, y: 0, z: 0 },
      minimumDegrees: 1
    });
    const body = report.bodies[0]!;
    expect(sortedRanges(body).map((range) => range[1])).toEqual([
      -90, 0, 0, 0, 0, 90
    ]);
    // The +X face is the one at +90° now.
    const top = body.faces.find((face) => face.min === 90)!;
    expect(top.samples).toBeGreaterThan(0);
    for (let index = 0; index < body.values.length; index += 1) {
      if (body.values[index] === 90)
        expect(body.normals[index * 3]).toBeCloseTo(1, 9);
    }
  });

  it('samples curved faces: a cylinder wall is 0°, a sphere crosses bands', async () => {
    const document = documentWith(
      { kind: 'cylinder', dimensions: { radius: 5, height: 20 } },
      { kind: 'sphere', dimensions: { radius: 5 } }
    );
    const report = await analyse(document, draftUp());
    expect(report.unsupported).toEqual([]);
    const [cylinder, sphere] = report.bodies;
    const wall = cylinder!.faces.find((face) => face.surface === 'cylinder')!;
    expect(wall.min).toBeCloseTo(0, 9);
    expect(wall.max).toBeCloseTo(0, 9);
    // A curved face's range is its samples', never claimed exact.
    expect(wall.exact).toBe(false);
    expect(
      cylinder!.faces
        .filter((face) => face.surface === 'plane')
        .map((face) => [face.min, face.exact])
        .sort()
    ).toEqual([
      [-90, true],
      [90, true]
    ]);
    // The sphere's two halves run from the equator (0°) to a pole (±90°):
    // each crosses from below the minimum into a drafted band.
    expect(sphere!.faces).toHaveLength(2);
    for (const face of sphere!.faces) {
      expect(face.exact).toBe(false);
      expect(Math.max(Math.abs(face.min), Math.abs(face.max))).toBeCloseTo(
        90,
        0
      );
      expect(draftVerdict(face.min, face.max, 1)).toBe('mixed');
    }
  });

  it('analyses a moved body where the build put it', async () => {
    let document = documentWith({
      kind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    document = transformBody(document, {
      name: 'Tilt',
      targetBodyId: document.bodyOrder[0] as BodyId,
      translation: { x: 50, y: 0, z: 0 },
      rotationDeg: { x: 30, y: 0, z: 0 }
    }).document;
    const report = await analyse(document, draftUp(), [
      document.bodyOrder.at(-1) as BodyId
    ]);
    const body = report.bodies[0]!;
    // Tilted 30° about X: the top and two walls now carry ±60° and ±30°.
    expect(
      sortedRanges(body).map((range) => Math.round(range[1] as number))
    ).toEqual([-60, -30, 0, 0, 30, 60]);
    let minX = Infinity;
    for (let index = 0; index < body.positions.length; index += 3)
      minX = Math.min(minX, body.positions[index]!);
    expect(minX).toBeGreaterThan(40);
  });

  it('lists a body with no exact geometry as missing, never analysed', async () => {
    const document = documentWith({
      kind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const report = await analyse(document, draftUp(), [
      document.bodyOrder[0] as BodyId,
      'body_gone' as BodyId
    ]);
    expect(report.bodies.map((body) => body.bodyId)).toEqual([
      document.bodyOrder[0]
    ]);
    expect(report.missing).toEqual(['body_gone']);
  });

  it('refuses a zero pull direction rather than guess one', async () => {
    const document = documentWith({
      kind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    await expect(
      analyse(document, {
        kind: 'draft',
        pull: { x: 0, y: 0, z: 0 },
        minimumDegrees: 1
      })
    ).rejects.toThrow(/pull direction/);
  });
});

describe('draft bands', () => {
  it('reads a range against the minimum', () => {
    expect(draftVerdict(2, 5, 1)).toBe('positive');
    expect(draftVerdict(-5, -2, 1)).toBe('negative');
    expect(draftVerdict(-0.5, 0.5, 1)).toBe('insufficient');
    expect(draftVerdict(0.5, 5, 1)).toBe('mixed');
    expect(draftVerdict(-5, 5, 1)).toBe('mixed');
    // A vertical wall is insufficient even at a 0° minimum.
    expect(draftVerdict(1e-14, 1e-14, 0)).toBe('insufficient');
    expect(draftVerdict(0.01, 0.01, 0)).toBe('positive');
  });
});

/** A 60 × 18 × 24 plate with a 12 mm bore through it. */
function boredPlate(): ProjectDocument {
  let document = createProjectDocument('Plate', owner);
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 60, height: 18, depth: 24 }
  });
  const plate = document.bodyOrder.at(-1)!;
  document = addPrimitiveFeature(document, {
    name: 'Bore',
    primitiveKind: 'cylinder',
    dimensions: { radius: 6, height: 28 }
  });
  document = transformBody(document, {
    name: 'Place the bore',
    targetBodyId: document.bodyOrder.at(-1) as BodyId,
    translation: { x: 30, y: 9, z: -2 },
    rotationDeg: { x: 0, y: 0, z: 0 }
  }).document;
  const bore = document.bodyOrder.at(-1)!;
  return new CommandManager(document).execute(
    commandFactories.booleanBodies({
      name: 'Drill',
      operation: 'subtract',
      targetBodyIds: [plate, bore]
    })
  );
}

const curvature = (measure: CurvatureMeasure): SurfaceAnalysisRequest => ({
  kind: 'curvature',
  measure
});

describe('curvature analysis', () => {
  it('reads a sphere exactly: k1 = k2 = 1/r, smallest radius r in closed form', async () => {
    const document = documentWith({
      kind: 'sphere',
      dimensions: { radius: 5 }
    });
    for (const [measure, expected] of [
      ['gaussian', 0.04],
      ['mean', 0.2],
      ['maximum', 0.2]
    ] as const) {
      const report = await analyse(document, curvature(measure));
      expect(
        report.unsupported.filter((u) => u.reason !== 'partly-evaluated')
      ).toEqual([]);
      for (const face of report.bodies[0]!.faces) {
        expect(face.surface).toBe('sphere');
        expect(face.min).toBeCloseTo(expected, 9);
        expect(face.max).toBeCloseTo(expected, 9);
        expect(face.exact).toBe(face.samples > 0 && !report.unsupported.length);
        expect(face.minRadius).toBeCloseTo(5, 9);
        expect(face.minRadiusExact).toBe(true);
      }
    }
  });

  it('signs a bore concave and its plate flat', async () => {
    const document = boredPlate();
    const mean = await analyse(document, curvature('mean'));
    // The bore tool and the plate before drilling are consumed: only the
    // drilled plate has exact geometry to analyse.
    expect(mean.bodies).toHaveLength(1);
    expect(mean.unsupported).toEqual([]);
    const body = mean.bodies.at(-1)!;
    const bore = body.faces.filter((face) => face.surface === 'cylinder');
    expect(bore).toHaveLength(1);
    // Concave against the outward normal: −(1/6 + 0)/2.
    expect(bore[0]!.min).toBeCloseTo(-1 / 12, 9);
    expect(bore[0]!.max).toBeCloseTo(-1 / 12, 9);
    expect(bore[0]!.exact).toBe(true);
    expect(bore[0]!.minRadius).toBeCloseTo(6, 9);
    expect(bore[0]!.minRadiusExact).toBe(true);
    for (const face of body.faces.filter((f) => f.surface === 'plane')) {
      expect([face.min, face.max, face.exact, face.minRadius]).toEqual([
        0,
        0,
        true,
        null
      ]);
    }
    // A cylinder is developable: no Gaussian curvature; its tightest
    // radius is the bore's.
    const gaussian = await analyse(document, curvature('gaussian'));
    const wall = gaussian.bodies
      .at(-1)!
      .faces.find((f) => f.surface === 'cylinder')!;
    expect(Math.abs(wall.min)).toBeLessThan(1e-12);
    expect(Math.abs(wall.max)).toBeLessThan(1e-12);
    const maximum = await analyse(document, curvature('maximum'));
    const tight = maximum.bodies
      .at(-1)!
      .faces.find((f) => f.surface === 'cylinder')!;
    expect(tight.max).toBeCloseTo(1 / 6, 9);
  });

  it('samples a torus, whose curvature varies over the face', async () => {
    const document = documentWith({
      kind: 'torus',
      dimensions: { majorRadius: 10, minorRadius: 3 }
    });
    const report = await analyse(document, curvature('gaussian'));
    const faces = report.bodies[0]!.faces.filter((f) => f.surface === 'torus');
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      // Outer equator: 1/3 · 1/13 > 0; inner: 1/3 · −1/7 < 0.
      expect(face.exact).toBe(false);
      expect(face.max).toBeLessThanOrEqual(1 / 39 + 1e-9);
      expect(face.min).toBeGreaterThanOrEqual(-1 / 21 - 1e-9);
      expect(face.minRadius).toBeCloseTo(3, 6);
      expect(face.minRadiusExact).toBe(true);
    }
    const all = faces.flatMap((f) => [f.min, f.max]);
    expect(Math.max(...all)).toBeGreaterThan(0);
    expect(Math.min(...all)).toBeLessThan(0);
  });
});

describe('zebra analysis', () => {
  it('carries the exact outward unit normal at denser samples', async () => {
    const document = documentWith({
      kind: 'cylinder',
      dimensions: { radius: 5, height: 20 }
    });
    const zebra = await analyse(document, { kind: 'zebra', stripes: 12 });
    const draft = await analyse(document, draftUp());
    const body = zebra.bodies[0]!;
    expect(body.positions.length).toBeGreaterThan(
      draft.bodies[0]!.positions.length
    );
    for (let index = 0; index < body.values.length; index += 1) {
      expect(body.values[index]).toBe(0);
      const n = [0, 1, 2].map((axis) => body.normals[index * 3 + axis]!);
      expect(Math.hypot(...n)).toBeCloseTo(1, 6);
      const p = [0, 1, 2].map((axis) => body.positions[index * 3 + axis]!);
      // On the wall the normal is radial and outward.
      const radial = Math.hypot(p[0]!, p[1]!);
      if (Math.abs(radial - 5) < 1e-4 && Math.abs(n[2]!) < 1e-6) {
        expect(n[0]! * p[0]! + n[1]! * p[1]!).toBeCloseTo(5, 3);
      }
    }
  });
});

const thickness = (minimum = 1): SurfaceAnalysisRequest => ({
  kind: 'thickness',
  minimum
});

describe('wall thickness analysis', () => {
  it('reads parallel planar walls as their exact separation', async () => {
    const document = documentWith({
      kind: 'box',
      dimensions: { width: 40, height: 30, depth: 2 }
    });
    const report = await analyse(document, thickness());
    expect(report.unsupported).toEqual([]);
    const body = report.bodies[0]!;
    expect(body.resolution).toBeGreaterThan(0);
    expect(
      body.faces
        .map((face) => [face.min, face.max, face.exact])
        .sort((a, b) => (a[0] as number) - (b[0] as number))
    ).toEqual([
      [2, 2, true],
      [2, 2, true],
      [30, 30, true],
      [30, 30, true],
      [40, 40, true],
      [40, 40, true]
    ]);
    // One value per overlay vertex, and the overlay is flat per triangle.
    expect(body.values).toHaveLength(body.positions.length / 3);
    expect(body.indices).toHaveLength(body.positions.length / 3);
    for (const face of body.faces) expect(face.thinnestAt).toBeDefined();
  });

  it('samples a cylinder wall across its diameter, its ends exactly', async () => {
    const document = documentWith({
      kind: 'cylinder',
      dimensions: { radius: 5, height: 20 }
    });
    const report = await analyse(document, thickness());
    const body = report.bodies[0]!;
    const wall = body.faces.find((face) => face.surface === 'cylinder')!;
    // Approximate: through the axis, to within the resolution.
    expect(wall.exact).toBe(false);
    expect(wall.min).toBeGreaterThan(10 - 4 * body.resolution!);
    expect(wall.max).toBeLessThan(10 + 4 * body.resolution!);
    const ends = body.faces.filter((face) => face.surface === 'plane');
    expect(ends.map((face) => [face.min, face.exact])).toEqual([
      [20, true],
      [20, true]
    ]);
  });

  it('finds the thin wall beside a bore, approximate, and never calls it exact', async () => {
    const report = await analyse(boredPlate(), thickness(4));
    expect(report.bodies).toHaveLength(1);
    const body = report.bodies[0]!;
    const thinnest = Math.min(...body.faces.map((face) => face.min));
    // The bore (r 6 at y 9) leaves 3 mm to the 18 mm plate's faces; samples
    // sit at triangle centres, so the reading may be a little over.
    expect(thinnest).toBeGreaterThan(3 - 2 * body.resolution!);
    expect(thinnest).toBeLessThan(3.4);
    const thin = body.faces.find((face) => face.min === thinnest)!;
    expect(thin.exact).toBe(false);
    expect(thin.thinnestAt).toBeDefined();
    // The bore wall itself reads the same 3 mm outward to the plate faces.
    const bore = body.faces.find((face) => face.surface === 'cylinder')!;
    expect(bore.min).toBeLessThan(3.4);
    expect(bore.exact).toBe(false);
  });
});

describe('wall thickness on traced surfaces', () => {
  it('traces a torus tube to its diameter, approximate', async () => {
    const document = documentWith({
      kind: 'torus',
      dimensions: { majorRadius: 10, minorRadius: 3 }
    });
    const report = await analyse(document, thickness());
    const body = report.bodies[0]!;
    const tube = body.faces.filter((face) => face.surface === 'torus');
    expect(tube.length).toBeGreaterThan(0);
    const measured = report.unsupported.filter(
      (entry) => entry.reason !== 'partly-evaluated'
    );
    expect(measured).toEqual([]);
    for (const face of tube) {
      expect(face.exact).toBe(false);
      // Through the tube's centre: its 6 mm diameter, to the resolution.
      expect(face.min).toBeGreaterThan(6 - 4 * body.resolution!);
      expect(face.max).toBeLessThan(6 + 4 * body.resolution!);
      expect(face.samples).toBeGreaterThan(0);
    }
  });
});

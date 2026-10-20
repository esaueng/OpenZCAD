import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  booleanBodies,
  createProjectDocument,
  extrudeSketch,
  findSketch
} from '@openzcad/document-core';
import { computeSketchRegions, type SketchRegion } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type FaceTopology,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';

/**
 * I01 (schema v27): ellipse and spline profiles extrude through the exact
 * builder. Ellipse pieces reach the kernel as true ellipse edges and spline
 * pieces as the NURBS the geometry layer computed, so the solid's volume is
 * the region's exact area times the height — πab·h for an ellipse — and a
 * hole loop traced clockwise keeps an orientation the next boolean accepts.
 */
describe('exact extrude of I01 curve profiles', () => {
  let kernel: ExactKernelAdapter;

  beforeAll(async () => {
    kernel = await createExactKernelAdapter();
  });

  afterAll(() => kernel.dispose());

  const HEIGHT = 10;

  async function extrudeRegion(
    objects: SketchObjectData[],
    pick: (regions: SketchRegion[]) => SketchRegion = (regions) =>
      regions.reduce((best, candidate) =>
        candidate.area > best.area ? candidate : best
      )
  ): Promise<{
    document: ProjectDocument;
    bodyId: BodyId;
    region: SketchRegion;
    volume: number;
    faces: FaceTopology[];
  }> {
    const { document: sketched, sketchId } = addSketchFeature(
      createProjectDocument('Curves', toUserId('user_curve_extrude')),
      {
        name: 'Profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects
      }
    );
    const sketch = findSketch(sketched, sketchId)!;
    const regions = computeSketchRegions(
      sketch.objectIds.map((id) => ({
        id,
        data: (sketched.nodes[id] as { data: SketchObjectData }).data
      })),
      (value) => (typeof value === 'number' ? value : Number(value))
    );
    const region = pick(regions);
    const extruded = extrudeSketch(sketched, {
      name: 'Extrude',
      sketchId,
      distance: HEIGHT,
      profiles: [
        {
          profileId: region.profileId,
          regionFingerprint: region.regionFingerprint,
          samplePoint: region.samplePoint,
          sourceArea: region.area,
          sourceEntityIds: region.sourceEntityIds
        }
      ]
    });
    const derived = await kernel.syncDocument(extruded.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[extruded.bodyId]!;
    expect(body).toBeDefined();
    return {
      document: { ...extruded.document, derived },
      bodyId: extruded.bodyId,
      region,
      volume: body.volume,
      faces: body.topology!.faces
    };
  }

  // Body volumes are measured on a 0.08 mm deflection mesh, which is exact
  // for planes and cylinders but good to about 1e-5 relative on spline
  // walls (an ellipse or spline wall is a ruled B-spline surface), so the
  // bound is 1e-4 rather than the 1e-9 analytic bodies meet.
  const relative = (actual: number, expected: number) =>
    Math.abs(actual - expected) / expected;
  const WALL_BOUND = 1e-4;
  const curvedWalls = (faces: FaceTopology[]) =>
    faces.filter((face) => face.geometry?.surfaceType !== 'plane').length;

  it('extrudes a rotated ellipse to πab·h with one curved wall', async () => {
    const { volume, faces } = await extrudeRegion([
      {
        objectKind: 'ellipse',
        centerX: 5,
        centerY: -4,
        radiusX: 30,
        radiusY: 15,
        rotationDeg: 20
      }
    ]);
    expect(relative(volume, Math.PI * 30 * 15 * HEIGHT)).toBeLessThan(
      WALL_BOUND
    );
    // Two caps and one wall: the ellipse is one edge, not facets.
    expect(faces).toHaveLength(3);
  }, 120_000);

  it('restates a taller-than-wide ellipse for the kernel', async () => {
    const { volume, faces } = await extrudeRegion([
      {
        objectKind: 'ellipse',
        centerX: 0,
        centerY: 0,
        radiusX: 8,
        radiusY: 20,
        rotationDeg: -35
      }
    ]);
    expect(relative(volume, Math.PI * 8 * 20 * HEIGHT)).toBeLessThan(
      WALL_BOUND
    );
    expect(faces).toHaveLength(3);
  }, 120_000);

  it('extrudes half an ellipse cut by a crossing line', async () => {
    // The line crosses the 0/2π seam side, so the pieces exercise the
    // quarter split and the seam split.
    const { volume } = await extrudeRegion(
      [
        {
          objectKind: 'ellipse',
          centerX: 0,
          centerY: 0,
          radiusX: 25,
          radiusY: 10,
          rotationDeg: 0
        },
        { objectKind: 'line', x1: 0, y1: -20, x2: 0, y2: 20 }
      ],
      (regions) => regions.find((region) => region.samplePoint.x > 0)!
    );
    expect(relative(volume, (Math.PI * 25 * 10 * HEIGHT) / 2)).toBeLessThan(
      WALL_BOUND
    );
  }, 120_000);

  it('extrudes an elliptical arc closed by its chord', async () => {
    const { volume, region } = await extrudeRegion([
      {
        objectKind: 'ellipse',
        centerX: 0,
        centerY: 0,
        radiusX: 20,
        radiusY: 12,
        rotationDeg: 15,
        startParamDeg: 30,
        endParamDeg: 250
      },
      {
        objectKind: 'line',
        x1:
          20 * Math.cos(Math.PI / 6) * Math.cos(Math.PI / 12) -
          12 * Math.sin(Math.PI / 6) * Math.sin(Math.PI / 12),
        y1:
          20 * Math.cos(Math.PI / 6) * Math.sin(Math.PI / 12) +
          12 * Math.sin(Math.PI / 6) * Math.cos(Math.PI / 12),
        x2:
          20 * Math.cos((250 * Math.PI) / 180) * Math.cos(Math.PI / 12) -
          12 * Math.sin((250 * Math.PI) / 180) * Math.sin(Math.PI / 12),
        y2:
          20 * Math.cos((250 * Math.PI) / 180) * Math.sin(Math.PI / 12) +
          12 * Math.sin((250 * Math.PI) / 180) * Math.cos(Math.PI / 12)
      }
    ]);
    // Segment area ab/2·(Δt − sin Δt) for a sweep Δt of 220°.
    const sweep = (220 * Math.PI) / 180;
    const expected = ((20 * 12) / 2) * (sweep - Math.sin(sweep));
    expect(region.area).toBeCloseTo(expected, 8);
    expect(relative(volume, expected * HEIGHT)).toBeLessThan(WALL_BOUND);
  }, 120_000);

  /**
   * Subtracts a corner-origin 10 × 10 × 30 box (it covers x, y ∈ [0, 10]
   * through the whole plate) from the extruded body: a hole loop wound the
   * wrong way still validates and only fails a boolean like this one.
   */
  async function subtractCornerBox(
    document: ProjectDocument,
    bodyId: BodyId
  ): Promise<number> {
    const withBox = addPrimitiveFeature(document, {
      name: 'Notch',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 30 }
    });
    const cut = booleanBodies(withBox, {
      name: 'Cut',
      operation: 'subtract',
      targetBodyIds: [bodyId, withBox.bodyOrder.at(-1)!]
    });
    const derived = await kernel.syncDocument(cut.document);
    expect(derived.warnings).toEqual([]);
    return derived.bodyRepresentations[cut.bodyId]!.volume;
  }

  it('keeps an ellipse hole loop booleanable after the extrude', async () => {
    // The hole loop runs clockwise; built counter-clockwise it would still
    // validate and only fail the next boolean.
    const { document, bodyId, volume, faces } = await extrudeRegion([
      {
        objectKind: 'rectangle',
        width: 100,
        height: 60,
        centerX: 0,
        centerY: 0
      },
      {
        objectKind: 'ellipse',
        centerX: -25,
        centerY: -10,
        radiusX: 15,
        radiusY: 8,
        rotationDeg: 30
      }
    ]);
    const plate = (100 * 60 - Math.PI * 15 * 8) * HEIGHT;
    expect(relative(volume, plate)).toBeLessThan(WALL_BOUND);
    // Four quarter walls, not facets: the kernel passes only a closed
    // circle through as a single-edge hole.
    expect(curvedWalls(faces)).toBe(4);
    expect(faces).toHaveLength(10);
    expect(
      relative(await subtractCornerBox(document, bodyId), plate - 1000)
    ).toBeLessThan(WALL_BOUND);
  }, 120_000);

  it('extrudes a closed fit spline to its exact area', async () => {
    const { volume, region, faces } = await extrudeRegion([
      {
        objectKind: 'spline',
        method: 'fit',
        closed: true,
        points: [
          { x: 0, y: 0 },
          { x: 30, y: -6 },
          { x: 38, y: 18 },
          { x: 12, y: 26 },
          { x: -4, y: 14 }
        ]
      }
    ]);
    expect(region.outer.curves.map((curve) => curve.kind)).toEqual(['spline']);
    expect(relative(volume, region.area * HEIGHT)).toBeLessThan(WALL_BOUND);
    // The closed spline goes in as two exact halves: two walls, two caps.
    expect(faces).toHaveLength(4);
    expect(curvedWalls(faces)).toBe(2);
  }, 120_000);

  it('extrudes an open control spline closed by a line', async () => {
    const { volume, region } = await extrudeRegion([
      {
        objectKind: 'spline',
        method: 'control',
        degree: 3,
        points: [
          { x: 0, y: 0 },
          { x: 5, y: 25 },
          { x: 25, y: 30 },
          { x: 40, y: 10 },
          { x: 45, y: 0 }
        ]
      },
      { objectKind: 'line', x1: 45, y1: 0, x2: 0, y2: 0 }
    ]);
    expect(relative(volume, region.area * HEIGHT)).toBeLessThan(WALL_BOUND);
  }, 120_000);

  it('keeps a spline hole loop booleanable after the extrude', async () => {
    const { document, bodyId, volume, region } = await extrudeRegion([
      {
        objectKind: 'rectangle',
        width: 120,
        height: 70,
        centerX: 0,
        centerY: 0
      },
      {
        objectKind: 'spline',
        method: 'fit',
        closed: true,
        points: [
          { x: -40, y: -10 },
          { x: -10, y: -20 },
          { x: -5, y: 10 },
          { x: -30, y: 22 }
        ]
      }
    ]);
    expect(region.holes).toHaveLength(1);
    expect(relative(volume, region.area * HEIGHT)).toBeLessThan(WALL_BOUND);
    expect(
      relative(await subtractCornerBox(document, bodyId), volume - 1000)
    ).toBeLessThan(WALL_BOUND);
  }, 120_000);
});

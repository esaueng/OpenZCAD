import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  holeBody
} from '@openzcad/document-core';
import { computeSketchRegions } from '@openzcad/geometry';
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
 * A body extruded from a region with an inner loop stays modifiable.
 *
 * A sketch circle traces its hole loop CLOCKWISE, and that direction has to
 * survive into the kernel edge — a circle carries its sense in its axis, not
 * in a separate orientation flag. Building the inner wire counter-clockwise,
 * the same way as the outer one, still extrudes and still validates, so the
 * defect is invisible until the NEXT operation: the following boolean comes
 * back with "shared edges have inconsistent face orientations" and every hole
 * drilled into the pocketed body is refused.
 *
 * The second half of this file is the reason the fix reverses the circle
 * through a pinned reference direction instead of just negating its axis.
 * Negating the axis moves the seam vertex to the far side of the circle, and
 * that vertex is inside the cap face's vertex mean — which is both the face's
 * persisted fingerprint input and the origin a hole's (u, v) is measured from.
 * Flipping it would silently relocate every hole on every saved pocketed part.
 */
describe('a region hole loop keeps its winding', () => {
  let kernel: ExactKernelAdapter;

  beforeAll(async () => {
    kernel = await createExactKernelAdapter();
  });

  afterAll(() => kernel.dispose());

  const PLATE_X = 60;
  const PLATE_Y = 20;
  const HEIGHT = 8;
  const POCKET_RADIUS = 5;
  const BORE_RADIUS = 3;

  /** Extrudes the largest sketch region and returns its top cap. */
  async function extrudeLargestRegion(objects: SketchObjectData[]): Promise<{
    document: ProjectDocument;
    bodyId: BodyId;
    cap: FaceTopology;
    volume: number;
  }> {
    const { document: sketched, sketchId } = addSketchFeature(
      createProjectDocument('Plate', toUserId('user_region_winding')),
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
    const region = regions.reduce((best, candidate) =>
      candidate.area > best.area ? candidate : best
    );
    const extruded = extrudeSketch(sketched, {
      name: 'Extrude',
      sketchId,
      distance: HEIGHT,
      profiles: [
        {
          profileId: region.profileId,
          regionFingerprint: region.regionFingerprint,
          samplePoint: region.centroid,
          sourceArea: region.area,
          sourceEntityIds: region.sourceEntityIds
        }
      ]
    });
    const derived = await kernel.syncDocument(extruded.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[extruded.bodyId]!;
    const cap = body.topology!.faces
      .filter((face) => face.geometry?.surfaceType === 'plane')
      .reduce((best, face) =>
        face.geometry!.center.z > best.geometry!.center.z ? face : best
      );
    return {
      document: { ...extruded.document, derived },
      bodyId: extruded.bodyId,
      cap,
      volume: body.volume
    };
  }

  /** A 60 x 20 x 8 plate with an r5 pocket punched through it at x = 14. */
  const pocketedPlate = () =>
    extrudeLargestRegion([
      {
        objectKind: 'rectangle',
        width: PLATE_X,
        height: PLATE_Y,
        centerX: 0,
        centerY: 0
      },
      { objectKind: 'circle', radius: POCKET_RADIUS, centerX: 14, centerY: 0 }
    ]);

  it('drills a second hole into an extruded pocket', async () => {
    const { document, bodyId, cap, volume } = await pocketedPlate();
    const plate =
      (PLATE_X * PLATE_Y - Math.PI * POCKET_RADIUS ** 2) * HEIGHT;
    expect(Math.abs(volume - plate) / plate).toBeLessThan(1e-9);

    // The bore is inside the cap and clear of the pocket wall, so this is a
    // plain cut with nothing geometrically delicate about it.
    const drilled = holeBody(document, {
      name: 'Bore',
      targetBodyId: bodyId,
      faceHash: cap.hash,
      ...(cap.reference ? { faceReference: cap.reference } : {}),
      style: 'simple',
      diameter: 2 * BORE_RADIUS,
      depthMode: 'through',
      position: { u: 0, v: 0 }
    });
    const derived = await kernel.syncDocument(drilled.document);
    expect(derived.warnings).toEqual([]);

    const body = derived.bodyRepresentations[drilled.bodyId]!;
    const expected = plate - Math.PI * BORE_RADIUS ** 2 * HEIGHT;
    expect(Math.abs(body.volume - expected) / expected).toBeLessThan(1e-9);
    // Four walls, two caps, the pocket, and the new bore — not a mesh.
    expect(body.topology!.faces).toHaveLength(8);
    expect(
      body.topology!.faces.filter(
        (face) =>
          face.geometry?.surfaceType === 'cylinder' &&
          Math.abs((face.geometry.radius ?? 0) - BORE_RADIUS) < 1e-9
      )
    ).toHaveLength(1);
  }, 120_000);

  it('leaves the pocket seam vertex where it has always been', async () => {
    const { cap } = await pocketedPlate();
    // Four rectangle corners about the origin plus the circle's single seam
    // vertex, which Remus places a quarter turn round from +x.
    expect(cap.geometry!.center.x).toBeCloseTo(14 / 5, 12);
    expect(cap.geometry!.center.y).toBeCloseTo(POCKET_RADIUS / 5, 12);
    expect(cap.geometry!.center.z).toBeCloseTo(HEIGHT, 12);
  }, 120_000);

  it('drills the wall of an annular extrude', async () => {
    // Both branches on one body: the ring's outer boundary is a circle that
    // must stay counter-clockwise, its bore a circle that must reverse.
    const { document, bodyId, cap, volume } = await extrudeLargestRegion([
      { objectKind: 'circle', radius: 20, centerX: 0, centerY: 0 },
      { objectKind: 'circle', radius: 8, centerX: 0, centerY: 0 }
    ]);
    const ring = Math.PI * (400 - 64) * HEIGHT;
    expect(Math.abs(volume - ring) / ring).toBeLessThan(1e-9);
    // The cap's two seams sit at r = 20 and r = 8 on the same ray, so their
    // mean is the middle of the ring wall — clear of both walls for an r2 bore.
    expect(cap.geometry!.center.y).toBeCloseTo(14, 12);

    const drilled = holeBody(document, {
      name: 'Bore',
      targetBodyId: bodyId,
      faceHash: cap.hash,
      ...(cap.reference ? { faceReference: cap.reference } : {}),
      style: 'simple',
      diameter: 4,
      depthMode: 'through',
      position: { u: 0, v: 0 }
    });
    const derived = await kernel.syncDocument(drilled.document);
    expect(derived.warnings).toEqual([]);
    const expected = ring - Math.PI * 4 * HEIGHT;
    const body = derived.bodyRepresentations[drilled.bodyId]!;
    expect(Math.abs(body.volume - expected) / expected).toBeLessThan(1e-9);
  }, 120_000);

  it('leaves an outer circle counter-clockwise', async () => {
    // Only hole loops reverse. A plain disc's boundary is an outer loop, so
    // its seam — and every reference measured against it — must not move.
    const { cap, volume } = await extrudeLargestRegion([
      { objectKind: 'circle', radius: 10, centerX: 0, centerY: 0 }
    ]);
    const disc = Math.PI * 100 * HEIGHT;
    expect(Math.abs(volume - disc) / disc).toBeLessThan(1e-9);
    expect(cap.geometry!.center.x).toBeCloseTo(0, 12);
    expect(cap.geometry!.center.y).toBeCloseTo(10, 12);
  }, 120_000);
});

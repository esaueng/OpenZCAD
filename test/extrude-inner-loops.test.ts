import { describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { computeSketchRegions } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

/**
 * Extruding a sketch region KEEPS its inner loops as holes.
 *
 * This pins behaviour that is currently CORRECT, which is unusual for this
 * suite and deliberate. Inner-wire handling is the single most repeated defect
 * family on this project — `draft` dropped inner wires, `shell` dropped holes,
 * `chamfer` and `split` both filled bores — so the one operation in that family
 * that gets it right is worth holding still.
 *
 * Every expectation is a closed form written out here, never a kernel reading.
 *
 * Note on the API, because getting this wrong looks exactly like a defect:
 * `extrudeSketch` has TWO paths. Given `profile`/`profiles` it goes through
 * `buildRegionExtrude` and honours regions. Given neither, it deliberately
 * takes `sketch.objectIds[0]` and extrudes that ONE object — so a sketch of a
 * rectangle plus a circle extrudes as a plain 16000 block with the circle
 * ignored. That is the documented contract, not a bug, and this file exercises
 * the region path on purpose.
 *
 * Region analysis was checked independently before any extrusion, since a
 * correct extrusion of a wrong region would pass for the wrong reason:
 *
 *   rect 40 + centred r5     -> 1521.460 (1 hole) and 78.540
 *   rect 40 + r15 + r5       -> 893.142 (1 hole), 628.319 (1 hole), 78.540
 *   two disjoint r5          -> 78.540, 78.540
 *   two overlapping r5 d=6   -> 56.175, 56.175, 22.365, summing to the union
 */
describe('extruding a sketch region with inner loops', () => {
  let adapter: ExactKernelAdapter;

  const PLATE = 40;
  const DEPTH = 10;

  const extrudeRegions = async (
    objects: unknown[],
    pick: (regions: { area: number; holes: unknown[] }[]) => number[]
  ) => {
    adapter ??= await createExactKernelAdapter();
    const document = createProjectDocument('Region', toUserId('user_region'));
    const { document: sketched, sketchId } = addSketchFeature(document, {
      name: 'Profile',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: objects as never
    });
    const sketch = findSketch(sketched, sketchId)!;
    const regionObjects = sketch.objectIds.map((id) => ({
      id,
      data: (sketched.nodes[id] as { data: unknown }).data
    }));
    const regions = computeSketchRegions(regionObjects as never, (value) =>
      typeof value === 'number' ? value : Number(value)
    );
    const chosen = pick(regions as never).map((index) => regions[index]!);
    const { document: extruded } = extrudeSketch(sketched, {
      name: 'Extrude',
      sketchId,
      distance: DEPTH,
      profiles: chosen.map((region) => ({
        profileId: region.profileId,
        regionFingerprint: region.regionFingerprint,
        samplePoint: region.centroid,
        sourceArea: region.area,
        sourceEntityIds: region.sourceEntityIds
      }))
    });
    const derived = await adapter.syncDocument(extruded);
    const body = derived.bodyRepresentations[extruded.bodyOrder.at(-1)!]!;
    return {
      regions,
      volume: body.volume,
      faces: body.topology?.faces.length ?? 0,
      warnings: derived.warnings
    };
  };

  /** Index of the single region carrying holes. */
  const holed = (regions: { holes: unknown[] }[]) =>
    regions.flatMap((region, index) =>
      region.holes.length > 0 ? [index] : []
    );

  it('subtracts one bore from a plate', async () => {
    const { regions, volume, faces, warnings } = await extrudeRegions(
      [
        {
          objectKind: 'rectangle',
          width: PLATE,
          height: PLATE,
          centerX: 0,
          centerY: 0
        },
        { objectKind: 'circle', radius: 5, centerX: 0, centerY: 0 }
      ],
      holed
    );
    // The analysis first: one holed cell and one island.
    expect(regions).toHaveLength(2);
    const expected = (PLATE * PLATE - Math.PI * 25) * DEPTH;
    expect(Math.abs(volume - expected) / expected).toBeLessThan(1e-9);
    // Four walls, two caps, one bore.
    expect(faces).toBe(7);
    expect(warnings).toEqual([]);
  }, 120_000);

  it('subtracts two bores from one plate', async () => {
    const { volume, faces, warnings } = await extrudeRegions(
      [
        {
          objectKind: 'rectangle',
          width: PLATE,
          height: PLATE,
          centerX: 0,
          centerY: 0
        },
        { objectKind: 'circle', radius: 5, centerX: -10, centerY: 0 },
        { objectKind: 'circle', radius: 5, centerX: 10, centerY: 0 }
      ],
      holed
    );
    const expected = (PLATE * PLATE - 2 * Math.PI * 25) * DEPTH;
    expect(Math.abs(volume - expected) / expected).toBeLessThan(1e-9);
    expect(faces).toBe(8);
    expect(warnings).toEqual([]);
  }, 120_000);

  it('extrudes the annulus between two nested circles', async () => {
    // The middle cell of a rect / r15 / r5 nest: bounded outside by r15 and
    // holed by r5, so it is an annular prism and nothing else.
    const { regions, volume, faces, warnings } = await extrudeRegions(
      [
        {
          objectKind: 'rectangle',
          width: PLATE,
          height: PLATE,
          centerX: 0,
          centerY: 0
        },
        { objectKind: 'circle', radius: 15, centerX: 0, centerY: 0 },
        { objectKind: 'circle', radius: 5, centerX: 0, centerY: 0 }
      ],
      (all) =>
        all.flatMap((region, index) =>
          region.area > 600 && region.area < 700 ? [index] : []
        )
    );
    expect(regions).toHaveLength(3);
    const expected = (Math.PI * 225 - Math.PI * 25) * DEPTH;
    expect(Math.abs(volume - expected) / expected).toBeLessThan(1e-9);
    // Outer wall, inner wall, two caps.
    expect(faces).toBe(4);
    expect(warnings).toEqual([]);
  }, 120_000);

  it('unions every region back to the undrilled plate', async () => {
    // The complement of the tests above: take ALL cells, including the
    // islands that fill the holes, and the result must be the solid block.
    const { volume, faces } = await extrudeRegions(
      [
        {
          objectKind: 'rectangle',
          width: PLATE,
          height: PLATE,
          centerX: 0,
          centerY: 0
        },
        { objectKind: 'circle', radius: 15, centerX: 0, centerY: 0 },
        { objectKind: 'circle', radius: 5, centerX: 0, centerY: 0 }
      ],
      (all) => all.map((_, index) => index)
    );
    expect(volume).toBeCloseTo(PLATE * PLATE * DEPTH, 6);
    // And it is a plain block again, not three stacked prisms.
    expect(faces).toBe(6);
  }, 120_000);
});

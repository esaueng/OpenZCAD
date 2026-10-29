import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { buildDemoDocument, DEMO_DEFINITIONS } from '../apps/web/src/lib/demos';

/**
 * Design review, demo Pipe Flange: dragging a bolt hole's diameter handle
 * inward always ended on "The hole kept its original diameter instead of
 * resizing to Ø4." The through-hole resize narrows a bore by fusing the
 * annulus between the two radii, and on these patterned holes Remus answers
 * that coincident fuse with the untouched body. Widening worked, so the
 * handle read as half-broken.
 */
describe('demo flange bolt hole resize', () => {
  let adapter: ExactKernelAdapter;
  let flange: ProjectDocument;
  let bodyId: BodyId;
  let hole: FaceTopology;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    const definition = DEMO_DEFINITIONS.find(
      (candidate) => candidate.key === 'flange'
    )!;
    flange = await buildDemoDocument(
      definition,
      toUserId('user_flange_hole_resize'),
      (candidate) => adapter.syncDocument(candidate)
    );
    bodyId = flange.derived.exportableBodyIds[0] as BodyId;
    hole = (
      flange.derived.bodyRepresentations[bodyId]?.topology?.faces ?? []
    ).find(
      (face) =>
        face.geometry?.featureType === 'through-hole' &&
        Math.abs((face.geometry.diameter ?? 0) - 6) < 1e-6
    )!;
  }, 120_000);

  afterAll(() => adapter.dispose());

  async function resize(diameter: number) {
    const document = new CommandManager(flange).runTransaction('Resize', [
      commandFactories.directEditBody({
        name: `Resize to ${diameter}`,
        targetBodyId: bodyId,
        operation: {
          kind: 'resize-through-hole',
          faceHash: hole.hash,
          sourceDiameter: hole.geometry!.diameter!,
          sourceAxisStart: hole.geometry!.axisStart!,
          sourceAxisEnd: hole.geometry!.axisEnd!,
          diameter
        }
      })
    ]);
    const derived = await adapter.syncDocument(document);
    const body = derived.bodyRepresentations[bodyId]!;
    const diameters = (body.topology?.faces ?? [])
      .filter((face) => face.geometry?.featureType === 'through-hole')
      .map((face) => face.geometry!.diameter!);
    return { derived, body, diameters };
  }

  it('picks one of the six 6 mm bolt holes', () => {
    expect(hole?.geometry).toMatchObject({
      surfaceType: 'cylinder',
      editableDimension: 'diameter'
    });
  });

  it.each([12, 4])(
    'resizes one bolt hole to %d mm and leaves the other five',
    async (diameter) => {
      const source = flange.derived.bodyRepresentations[bodyId]!;
      const { derived, body, diameters } = await resize(diameter);
      expect(derived.warnings).toEqual([]);
      expect(
        diameters.filter((value) => Math.abs(value - diameter) < 1e-6)
      ).toHaveLength(1);
      expect(
        diameters.filter((value) => Math.abs(value - 6) < 1e-6)
      ).toHaveLength(5);
      // Same face count: the bore is replaced, not split or doubled.
      expect(body.faceCount).toBe(source.faceCount);
      // The volume moves by exactly the annulus between the two bores.
      const length = 10;
      const annulus = (Math.PI / 4) * (36 - diameter * diameter) * length;
      expect(body.volume - source.volume).toBeCloseTo(annulus, 0);
    },
    120_000
  );
});

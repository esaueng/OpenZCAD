import { it, expect } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyRepresentation,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import { rotationalSleeveStep } from './support/rotational-sleeve';

function wall(body: BodyRepresentation, radius: number): FaceTopology {
  const matches = body.topology!.faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'cylinder' &&
      Math.abs(face.geometry.radius! - radius) < 1e-6
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

it('replays bore, outer wall, neck and cap edits with complete references through undo and reopen', async () => {
  const imported = importStepBody(
    createProjectDocument('Rotational sleeve', toUserId('user_test')),
    {
      name: 'Sleeve',
      sourceName: 'rotational-sleeve.step',
      artifactId: 'rotational-sleeve',
      stepText: new TextDecoder().decode(await rotationalSleeveStep())
    }
  );
  const adapter = await createExactKernelAdapter();
  const fresh = await createExactKernelAdapter();
  try {
    const manager = new CommandManager(imported.document);
    const sync = async () => {
      const derived = await adapter.syncDocument(manager.document);
      expect(derived.warnings).toEqual([]);
      manager.commitDerivedState(derived);
      const body = derived.bodyRepresentations[imported.bodyId]!;
      expect(body.faceCount).toBe(13);
      expect(
        body
          .topology!.faces.filter((face) => !face.reference)
          .map((face) => ({ hash: face.hash, geometry: face.geometry }))
      ).toEqual([]);
      return body;
    };
    let body = await sync();
    for (const [from, radius, concavity] of [
      [11.5, 11, 'hole'],
      [11, 12, 'hole'],
      [20, 19.5, 'boss'],
      [16.5, 16, 'boss']
    ] as const) {
      const face = wall(body, from);
      const g = face.geometry!;
      manager.execute(
        commandFactories.directEditBody({
          name: 'Resize wall',
          targetBodyId: imported.bodyId,
          operation: {
            kind: 'resize-cylindrical-face',
            faceHash: face.hash,
            faceReference: face.reference!,
            sourceRadius: g.radius!,
            sourceAxisStart: g.axisStart!,
            sourceAxisEnd: g.axisEnd!,
            concavity,
            radius
          }
        })
      );
      body = await sync();
      expect(wall(body, radius).reference?.lineageName).toBe(
        face.reference!.lineageName
      );
    }
    const beforeFloor = body.volume;
    for (const [sense, offset] of [
      [1, 14],
      [-1, 1]
    ] as const) {
      const face = body.topology!.faces.find(
        (face) =>
          face.geometry?.surfaceType === 'plane' &&
          face.geometry.normal!.z * sense > 0.99 &&
          (sense < 0 || face.geometry.area < 500)
      )!;
      const plan = planFaceOffset({
        document: manager.document,
        bodyId: imported.bodyId,
        face,
        faceHash: face.hash,
        offset
      });
      expect(plan?.kind).toBe('direct-edit');
      manager.execute(plan!.command);
      body = await sync();
      expect(
        body.topology!.faces.some(
          (candidate) =>
            candidate.geometry?.surfaceType === 'plane' &&
            candidate.geometry.normal!.z * sense > 0.99 &&
            Math.abs(candidate.geometry.center.z - (sense > 0 ? 30.5 : -1)) <
              1e-6
        )
      ).toBe(true);
    }
    expect(body.volume - beforeFloor).toBeCloseTo(
      Math.PI * 12 ** 2 * 14 + (Math.PI * (16 ** 2 + 16 * 15 + 15 ** 2)) / 3,
      4
    );
    const acceptedVolume = body.volume;
    manager.undo();
    expect((await sync()).volume).toBeLessThan(acceptedVolume);
    manager.redo();
    expect((await sync()).volume).toBeCloseTo(acceptedVolume, 5);
    const reopened = await fresh.syncDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    expect(reopened.warnings).toEqual([]);
    const restored = reopened.bodyRepresentations[imported.bodyId]!;
    expect(restored.faceCount).toBe(13);
    expect(restored.volume).toBeCloseTo(acceptedVolume, 5);
    expect(restored.topology!.faces.map((face) => face.reference)).toEqual(
      body.topology!.faces.map((face) => face.reference)
    );
  } finally {
    adapter.dispose();
    fresh.dispose();
  }
}, 180_000);

import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  importStepBody,
  normalizeDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyRepresentation,
  type ProjectDocument
} from '@openzcad/shared';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../packages/kernel-adapter/src/boolean-result-validation';
import { sphereCylinderUnionInputs } from './support/sphere-cylinder-union';

function expectUnion(body: BodyRepresentation) {
  expect(body.exportableStep).toBe(true);
  expect(
    body.topology?.faces.map((face) => face.geometry?.surfaceType).sort()
  ).toEqual(['cylinder', 'plane', 'sphere', 'sphere']);
  // Independent integration of the sphere height over the cylinder disk.
  const sphereVolume = (4 * Math.PI * 73.5 ** 3) / 3;
  expect(Math.abs(body.volume - sphereVolume - 6030.504746075203)).toBeLessThan(
    0.05
  );
  const closure = inspectTriangleMeshClosure(
    body.mesh.vertices,
    body.mesh.indices
  );
  expect(
    isClosedConsistentlyOrientedMesh(closure),
    JSON.stringify(closure)
  ).toBe(true);
  expect(body.bbox.min.x).toBeCloseTo(-48, 6);
  expect(body.bbox.min.y).toBeCloseTo(-75, 6);
  expect(body.bbox.min.z).toBeCloseTo(-73.5, 6);
  expect(body.bbox.max.x).toBeCloseTo(99, 6);
  expect(body.bbox.max.y).toBeCloseTo(72, 6);
  expect(body.bbox.max.z).toBeCloseTo(122.1, 6);
}

describe('off-axis sphere cylinder union', () => {
  it.each([false, true])(
    'joins the shared closed section, swapped=%s',
    async (swapped) => {
      const { document, sphere, cylinder } = sphereCylinderUnionInputs();
      const manager = new CommandManager(document);
      const adapter = await createExactKernelAdapter();
      try {
        manager.execute(
          commandFactories.booleanBodies({
            name: 'Union',
            operation: 'union',
            targetBodyIds: swapped ? [cylinder, sphere] : [sphere, cylinder]
          })
        );
        const bodyId = manager.document.bodyOrder.at(-1)!;
        const joined = await adapter.syncDocument(manager.document);
        expect(joined.warnings).toEqual([]);
        expectUnion(joined.bodyRepresentations[bodyId]!);
        expect(joined.bodyRepresentations[sphere]?.consumed).toBe(true);
        expect(joined.bodyRepresentations[cylinder]?.consumed).toBe(true);
        manager.undo();
        const undone = await adapter.syncDocument(manager.document);
        expect(undone.warnings).toEqual([]);
        expect(undone.bodyRepresentations[sphere]?.consumed).not.toBe(true);
        expect(undone.bodyRepresentations[cylinder]?.consumed).not.toBe(true);
        manager.redo();
        const reopened = normalizeDocument(
          JSON.parse(
            JSON.stringify(withoutDerivedProjection(manager.document))
          ) as ProjectDocument
        );
        const fresh = await createExactKernelAdapter();
        try {
          const rebuilt = await fresh.syncDocument(reopened);
          expect(rebuilt.warnings).toEqual([]);
          expectUnion(rebuilt.bodyRepresentations[bodyId]!);
          const step = await fresh.exportStep(reopened, [bodyId]);
          expect(await fresh.inspectStep(step)).toMatchObject({
            solid: true,
            valid: true
          });
          const imported = importStepBody(
            createProjectDocument(
              'Union round trip',
              toUserId('user_union_test')
            ),
            {
              name: 'Union',
              artifactId: 'artifact_union',
              sourceName: 'union.step',
              stepText: step
            }
          ).document;
          const roundTrip = await fresh.syncDocument(imported);
          expect(roundTrip.warnings).toEqual([]);
          expectUnion(roundTrip.bodyRepresentations[imported.bodyOrder[0]!]!);
        } finally {
          fresh.dispose();
        }
      } finally {
        adapter.dispose();
      }
    },
    120_000
  );
});

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  directEditBody,
  importStepBody,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyRepresentation,
  type DirectEditOperation,
  type ProjectDocument,
  type FeatureId,
  type FaceTopology
} from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { applyDirectEdit } from '../packages/kernel-adapter/src/exact-direct-edit-ops';
import { measureFaceGeometry } from '../packages/kernel-adapter/src/exact-measure';
import { faceFingerprint } from '../packages/kernel-adapter/src/exact-witnesses';
import { topologyCandidatesForSolid } from '../packages/kernel-adapter/src/exact-lineage-builders';
import { createRemusSemanticLineage } from '../packages/kernel-adapter/src/remus-lineage';
import { compoundOffsetSolids } from './support/compound-offset';

type Offset = Extract<DirectEditOperation, { kind: 'offset-face' }>;
function operationFor(
  face: FaceTopology,
  offset: number,
  withReference = true
): Offset {
  return {
    kind: 'offset-face',
    faceHash: face.hash,
    ...(withReference && face.reference
      ? { faceReference: face.reference }
      : {}),
    sourceSurfaceType: 'plane',
    sourceArea: face.geometry!.area,
    sourceCenter: face.geometry!.center,
    sourceNormal: face.geometry!.normal!,
    offset
  };
}
function cap(body: BodyRepresentation, x: number): FaceTopology {
  const face = body.topology!.faces.find(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      Math.abs(face.geometry.center.x - x) < 1e-6 &&
      face.geometry.normal!.x > 0.99
  );
  expect(face).toBeDefined();
  return face!;
}
function siblings(body: BodyRepresentation) {
  // Everything left of the cap cylinder belongs to one of the other solids.
  return body
    .topology!.faces.filter((face) => face.geometry!.center.x < 50)
    .map((face) => ({
      hash: face.hash,
      reference: face.reference,
      geometry: face.geometry
    }))
    .sort((a, b) => a.hash - b.hash);
}

describe('compound imported face offsets', () => {
  let stepText: string;
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    const kernel = new RemusKernel();
    const io = await loadRemusTranslators();
    stepText = new TextDecoder().decode(
      io.exportStep(
        kernel.serializeSolids(Uint32Array.from(compoundOffsetSolids(kernel)))
      )
    );
    kernel.free();
  });
  afterEach(() => {
    adapter?.dispose();
    vi.restoreAllMocks();
  });
  async function fixture() {
    adapter = await createExactKernelAdapter();
    const imported = importStepBody(
      createProjectDocument('Compound offset', toUserId('user_test')),
      {
        name: 'Components',
        sourceName: 'components.step',
        artifactId: 'artifact_compound_offset',
        stepText
      }
    );
    const document = transformBody(imported.document, {
      name: 'Position components',
      targetBodyId: imported.bodyId,
      translation: { x: 0, y: 20, z: 10 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const before = await adapter.syncDocument(document);
    expect(before.warnings).toEqual([]);
    return {
      document,
      bodyId: imported.bodyId,
      before: before.bodyRepresentations[imported.bodyId]!
    };
  }

  it.each([true, false])(
    'offsets only the owner and exports four exact solids (reference=%s)',
    async (withReference) => {
      const { document, bodyId, before } = await fixture();
      const face = cap(before, 63);
      expect(face.reference).toBeDefined();
      const fuse = vi.spyOn(RemusKernel.prototype, 'fuseAll');
      for (const offset of [5, -1]) {
        const edited = directEditBody(document, {
          name: 'Offset cap',
          targetBodyId: bodyId,
          operation: operationFor(face, offset, withReference)
        }).document;
        const derived = await adapter.syncDocument(edited);
        expect(derived.warnings).toEqual([]);
        const body = derived.bodyRepresentations[bodyId]!;
        expect(body.faceCount).toBe(before.faceCount);
        expect(body.volume - before.volume).toBeCloseTo(
          Math.PI * 225 * offset,
          5
        );
        expect(cap(body, 63 + offset).geometry!.area).toBeCloseTo(
          Math.PI * 225,
          7
        );
        expect(
          body.topology!.faces.find((face) => face.geometry?.radius === 15)
            ?.geometry?.axialLength
        ).toBeCloseTo(12 + offset, 7);
        expect(siblings(body)).toEqual(siblings(before));
        const exported = await adapter.exportStep(edited, [bodyId]);
        const kernel = new RemusKernel();
        try {
          const io = await loadRemusTranslators();
          const solids = [
            ...kernel.deserializeSolids(
              io.importStep(new TextEncoder().encode(exported))
            )
          ];
          expect(solids).toHaveLength(4);
          expect(
            solids.map((solid) => kernel.validateSolidRelaxed(solid))
          ).toEqual([0, 0, 0, 0]);
          expect(
            solids.reduce((sum, solid) => sum + kernel.volume(solid, 0.01), 0)
          ).toBeCloseTo(body.volume, 3);
          expect(
            solids
              .flatMap((solid) =>
                [...kernel.getSolidFaces(solid)].map((face) =>
                  measureFaceGeometry(kernel, face)
                )
              )
              .filter((face) => face?.surfaceType === 'cylinder')
          ).toHaveLength(2);
        } finally {
          kernel.free();
        }
      }
      expect(fuse).not.toHaveBeenCalled();
    }
  );

  it('replays, undoes, redoes and follows a later edit on an untouched sibling', async () => {
    const { document, bodyId, before } = await fixture();
    const siblingFace = cap(before, 55);
    expect(siblingFace.reference).toBeDefined();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.directEditBody({
        name: 'Grow cap',
        targetBodyId: bodyId,
        operation: operationFor(cap(before, 63), 5)
      })
    );
    manager.execute(
      commandFactories.directEditBody({
        name: 'Grow sibling',
        targetBodyId: bodyId,
        operation: operationFor(siblingFace, 1)
      })
    );
    const expectedVolume = before.volume + Math.PI * (225 * 5 + 64);
    const check = async (expected: number) => {
      const result = await adapter.syncDocument(manager.document);
      expect(result.warnings).toEqual([]);
      expect(result.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
        expected,
        5
      );
    };
    await check(expectedVolume);
    manager.undo();
    await check(expectedVolume - Math.PI * 64);
    manager.redo();
    await check(expectedVolume);
    const saved = JSON.parse(
      JSON.stringify(manager.document)
    ) as ProjectDocument;
    adapter.dispose();
    adapter = await createExactKernelAdapter();
    const reopened = await adapter.syncDocument(saved);
    expect(reopened.warnings).toEqual([]);
    expect(reopened.bodyRepresentations[bodyId]!.volume).toBeCloseTo(
      expectedVolume,
      5
    );
    const again = directEditBody(saved, {
      name: 'Grow again',
      targetBodyId: bodyId,
      operation: operationFor(cap(reopened.bodyRepresentations[bodyId]!, 68), 1)
    }).document;
    const repeated = await adapter.syncDocument(again);
    expect(repeated.warnings).toEqual([]);
    expect(cap(repeated.bodyRepresentations[bodyId]!, 69)).toBeDefined();
  });

  it('refuses a stale semantic reference without falling back to its matching hash', async () => {
    const { document, bodyId, before } = await fixture();
    const operation = operationFor(cap(before, 63), 5);
    operation.faceReference = {
      ...operation.faceReference!,
      lineageName: 'missing.face'
    };
    const bad = directEditBody(document, {
      name: 'Stale offset',
      targetBodyId: bodyId,
      operation
    }).document;
    const result = await adapter.syncDocument(bad);
    expect(result.warnings.join('\n')).toContain('Direct-edit face is stale');
    expect(result.bodyRepresentations[bodyId]!.volume).toBe(before.volume);
    expect(siblings(result.bodyRepresentations[bodyId]!)).toEqual(
      siblings(before)
    );
  });
});

it('refuses ambiguous ownership and preserves exact sibling handles and bytes', () => {
  const kernel = new RemusKernel();
  try {
    const solids = compoundOffsetSolids(kernel);
    const owner = solids[2]!;
    const face = [...kernel.getSolidFaces(owner)].find(
      (handle) => (measureFaceGeometry(kernel, handle)?.normal?.x ?? 0) > 0.99
    )!;
    const topology = {
      hash: faceFingerprint(kernel, face),
      geometry: measureFaceGeometry(kernel, face)!
    } as FaceTopology;
    const operation = operationFor(topology, 5, false);
    const siblingBytes = solids
      .filter((_, i) => i !== 2)
      .map((solid) => kernel.serializeSolids(Uint32Array.of(solid)));
    const edited = applyDirectEdit(kernel, { solids }, operation, {});
    expect(edited.solids.filter((_, i) => i !== 2)).toEqual(
      solids.filter((_, i) => i !== 2)
    );
    expect(
      edited.solids
        .filter((_, i) => i !== 2)
        .map((solid) => kernel.serializeSolids(Uint32Array.of(solid)))
    ).toEqual(siblingBytes);
    const duplicate = kernel.deserializeSolids(
      kernel.serializeSolids(Uint32Array.of(owner))
    )[0]!;
    expect(() =>
      applyDirectEdit(kernel, { solids: [owner, duplicate] }, operation, {})
    ).toThrow(/ambiguous/i);
    const candidates = [owner, duplicate].flatMap((solid) =>
      topologyCandidatesForSolid(kernel, solid)
    );
    const lineage = createRemusSemanticLineage(
      'feature_test' as FeatureId,
      'primitive',
      candidates.map((candidate) => ({
        ...candidate,
        lineageName: `face.${candidate.handle}`
      }))
    );
    const reference = lineage.faceReferences.get(face)!;
    const duplicateFace = [...kernel.getSolidFaces(duplicate)].find(
      (handle) => faceFingerprint(kernel, handle) === operation.faceHash
    )!;
    lineage.faceReferences.set(duplicateFace, reference);
    expect(() =>
      applyDirectEdit(
        kernel,
        { solids: [owner, duplicate], lineage },
        { ...operation, faceReference: reference },
        {}
      )
    ).toThrow(/multiple compatible candidates/);
  } finally {
    kernel.free();
  }
});

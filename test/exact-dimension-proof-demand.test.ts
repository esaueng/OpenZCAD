import { expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  directEditBody,
  importStepBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { createExactKernelAdapter } from '../packages/kernel-adapter/src/exact';
import * as distances from '../packages/kernel-adapter/src/exact-face-distance';

it('defers unrelated planar proofs after diameter acceptance and proves a foreground demand afresh', async () => {
  const adapter = await createExactKernelAdapter();
  const proof = vi.spyOn(distances, 'proveChangedFaceDistance');
  try {
    const native = addPrimitiveFeature(
      createProjectDocument('Dimension proof demand', toUserId('user')),
      {
        name: 'Post',
        primitiveKind: 'cylinder',
        dimensions: { radius: 6, height: 20 }
      }
    );
    const step = await adapter.exportStep(native, [native.bodyOrder[0]!]);
    const imported = importStepBody(
      createProjectDocument('Imported post', toUserId('user')),
      {
        name: 'Post',
        artifactId: 'post',
        sourceName: 'post.step',
        stepText: step
      }
    ).document;
    const initial = await adapter.syncDocument(imported);
    const id = initial.exportableBodyIds[0]!;
    const face = initial.bodyRepresentations[id]!.topology!.faces.find(
      (f) => f.geometry?.surfaceType === 'cylinder'
    )!;
    const edit = directEditBody(imported, {
      name: 'Resize post',
      targetBodyId: id,
      operation: {
        kind: 'resize-cylindrical-face',
        faceHash: face.hash,
        faceReference: face.reference,
        sourceRadius: 6,
        sourceAxisStart: face.geometry!.axisStart!,
        sourceAxisEnd: face.geometry!.axisEnd!,
        concavity: 'boss',
        radius: 7
      }
    }).document;
    proof.mockClear();
    const resized = await adapter.syncDocument(edit);
    expect(resized.warnings).toEqual([]);
    expect(resized.bodyRepresentations[id]!.volume).toBeCloseTo(
      Math.PI * 49 * 20,
      3
    );
    expect(proof).not.toHaveBeenCalled();
    const cap = resized.bodyRepresentations[id]!.topology!.faces.find(
      (f) => f.geometry?.surfaceType === 'plane'
    )!;
    const foreground = await adapter.syncDocument(edit, undefined, undefined, {
      bodyId: id,
      faceHashes: [cap.hash]
    });
    expect(foreground.warnings).toEqual([]);
    expect(proof).toHaveBeenCalled();
    expect(foreground.bodyRepresentations[id]!.mesh).toEqual(
      resized.bodyRepresentations[id]!.mesh
    );
    // An idle echo must not confuse the foreground proof result with the
    // deferred capability entry and repeat these expensive discovery calls.
    proof.mockClear();
    await adapter.syncDocument(edit);
    expect(proof).not.toHaveBeenCalled();
  } finally {
    proof.mockRestore();
    adapter.dispose();
  }
}, 60_000);

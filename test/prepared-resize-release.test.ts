import { expect, it, vi } from 'vitest';
import { directEditBody } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { DerivedState, ProjectDocument } from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { filletedUnion } from './support/filleted-union';

/**
 * Everything a release accepts, without its display: the mesh, the faces'
 * triangle ranges in it (a release is drafted) and the sampled points of
 * freeform edges, which an incremental build already sampled differently
 * from a cold one before releases reused prepared edits.
 */
function accepted(derived: DerivedState) {
  const exact = JSON.parse(
    JSON.stringify(derived.bodyRepresentations, (key, value: unknown) =>
      key === 'mesh' ||
      key === 'triangleStart' ||
      key === 'triangleCount' ||
      key === 'points'
        ? undefined
        : value
    )
  ) as DerivedState['bodyRepresentations'];
  return {
    warnings: derived.warnings,
    featureWarnings: derived.featureWarnings,
    exportableBodyIds: derived.exportableBodyIds,
    bodies: Object.fromEntries(
      Object.entries(exact).map(([id, body]) => [
        id,
        { volume: body.volume, topology: body.topology }
      ])
    )
  };
}

/**
 * The release of a boss diameter drag commits the resize its preview
 * prepared (`commitPreparedGroupEditJournaled`) instead of rebuilding it
 * (`resizeCylindricalFaceJournaled`), which on the owner's 32-feature part
 * cut the release check by about 130 ms.
 *
 * That needs the release to restore the checkpoint the preview prepared
 * on. Here, as on that part, the checkpoint schedule is full, so the live
 * build of a history ending in a face offset keeps the offset's source but
 * not its result. The first preview frame of the appended resize replays
 * that offset; replayed display-only, its checkpoint was one the checked
 * release could not restore, so the release replayed the prefix again and
 * resized the wall afresh.
 */
it('releases a boss resize from the checkpoint its preview prepared', async () => {
  const adapter = await createExactKernelAdapter({
    historyCheckpointLimit: 3
  });
  const fresh = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
  const prepared = vi.spyOn(
    RemusKernel.prototype as unknown as {
      commitPreparedGroupEditJournaled(handle: number, radius: number): string;
    },
    'commitPreparedGroupEditJournaled'
  );
  const rebuilt = vi.spyOn(
    RemusKernel.prototype,
    'resizeCylindricalFaceJournaled'
  );
  try {
    const model = await filletedUnion(adapter);
    const wall = model.body.topology!.faces.find(
      (face) =>
        face.reference?.lineageName ===
        'boolean.face.operand.0.primitive.cylinder.face.wall'
    )!;
    expect(wall.geometry?.radius).toBeCloseTo(6, 9);
    const resize = (radius: number): ProjectDocument =>
      directEditBody(model.document, {
        name: 'Resize Cylinder',
        targetBodyId: model.bodyId,
        operation: {
          kind: 'resize-cylindrical-face',
          faceHash: wall.hash,
          ...(wall.reference ? { faceReference: wall.reference } : {}),
          sourceRadius: 6,
          sourceAxisStart: wall.geometry!.axisStart!,
          sourceAxisEnd: wall.geometry!.axisEnd!,
          concavity: 'boss',
          radius
        }
      }).document;

    // The drag, as the app sends it, then the release's check.
    for (const radius of [6.4, 6.8, 7])
      await adapter.previewGeometry(resize(radius), {
        deferTopology: true,
        proposeCarry: true
      });
    prepared.mockClear();
    rebuilt.mockClear();
    const release = await adapter.syncDocument(
      resize(7),
      undefined,
      undefined,
      undefined,
      { lineageDemand: [], proposeCarry: true }
    );
    expect(prepared).toHaveBeenCalledTimes(1);
    expect(rebuilt).not.toHaveBeenCalled();

    // Exactly what a cold, fully checked rebuild accepts.
    expect(accepted(release)).toEqual(
      accepted(
        await fresh.syncDocument(resize(7), undefined, undefined, undefined, {
          lineageDemand: [],
          proposeCarry: true
        })
      )
    );
  } finally {
    prepared.mockRestore();
    rebuilt.mockRestore();
    adapter.dispose();
    fresh.dispose();
  }
}, 120_000);

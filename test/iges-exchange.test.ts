import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CommandManager, replayCommands } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { buildDocumentHistory } from '../packages/kernel-adapter/src/exact-build-loop';
import {
  runStepImport,
  localStepImportSourceStore
} from '../apps/web/src/lib/stepImportRun';
import { createInFlightImportChecksums } from '../apps/web/src/lib/importArchival';

/**
 * I06: an IGES B-rep imports as the exact STEP the Remus translator restates
 * it to. The fixtures were written in B-rep mode by an independent IGES
 * writer: a 30 mm cube with an R8 spherical cavity, in inches (24,855.339 mm³,
 * centred at 15, 15, 15 per that writer's own reader), and the same writer's
 * trimmed-surface model of a holed plate.
 */
const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`./fixtures/iges/${name}`, import.meta.url))
  );

it('imports an independent IGES B-rep solid exactly, replayable from its STEP restatement', async () => {
  const kernel = new RemusKernel();
  const iges = fixture('cavity-brep-in.igs');
  const probe = await createExactKernelAdapter();
  const step = await probe.igesAsStep(iges.slice().buffer);
  probe.dispose();
  const checksum = createHash('sha256').update(step).digest('hex');
  const adapter = await createExactKernelAdapter({
    resolveSourceBytes: async () => step
  });
  const initial = createProjectDocument('IGES', toUserId('user_i06'));
  const manager = new CommandManager(initial);
  try {
    const result = await runStepImport({
      file: new File([Uint8Array.from(step)], 'cavity.igs'),
      contentType: 'model/step',
      inspectSolids: async () =>
        (await adapter.inspectStep(step.slice().buffer)).solidIndices,
      store: {
        ...localStepImportSourceStore,
        ensureLocalProjectStorage: async () => 'ready',
        putSourceBlobIfAbsent: async () => ({
          ref: {
            marker: 'openzcad-source-ref',
            version: 1,
            hashAlgorithm: 'sha256',
            checksumSha256: checksum,
            logicalBytes: step.length
          },
          created: true
        }),
        releaseSourceBlobClaim: async () => {}
      },
      archive: async () => 'artifact_iges',
      validatedFeature: {
        reserve: () => ({ release() {} }),
        run: async (command, options) => {
          const derived = await adapter.syncDocument(
            command.apply(manager.document)
          );
          expect(derived.warnings).toEqual([]);
          manager.execute(await options.finalize!());
          return 'committed';
        }
      },
      status: { setStatus() {}, setFeatureFormError() {} },
      marks: {
        inFlight: createInFlightImportChecksums(),
        abandoned: new Set()
      },
      currentDocument: () => manager.document,
      editDisabledReason: () => null,
      newId: () => crypto.randomUUID()
    });
    expect(result.outcome).toBe('committed');
    const [bodyId] = manager.document.bodyOrder;
    const body = Object.values(manager.document.nodes).find(
      (node) => node.kind === 'body' && node.bodyId === bodyId
    )!;
    // Named after the IGES file, which is also the source's name.
    expect(body.name).toBe('cavity');
    const feature = Object.values(manager.document.nodes).find(
      (node) => node.kind === 'feature' && node.featureKind === 'imported-step'
    )!;
    expect(feature.kind === 'feature' && feature.data).toMatchObject({
      sourceName: 'cavity.igs'
    });
    const replayed = replayCommands(initial, manager.document.commandLog);
    const build = buildDocumentHistory(
      kernel,
      replayed,
      new Map([[checksum, step]])
    );
    expect(build.warnings).toEqual([]);
    const solid = build.shapes.get(bodyId!)!.solids[0]!;
    expect(kernel.volume(solid, 0.001)).toBeCloseTo(24_855.339, 2);
    Array.from(kernel.boundingBox(solid)).forEach((value, axis) =>
      expect(value).toBeCloseTo([0, 0, 0, 30, 30, 30][axis]!, 5)
    );
  } finally {
    adapter.dispose();
    kernel.free();
  }
}, 120_000);

it('refuses an IGES surface model by name before storing anything', async () => {
  const adapter = await createExactKernelAdapter();
  try {
    await expect(
      adapter.igesAsStep(fixture('holed-plate-faces-mm.igs').slice().buffer)
    ).rejects.toThrow(
      'IGES surface model (7 trimmed surfaces, no type 186 solid)'
    );
  } finally {
    adapter.dispose();
  }
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CommandManager, replayCommands } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { buildDocumentHistory } from '../packages/kernel-adapter/src/exact-build-loop';
import { transformMatrix } from '../packages/kernel-adapter/src/exact-math';
import {
  runStepImport,
  localStepImportSourceStore
} from '../apps/web/src/lib/stepImportRun';
import { createInFlightImportChecksums } from '../apps/web/src/lib/importArchival';

it('imports two exact solids through the real orchestration with shared source, placement, export and replay', async () => {
  const kernel = new RemusKernel();
  const io = await loadRemusTranslators();
  const sourceSolids = [
    kernel.makeBox(10, 20, 30),
    kernel.copyAndTransformSolid(
      kernel.makeBox(5, 6, 7),
      transformMatrix({ x: 50, y: 70, z: 90 }, { x: 0, y: 0, z: 0 })
    )
  ];
  // Optional local-only fixture: never publish a user's CAD source.
  const bytes = process.env.OZ_STEP_MULTI_BODY_FIXTURE
    ? new Uint8Array(readFileSync(process.env.OZ_STEP_MULTI_BODY_FIXTURE))
    : io.exportStep(kernel.serializeSolids(Uint32Array.from(sourceSolids)));
  const original = Array.from(kernel.deserializeSolids(io.importStep(bytes)));
  const originalBlobs = original.map((solid) => kernel.serializeSolid(solid));
  // Compare export against the same reader/writer round trip without the UI
  // split. Separately require byte-identical imported B-reps before export.
  const roundTripped = original.map(
    (solid) =>
      kernel.deserializeSolids(
        io.importStep(
          io.exportStep(kernel.serializeSolids(Uint32Array.of(solid)))
        )
      )[0]!
  );
  const expected = roundTripped.map((solid) => ({
    volume: kernel.volume(solid, 0.1),
    bounds: Array.from(kernel.boundingBox(solid)),
    faces: kernel.getSolidFaces(solid).length
  }));
  expect(expected).toHaveLength(2);
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const ref = {
    marker: 'openzcad-source-ref',
    version: 1,
    hashAlgorithm: 'sha256',
    checksumSha256: checksum,
    logicalBytes: bytes.length
  } as const;
  const adapter = await createExactKernelAdapter({
    resolveSourceBytes: async () => bytes
  });
  const initial = createProjectDocument(
    'Separated import',
    toUserId('user_test')
  );
  const manager = new CommandManager(initial);
  try {
    const result = await runStepImport({
      file: new File([Uint8Array.from(bytes)], 'components.step'),
      contentType: 'model/step',
      inspectSolids: async () =>
        (await adapter.inspectStep(new TextDecoder().decode(bytes)))
          .solidIndices,
      store: {
        ...localStepImportSourceStore,
        ensureLocalProjectStorage: async () => 'ready',
        putSourceBlobIfAbsent: async () => ({ ref, created: true }),
        releaseSourceBlobClaim: async () => {}
      },
      archive: async () => 'artifact_shared',
      validatedFeature: {
        reserve: () => ({ release() {} }),
        run: async (command, options) => {
          const candidate = command.apply(manager.document);
          const derived = await adapter.syncDocument(candidate);
          expect(derived.warnings).toEqual([]);
          expect(options.targets).toHaveLength(2);
          for (const target of options.targets!)
            expect(
              derived.bodyRepresentations[target.resultBodyId]
            ).toBeDefined();
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
    expect(manager.document.bodyOrder).toHaveLength(2);
    const ids = [...manager.document.bodyOrder];
    const verify = async () => {
      const build = buildDocumentHistory(
        kernel,
        manager.document,
        new Map([[checksum, bytes]])
      );
      expect(build.warnings).toEqual([]);
      for (const [index, bodyId] of ids.entries()) {
        const shape = build.shapes.get(bodyId)!;
        expect(shape.solids).toHaveLength(1);
        expect(kernel.serializeSolid(shape.solids[0]!)).toEqual(
          originalBlobs[index]
        );
      }
      for (const [index, bodyId] of ids.entries()) {
        const text = await adapter.exportStep(manager.document, [bodyId]);
        const solids = Array.from(
          kernel.deserializeSolids(
            io.importStep(new TextEncoder().encode(text))
          )
        );
        expect(solids).toHaveLength(1);
        expect(kernel.volume(solids[0]!, 0.1)).toBeCloseTo(
          expected[index]!.volume,
          5
        );
        expect(kernel.getSolidFaces(solids[0]!).length).toBe(
          expected[index]!.faces
        );
        Array.from(kernel.boundingBox(solids[0]!)).forEach((value, axis) =>
          expect(value).toBeCloseTo(expected[index]!.bounds[axis]!, 6)
        );
      }
    };
    await verify();
    manager.undo();
    expect(manager.document.bodyOrder).toHaveLength(0);
    manager.redo();
    expect(manager.document.bodyOrder).toEqual(ids);
    await verify();
    const replayed = replayCommands(initial, manager.document.commandLog);
    expect(replayed.bodyOrder).toEqual(ids);
    const reopened = await adapter.syncDocument(
      JSON.parse(JSON.stringify(manager.document))
    );
    expect(reopened.exportableBodyIds).toEqual(ids);
  } finally {
    adapter.dispose();
    kernel.free();
  }
}, 60_000);

it('discovers original indices after rejecting an open middle shell', async () => {
  const kernel = new RemusKernel();
  const io = await loadRemusTranslators();
  const adapter = await createExactKernelAdapter();
  try {
    const bytes = io.exportStep(
      kernel.serializeSolids(
        Uint32Array.from([
          kernel.makeBox(10, 10, 10),
          kernel.makeBox(20, 20, 20),
          kernel.makeBox(30, 30, 30)
        ])
      )
    );
    let shell = 0;
    const source = new TextDecoder()
      .decode(bytes)
      .replace(/CLOSED_SHELL\('',\s*\(([^)]+)\)\)/g, (record, faces: string) => {
        shell += 1;
        return shell === 2
          ? `CLOSED_SHELL('',(${faces.split(',').slice(1).join(',')}))`
          : record;
      });
    expect(shell).toBe(3);
    const inspection = await adapter.inspectStep(source);
    expect(inspection.solidIndices).toEqual([0, 2]);
    expect(inspection.reason).toContain('open shell');
  } finally {
    adapter.dispose();
    kernel.free();
  }
});

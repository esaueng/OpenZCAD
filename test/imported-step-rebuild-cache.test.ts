import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type ImportedSourceReference,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * Editing a document used to re-read and re-parse every imported STEP source
 * on every rebuild, which is what made a large import able to exhaust memory.
 * These cover the contract that replaced it: the source is read once, and
 * later rebuilds produce exactly what the first one produced.
 */

const SOURCE = new Uint8Array(readFileSync('samples/parametric-bracket.step'));

const REFERENCE: ImportedSourceReference = {
  marker: 'openzcad-source-ref',
  version: 1,
  hashAlgorithm: 'sha256',
  checksumSha256: createHash('sha256').update(SOURCE).digest('hex'),
  logicalBytes: SOURCE.byteLength
};

function documentWithImport(): ProjectDocument {
  const manager = new CommandManager(
    createProjectDocument('Imported frame', toUserId('user_rebuild_cache'))
  );
  manager.execute(
    commandFactories.importStep({
      name: 'Frame',
      artifactId: 'artifact_cloud_frame',
      sourceName: 'frame.step',
      stepSourceRef: REFERENCE
    })
  );
  return manager.document;
}

function adapterWithCountedSource() {
  let reads = 0;
  const adapter = createExactKernelAdapter({
    resolveSourceBytes: async () => {
      reads += 1;
      return SOURCE;
    }
  });
  return { adapter, reads: () => reads };
}

describe('imported STEP rebuild cache', () => {
  it('reads and parses the source once across repeated rebuilds', async () => {
    const { adapter, reads } = adapterWithCountedSource();
    const kernel = await adapter;
    const document = documentWithImport();

    const first = await kernel.syncDocument(document);
    expect(reads()).toBe(1);

    // A later rebuild of the same content must not touch the source again:
    // that read is the largest allocation a rebuild makes.
    const second = await kernel.syncDocument(document);
    expect(reads()).toBe(1);

    // And an edited document — the realistic case, since every keystroke
    // rebuilds — still must not re-read it.
    const renamed: ProjectDocument = {
      ...document,
      name: 'Renamed frame',
      version: document.version + 1
    };
    const third = await kernel.syncDocument(renamed);
    expect(reads()).toBe(1);

    expect(second.bodyRepresentations).toEqual(first.bodyRepresentations);
    expect(third.bodyRepresentations).toEqual(first.bodyRepresentations);
  }, 60_000);

  it('produces the same geometry as an adapter that never caches', async () => {
    const cached = await adapterWithCountedSource().adapter;
    const document = documentWithImport();
    await cached.syncDocument(document);
    const fromCache = await cached.syncDocument(document);

    // A fresh adapter has an empty cache, so this rebuild is the cold path.
    const cold = await adapterWithCountedSource().adapter;
    const fromParse = await cold.syncDocument(document);

    expect(fromCache.bodyRepresentations).toEqual(
      fromParse.bodyRepresentations
    );
    expect(fromCache.exportableBodyIds).toEqual(fromParse.exportableBodyIds);
    expect(fromCache.warnings).toEqual(fromParse.warnings);
  }, 60_000);

  it('still reports a source that cannot be resolved', async () => {
    const kernel = await createExactKernelAdapter({
      resolveSourceBytes: async () => {
        throw new Error('not on this device');
      }
    });
    const derived = await kernel.syncDocument(documentWithImport());
    expect(JSON.stringify(derived.warnings)).toMatch(/not available|not in local/i);
  }, 60_000);
});

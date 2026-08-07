import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createBodyFeatureIds,
  createProjectDocument
} from '@openzcad/document-core';
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

function adapterWithCountedSource(importedStepCacheBytes?: number) {
  let reads = 0;
  const adapter = createExactKernelAdapter({
    ...(importedStepCacheBytes === undefined ? {} : { importedStepCacheBytes }),
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

  /**
   * An import is now pre-flighted before it is committed, so the source is
   * seen by two rebuilds instead of one: the candidate the validated-commit
   * path derives, then the committed document the broadcast rebuild echoes.
   * The cache is keyed on the source checksum, which both share, so the read
   * budget is unchanged — this is the assertion that keeps it that way.
   */
  it('reads the source once across the import pre-flight and the commit', async () => {
    const { adapter, reads } = adapterWithCountedSource();
    const kernel = await adapter;
    const manager = new CommandManager(
      createProjectDocument('Imported frame', toUserId('user_rebuild_cache'))
    );
    // Explicit ids: the pre-flight has to name the body it is checking, and
    // the committed command carries the same ones.
    const ids = createBodyFeatureIds();
    const command = commandFactories.importStep({
      name: 'Frame',
      artifactId: 'artifact_local_preflight',
      sourceName: 'frame.step',
      stepSourceRef: REFERENCE,
      ids
    });

    const candidate = command.apply(manager.document);
    const preflight = await kernel.syncDocument(candidate);
    expect(reads()).toBe(1);
    expect(preflight.bodyRepresentations[ids.bodyId]).toBeDefined();

    // The finalized command differs only in the artifact id, which is
    // geometry-inert: the source is resolved by checksum.
    const committed = manager.execute(
      commandFactories.importStep({
        name: 'Frame',
        artifactId: 'artifact_cloud_frame',
        sourceName: 'frame.step',
        stepSourceRef: REFERENCE,
        ids
      })
    );
    const rebuilt = await kernel.syncDocument(committed);
    expect(reads()).toBe(1);
    expect(rebuilt.bodyRepresentations[ids.bodyId]).toEqual(
      preflight.bodyRepresentations[ids.bodyId]
    );
  }, 60_000);

  /**
   * The cache is keyed on the source reference, so the legacy embedded form —
   * which carries its text in the document — is never cached and never
   * consults the resolver. It still has to build.
   */
  it('builds an embedded import without touching the source resolver', async () => {
    const { adapter, reads } = adapterWithCountedSource();
    const kernel = await adapter;
    const manager = new CommandManager(
      createProjectDocument('Embedded frame', toUserId('user_rebuild_cache'))
    );
    const ids = createBodyFeatureIds();
    manager.execute(
      commandFactories.importStep({
        name: 'Embedded',
        artifactId: 'artifact_local_embedded',
        sourceName: 'frame.step',
        stepText: new TextDecoder().decode(SOURCE),
        ids
      })
    );

    const derived = await kernel.syncDocument(manager.document);
    expect(reads()).toBe(0);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[ids.bodyId]).toBeDefined();
  }, 60_000);

  /**
   * The budget scaled down to meet the corpus: 1 KiB stands in for the shipped
   * 64 MiB ceiling, and `parametric-bracket.step` stands in for the imports
   * that actually exceed it. The ratio is what the contract turns on, and the
   * existing coverage only ever exercised files far below the budget.
   */
  const TINY_CACHE_BUDGET = 1024;

  it('reads an over-budget source once across the pre-flight and the commit', async () => {
    // Refusing to cache an import larger than the whole budget re-parsed
    // exactly the largest files on every rebuild — the regression the cache
    // exists to prevent, aimed at the documents that motivated it.
    const { adapter, reads } = adapterWithCountedSource(TINY_CACHE_BUDGET);
    const kernel = await adapter;
    const manager = new CommandManager(
      createProjectDocument('Big import', toUserId('user_rebuild_cache'))
    );
    const ids = createBodyFeatureIds();
    const candidate = commandFactories
      .importStep({
        name: 'Frame',
        artifactId: 'artifact_local_preflight',
        sourceName: 'frame.step',
        stepSourceRef: REFERENCE,
        ids
      })
      .apply(manager.document);

    const preflight = await kernel.syncDocument(candidate);
    expect(reads()).toBe(1);
    expect(preflight.bodyRepresentations[ids.bodyId]).toBeDefined();

    const committed = manager.execute(
      commandFactories.importStep({
        name: 'Frame',
        artifactId: 'artifact_cloud_frame',
        sourceName: 'frame.step',
        stepSourceRef: REFERENCE,
        ids
      })
    );
    const rebuilt = await kernel.syncDocument(committed);
    expect(reads()).toBe(1);
    expect(rebuilt.bodyRepresentations[ids.bodyId]).toEqual(
      preflight.bodyRepresentations[ids.bodyId]
    );
  }, 60_000);

  it('does not evict an import the build in progress still needs', async () => {
    // Two over-budget imports in one document. Whichever is parsed second used
    // to push the first out, so the next rebuild had to read and re-parse a
    // source the prefetch had already skipped as cached.
    const secondSource = new Uint8Array(
      readFileSync('test/parity/corpus/a-export-box.step')
    );
    const secondReference: ImportedSourceReference = {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256: createHash('sha256').update(secondSource).digest('hex'),
      logicalBytes: secondSource.byteLength
    };
    let reads = 0;
    const kernel = await createExactKernelAdapter({
      importedStepCacheBytes: TINY_CACHE_BUDGET,
      resolveSourceBytes: async (ref) => {
        reads += 1;
        return ref.checksumSha256 === REFERENCE.checksumSha256
          ? SOURCE
          : secondSource;
      }
    });
    const manager = new CommandManager(
      createProjectDocument('Two imports', toUserId('user_rebuild_cache'))
    );
    const first = createBodyFeatureIds();
    const second = createBodyFeatureIds();
    manager.execute(
      commandFactories.importStep({
        name: 'Frame',
        artifactId: 'artifact_cloud_frame',
        sourceName: 'frame.step',
        stepSourceRef: REFERENCE,
        ids: first
      })
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Box',
        artifactId: 'artifact_cloud_box',
        sourceName: 'box.step',
        stepSourceRef: secondReference,
        ids: second
      })
    );

    const built = await kernel.syncDocument(manager.document);
    expect(reads).toBe(2);
    expect(built.bodyRepresentations[first.bodyId]).toBeDefined();
    expect(built.bodyRepresentations[second.bodyId]).toBeDefined();

    const rebuilt = await kernel.syncDocument(manager.document);
    expect(reads).toBe(2);
    expect(rebuilt.bodyRepresentations).toEqual(built.bodyRepresentations);
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

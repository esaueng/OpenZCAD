import { describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, findFeature } from '@openzcad/document-core';
import {
  toUserId,
  type ImportedSourceReference,
  type ProjectDocument
} from '@openzcad/shared';
import {
  archiveLocalOnlyImportSources,
  createInFlightImportChecksums,
  discardUnreferencedImportSource,
  listLocalOnlyImportSources
} from './importArchival';

function referenceFor(text: string): ImportedSourceReference {
  return {
    marker: 'openzcad-source-ref',
    version: 1,
    hashAlgorithm: 'sha256',
    checksumSha256: `checksum-${text}`,
    logicalBytes: text.length
  };
}

function managerWithImports(): CommandManager {
  const manager = new CommandManager(
    createProjectDocument('Local sources', toUserId('user_archival'))
  );
  manager.execute(
    commandFactories.importStep({
      name: 'Archived import',
      artifactId: 'artifact_cloud_1',
      sourceName: 'archived.step',
      stepSourceRef: referenceFor('archived')
    })
  );
  manager.execute(
    commandFactories.importStep({
      name: 'Local import',
      artifactId: 'artifact_local_abc',
      sourceName: 'local.step',
      stepSourceRef: referenceFor('local')
    })
  );
  manager.execute(
    commandFactories.importStep({
      name: 'Second local import',
      artifactId: 'artifact_local_ghi',
      sourceName: 'local2.step',
      stepSourceRef: referenceFor('local2')
    })
  );
  // Rebuildable everywhere from the document itself, so it must stay out of
  // every list and every upload below.
  manager.execute(
    commandFactories.importStep({
      name: 'Embedded import',
      artifactId: 'artifact_local_def',
      sourceName: 'embedded.step',
      stepText: 'ISO-10303-21;'
    })
  );
  return manager;
}

describe('listLocalOnlyImportSources', () => {
  it('lists reference-form imports whose bytes were never archived', () => {
    const sources = listLocalOnlyImportSources(managerWithImports().document);
    expect(sources.map((source) => source.sourceName)).toEqual([
      'local.step',
      'local2.step'
    ]);
    expect(sources[0]).toMatchObject({ checksumSha256: 'checksum-local' });
  });

  it('does not report an embedded-text import as local-only', () => {
    // `stepText` travels inside the document, which syncs, and the kernel
    // rebuilds straight from it — so every device can already open this
    // project. Listing it would raise "other devices cannot rebuild it" over a
    // project that is fine, and only the original upload is missing.
    const manager = new CommandManager(
      createProjectDocument('Embedded only', toUserId('user_archival'))
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Embedded import',
        artifactId: 'artifact_local_def',
        sourceName: 'embedded.step',
        stepText: 'ISO-10303-21;'
      })
    );
    expect(listLocalOnlyImportSources(manager.document)).toEqual([]);
  });

  it('is empty for a fully archived document', () => {
    const manager = new CommandManager(
      createProjectDocument('Archived', toUserId('user_archival'))
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Cloud import',
        artifactId: 'artifact_cloud_2',
        sourceName: 'cloud.step',
        stepSourceRef: referenceFor('cloud')
      })
    );
    expect(listLocalOnlyImportSources(manager.document)).toEqual([]);
  });
});

describe('archiveLocalOnlyImportSources', () => {
  function applyViaManager(manager: CommandManager) {
    return (featureId: never, artifactId: string) =>
      manager.execute(
        commandFactories.updateFeature({
          featureId,
          data: { artifactId: artifactId as never }
        })
      );
  }

  it('uploads blob-store sources and rewires the features', async () => {
    const manager = managerWithImports();
    const uploaded: string[] = [];
    const result = await archiveLocalOnlyImportSources({
      document: manager.document,
      loadSourceBytes: async () =>
        new TextEncoder().encode('local step bytes'),
      archive: async (input) => {
        uploaded.push(`${input.fileName}:${input.body.size}`);
        return `artifact_cloud_${input.fileName}`;
      },
      applyArtifactId: applyViaManager(manager) as never
    });
    expect(result).toEqual({
      archived: ['local.step', 'local2.step'],
      missing: [],
      failed: []
    });
    // The embedded import is never uploaded: it was never a local-only source.
    expect(uploaded).toEqual(['local.step:16', 'local2.step:16']);
    expect(listLocalOnlyImportSources(manager.document)).toEqual([]);
    // The content-addressed reference survives the rewire, so local
    // rebuilds keep resolving from the blob store.
    const doc: ProjectDocument = manager.document;
    const rewired = listStepFeatureData(doc);
    expect(rewired).toContainEqual(
      expect.objectContaining({
        artifactId: 'artifact_cloud_local.step',
        checksum: 'checksum-local'
      })
    );
  });

  it('reports missing bytes without touching the document', async () => {
    const manager = managerWithImports();
    const before = manager.document;
    const result = await archiveLocalOnlyImportSources({
      document: before,
      loadSourceBytes: async () => null,
      archive: async () => {
        throw new Error('should not upload anything');
      },
      applyArtifactId: () => {
        throw new Error('should not edit anything');
      }
    });
    expect(result.missing).toEqual(['local.step', 'local2.step']);
    expect(result.failed).toEqual([]);
    expect(manager.document).toBe(before);
  });

  it('keeps unarchived features retryable after a partial failure', async () => {
    const manager = managerWithImports();
    const result = await archiveLocalOnlyImportSources({
      document: manager.document,
      loadSourceBytes: async () =>
        new TextEncoder().encode('local step bytes'),
      archive: async (input) => {
        if (input.fileName === 'local.step') {
          throw new Error('storage down');
        }
        return 'artifact_cloud_local2';
      },
      applyArtifactId: applyViaManager(manager) as never
    });
    expect(result.failed).toEqual(['local.step']);
    expect(result.archived).toEqual(['local2.step']);
    expect(
      listLocalOnlyImportSources(manager.document).map((s) => s.sourceName)
    ).toEqual(['local.step']);
  });
});

/**
 * The mark that stops one import's cleanup from deleting the bytes another is
 * still working with. Content addressing puts every import of one file on ONE
 * key, so the mark has to survive until the LAST holder lets go of it.
 */
describe('in-flight import checksums', () => {
  it('stays marked until every holder has released it', () => {
    const marks = createInFlightImportChecksums();
    marks.acquire('sha256-frame');
    marks.acquire('sha256-frame');

    marks.release('sha256-frame');
    // A set cannot express this: two imports of the same file put one entry in
    // it, and the first `delete` erases the second import's protection too.
    expect(marks.has('sha256-frame')).toBe(true);

    marks.release('sha256-frame');
    expect(marks.has('sha256-frame')).toBe(false);
  });

  it('tracks each checksum separately and ignores an unheld release', () => {
    const marks = createInFlightImportChecksums();
    marks.acquire('sha256-a');
    expect(marks.has('sha256-b')).toBe(false);
    marks.release('sha256-b');
    expect(marks.has('sha256-a')).toBe(true);
    marks.release('sha256-a');
    expect(marks.has('sha256-a')).toBe(false);
  });

  it('keeps the bytes of the import still holding the mark', async () => {
    // Two imports of the same file, both counted in; the first one to finish
    // releases and then tries to clean up. With a set its own release would
    // have erased the other's mark, and it would delete bytes the survivor is
    // about to commit against.
    const marks = createInFlightImportChecksums();
    marks.acquire('sha256-frame');
    marks.acquire('sha256-frame');
    marks.release('sha256-frame');
    const deleteSourceBlob = vi.fn(() => Promise.resolve());

    await expect(
      discardUnreferencedImportSource({
        checksumSha256: 'sha256-frame',
        createdByThisImport: true,
        document: null,
        inFlightChecksums: marks,
        deleteSourceBlob
      })
    ).resolves.toBe(false);
    expect(deleteSourceBlob).not.toHaveBeenCalled();
  });
});

function listStepFeatureData(document: ProjectDocument) {
  return document.featureOrder
    .map((featureId) => findFeature(document, featureId))
    .flatMap((feature) =>
      feature && feature.data.featureKind === 'imported-step'
        ? [
            {
              artifactId: String(feature.data.artifactId),
              checksum: feature.data.stepSourceRef?.checksumSha256 ?? null
            }
          ]
        : []
    );
}

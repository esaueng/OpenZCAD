import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, findFeature } from '@openzcad/document-core';
import {
  toUserId,
  type ImportedSourceReference,
  type ProjectDocument
} from '@openzcad/shared';
import {
  archiveLocalOnlyImportSources,
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
      name: 'Embedded import',
      artifactId: 'artifact_local_def',
      sourceName: 'embedded.step',
      stepText: 'ISO-10303-21;'
    })
  );
  return manager;
}

describe('listLocalOnlyImportSources', () => {
  it('lists only STEP imports with an artifact_local_ reference', () => {
    const sources = listLocalOnlyImportSources(managerWithImports().document);
    expect(sources.map((source) => source.sourceName)).toEqual([
      'local.step',
      'embedded.step'
    ]);
    expect(sources[0]).toMatchObject({
      checksumSha256: 'checksum-local',
      stepText: null
    });
    expect(sources[1]).toMatchObject({
      checksumSha256: null,
      stepText: 'ISO-10303-21;'
    });
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

  it('uploads blob-store and embedded sources and rewires the features', async () => {
    const manager = managerWithImports();
    const uploaded: string[] = [];
    const result = await archiveLocalOnlyImportSources({
      document: manager.document,
      loadSourceBytes: async (checksum) =>
        checksum === 'checksum-local'
          ? new TextEncoder().encode('local step bytes')
          : null,
      archive: async (input) => {
        uploaded.push(`${input.fileName}:${input.body.size}`);
        return `artifact_cloud_${input.fileName}`;
      },
      applyArtifactId: applyViaManager(manager) as never
    });
    expect(result).toEqual({
      archived: ['local.step', 'embedded.step'],
      missing: [],
      failed: []
    });
    expect(uploaded).toEqual([
      'local.step:16',
      'embedded.step:13'
    ]);
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
    // The blob-backed source has no bytes → missing; the embedded source
    // still has bytes but its upload throws here → failed.
    expect(result.missing).toEqual(['local.step']);
    expect(result.failed).toEqual(['embedded.step']);
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
        return 'artifact_cloud_embedded';
      },
      applyArtifactId: applyViaManager(manager) as never
    });
    expect(result.failed).toEqual(['local.step']);
    expect(result.archived).toEqual(['embedded.step']);
    expect(
      listLocalOnlyImportSources(manager.document).map((s) => s.sourceName)
    ).toEqual(['local.step']);
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

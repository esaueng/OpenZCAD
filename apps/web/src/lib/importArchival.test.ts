import { describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, findFeature } from '@openzcad/document-core';
import {
  IMPORTED_MESH_PAYLOAD_CONTENT_TYPE,
  documentNodesWithHistory,
  toUserId,
  type ImportedSourceReference,
  type ProjectDocument
} from '@openzcad/shared';
import {
  archiveLocalOnlyImportSources,
  createInFlightImportChecksums,
  importSourceChecksums,
  discardUnreferencedImportSource,
  listLocalOnlyImportSources,
  meshPayloadArchive,
  settleImportSource,
  sourceBlobClaimExpired,
  sourceBlobClaimHolds,
  SOURCE_BLOB_CLAIM_TTL_MS
} from './importArchival';
import { parseCreateUploadSessionRequest } from '../../worker/validation';

it.each([249, 250, 251, 252, 253, 254, 255])(
  'archives a mesh payload with an accepted %i-character source filename',
  (length) => {
    const sourceName = `${'x'.repeat(length - 4)}.stl`;
    expect(() =>
      parseCreateUploadSessionRequest({
        projectId: 'proj_filename',
        fileName: sourceName,
        contentType: 'model/stl',
        kind: 'stl-import'
      })
    ).not.toThrow();
    const archive = meshPayloadArchive(sourceName);
    const request = parseCreateUploadSessionRequest({
      projectId: 'proj_filename',
      ...archive
    });
    expect(request.fileName).toHaveLength(255);
    expect(request.fileName.endsWith('.ozmesh')).toBe(true);
  }
);

function referenceFor(text: string): ImportedSourceReference {
  return {
    marker: 'openzcad-source-ref',
    version: 1,
    hashAlgorithm: 'sha256',
    checksumSha256: Array.from(text, (letter) =>
      letter.charCodeAt(0).toString(16)
    )
      .join('')
      .padEnd(64, '0'),
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
    expect(sources[0]).toMatchObject({
      checksumSha256: referenceFor('local').checksumSha256
    });
  });

  it.each([
    { artifactId: null },
    { artifactId: {} },
    { artifactId: 42 },
    { sourceName: {} },
    { stepSourceRef: null },
    { stepSourceRef: 'checksum' },
    { stepSourceRef: { checksumSha256: {} } },
    { stepSourceRef: { ...referenceFor('local'), logicalBytes: -1 } },
    { stepText: {} },
    { stepText: 'ISO-10303-21;' }
  ])(
    'ignores malformed source fields without hiding valid imports: %j',
    (data) => {
      const document = structuredClone(managerWithImports().document);
      delete document.editHistory;
      const feature = Object.values(document.nodes).find(
        (node) => node.kind === 'feature' && node.name === 'Local import'
      );
      if (!feature || feature.kind !== 'feature')
        throw new Error('Missing fixture');
      Object.assign(feature.data, data);
      expect(
        listLocalOnlyImportSources(document).map((source) => source.sourceName)
      ).toEqual(['local2.step']);
    }
  );

  it('ignores malformed import snapshots in undo and redo history', () => {
    const document = structuredClone(managerWithImports().document);
    const feature = Object.values(document.nodes).find(
      (node) => node.kind === 'feature' && node.name === 'Local import'
    );
    if (!feature || !document.editHistory) throw new Error('Missing fixture');
    document.editHistory.entries.push({
      id: 'malformed-snapshot',
      label: 'Historical import',
      changes: [
        {
          kind: 'value',
          field: 'nodes',
          key: feature.id,
          before: {
            ...feature,
            data: { featureKind: 'imported-step', artifactId: null }
          },
          after: { ...feature, data: null }
        },
        {
          kind: 'value',
          field: 'nodes',
          after: {
            [feature.id]: {
              ...feature,
              data: { featureKind: 'imported-step', artifactId: {} }
            }
          }
        }
      ]
    });
    expect(
      listLocalOnlyImportSources(document).map((source) => source.sourceName)
    ).toEqual(['local.step', 'local2.step']);
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
      loadSourceBytes: async () => new TextEncoder().encode('local step bytes'),
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
        checksum: referenceFor('local').checksumSha256
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
      loadSourceBytes: async () => new TextEncoder().encode('local step bytes'),
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
    const deleteSourceBlobIfUnreferenced = vi.fn(() => Promise.resolve(true));

    await expect(
      discardUnreferencedImportSource({
        checksumSha256: 'sha256-frame',
        createdByThisImport: true,
        document: null,
        inFlightChecksums: marks,
        deleteSourceBlobIfUnreferenced
      })
    ).resolves.toBe(false);
    expect(deleteSourceBlobIfUnreferenced).not.toHaveBeenCalled();
  });
});

describe('source blob claims', () => {
  const checksumSha256 = 'sha256-frame';
  const now = Date.parse('2026-08-07T12:00:00.000Z');
  const claim = (claimId: string, createdAt: string) => ({
    checksumSha256,
    claimId,
    createdAt
  });

  it('holds for another run but never blocks its owner', () => {
    const createdAt = new Date(now - 60_000).toISOString();
    expect(
      sourceBlobClaimHolds(claim('theirs', createdAt), {
        checksumSha256,
        ownClaimId: 'mine',
        now
      })
    ).toBe(true);
    expect(
      sourceBlobClaimHolds(claim('mine', createdAt), {
        checksumSha256,
        ownClaimId: 'mine',
        now
      })
    ).toBe(false);
  });

  it('expires abandoned and malformed holds instead of keeping them forever', () => {
    const justInside = new Date(
      now - SOURCE_BLOB_CLAIM_TTL_MS + 1
    ).toISOString();
    const lapsed = new Date(now - SOURCE_BLOB_CLAIM_TTL_MS).toISOString();

    expect(sourceBlobClaimExpired(claim('live', justInside), now)).toBe(false);
    expect(sourceBlobClaimExpired(claim('lapsed', lapsed), now)).toBe(true);
    expect(sourceBlobClaimExpired(claim('bad', 'not-a-date'), now)).toBe(true);
  });
});

/**
 * Who comes away holding a licence to delete, which is the one thing a run's
 * own outcome does not show.
 *
 * `abandoned` is a standing grant: a checksum in it may be deleted by a LATER
 * run of this tab even though that run created nothing. So the question a test
 * has to ask about a refusal is not only "did it delete?" but "did it acquire
 * the right to delete later?" — and the two can disagree.
 */
describe('the licence a finished import leaves behind', () => {
  const checksum = 'sha256-frame';

  function documentReferencing(reference: ImportedSourceReference) {
    const manager = new CommandManager(
      createProjectDocument('Frames', toUserId('user_licence'))
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Frame',
        artifactId: 'artifact_local_frame',
        sourceName: 'frame.step',
        stepSourceRef: reference
      })
    );
    return manager.document;
  }

  const frameReference: ImportedSourceReference = {
    marker: 'openzcad-source-ref',
    version: 1,
    hashAlgorithm: 'sha256',
    checksumSha256: checksum,
    logicalBytes: 21
  };

  it('takes no licence for bytes a feature still rebuilds from', async () => {
    // The run WROTE these bytes — the blob was missing while the feature that
    // needs it was not, which is any document that arrived by sync, or any
    // device whose storage was cleared — and then it was refused. So the bytes
    // are this tab's own by every ownership test, AND they are the source of a
    // feature in the open document.
    //
    // Not deleting them now is the easy half, and the reference check inside
    // `discardUnreferencedImportSource` would manage that much on its own. The
    // half that only shows up later is the NOTE: recording these as abandoned
    // hands this tab a standing licence over bytes it does not own the only
    // copy of. Delete that feature, re-import the same file, have it refused,
    // and the licence fires — against a key that may by then be the last copy
    // backing another project on this device.
    const abandonedChecksums = new Set<string>();
    const deleteSourceBlobIfUnreferenced = vi.fn(() => Promise.resolve(true));
    const releaseSourceBlobClaim = vi.fn(() => Promise.resolve());

    await expect(
      settleImportSource({
        checksumSha256: checksum,
        result: 'refused',
        createdByThisImport: true,
        abandonedChecksums,
        document: documentReferencing(frameReference),
        inFlightChecksums: createInFlightImportChecksums(),
        deleteSourceBlobIfUnreferenced,
        releaseSourceBlobClaim
      })
    ).resolves.toBe(false);

    expect(deleteSourceBlobIfUnreferenced).not.toHaveBeenCalled();
    expect(releaseSourceBlobClaim).toHaveBeenCalledOnce();
    // The assertion the surviving bytes cannot make on their own.
    expect(abandonedChecksums.has(checksum)).toBe(false);
  });

  it('clears a licence it was already holding once a feature claims the bytes', async () => {
    // The same rule from the other side: this tab wrote these bytes in an
    // earlier run that reached no verdict, so it does hold a licence over them.
    // A feature now rebuilds from them, and the licence has to go — otherwise
    // the note outlives the reason it was taken.
    const abandonedChecksums = new Set([checksum]);
    const deleteSourceBlobIfUnreferenced = vi.fn(() => Promise.resolve(true));
    const releaseSourceBlobClaim = vi.fn(() => Promise.resolve());

    await expect(
      settleImportSource({
        checksumSha256: checksum,
        result: 'committed',
        createdByThisImport: true,
        abandonedChecksums,
        document: documentReferencing(frameReference),
        inFlightChecksums: createInFlightImportChecksums(),
        deleteSourceBlobIfUnreferenced,
        releaseSourceBlobClaim
      })
    ).resolves.toBe(false);

    expect(deleteSourceBlobIfUnreferenced).not.toHaveBeenCalled();
    expect(releaseSourceBlobClaim).not.toHaveBeenCalled();
    expect(abandonedChecksums.has(checksum)).toBe(false);
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

/**
 * Mesh payloads are content-addressed import bytes exactly like STEP sources:
 * every walk that keeps, lists or uploads those must see them too, or a
 * referenced mesh is the one import other devices can never rebuild.
 */
describe('mesh payload references', () => {
  function managerWithMeshes(): CommandManager {
    const manager = new CommandManager(
      createProjectDocument('Mesh sources', toUserId('user_archival'))
    );
    manager.execute(
      commandFactories.importMesh({
        name: 'Local mesh',
        artifactId: 'artifact_local_mesh',
        sourceName: 'scan.stl',
        triangleCount: 1,
        meshPayloadRef: referenceFor('mesh')
      })
    );
    manager.execute(
      commandFactories.importMesh({
        name: 'Embedded mesh',
        artifactId: 'artifact_local_embedded',
        sourceName: 'old.stl',
        triangleCount: 1,
        vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2]
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
    return manager;
  }

  it('lists a referenced mesh as local-only, never an embedded one', () => {
    expect(listLocalOnlyImportSources(managerWithMeshes().document)).toEqual([
      expect.objectContaining({
        sourceName: 'scan.stl',
        checksumSha256: referenceFor('mesh').checksumSha256,
        kind: 'mesh-payload'
      }),
      expect.objectContaining({ sourceName: 'local.step', kind: 'step-source' })
    ]);
  });

  it('protects a referenced payload from refused-import cleanup, history included', () => {
    const manager = managerWithMeshes();
    expect(importSourceChecksums(manager.document)).toContain(
      referenceFor('mesh').checksumSha256
    );
    manager.undo();
    manager.undo();
    manager.undo();
    // Only undo history names the mesh now; redo would need its bytes.
    expect(manager.document.featureOrder).toEqual([]);
    expect(importSourceChecksums(manager.document)).toContain(
      referenceFor('mesh').checksumSha256
    );
  });

  it('uploads a payload as a mesh-payload artifact and a STEP source as a step-import', async () => {
    const manager = managerWithMeshes();
    const uploads: { fileName: string; kind: string; type: string }[] = [];
    const result = await archiveLocalOnlyImportSources({
      document: manager.document,
      loadSourceBytes: async () => new Uint8Array([1, 2, 3]),
      archive: async (input) => {
        uploads.push({
          fileName: input.fileName,
          kind: input.kind,
          type: input.contentType
        });
        return `artifact_cloud_${uploads.length}`;
      },
      applyArtifactId: (featureId, artifactId) => {
        manager.archiveSource(featureId, artifactId);
        return true;
      }
    });
    expect(result.archived).toEqual(['scan.stl', 'local.step']);
    expect(uploads).toEqual([
      {
        fileName: 'scan.stl.ozmesh',
        kind: 'mesh-payload',
        type: IMPORTED_MESH_PAYLOAD_CONTENT_TYPE
      },
      { fileName: 'local.step', kind: 'step-import', type: 'model/step' }
    ]);
    expect(listLocalOnlyImportSources(manager.document)).toEqual([]);
  });

  it.each(['refuses', 'throws'] as const)(
    'discards only the originating project payload when its edit %s after archival',
    async (outcome) => {
      const manager = managerWithMeshes();
      const originating = manager.document;
      let open = originating;
      const payloads = new Set<string>();
      const discard = vi.fn(async (_projectId: string, artifactId: string) => ({
        deleted: payloads.delete(artifactId)
      }));
      const result = await archiveLocalOnlyImportSources({
        document: originating,
        currentDocument: () => open,
        loadSourceBytes: async () => new Uint8Array([1, 2, 3]),
        archive: async ({ kind }) => {
          open = createProjectDocument(
            'Different project',
            toUserId('user_archival')
          );
          if (kind === 'mesh-payload') payloads.add('artifact_new_payload');
          return kind === 'mesh-payload'
            ? 'artifact_new_payload'
            : 'artifact_new_step';
        },
        applyArtifactId: () => {
          if (outcome === 'throws')
            throw new Error('Project changed after upload');
          return false;
        },
        discardMeshPayload: discard
      });
      expect(result).toEqual({
        archived: [],
        missing: [],
        failed: ['scan.stl', 'local.step']
      });
      expect(discard).toHaveBeenCalledExactlyOnceWith(
        originating.projectId,
        'artifact_new_payload'
      );
      expect(open.projectId).not.toBe(originating.projectId);
      expect(payloads.size).toBe(0);
    }
  );

  it.each(['rejects', 'retains'] as const)(
    'reports cleanup separately when the discard API %s without replacing the edit failure',
    async (outcome) => {
      const manager = managerWithMeshes();
      const cleanupFailure = vi.fn((_sourceName: string, _error: unknown) => {
        throw new Error('Observer failed');
      });
      const result = await archiveLocalOnlyImportSources({
        document: manager.document,
        currentDocument: () => manager.document,
        loadSourceBytes: async () => new Uint8Array([1, 2, 3]),
        archive: async () => 'artifact_new_payload',
        applyArtifactId: () => {
          throw new Error('Original edit refusal');
        },
        discardMeshPayload: async () => {
          if (outcome === 'rejects') throw new Error('Cleanup unavailable');
          return { deleted: false };
        },
        onCleanupFailure: cleanupFailure
      });
      expect(result.failed).toEqual(['scan.stl', 'local.step']);
      expect(cleanupFailure).toHaveBeenCalledOnce();
      expect(cleanupFailure.mock.calls[0]?.[0]).toBe('scan.stl');
    }
  );

  it.each(['success', 'throws-after-rewire'] as const)(
    'keeps mesh bytes when the originating history was rewired: %s',
    async (outcome) => {
      const manager = managerWithMeshes();
      const discard = vi.fn();
      const result = await archiveLocalOnlyImportSources({
        document: manager.document,
        currentDocument: () => manager.document,
        loadSourceBytes: async () => new Uint8Array([1, 2, 3]),
        archive: async () => 'artifact_new_payload',
        applyArtifactId: (featureId, artifactId) => {
          manager.archiveSource(featureId, artifactId);
          if (outcome === 'throws-after-rewire')
            throw new Error('UI publication failed');
          return true;
        },
        discardMeshPayload: discard
      });
      expect(discard).not.toHaveBeenCalled();
      expect(listLocalOnlyImportSources(manager.document)).toEqual([]);
      expect(result[outcome === 'success' ? 'archived' : 'failed']).toEqual([
        'scan.stl',
        'local.step'
      ]);
    }
  );

  it('never discards an already owned mesh payload', async () => {
    const manager = managerWithMeshes();
    manager.archiveSource(
      manager.document.featureOrder[0]!,
      'artifact_existing_payload'
    );
    const discard = vi.fn();
    const archive = vi.fn(
      async (_input: { kind: string }) => 'artifact_new_step'
    );
    await archiveLocalOnlyImportSources({
      document: manager.document,
      currentDocument: () => manager.document,
      loadSourceBytes: async () => new Uint8Array([1, 2, 3]),
      archive,
      applyArtifactId: () => false,
      discardMeshPayload: discard
    });
    expect(archive).toHaveBeenCalledOnce();
    expect(archive.mock.calls[0]?.[0]).toMatchObject({ kind: 'step-import' });
    expect(discard).not.toHaveBeenCalled();
  });

  it('keeps a restored current mesh local while an older upload archives only its retained source', async () => {
    const manager = managerWithMeshes();
    const initial = manager.document;
    const featureId = initial.featureOrder[0]!;
    const newer = { ...referenceFor('different mesh'), logicalBytes: 23 };
    const result = await archiveLocalOnlyImportSources({
      document: initial,
      currentDocument: () => manager.document,
      loadSourceBytes: async () => new Uint8Array([1, 2, 3]),
      archive: async ({ kind }) => {
        if (kind === 'mesh-payload')
          manager.execute(
            commandFactories.updateFeature({
              featureId,
              data: {
                artifactId: 'artifact_local_restored' as never,
                meshPayloadRef: newer
              }
            })
          );
        return kind === 'mesh-payload'
          ? 'artifact_cloud_old_mesh'
          : 'artifact_cloud_step';
      },
      applyArtifactId: (id, artifactId, source) => {
        manager.archiveSource(id, artifactId, source);
        return true;
      }
    });
    expect(result.archived).toEqual(['scan.stl', 'local.step']);
    expect(findFeature(manager.document, featureId)!.data).toMatchObject({
      artifactId: 'artifact_local_restored',
      meshPayloadRef: newer
    });
    expect(
      listLocalOnlyImportSources(manager.document).map(
        (source) => source.checksumSha256
      )
    ).toEqual([newer.checksumSha256]);
    manager.undo();
    expect(findFeature(manager.document, featureId)!.data).toMatchObject({
      artifactId: 'artifact_cloud_old_mesh',
      meshPayloadRef: referenceFor('mesh')
    });
  });

  it('discards the uploaded payload when a restore removes its model and retained history', async () => {
    const manager = managerWithMeshes();
    const initial = manager.document;
    const discard = vi.fn(async () => ({ deleted: true }));
    const result = await archiveLocalOnlyImportSources({
      document: initial,
      currentDocument: () => manager.document,
      loadSourceBytes: async () => new Uint8Array([1, 2, 3]),
      archive: async () => {
        manager.document = {
          ...createProjectDocument('Restored empty', initial.ownerUserId),
          projectId: initial.projectId
        };
        return 'artifact_cloud_unused';
      },
      applyArtifactId: (id, artifactId, source) => {
        const next = manager.archiveSource(id, artifactId, source);
        return [...documentNodesWithHistory(next)].some(
          (node) =>
            node.kind === 'feature' &&
            'artifactId' in node.data &&
            node.data.artifactId === artifactId
        );
      },
      discardMeshPayload: discard
    });
    expect(result.failed).toEqual(['scan.stl', 'local.step']);
    expect(discard).toHaveBeenCalledExactlyOnceWith(
      initial.projectId,
      'artifact_cloud_unused'
    );
    expect(manager.document.featureOrder).toEqual([]);
  });
});

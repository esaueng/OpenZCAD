import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProjectDocument,
  duplicateProjectDocument,
  importMeshBody,
  importStepBody
} from '@openzcad/document-core';
import {
  encodeImportedMeshPayload,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  deleteSourceBlobIfUnreferenced,
  loadSourceBlob,
  saveLocalProject
} from './localProjectStore';
import {
  preloadSharedImportSources,
  resolveExactSourceBytes
} from './exactSourceResolver';
import {
  archiveAccountImportSources,
  localizeImportedSourceArtifacts
} from './accountImportSources';
import {
  listLocalOnlyImportSources,
  meshPayloadArchive
} from './importArchival';
import {
  InMemoryPersistenceService,
  ProjectNotFoundError
} from '@openzcad/persistence';

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => vi.unstubAllGlobals());

async function sharedImport(artifactId: string): Promise<{
  document: ProjectDocument;
  source: Uint8Array<ArrayBuffer>;
  checksumSha256: string;
}> {
  const source = new TextEncoder().encode('ISO-10303-21;\nEND-ISO-10303-21;');
  const checksumSha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', source)),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
  const base = createProjectDocument(
    'Synthetic share',
    toUserId('source_owner')
  );
  const document = importStepBody(base, {
    name: 'Synthetic import',
    sourceName: 'synthetic.step',
    artifactId,
    stepSourceRef: {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256,
      logicalBytes: source.byteLength
    }
  }).document;
  return { document, source, checksumSha256 };
}

describe('anonymous shared STEP source preload', () => {
  it('fetches by share token and verifies source bytes before caching them', async () => {
    const { document, source, checksumSha256 } =
      await sharedImport('artifact_source');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(source, {
        headers: { 'content-length': String(source.byteLength) }
      })
    );
    await preloadSharedImportSources(document, 'share_token', fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/share/share_token/sources/artifact_source',
      { credentials: 'omit' }
    );
    expect(await loadSourceBlob(checksumSha256)).toEqual(source);
    await preloadSharedImportSources(document, 'share_token', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refuses damaged and device-only sources before opening the model', async () => {
    const { document, checksumSha256 } = await sharedImport('artifact_source');
    await expect(
      preloadSharedImportSources(
        document,
        'share_token',
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(new TextEncoder().encode('wrong')))
      )
    ).rejects.toThrow('failed its integrity check');
    expect(await loadSourceBlob(checksumSha256)).toBeNull();
    const local = await sharedImport('artifact_local_source');
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      preloadSharedImportSources(local.document, 'share_token', fetcher)
    ).rejects.toThrow('needs to save the source file');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('anonymous shared mesh payload preload', () => {
  it('saves a share copy under its own account and rebuilds on a fresh device', async () => {
    const service = new InMemoryPersistenceService();
    const owner = toUserId('mesh_source_owner');
    const visitor = toUserId('mesh_copy_owner');
    const { document: base } = await service.createProject(owner, {
      name: 'Shared scan'
    });
    const payload = encodeImportedMeshPayload({
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2]
    });
    const checksumSha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', payload)),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('');
    const ref = {
      marker: 'openzcad-source-ref' as const,
      version: 1 as const,
      hashAlgorithm: 'sha256' as const,
      checksumSha256,
      logicalBytes: payload.byteLength
    };
    const { session: original } = await service.createUploadSession(owner, {
      projectId: base.projectId,
      ...meshPayloadArchive('scan.stl')
    });
    await service.putUpload(owner, original.uploadSessionId, payload.buffer);
    await service.finalizeArtifact(owner, {
      projectId: base.projectId,
      uploadSessionId: original.uploadSessionId,
      artifactId: original.artifactId
    });
    const source = importMeshBody(base, {
      name: 'Scan',
      sourceName: 'scan.stl',
      triangleCount: 1,
      artifactId: original.artifactId,
      meshPayloadRef: ref
    }).document;
    const originalDocument = structuredClone(source);
    await preloadSharedImportSources(
      source,
      'owner_share_token',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(payload))
    );
    const copy = localizeImportedSourceArtifacts(
      duplicateProjectDocument(source, 'My scan', visitor)
    );
    await saveLocalProject(copy);
    // The persisted copy protects cached bytes even while its archive is pending.
    expect(await deleteSourceBlobIfUnreferenced({ checksumSha256 })).toBe(
      false
    );
    const { document: adopted } = await service.createProject(visitor, {
      name: copy.name,
      document: copy
    });
    const archived = await archiveAccountImportSources(adopted, {
      loadSourceBytes: loadSourceBlob,
      archive: async (input) => {
        const { session } = await service.createUploadSession(visitor, {
          projectId: adopted.projectId,
          fileName: input.fileName,
          contentType: input.contentType,
          kind: input.kind,
          metadata: input.metadata
        });
        await service.putUpload(
          visitor,
          session.uploadSessionId,
          await input.body.arrayBuffer()
        );
        const artifact = await service.finalizeArtifact(visitor, {
          projectId: adopted.projectId,
          uploadSessionId: session.uploadSessionId,
          artifactId: session.artifactId
        });
        if (!artifact) throw new Error('Payload archive did not finalize.');
        return artifact.artifactId;
      }
    });
    expect(archived.result.archived).toEqual(['scan.stl']);
    expect(listLocalOnlyImportSources(archived.document)).toEqual([]);
    await service.saveDocument(visitor, {
      projectId: adopted.projectId,
      expectedVersion: adopted.version,
      document: archived.document
    });
    const mesh = Object.values(archived.document.nodes).find(
      (node) =>
        node.kind === 'feature' && node.data.featureKind === 'imported-mesh'
    );
    if (
      !mesh ||
      mesh.kind !== 'feature' ||
      mesh.data.featureKind !== 'imported-mesh'
    )
      throw new Error('Copied mesh is missing.');
    const artifactId = mesh.data.artifactId;
    expect(artifactId).not.toBe(original.artifactId);
    const download = await service.downloadArtifact(
      visitor,
      mesh.data.artifactId
    );
    expect(download?.artifact.projectId).toBe(adopted.projectId);
    await expect(
      service.downloadArtifact(visitor, original.artifactId)
    ).rejects.toThrow(ProjectNotFoundError);
    expect(source).toEqual(originalDocument);

    // Another device has neither the owner's token nor the preload cache.
    globalThis.indexedDB = new IDBFactory();
    expect(await loadSourceBlob(checksumSha256)).toBeNull();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      expect(input).toBe(`/api/artifacts/${artifactId}/download`);
      return new Response(download?.body);
    });
    vi.stubGlobal('fetch', fetcher);
    expect(
      await resolveExactSourceBytes(ref, {
        artifactId: mesh.data.artifactId,
        sourceName: mesh.data.sourceName
      })
    ).toEqual(payload);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('fetches a referenced mesh payload through the share link before opening', async () => {
    const payload = encodeImportedMeshPayload({
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2]
    });
    const checksumSha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', payload)),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('');
    const document = importMeshBody(
      createProjectDocument('Shared mesh', toUserId('source_owner')),
      {
        name: 'Scan',
        sourceName: 'scan.stl',
        artifactId: 'artifact_payload',
        triangleCount: 1,
        meshPayloadRef: {
          marker: 'openzcad-source-ref',
          version: 1,
          hashAlgorithm: 'sha256',
          checksumSha256,
          logicalBytes: payload.byteLength
        }
      }
    ).document;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(payload));
    await preloadSharedImportSources(document, 'share_token', fetcher);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/share/share_token/sources/artifact_payload',
      { credentials: 'omit' }
    );
    expect(await loadSourceBlob(checksumSha256)).toEqual(payload);
  });
});

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
  type ArtifactId,
  type ImportedSourceReference,
  type ProjectDocument
} from '@openzcad/shared';
import {
  deleteSourceBlobIfUnreferenced,
  loadSourceBlob,
  saveLocalProject
} from './localProjectStore';
import {
  preloadEncryptedImportSources,
  preloadSharedImportSources,
  resolveExactSourceBytes,
  SOURCE_DOWNLOAD_IDLE_MS
} from './exactSourceResolver';
import {
  pageBlobReferences,
  setEncryptedBlobReader
} from './e2ee/blobReferences';
import { archiveAccountImportSources } from './accountImportSources';
import { readSharedSourceBytes } from './sharedSourceDownload';
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
      { credentials: 'omit', signal: fetcher.mock.calls[0]?.[1]?.signal }
    );
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
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
    const copy = duplicateProjectDocument(source, 'My scan', visitor);
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
      { credentials: 'omit', signal: fetcher.mock.calls[0]?.[1]?.signal }
    );
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(await loadSourceBlob(checksumSha256)).toEqual(payload);
  });
});

describe('anonymous shared source download budget', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['headers', 'body'] as const)(
    'rejects stalled %s even when the transport ignores abort, without caching late bytes',
    async (stage) => {
      const { document, source, checksumSha256 } =
        await sharedImport('artifact_source');
      let canceled = false;
      const cancel = vi.fn(() => {
        canceled = true;
      });
      let finishBody: (() => void) | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (stage === 'body') controller.enqueue(source.slice(0, 4));
          finishBody = () => {
            if (canceled) return;
            controller.enqueue(stage === 'body' ? source.slice(4) : source);
            controller.close();
          };
        },
        cancel
      });
      let releaseHeaders: (() => void) | undefined;
      const fetcher = vi.fn<typeof fetch>(() =>
        stage === 'headers'
          ? new Promise<Response>((resolve) => {
              releaseHeaders = () => resolve(new Response(body));
            })
          : Promise.resolve(new Response(body))
      );
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let outcome = 'pending';
      const pending = preloadSharedImportSources(
        document,
        'share_token',
        fetcher
      ).then(
        () => {
          outcome = 'resolved';
        },
        () => {
          outcome = 'rejected';
        }
      );
      try {
        await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(SOURCE_DOWNLOAD_IDLE_MS + 1);
        expect(outcome).toBe('rejected');
        expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
        expect(await loadSourceBlob(checksumSha256)).toBeNull();
        // A fetch that ignores abort can still resolve after the open failed.
        releaseHeaders?.();
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
        expect(body.locked).toBe(false);
        expect(await loadSourceBlob(checksumSha256)).toBeNull();
        await preloadSharedImportSources(
          document,
          'share_token',
          vi.fn<typeof fetch>().mockResolvedValue(new Response(source))
        );
        expect(await loadSourceBlob(checksumSha256)).toEqual(source);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        releaseHeaders?.();
        finishBody?.();
        await pending;
      }
    }
  );

  it('allows a shared source to take longer than one idle interval while headers and chunks progress', async () => {
    const { document, source, checksumSha256 } =
      await sharedImport('artifact_source');
    let resolveHeaders: ((response: Response) => void) | undefined;
    let push: ((chunk: Uint8Array | null) => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) =>
          chunk ? controller.enqueue(chunk) : controller.close();
      }
    });
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveHeaders = resolve;
        })
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = preloadSharedImportSources(
      document,
      'share_token',
      fetcher
    );
    await vi.waitFor(() => expect(resolveHeaders).toBeDefined());
    await vi.advanceTimersByTimeAsync(SOURCE_DOWNLOAD_IDLE_MS - 1_000);
    resolveHeaders!(new Response(body));
    await vi.advanceTimersByTimeAsync(SOURCE_DOWNLOAD_IDLE_MS - 1_000);
    push!(source.slice(0, 4));
    expect(await loadSourceBlob(checksumSha256)).toBeNull();
    await vi.advanceTimersByTimeAsync(SOURCE_DOWNLOAD_IDLE_MS - 1_000);
    push!(source.slice(4));
    push!(null);
    await pending;
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    expect(await loadSourceBlob(checksumSha256)).toEqual(source);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not count an empty body chunk as download progress', async () => {
    const { document, checksumSha256 } = await sharedImport('artifact_source');
    let push: (() => void) | undefined;
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            push = () => controller.enqueue(new Uint8Array());
          },
          cancel
        })
      )
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let outcome = 'pending';
    const pending = preloadSharedImportSources(
      document,
      'share_token',
      fetcher
    ).catch(() => {
      outcome = 'rejected';
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(SOURCE_DOWNLOAD_IDLE_MS - 1_000);
    push!();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(outcome).toBe('rejected');
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(await loadSourceBlob(checksumSha256)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['declared-size', 'logical-size', 'checksum'] as const)(
    'keeps a shared source with invalid %s out of the cache',
    async (failure) => {
      const { document, source, checksumSha256 } =
        await sharedImport('artifact_source');
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            failure === 'logical-size'
              ? source.slice(1)
              : failure === 'checksum'
                ? new Uint8Array(source.byteLength)
                : source
          );
          controller.close();
        },
        cancel
      });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(body, {
          headers:
            failure === 'declared-size'
              ? { 'content-length': String(128 * 1024 * 1024 + 1) }
              : {}
        })
      );
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await expect(
        preloadSharedImportSources(document, 'share_token', fetcher)
      ).rejects.toThrow('failed its integrity check');
      expect(await loadSourceBlob(checksumSha256)).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      if (failure === 'declared-size') expect(cancel).toHaveBeenCalledOnce();
    }
  );

  it.each(['declared', 'streamed'] as const)(
    'cancels a body that exceeds the %s ceiling without trusting its header',
    async (mode) => {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5, 6]));
        },
        cancel
      });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(body, {
          headers: { 'content-length': mode === 'declared' ? '6' : '1' }
        })
      );
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await expect(
        readSharedSourceBytes(
          '/source',
          'source.step',
          fetcher,
          5,
          SOURCE_DOWNLOAD_IDLE_MS
        )
      ).resolves.toBeNull();
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});

describe('reference source download budget', () => {
  afterEach(() => vi.useRealTimers());

  const context = {
    artifactId: 'artifact_cloud_source' as ArtifactId,
    sourceName: 'bracket.step'
  };

  function referenceTo(
    source: Uint8Array,
    checksumSha256: string
  ): ImportedSourceReference {
    return {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256,
      logicalBytes: source.byteLength
    };
  }

  /** A download that never progresses until its fetch signal aborts. */
  function stalledFetch(stage: 'headers' | 'body') {
    return vi.fn<typeof fetch>((_input, init) => {
      const signal = init?.signal;
      const aborted = () =>
        new DOMException('The operation was aborted.', 'AbortError');
      if (stage === 'headers') {
        return new Promise<Response>((_, reject) =>
          signal?.addEventListener('abort', () => reject(aborted()))
        );
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([73, 83, 79]));
          signal?.addEventListener('abort', () => controller.error(aborted()));
        }
      });
      return Promise.resolve(new Response(body));
    });
  }

  it.each(['headers', 'body'] as const)(
    'gives up on a download whose %s stall, as an unavailable source',
    async (stage) => {
      const { source, checksumSha256 } = await sharedImport('artifact_source');
      const fetcher = stalledFetch(stage);
      vi.stubGlobal('fetch', fetcher);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const outcome = resolveExactSourceBytes(
        referenceTo(source, checksumSha256),
        context
      ).then(
        () => 'resolved',
        (error: Error) => error.message
      );
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(SOURCE_DOWNLOAD_IDLE_MS + 1);
      expect(await outcome).toBe(
        'Import source for "bracket.step" is not in local storage and could not be fetched.'
      );
    }
  );

  it('marks only a device-only miss as one no later sync can recover', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 503 }))
    );
    const { source, checksumSha256 } = await sharedImport('artifact_source');
    const ref = referenceTo(source, checksumSha256);
    await expect(resolveExactSourceBytes(ref, context)).rejects.toMatchObject({
      permanent: false
    });
    await expect(
      resolveExactSourceBytes(ref, {
        ...context,
        artifactId: 'artifact_local_source' as ArtifactId
      })
    ).rejects.toMatchObject({ permanent: true });
  });

  it('lets a slow download finish while it keeps making progress', async () => {
    const { source, checksumSha256 } = await sharedImport('artifact_source');
    const half = Math.ceil(source.byteLength / 2);
    let push: ((chunk: Uint8Array | null) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                push = (chunk) =>
                  chunk ? controller.enqueue(chunk) : controller.close();
              }
            })
          )
        )
      )
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const resolved = resolveExactSourceBytes(
      referenceTo(source, checksumSha256),
      context
    );
    await vi.waitFor(() => expect(push).toBeDefined());
    // Longer in total than the idle budget, but never idle for that long.
    await vi.advanceTimersByTimeAsync(SOURCE_DOWNLOAD_IDLE_MS - 1_000);
    push!(source.slice(0, half));
    await vi.advanceTimersByTimeAsync(SOURCE_DOWNLOAD_IDLE_MS - 1_000);
    push!(source.slice(half));
    push!(null);
    await expect(resolved).resolves.toEqual(source);
    expect(await loadSourceBlob(checksumSha256)).toEqual(source);
  });

  /** A download whose body the test feeds; it errors once its fetch aborts. */
  function feedableFetch() {
    const fed: { push?: (chunk: Uint8Array | null) => void } = {};
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>((_input, init) => {
      const signal = init!.signal!;
      signals.push(signal);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          fed.push = (chunk) =>
            chunk ? controller.enqueue(chunk) : controller.close();
          signal.addEventListener('abort', () =>
            controller.error(new DOMException('Aborted', 'AbortError'))
          );
        }
      });
      return Promise.resolve(new Response(body));
    });
    vi.stubGlobal('fetch', fetcher);
    return { fed, signals, fetcher };
  }

  it('lets the rebuild that superseded another join its running download', async () => {
    const { source, checksumSha256 } = await sharedImport('artifact_source');
    const ref = referenceTo(source, checksumSha256);
    const { fed, fetcher } = feedableFetch();
    // An edit supersedes the first rebuild mid-download...
    const superseded = new AbortController();
    void resolveExactSourceBytes(ref, {
      ...context,
      signal: superseded.signal
    }).catch(() => undefined);
    await vi.waitFor(() => expect(fed.push).toBeDefined());
    fed.push!(source.slice(0, 4));
    superseded.abort();
    // ...and the rebuild that replaced it takes the transfer over.
    const next = resolveExactSourceBytes(ref, {
      ...context,
      signal: new AbortController().signal
    });
    fed.push!(source.slice(4));
    fed.push!(null);
    await expect(next).resolves.toEqual(source);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('aborts a download no rebuild has wanted for the idle budget', async () => {
    const { source, checksumSha256 } = await sharedImport('artifact_source');
    const { fed, signals } = feedableFetch();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const superseded = new AbortController();
    void resolveExactSourceBytes(referenceTo(source, checksumSha256), {
      ...context,
      signal: superseded.signal
    }).catch(() => undefined);
    await vi.waitFor(() => expect(fed.push).toBeDefined());
    superseded.abort();
    // Still progressing, so only the abandonment can end it.
    for (let second = 0; second < SOURCE_DOWNLOAD_IDLE_MS; second += 10_000) {
      expect(signals[0]!.aborted).toBe(false);
      fed.push!(new Uint8Array(1));
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(signals[0]!.aborted).toBe(true);
  });
});

/**
 * ADR-024 Phase 4, content blobs: an encrypted project's sources are blobs
 * only this page holds keys for, so geometry workers cannot fetch them. The
 * page puts them in the local blob store first, decrypted by its registered
 * reader and checked against the document's own checksum, and never asks
 * the plaintext download route.
 */
describe('encrypted project sources', () => {
  const BLOB = 'b'.repeat(32);
  afterEach(() => {
    setEncryptedBlobReader(null);
    pageBlobReferences.clear();
  });

  function holdReference(plaintextLength: number) {
    pageBlobReferences.remember('proj_encrypted', {
      blobId: BLOB,
      kind: 'import-source',
      key: new Uint8Array(32),
      ciphertextHash: new Uint8Array(32),
      plaintextLength
    });
  }

  it('fetches, checks and caches a source before the workers need it', async () => {
    const { document, source, checksumSha256 } = await sharedImport(BLOB);
    holdReference(source.byteLength);
    const reader = vi.fn(async () => new Uint8Array(source));
    setEncryptedBlobReader(reader);
    const plaintext = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', plaintext);
    await preloadEncryptedImportSources(document);
    expect(reader).toHaveBeenCalledWith(
      'proj_encrypted',
      BLOB,
      expect.anything(),
      expect.any(Function)
    );
    expect(await loadSourceBlob(checksumSha256)).toEqual(source);
    expect(plaintext).not.toHaveBeenCalled();
    // Cached now: a second preload reads nothing.
    await preloadEncryptedImportSources(document);
    expect(reader).toHaveBeenCalledOnce();
  });

  it('refuses decrypted bytes that are not the document’s source', async () => {
    const { document, source, checksumSha256 } = await sharedImport(BLOB);
    holdReference(source.byteLength);
    setEncryptedBlobReader(async () => new TextEncoder().encode('other'));
    await expect(preloadEncryptedImportSources(document)).rejects.toThrow(
      /could not be fetched/
    );
    expect(await loadSourceBlob(checksumSha256)).toBeNull();
  });

  it('leaves an id this page holds no key for to the ordinary paths', async () => {
    const { document } = await sharedImport('artifact_plain');
    const reader = vi.fn();
    setEncryptedBlobReader(reader);
    await preloadEncryptedImportSources(document);
    expect(reader).not.toHaveBeenCalled();
  });
});

import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import {
  toUserId,
  type ArtifactId,
  type ImportedSourceReference,
  type ProjectDocument
} from '@openzcad/shared';
import { loadSourceBlob } from './localProjectStore';
import {
  preloadSharedImportSources,
  resolveExactSourceBytes,
  SOURCE_DOWNLOAD_IDLE_MS
} from './exactSourceResolver';

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

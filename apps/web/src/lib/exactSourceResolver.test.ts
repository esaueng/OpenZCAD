import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { loadSourceBlob } from './localProjectStore';
import { preloadSharedImportSources } from './exactSourceResolver';

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

import { describe, expect, it, vi } from 'vitest';
import {
  E2EE_FRAME_CONTENT_TYPE,
  decodeE2eeFrame,
  encodeE2eeFrame
} from '@openzcad/shared';
import { ApiError } from '../api';
import { createEncryptedDocumentsApi } from './encryptedDocumentsApi';

const upload = {
  expectedVersion: 2,
  signature: 'sig',
  wrappedVersionKey: 'wrap',
  signerDeviceId: 'dev'
};

describe('encrypted documents API', () => {
  it('sends envelopes as raw frames, never as base64 JSON', async () => {
    const fetcher = vi.fn(
      async (_path: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ version: 3 }), { status: 200 })
    );
    const api = createEncryptedDocumentsApi(fetcher);
    const envelope = Uint8Array.of(1, 2, 3, 250);
    await api.saveDocument('proj_a/b', upload, envelope);
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe('/api/e2ee/projects/proj_a%2Fb/document');
    expect(init?.method).toBe('PUT');
    expect(
      (init?.headers as Record<string, string>)['content-type']
    ).toBe(E2EE_FRAME_CONTENT_TYPE);
    const frame = decodeE2eeFrame(init!.body as Uint8Array);
    expect(frame.metadata).toEqual({ version: upload });
    expect([...frame.payload]).toEqual([1, 2, 3, 250]);
  });

  it('reads the head frame and turns refusals into ApiErrors', async () => {
    const metadata = { head: { documentVersion: 4 } };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(encodeE2eeFrame(metadata, Uint8Array.of(9, 8)), {
          status: 200
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'Newer.',
            code: 'REVISION_CONFLICT',
            currentVersion: 7
          }),
          { status: 409 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'REVISION_NOT_FOUND' }), {
          status: 404
        })
      )
      .mockResolvedValueOnce(new Response('<html>', { status: 200 }));
    const api = createEncryptedDocumentsApi(fetcher);
    const head = await api.loadDocument('proj_a', 3);
    expect(fetcher.mock.calls[0]![0]).toBe(
      '/api/e2ee/projects/proj_a/document?since=3'
    );
    expect(head.metadata).toEqual(metadata);
    expect([...head.envelope]).toEqual([9, 8]);
    await expect(
      api.saveDocument('proj_a', upload, new Uint8Array(1))
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ApiError &&
        error.status === 409 &&
        error.code === 'REVISION_CONFLICT' &&
        error.details?.currentVersion === 7
    );
    // A pruned revision is an ordinary null.
    await expect(api.revision('proj_a', 'rev_1')).resolves.toBeNull();
    // A static host's HTML is not a frame.
    await expect(api.loadDocument('proj_a')).rejects.toMatchObject({
      status: 502
    });
  });
});

import { describe, expect, it } from 'vitest';
import { ARTIFACT_UPLOAD_PART_BYTES } from '@openzcad/shared';
import {
  ARTIFACT_PART_UPLOAD_ATTEMPTS,
  planUploadParts,
  uploadArtifactBody,
  type ArtifactUploadTransport
} from './artifactUpload';

const MIB = 1024 * 1024;
const OLD_SINGLE_PUT_CAP = 25 * MIB;

function recordingTransport(overrides?: Partial<ArtifactUploadTransport>): {
  transport: ArtifactUploadTransport;
  calls: string[];
} {
  const calls: string[] = [];
  const transport: ArtifactUploadTransport = {
    async uploadArtifact(_url, body) {
      calls.push(`put:${body.size}`);
    },
    async createMultipartUpload() {
      calls.push('create');
      return { uploadId: 'upload_test' };
    },
    async uploadArtifactPart(_session, _uploadId, partNumber, body) {
      calls.push(`part:${partNumber}:${body.size}`);
      return { partNumber, etag: `etag-${partNumber}` };
    },
    async completeMultipartUpload(_session, payload) {
      calls.push(`complete:${payload.parts.length}`);
    },
    async abortMultipartUpload(_session, uploadId) {
      calls.push(`abort:${uploadId}`);
    },
    ...overrides
  };
  return { transport, calls };
}

const session = { uploadSessionId: 'us_1', uploadUrl: '/api/uploads/us_1/content' };
const noDelay = () => Promise.resolve();

describe('planUploadParts', () => {
  it('slices equal parts with a smaller final part', () => {
    const parts = planUploadParts(40 * MIB, 16 * MIB);
    expect(parts).toEqual([
      { partNumber: 1, start: 0, end: 16 * MIB },
      { partNumber: 2, start: 16 * MIB, end: 32 * MIB },
      { partNumber: 3, start: 32 * MIB, end: 40 * MIB }
    ]);
  });

  it('covers the sizes around the old 25 MiB single-request cap', () => {
    // Just below and above the boundary that produced the production 413:
    // both now chunk, and every non-final part is exactly the fixed size.
    for (const total of [OLD_SINGLE_PUT_CAP - 1, OLD_SINGLE_PUT_CAP + 1]) {
      const parts = planUploadParts(total);
      expect(parts.length).toBe(2);
      expect(parts[0]).toMatchObject({ start: 0, end: ARTIFACT_UPLOAD_PART_BYTES });
      expect(parts[1]!.end).toBe(total);
    }
  });

  it('keeps the advertised 250 MB limit within the part-count ceiling', () => {
    const parts = planUploadParts(250 * 1000 * 1000);
    expect(parts.length).toBe(15);
    expect(parts.every((p, i) => p.partNumber === i + 1)).toBe(true);
    expect(parts.at(-1)!.end).toBe(250 * 1000 * 1000);
  });
});

describe('uploadArtifactBody', () => {
  it('uses a single PUT at or below the part size', async () => {
    const { transport, calls } = recordingTransport();
    await uploadArtifactBody(transport, session, new Blob(['x']), {
      partBytes: 8
    });
    expect(calls).toEqual(['put:1']);
  });

  it('chunks larger bodies and completes with every part', async () => {
    const { transport, calls } = recordingTransport();
    await uploadArtifactBody(
      transport,
      session,
      new Blob(['a'.repeat(20)]),
      { partBytes: 8, retryDelay: noDelay }
    );
    expect(calls).toEqual([
      'create',
      'part:1:8',
      'part:2:8',
      'part:3:4',
      'complete:3'
    ]);
  });

  it('retries a failing part before succeeding', async () => {
    const shared = recordingTransport();
    let remaining = ARTIFACT_PART_UPLOAD_ATTEMPTS - 1;
    const flaky: ArtifactUploadTransport = {
      ...shared.transport,
      async uploadArtifactPart(s, u, partNumber, body) {
        if (partNumber === 2 && remaining > 0) {
          remaining -= 1;
          throw new Error('flaky network');
        }
        return shared.transport.uploadArtifactPart(s, u, partNumber, body);
      }
    };
    await uploadArtifactBody(flaky, session, new Blob(['a'.repeat(20)]), {
      partBytes: 8,
      retryDelay: noDelay
    });
    expect(shared.calls).toContain('part:2:8');
    expect(shared.calls.at(-1)).toBe('complete:3');
  });

  it('aborts the multipart upload after the retries are exhausted', async () => {
    const shared = recordingTransport();
    const failing: ArtifactUploadTransport = {
      ...shared.transport,
      async uploadArtifactPart() {
        shared.calls.push('part-attempt');
        throw new Error('storage down');
      }
    };
    await expect(
      uploadArtifactBody(failing, session, new Blob(['a'.repeat(20)]), {
        partBytes: 8,
        retryDelay: noDelay
      })
    ).rejects.toThrow('storage down');
    expect(
      shared.calls.filter((call) => call === 'part-attempt').length
    ).toBe(ARTIFACT_PART_UPLOAD_ATTEMPTS);
    expect(shared.calls.at(-1)).toBe('abort:upload_test');
  });

  it('aborts when completion fails and still surfaces the error', async () => {
    const shared = recordingTransport();
    const failing: ArtifactUploadTransport = {
      ...shared.transport,
      async completeMultipartUpload() {
        throw new Error('completion refused');
      }
    };
    await expect(
      uploadArtifactBody(failing, session, new Blob(['a'.repeat(20)]), {
        partBytes: 8,
        retryDelay: noDelay
      })
    ).rejects.toThrow('completion refused');
    expect(shared.calls.at(-1)).toBe('abort:upload_test');
  });

  /**
   * Progress here is exact rather than estimated: the part plan is computed
   * before the first request, so each report is the byte the store has
   * actually accepted.
   */
  it('reports accepted bytes after each part', async () => {
    const { transport } = recordingTransport();
    const reported: [number, number][] = [];
    await uploadArtifactBody(transport, session, new Blob(['a'.repeat(20)]), {
      partBytes: 8,
      retryDelay: noDelay,
      onProgress: (uploaded, total) => reported.push([uploaded, total])
    });
    expect(reported).toEqual([
      [8, 20],
      [16, 20],
      [20, 20]
    ]);
  });

  /**
   * There is no progress inside a single request to report, so a small body
   * goes from nothing to done. Staying silent instead would leave the card's
   * archiving phase looking stalled for the whole upload.
   */
  it('reports once on completion for a single-PUT body', async () => {
    const { transport } = recordingTransport();
    const reported: [number, number][] = [];
    await uploadArtifactBody(transport, session, new Blob(['abc']), {
      partBytes: 8,
      onProgress: (uploaded, total) => reported.push([uploaded, total])
    });
    expect(reported).toEqual([[3, 3]]);
  });

  /** A part that never lands must not be counted as accepted. */
  it('reports nothing for a part the store refused', async () => {
    const shared = recordingTransport();
    const failing: ArtifactUploadTransport = {
      ...shared.transport,
      async uploadArtifactPart(_session, _uploadId, partNumber, body) {
        if (partNumber === 2) {
          throw new Error('part rejected');
        }
        return { partNumber, etag: `etag-${partNumber}-${body.size}` };
      }
    };
    const reported: number[] = [];
    await expect(
      uploadArtifactBody(failing, session, new Blob(['a'.repeat(20)]), {
        partBytes: 8,
        retryDelay: noDelay,
        onProgress: (uploaded) => reported.push(uploaded)
      })
    ).rejects.toThrow('part rejected');
    expect(reported).toEqual([8]);
  });

  /**
   * Aborting must still unwind the multipart state. A stopped upload that left
   * its parts behind would occupy the session with an upload nobody finishes.
   */
  it('aborts the multipart state when cancelled between parts', async () => {
    const shared = recordingTransport();
    const controller = new AbortController();
    const cancelling: ArtifactUploadTransport = {
      ...shared.transport,
      async uploadArtifactPart(_session, _uploadId, partNumber, body) {
        if (partNumber === 2) {
          controller.abort();
        }
        return { partNumber, etag: `etag-${partNumber}-${body.size}` };
      }
    };
    await expect(
      uploadArtifactBody(cancelling, session, new Blob(['a'.repeat(20)]), {
        partBytes: 8,
        retryDelay: noDelay,
        signal: controller.signal
      })
    ).rejects.toThrow();
    expect(shared.calls.at(-1)).toBe('abort:upload_test');
    expect(shared.calls).not.toContain('complete:3');
  });

  it('uploads nothing at all when already cancelled', async () => {
    const { transport, calls } = recordingTransport();
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadArtifactBody(transport, session, new Blob(['a'.repeat(20)]), {
        partBytes: 8,
        retryDelay: noDelay,
        signal: controller.signal
      })
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
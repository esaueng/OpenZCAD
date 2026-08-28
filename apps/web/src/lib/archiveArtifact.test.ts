import { describe, expect, it, vi } from 'vitest';
import { toProjectId, type ArtifactRecord } from '@openzcad/shared';
import {
  archiveArtifact,
  type ArchiveArtifactTransport
} from './archiveArtifact';

const PROJECT = toProjectId('proj_archive');

function record(): ArtifactRecord {
  return {
    artifactId: 'art_one',
    projectId: PROJECT,
    kind: 'step-import',
    fileName: 'bracket.step',
    contentType: 'application/step',
    bytes: 10,
    checksumSha256: 'sha',
    createdAt: '2026-01-01T00:00:00.000Z'
  } as unknown as ArtifactRecord;
}

/**
 * A transport that reports the upload part by part and lets the test decide
 * when to cancel — the real thing is a multipart PUT loop that checks the
 * signal between parts.
 */
function transport(overrides: Partial<ArchiveArtifactTransport> = {}) {
  const uploadArtifact = vi.fn<ArchiveArtifactTransport['uploadArtifact']>(
    () => Promise.resolve()
  );
  const uploadArtifactPart = vi.fn<
    ArchiveArtifactTransport['uploadArtifactPart']
  >((_session, _uploadId, partNumber) =>
    Promise.resolve({ partNumber, etag: `etag-${partNumber}` })
  );
  const api: ArchiveArtifactTransport = {
    uploadArtifact,
    createMultipartUpload: vi.fn(() => Promise.resolve({ uploadId: 'mp_1' })),
    uploadArtifactPart,
    completeMultipartUpload: vi.fn(() => Promise.resolve()),
    abortMultipartUpload: vi.fn(() => Promise.resolve()),
    createUploadSession: vi.fn(() =>
      Promise.resolve({
        session: {
          uploadSessionId: 'ups_1',
          artifactId: 'art_one',
          uploadUrl: 'https://upload.test/put'
        }
      })
    ) as unknown as ArchiveArtifactTransport['createUploadSession'],
    finalizeArtifact: vi.fn(() => Promise.resolve({ artifactId: 'art_one' })),
    getArtifactMetadata: vi.fn(() => Promise.resolve({ artifact: record() })),
    ...overrides
  };
  return { api, uploadArtifact, uploadArtifactPart };
}

/**
 * Cancelling an import used to leave its upload running.
 *
 * `runStepImport` has always handed an AbortSignal to the archive step, but
 * the app's implementation of that step did not declare the property, so it
 * was dropped without a type error. Archiving is the longest phase of an
 * import and the only one with a byte-accurate progress bar, so it is exactly
 * the phase a user reaches for Cancel during — and up to 128 MB kept going,
 * then finalized an artifact into the File menu after the card had said the
 * import was cancelled. A cancelled import prunes its local source, so the
 * finalized object was left owned by nothing.
 */
describe('archiving an artifact for an import that is cancelled', () => {
  it('stops the upload and finalizes nothing', async () => {
    const controller = new AbortController();
    const { api, uploadArtifact } = transport();
    uploadArtifact.mockImplementation(() => {
      controller.abort();
      return Promise.resolve();
    });

    await expect(
      archiveArtifact(api, PROJECT, {
        fileName: 'bracket.step',
        contentType: 'application/step',
        kind: 'step-import',
        body: new Blob(['solid']),
        signal: controller.signal
      })
    ).rejects.toThrow();

    // The artifact must not exist. An unfinalized session is swept by the
    // worker's expiry sweep; a finalized artifact is permanent.
    expect(api.finalizeArtifact).not.toHaveBeenCalled();
    expect(api.getArtifactMetadata).not.toHaveBeenCalled();
  });

  it('does not open an upload session when already cancelled', async () => {
    const { api } = transport();
    await expect(
      archiveArtifact(api, PROJECT, {
        fileName: 'bracket.step',
        contentType: 'application/step',
        kind: 'step-import',
        body: new Blob(['solid']),
        signal: AbortSignal.abort()
      })
    ).rejects.toThrow();
    expect(api.createUploadSession).not.toHaveBeenCalled();
  });

  it('hands the signal to the multipart loop, which stops between parts', async () => {
    const controller = new AbortController();
    const { api, uploadArtifactPart: part } = transport();
    part.mockImplementation((_session, _uploadId, partNumber) => {
      // Cancel while the transfer is genuinely in flight, which is what a
      // user watching the progress bar does.
      if (partNumber === 1) {
        controller.abort();
      }
      return Promise.resolve({ partNumber, etag: `etag-${partNumber}` });
    });

    await expect(
      archiveArtifact(api, PROJECT, {
        fileName: 'big.step',
        contentType: 'application/step',
        kind: 'step-import',
        // Over the real 16 MiB part size, so this takes the chunked path with
        // the shipped constants rather than a seam invented for the test.
        body: new Blob(['x'.repeat(17 * 1024 * 1024)]),
        signal: controller.signal
      })
    ).rejects.toThrow();

    // 17 MiB is two parts. The first was already in flight when Cancel
    // landed, and mid-request there is nothing to stop; the second never went
    // up at all. Without the signal both parts transfer.
    expect(part).toHaveBeenCalledTimes(1);
    expect(api.completeMultipartUpload).not.toHaveBeenCalled();
    expect(api.finalizeArtifact).not.toHaveBeenCalled();
    // The multipart state is cleaned up rather than left occupying the session.
    expect(api.abortMultipartUpload).toHaveBeenCalled();
  });

  it('still archives normally when nothing cancels', async () => {
    const { api } = transport();
    const stored = vi.fn();
    const artifactId = await archiveArtifact(
      api,
      PROJECT,
      {
        fileName: 'bracket.step',
        contentType: 'application/step',
        kind: 'step-import',
        body: new Blob(['solid'])
      },
      stored
    );
    expect(artifactId).toBe('art_one');
    expect(api.finalizeArtifact).toHaveBeenCalledOnce();
    expect(stored).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: 'art_one' })
    );
  });
});

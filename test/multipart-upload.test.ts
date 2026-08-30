import { describe, expect, it } from 'vitest';
import {
  ArtifactStorageError,
  InMemoryPersistenceService
} from '@openzcad/persistence';
import { MAX_ARTIFACT_UPLOAD_PARTS, toUserId } from '@openzcad/shared';
import {
  parseCompleteMultipartUploadRequest,
  parseCreateUploadSessionRequest
} from '../apps/web/worker/validation';

const userId = toUserId('user_multipart');

async function sessionFor(service: InMemoryPersistenceService) {
  const projectId = (
    await service.createProject(userId, { name: 'Big imports' })
  ).document.projectId;
  const { session } = await service.createUploadSession(userId, {
    projectId,
    fileName: 'huge.step',
    contentType: 'model/step',
    kind: 'step-import'
  });
  return { projectId, session };
}

function chunk(text: string): ArrayBuffer {
  const encoded = new TextEncoder().encode(text);
  return encoded.buffer.slice(0, encoded.byteLength);
}

describe('multipart artifact upload', () => {
  it('stitches parts in part-number order and finalizes like a single PUT', async () => {
    const service = new InMemoryPersistenceService();
    const { projectId, session } = await sessionFor(service);

    const { uploadId } = await service.createMultipartUpload(
      userId,
      session.uploadSessionId
    );
    // Upload out of order; completion order is the part numbers, not arrival.
    const second = await service.putUploadPart(
      userId,
      session.uploadSessionId,
      uploadId,
      2,
      chunk('WORLD')
    );
    const first = await service.putUploadPart(
      userId,
      session.uploadSessionId,
      uploadId,
      1,
      chunk('HELLO-')
    );
    await service.completeMultipartUpload(userId, session.uploadSessionId, {
      uploadId,
      parts: [second, first]
    });

    const artifact = await service.finalizeArtifact(userId, {
      projectId,
      uploadSessionId: session.uploadSessionId,
      artifactId: session.artifactId
    });
    expect(artifact).not.toBeNull();
    const downloaded = await service.downloadArtifact(
      userId,
      session.artifactId
    );
    // The in-memory backend always returns buffered bytes; object-storage
    // backends stream, which is why the contract is a union.
    expect(downloaded!.body).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(downloaded!.body as ArrayBuffer)).toBe(
      'HELLO-WORLD'
    );
  });

  it('rejects completion with a stale etag or unknown upload id', async () => {
    const service = new InMemoryPersistenceService();
    const { session } = await sessionFor(service);
    const { uploadId } = await service.createMultipartUpload(
      userId,
      session.uploadSessionId
    );
    const part = await service.putUploadPart(
      userId,
      session.uploadSessionId,
      uploadId,
      1,
      chunk('DATA')
    );
    await expect(
      service.completeMultipartUpload(userId, session.uploadSessionId, {
        uploadId: 'multipart_unknown',
        parts: [part]
      })
    ).rejects.toThrow(ArtifactStorageError);
    await expect(
      service.completeMultipartUpload(userId, session.uploadSessionId, {
        uploadId,
        parts: [{ partNumber: 1, etag: 'etag-1-999' }]
      })
    ).rejects.toThrow(ArtifactStorageError);
  });

  it('discards parts on abort so completion can no longer stitch them', async () => {
    const service = new InMemoryPersistenceService();
    const { session } = await sessionFor(service);
    const { uploadId } = await service.createMultipartUpload(
      userId,
      session.uploadSessionId
    );
    const part = await service.putUploadPart(
      userId,
      session.uploadSessionId,
      uploadId,
      1,
      chunk('DATA')
    );
    await service.abortMultipartUpload(
      userId,
      session.uploadSessionId,
      uploadId
    );
    await expect(
      service.completeMultipartUpload(userId, session.uploadSessionId, {
        uploadId,
        parts: [part]
      })
    ).rejects.toThrow(ArtifactStorageError);
    // Aborting an unknown or already-aborted id is a no-op, so a client can
    // always abort on its failure path.
    await expect(
      service.abortMultipartUpload(userId, session.uploadSessionId, uploadId)
    ).resolves.toBeUndefined();
  });

  it('reuses the active upload and rejects parts above the completion cap', async () => {
    const service = new InMemoryPersistenceService();
    const { session } = await sessionFor(service);
    const first = await service.createMultipartUpload(
      userId,
      session.uploadSessionId
    );
    const second = await service.createMultipartUpload(
      userId,
      session.uploadSessionId
    );

    expect(second).toEqual(first);
    await service.abortMultipartUpload(
      userId,
      session.uploadSessionId,
      'multipart_unknown'
    );
    await expect(
      service.createMultipartUpload(userId, session.uploadSessionId)
    ).resolves.toEqual(first);
    await expect(
      service.putUploadPart(
        userId,
        session.uploadSessionId,
        first.uploadId,
        MAX_ARTIFACT_UPLOAD_PARTS + 1,
        chunk('DATA')
      )
    ).rejects.toThrow(/out of range/);
  });

  it('parses a completion request and rejects malformed part lists', () => {
    const valid = parseCompleteMultipartUploadRequest({
      uploadId: 'multipart_a',
      parts: [
        { partNumber: 2, etag: 'b' },
        { partNumber: 1, etag: 'a' }
      ]
    });
    expect(valid.parts).toHaveLength(2);

    expect(() =>
      parseCompleteMultipartUploadRequest({ uploadId: 'x', parts: [] })
    ).toThrow(/non-empty/);
    expect(() =>
      parseCompleteMultipartUploadRequest({
        uploadId: 'x',
        parts: [
          { partNumber: 1, etag: 'a' },
          { partNumber: 1, etag: 'b' }
        ]
      })
    ).toThrow(/unique integer/);
    expect(() =>
      parseCompleteMultipartUploadRequest({
        uploadId: 'x',
        parts: Array.from(
          { length: MAX_ARTIFACT_UPLOAD_PARTS + 1 },
          (_, i) => ({
            partNumber: i + 1,
            etag: 'e'
          })
        )
      })
    ).toThrow(/cannot exceed/);
    expect(() =>
      parseCompleteMultipartUploadRequest({
        uploadId: 'x',
        parts: [{ partNumber: 0, etag: 'a' }]
      })
    ).toThrow(/unique integer/);
  });

  it('keeps the legacy multipart marker out of client metadata', () => {
    expect(() =>
      parseCreateUploadSessionRequest({
        projectId: 'project_a',
        fileName: 'model.step',
        contentType: 'model/step',
        kind: 'step-import',
        metadata: { __openzcadMultipartUploadId: 'user-controlled' }
      })
    ).toThrow(/reserved field/);
  });
});

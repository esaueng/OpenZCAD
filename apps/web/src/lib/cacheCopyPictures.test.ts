import { describe, expect, it, vi } from 'vitest';
import {
  addReferenceImage,
  createProjectDocument
} from '@openzcad/document-core';
import {
  toUserId,
  type ArtifactId,
  type ProjectDocument,
  type ReferenceImage,
  type ReferenceImageId
} from '@openzcad/shared';

const resolver = vi.hoisted(() => ({
  resolveExactSourceBytes: vi.fn(
    async (_ref: unknown, context: { artifactId: string }) => {
      if (context.artifactId.startsWith('artifact_local_'))
        throw new Error('That picture is on another device only.');
      return new Uint8Array(4);
    }
  )
}));
vi.mock('./exactSourceResolver', () => resolver);

const { cacheCopyPictures } = await import('./sourceBlobClaims');

const sum = 'a'.repeat(64);

function picture(id: string, artifactId: string): ReferenceImage {
  return {
    imageId: id as ReferenceImageId,
    name: id,
    contentType: 'image/png',
    source: {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256: sum,
      logicalBytes: 4
    },
    artifactId: artifactId as ArtifactId,
    pixelWidth: 2,
    pixelHeight: 2,
    plane: { type: 'canonical', plane: 'XY', offset: 0 },
    center: { u: 0, v: 0 },
    rotationDeg: 0,
    width: 10,
    opacity: 1
  };
}

function withPictures(...images: ReferenceImage[]): ProjectDocument {
  return images.reduce(
    (document, image) => addReferenceImage(document, { image }),
    createProjectDocument('Copy source', toUserId('test'))
  );
}

describe('cacheCopyPictures', () => {
  it('takes the picture from any record that can serve it', async () => {
    const document = withPictures(
      picture('rimg_a', 'artifact_local_elsewhere'),
      picture('rimg_b', 'artifact_cloud')
    );
    await expect(
      cacheCopyPictures(
        document,
        async () => null,
        async () => sum
      )
    ).resolves.toBeUndefined();
    expect(
      resolver.resolveExactSourceBytes.mock.calls.map(
        ([, context]) => context.artifactId
      )
    ).toEqual(['artifact_local_elsewhere', 'artifact_cloud']);
  });

  it('refuses the copy only when no record can serve it', async () => {
    const document = withPictures(
      picture('rimg_a', 'artifact_local_one'),
      picture('rimg_b', 'artifact_local_two')
    );
    await expect(
      cacheCopyPictures(
        document,
        async () => null,
        async () => sum
      )
    ).rejects.toThrow(/another device only/);
  });
});

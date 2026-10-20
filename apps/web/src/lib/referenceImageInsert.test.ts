import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import {
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_IMAGE_BYTES,
  toUserId,
  type ImportedSourceReference
} from '@openzcad/shared';

type Readiness = 'ready' | 'blocked' | 'unavailable';
const store = vi.hoisted(
  (): {
    ready: Readiness;
    blobs: Map<string, Uint8Array>;
    puts: Uint8Array[];
    deleted: string[];
  } => ({ ready: 'ready', blobs: new Map(), puts: [], deleted: [] })
);

vi.mock('./localProjectStore', () => ({
  ensureLocalProjectStorage: vi.fn(async () => store.ready),
  putSourceBlobIfAbsent: vi.fn(async (bytes: Uint8Array) => {
    store.puts.push(bytes);
    const checksumSha256 = 'e'.repeat(64);
    const created = !store.blobs.has(checksumSha256);
    store.blobs.set(checksumSha256, bytes);
    return {
      ref: {
        marker: 'openzcad-source-ref',
        version: 1,
        hashAlgorithm: 'sha256',
        checksumSha256,
        logicalBytes: bytes.byteLength
      } satisfies ImportedSourceReference,
      created
    };
  }),
  loadSourceBlob: vi.fn(
    async (checksum: string) => store.blobs.get(checksum) ?? null
  ),
  sha256Hex: vi.fn(async () => 'e'.repeat(64)),
  deleteSourceBlobIfUnreferenced: vi.fn(
    async ({ checksumSha256 }: { checksumSha256: string }) => {
      store.deleted.push(checksumSha256);
      return true;
    }
  )
}));

const resolver = vi.hoisted(() => ({
  resolveExactSourceBytes: vi.fn(async () => new Uint8Array([7, 7]))
}));
vi.mock('./exactSourceResolver', () => resolver);

const {
  discardReferenceImageBytes,
  loadReferenceImageBlob,
  prepareReferenceImage
} = await import('./referenceImageInsert');

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2
]);

function file(bytes: Uint8Array, name = 'Floor plan.png') {
  return new File([bytes as Uint8Array<ArrayBuffer>], name);
}

const plane = { type: 'canonical', plane: 'XY', offset: 0 } as const;
const measure = vi.fn(async () => ({ width: 640, height: 480 }));

beforeEach(() => {
  store.ready = 'ready';
  store.blobs.clear();
  store.puts = [];
  store.deleted = [];
  measure.mockClear();
  resolver.resolveExactSourceBytes.mockClear();
});

describe('prepareReferenceImage', () => {
  it('stores the bytes, archives them and returns a reference-only record', async () => {
    const archive = vi.fn(async () => 'artifact_cloud');
    const document = createProjectDocument('Images', toUserId('test'));
    const { image, bytesCreated } = await prepareReferenceImage({
      file: file(PNG),
      document: { ...document, units: 'inch' },
      plane,
      archive,
      measure
    });
    expect(bytesCreated).toBe(true);
    expect(store.puts).toHaveLength(1);
    expect(archive).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'reference-image',
        contentType: 'image/png',
        fileName: 'Floor plan.png'
      })
    );
    expect(image).toMatchObject({
      name: 'Floor plan',
      contentType: 'image/png',
      artifactId: 'artifact_cloud',
      pixelWidth: 640,
      pixelHeight: 480,
      plane,
      // 100 mm, in the document's inches.
      width: 100 / 25.4
    });
    expect(image.source.checksumSha256).toBe('e'.repeat(64));
    // Nothing but the reference: no pixels in the record.
    expect(JSON.stringify(image).length).toBeLessThan(1000);
  });

  it('keeps a device-local artifact id when there is no account copy', async () => {
    const { image } = await prepareReferenceImage({
      file: file(PNG),
      document: createProjectDocument('Images', toUserId('test')),
      plane,
      archive: async () => {
        throw new Error('Cloud archival needs an account project.');
      },
      measure
    });
    expect(image.artifactId).toMatch(/^artifact_local_/);
  });

  it('names a second copy apart from the first', async () => {
    const { image: first } = await prepareReferenceImage({
      file: file(PNG),
      document: createProjectDocument('Images', toUserId('test')),
      plane,
      archive: async () => 'artifact_one',
      measure
    });
    const document = {
      ...createProjectDocument('Images', toUserId('test')),
      referenceImages: { images: [first] }
    };
    const { image: second } = await prepareReferenceImage({
      file: file(PNG),
      document,
      plane,
      archive: async () => 'artifact_two',
      measure
    });
    expect(second.name).toBe('Floor plan 2');
  });

  it('refuses what is not a PNG or JPEG, too large, or unstorable', async () => {
    const document = createProjectDocument('Images', toUserId('test'));
    const archive = vi.fn(async () => 'artifact_one');
    await expect(
      prepareReferenceImage({
        file: file(new TextEncoder().encode('<svg/>'), 'plan.png'),
        document,
        plane,
        archive,
        measure
      })
    ).rejects.toThrow(/not a PNG or JPEG/);
    const huge = new File(
      [new Uint8Array(MAX_REFERENCE_IMAGE_BYTES + 1)],
      'big.png'
    );
    await expect(
      prepareReferenceImage({ file: huge, document, plane, archive, measure })
    ).rejects.toThrow(/larger than 20 MB/);
    await expect(
      prepareReferenceImage({
        file: file(PNG),
        document,
        plane,
        archive,
        measure: async () => ({ width: 9000, height: 10 })
      })
    ).rejects.toThrow(/up to 8192 pixels/);
    store.ready = 'blocked';
    await expect(
      prepareReferenceImage({
        file: file(PNG),
        document,
        plane,
        archive,
        measure
      })
    ).rejects.toThrow(/cannot be kept/);
    // Nothing was stored or uploaded for a refused picture.
    expect(store.puts).toHaveLength(0);
    expect(archive).not.toHaveBeenCalled();
  });
});

describe('reference-image capacity', () => {
  it('refuses a picture past the limit before storing or uploading it', async () => {
    const { image: first } = await prepareReferenceImage({
      file: file(PNG),
      document: createProjectDocument('Images', toUserId('test')),
      plane,
      archive: async () => 'artifact_one',
      measure
    });
    store.puts = [];
    const full = {
      ...createProjectDocument('Images', toUserId('test')),
      referenceImages: {
        images: Array.from({ length: MAX_REFERENCE_IMAGES }, (_, index) => ({
          ...first,
          imageId: `rimg_${index}` as typeof first.imageId,
          name: `Image ${index}`
        }))
      }
    };
    const archive = vi.fn(async () => 'artifact_two');
    await expect(
      prepareReferenceImage({
        file: file(PNG),
        document: full,
        plane,
        archive,
        measure
      })
    ).rejects.toThrow(/at most 64 reference images/);
    expect(store.puts).toHaveLength(0);
    expect(archive).not.toHaveBeenCalled();
  });

  it('releases stored bytes when the insert cannot commit, never bytes others own', async () => {
    const prepared = await prepareReferenceImage({
      file: file(PNG),
      document: createProjectDocument('Images', toUserId('test')),
      plane,
      archive: async () => 'artifact_one',
      measure
    });
    await discardReferenceImageBytes(prepared, [null]);
    expect(store.deleted).toEqual([prepared.image.source.checksumSha256]);
    // Bytes the device already held (another image placed the same file)
    // are not this insert's to release.
    store.deleted = [];
    const again = await prepareReferenceImage({
      file: file(PNG),
      document: createProjectDocument('Images', toUserId('test')),
      plane,
      archive: async () => 'artifact_two',
      measure
    });
    expect(again.bytesCreated).toBe(false);
    await discardReferenceImageBytes(again, [null]);
    expect(store.deleted).toEqual([]);
    // Nor are bytes an unsaved live document already uses.
    const live = {
      ...createProjectDocument('Images', toUserId('test')),
      referenceImages: { images: [prepared.image] }
    };
    await discardReferenceImageBytes(prepared, [live]);
    expect(store.deleted).toEqual([]);
  });
});

describe('loadReferenceImageBlob', () => {
  it('reads this device first, then the archived artifact, never a local id remotely', async () => {
    const { image } = await prepareReferenceImage({
      file: file(PNG),
      document: createProjectDocument('Images', toUserId('test')),
      plane,
      archive: async () => 'artifact_cloud',
      measure
    });
    const local = await loadReferenceImageBlob([image]);
    expect(local?.type).toBe('image/png');
    expect(resolver.resolveExactSourceBytes).not.toHaveBeenCalled();
    store.blobs.clear();
    const remote = await loadReferenceImageBlob([image]);
    expect(remote?.size).toBe(2);
    expect(resolver.resolveExactSourceBytes).toHaveBeenCalledWith(
      image.source,
      expect.objectContaining({ artifactId: 'artifact_cloud' })
    );
    const deviceOnly = {
      ...image,
      artifactId: 'artifact_local_x' as typeof image.artifactId
    };
    resolver.resolveExactSourceBytes.mockClear();
    expect(await loadReferenceImageBlob([deviceOnly])).toBeNull();
    expect(resolver.resolveExactSourceBytes).not.toHaveBeenCalled();
    // The same picture placed twice: a device-only first record does not
    // hide the second record's archive.
    const both = await loadReferenceImageBlob([deviceOnly, image]);
    expect(both?.size).toBe(2);
    expect(resolver.resolveExactSourceBytes).toHaveBeenCalledWith(
      image.source,
      expect.objectContaining({ artifactId: 'artifact_cloud' })
    );
  });
});

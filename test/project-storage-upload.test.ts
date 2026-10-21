import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  normalizeDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  decodeProjectStorageBody,
  hydrateProjectStorageSnapshot,
  openProjectStorageUpload,
  prepareClientProjectStorageSnapshot,
  prepareProjectStorageSnapshot,
  ProjectStorageUploadError,
  sha256Hex,
  splitProjectStorageUpload,
  type ProjectStorageAssetReference
} from '@openzcad/persistence';
import {
  MAX_CLOUD_PROJECT_DOCUMENT_BYTES,
  MAX_PROJECT_STORAGE_ASSET_UPLOADS,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';

const STEP_TEXT = `ISO-10303-21;\n${'CARTESIAN_POINT'.repeat(20_000)}\nEND-ISO-10303-21;`;

/** Embedded STEP text and mesh arrays in the model, the command log and undo history. */
function importedDocument(): ProjectDocument {
  const manager = new CommandManager(
    createProjectDocument('Imported bracket', toUserId('user_split_test'))
  );
  manager.execute(
    commandFactories.importStep({
      name: 'Bracket STEP',
      artifactId: 'artifact_step_test',
      sourceName: 'bracket.step',
      stepText: STEP_TEXT
    })
  );
  manager.execute(
    commandFactories.importMesh({
      name: 'Bracket mesh',
      artifactId: 'artifact_mesh_test',
      sourceName: 'bracket.stl',
      triangleCount: 2,
      vertices: [0, 0, 0, 10.25, 0, 0, 0, 4.5, 0, 0, 0, 2.75],
      indices: [0, 1, 2, 0, 2, 3]
    })
  );
  return manager.document;
}

/** What the account stores for a document it receives whole. */
function stored(document: ProjectDocument): ProjectDocument {
  return withoutDerivedProjection(normalizeDocument(document));
}

function base64Of(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function gzipBase64(text: string): Promise<string> {
  const compressed = new Blob([text])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return base64Of(new Uint8Array(await new Response(compressed).arrayBuffer()));
}

function references(document: unknown): ProjectStorageAssetReference[] {
  const found: ProjectStorageAssetReference[] = [];
  JSON.stringify(document, (_key, value: unknown) => {
    if (
      value &&
      typeof value === 'object' &&
      (value as { marker?: unknown }).marker === 'openzcad-project-asset'
    )
      found.push(value as ProjectStorageAssetReference);
    return value;
  });
  return found;
}

describe('browser-split project storage (ADR-024 Phase 1)', () => {
  it('splits every embedded payload once and hydrates back to the stored document', async () => {
    const original = importedDocument();
    const split = await splitProjectStorageUpload(original);

    expect(split.storageAssets.map((asset) => asset.kind).sort()).toEqual([
      'mesh-payload',
      'step-source'
    ]);
    // The node, its import command and its undo entry all point at one upload.
    expect(references(split.document).length).toBeGreaterThan(2);
    expect(JSON.stringify(split.document)).not.toContain(
      'CARTESIAN_POINTCARTESIAN_POINT'
    );
    // The wire carries compressed payloads, not the STEP text.
    const step = split.storageAssets.find((a) => a.kind === 'step-source')!;
    expect(step.logicalBytes).toBe(new TextEncoder().encode(STEP_TEXT).length);
    expect(step.storedBody.length).toBeLessThan(step.logicalBytes / 10);
    expect(step.checksumSha256).toBe(
      await sha256Hex(new TextEncoder().encode(STEP_TEXT))
    );

    const opened = await openProjectStorageUpload(
      JSON.parse(JSON.stringify(split.document)),
      JSON.parse(JSON.stringify(split.storageAssets)),
      original.projectId
    );
    expect(opened.document).toEqual(
      JSON.parse(JSON.stringify(stored(original)))
    );
  });

  it('stores the same projection and asset keys the server split wrote, so existing projects need no migration', async () => {
    const original = importedDocument();
    const split = await splitProjectStorageUpload(original);
    const opened = await openProjectStorageUpload(
      split.document,
      split.storageAssets,
      original.projectId
    );
    const client = await prepareClientProjectStorageSnapshot(
      stored(original),
      opened.storage
    );
    const server = await prepareProjectStorageSnapshot(stored(original));

    expect(client.snapshot).toEqual(server.snapshot);
    expect(client.checksumSha256).toBe(server.checksumSha256);
    const identity = (asset: (typeof client.assets)[number]) => ({
      kind: asset.kind,
      objectKey: asset.objectKey,
      checksumSha256: asset.checksumSha256,
      logicalBytes: asset.logicalBytes,
      contentEncoding: asset.contentEncoding,
      contentType: asset.contentType
    });
    expect(client.assets.map(identity)).toEqual(server.assets.map(identity));

    // The stored bytes are the browser's; load reads them like any other.
    const hydrated = await hydrateProjectStorageSnapshot(
      client.snapshot,
      original.projectId,
      async (reference) => {
        const asset = client.assets.find(
          (candidate) => candidate.objectKey === reference.objectKey
        )!;
        return decodeProjectStorageBody(
          Uint8Array.from(asset.storedBody).buffer,
          'gzip',
          reference.logicalBytes
        );
      }
    );
    expect(hydrated).toEqual(JSON.parse(JSON.stringify(stored(original))));
  });

  it('sends a document without embedded payloads unchanged, with no uploads', async () => {
    const plain = createProjectDocument('Plain', toUserId('user_split_test'));
    const split = await splitProjectStorageUpload(plain);
    expect(split.storageAssets).toEqual([]);
    expect(split.document).toEqual(JSON.parse(JSON.stringify(stored(plain))));
  });

  it('refuses a projection that does not hydrate to the document the account stores', async () => {
    const original = importedDocument();
    const split = await splitProjectStorageUpload(original);
    const opened = await openProjectStorageUpload(
      split.document,
      split.storageAssets,
      original.projectId
    );
    await expect(
      prepareClientProjectStorageSnapshot(
        { ...stored(original), name: 'Renamed by the account' },
        opened.storage
      )
    ).rejects.toThrow(/does not match the document the account stores/);
  });

  describe('refuses uploads the account cannot store as sent', () => {
    const refusals: Array<
      [
        string,
        (
          split: Awaited<ReturnType<typeof splitProjectStorageUpload>>
        ) => Promise<{
          document?: unknown;
          storageAssets: unknown;
          projectId?: string;
        }>,
        RegExp
      ]
    > = [
      [
        'bytes that do not match their checksum',
        async (split) => ({
          storageAssets: await Promise.all(
            split.storageAssets.map(async (asset) =>
              asset.kind === 'step-source'
                ? {
                    ...asset,
                    storedBody: await gzipBase64(
                      STEP_TEXT.replace('CARTESIAN', 'CARTESIAM')
                    )
                  }
                : asset
            )
          )
        }),
        /failed its checksum/
      ],
      [
        'a payload larger than its declared size',
        async (split) => ({
          storageAssets: split.storageAssets.map((asset) =>
            asset.kind === 'step-source'
              ? { ...asset, logicalBytes: asset.logicalBytes - 1 }
              : asset
          )
        }),
        /not a gzip payload of its declared size/
      ],
      [
        'a payload smaller than its declared size',
        async (split) => ({
          storageAssets: split.storageAssets.map((asset) =>
            asset.kind === 'step-source'
              ? { ...asset, logicalBytes: asset.logicalBytes + 1 }
              : asset
          )
        }),
        /unexpected size/
      ],
      [
        'a body that is not gzip',
        async (split) => ({
          storageAssets: split.storageAssets.map((asset) =>
            asset.kind === 'step-source'
              ? { ...asset, storedBody: base64Of(new Uint8Array([1, 2, 3])) }
              : asset
          )
        }),
        /not a gzip payload/
      ],
      [
        'a body that is not base64',
        async (split) => ({
          storageAssets: split.storageAssets.map((asset) =>
            asset.kind === 'step-source'
              ? { ...asset, storedBody: '%%%' }
              : asset
          )
        }),
        /not a gzip payload/
      ],
      [
        'a reference the request did not upload',
        async (split) => ({
          storageAssets: split.storageAssets.filter(
            (asset) => asset.kind !== 'mesh-payload'
          )
        }),
        /did not upload/
      ],
      [
        'an upload the document does not reference',
        async (split) => ({
          storageAssets: [
            ...split.storageAssets,
            {
              kind: 'step-source',
              checksumSha256: await sha256Hex(new TextEncoder().encode('x')),
              logicalBytes: 1,
              storedBody: await gzipBase64('x')
            }
          ]
        }),
        /does not reference/
      ],
      [
        'the same payload uploaded twice',
        async (split) => ({
          storageAssets: [...split.storageAssets, split.storageAssets[0]]
        }),
        /uploaded twice/
      ],
      [
        "references keyed under another project's assets",
        async (split) => ({
          storageAssets: split.storageAssets,
          projectId: 'proj_other'
        }),
        /did not upload/
      ],
      [
        'a reference whose size disagrees with its upload',
        async (split) => ({
          document: JSON.parse(
            JSON.stringify(split.document).replaceAll(
              `"logicalBytes":${split.storageAssets.find((a) => a.kind === 'step-source')!.logicalBytes}`,
              '"logicalBytes":7'
            )
          ),
          storageAssets: split.storageAssets
        }),
        /did not upload/
      ],
      [
        'a STEP reference in a mesh position',
        async (split) => {
          const step = references(split.document).find(
            (reference) => reference.kind === 'step-source'
          )!;
          const document = JSON.parse(
            JSON.stringify(split.document)
          ) as ProjectDocument;
          for (const node of Object.values(document.nodes))
            if (
              node.kind === 'feature' &&
              node.data.featureKind === 'imported-mesh'
            )
              (node.data as unknown as Record<string, unknown>)[
                '__openzcadMeshPayload'
              ] = step;
          return {
            document,
            storageAssets: split.storageAssets.filter(
              (asset) => asset.kind === 'step-source'
            )
          };
        },
        /incompatible project asset/
      ],
      [
        'a malformed upload entry',
        async (split) => ({
          storageAssets: split.storageAssets.map((asset) => ({
            ...asset,
            checksumSha256: asset.checksumSha256.toUpperCase()
          }))
        }),
        /is not a split payload/
      ],
      [
        'an upload entry with extra fields',
        async (split) => ({
          storageAssets: split.storageAssets.map((asset) => ({
            ...asset,
            objectKey: 'project-storage/proj_other/assets/x.step.txt.gz'
          }))
        }),
        /is not a split payload/
      ],
      [
        'uploads that are not an array',
        async () => ({ storageAssets: {} }),
        /must be an array/
      ],
      [
        'more uploads than one write may carry',
        async () => ({
          storageAssets: Array.from(
            { length: MAX_PROJECT_STORAGE_ASSET_UPLOADS + 1 },
            () => ({})
          )
        }),
        /at most/
      ],
      [
        'declared sizes beyond the document ceiling, before decompressing',
        async (split) => ({
          storageAssets: split.storageAssets.map((asset) => ({
            ...asset,
            logicalBytes: MAX_CLOUD_PROJECT_DOCUMENT_BYTES
          }))
        }),
        /exceed the cloud document size limit/
      ]
    ];

    it.each(refusals)('%s', async (_name, tamper, message) => {
      const original = importedDocument();
      const split = await splitProjectStorageUpload(original);
      const request = await tamper(split);
      const opening = openProjectStorageUpload(
        request.document ?? split.document,
        request.storageAssets,
        request.projectId ?? original.projectId
      );
      await expect(opening).rejects.toBeInstanceOf(ProjectStorageUploadError);
      await expect(opening).rejects.toThrow(message);
    });
  });

  it('opens a write with no embedded payloads and an empty upload list', async () => {
    const plain = createProjectDocument('Plain', toUserId('user_split_test'));
    const opened = await openProjectStorageUpload(
      JSON.parse(JSON.stringify(stored(plain))),
      [],
      plain.projectId
    );
    expect(opened.storage.payloads.size).toBe(0);
    expect(opened.document).toEqual(JSON.parse(JSON.stringify(stored(plain))));
  });
});

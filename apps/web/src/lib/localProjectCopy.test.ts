import 'fake-indexeddb/auto';
import { Blob as NodeBlob } from 'node:buffer';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  importMeshBody,
  importStepBody,
  duplicateProjectDocument
} from '@openzcad/document-core';
import {
  documentNodesWithHistory,
  encodeImportedMeshPayload,
  importedSourceReferenceOf,
  projectBranchPoint,
  toUserId
} from '@openzcad/shared';
import { cacheCopySources } from './sourceBlobClaims';
import {
  loadLocalProject,
  loadSourceBlob,
  putSourceBlob,
  saveLocalProject,
  sha256Hex
} from './localProjectStore';
import { resolveExactSourceBytes } from './exactSourceResolver';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('Blob', NodeBlob);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture(kind: 'mesh' | 'step' = 'mesh') {
  const bytes =
    kind === 'mesh'
      ? encodeImportedMeshPayload({
          vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          indices: [0, 1, 2]
        })
      : new TextEncoder().encode('ISO-10303-21;\nEND-ISO-10303-21;');
  const ref = {
    marker: 'openzcad-source-ref' as const,
    version: 1 as const,
    hashAlgorithm: 'sha256' as const,
    checksumSha256: await sha256Hex(bytes),
    logicalBytes: bytes.byteLength
  };
  const base = createProjectDocument('Cloud source', toUserId('owner'));
  const input = {
    name: 'Imported source',
    sourceName: `remote.${kind === 'mesh' ? 'stl' : 'step'}`,
    artifactId: 'artifact_cloud_original'
  };
  const source =
    kind === 'mesh'
      ? importMeshBody(base, {
          ...input,
          triangleCount: 1,
          meshPayloadRef: ref
        }).document
      : importStepBody(base, { ...input, stepSourceRef: ref }).document;
  await saveLocalProject(source);
  return { bytes, ref, source };
}

it.each(['mesh', 'step'] as const)(
  'caches uncached cloud %s bytes before localizing a new independent copy',
  async (kind) => {
    const { bytes, ref, source } = await fixture(kind);
    const before = JSON.stringify(source);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(bytes));
    vi.stubGlobal('fetch', fetch);
    await cacheCopySources(source, loadSourceBlob, sha256Hex);
    const copy = duplicateProjectDocument(source, 'Copy', toUserId('owner'));
    expect(fetch).toHaveBeenCalledWith(
      '/api/artifacts/artifact_cloud_original/download',
      expect.any(Object)
    );
    expect(copy.projectId).not.toBe(source.projectId);
    expect(JSON.stringify(copy)).not.toContain('artifact_cloud_original');
    const feature = [...documentNodesWithHistory(copy)].find(
      (node) => node.kind === 'feature'
    )!;
    if (feature.kind !== 'feature') throw new Error('Missing copied feature');
    const copyRef = importedSourceReferenceOf(feature.data)!;
    await expect(
      resolveExactSourceBytes(
        copyRef,
        feature.data as Parameters<typeof resolveExactSourceBytes>[1]
      )
    ).resolves.toEqual(bytes);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await loadSourceBlob(ref.checksumSha256)).toEqual(bytes);
    expect(JSON.stringify(source)).toBe(before);
    expect(JSON.stringify(await loadLocalProject(source.projectId))).toBe(
      before
    );
  }
);

it.each([401, 404, 'corrupt'] as const)(
  'refuses a new identity when its source download is %s, preserving the original',
  async (failure) => {
    const { source } = await fixture();
    const before = JSON.stringify(source);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          failure === 'corrupt'
            ? new Response('wrong bytes')
            : new Response(null, { status: failure })
        )
    );
    await expect(
      cacheCopySources(source, loadSourceBlob, sha256Hex)
    ).rejects.toThrow('could not be fetched');
    expect(JSON.stringify(source)).toBe(before);
    expect(JSON.stringify(await loadLocalProject(source.projectId))).toBe(
      before
    );
  }
);

it('uses cached bytes offline and preserves branch provenance', async () => {
  const { bytes, ref, source } = await fixture('step');
  await putSourceBlob(bytes);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const branchPoint = projectBranchPoint(source, {
    revisionId: source.revisions.at(-1)!.revisionId,
    reason: 'Saved source'
  });
  await cacheCopySources(source, loadSourceBlob, sha256Hex);
  const copy = duplicateProjectDocument(
    source,
    'Branch',
    toUserId('owner'),
    branchPoint
  );
  expect(copy.branchedFrom).toEqual(branchPoint);
  expect(JSON.stringify(copy)).toContain(
    `artifact_local_${ref.checksumSha256}`
  );
  expect(fetch).not.toHaveBeenCalled();
});

it('checks sources retained only in undo and redo before localizing', async () => {
  const { bytes, ref } = await fixture('step');
  const manager = new CommandManager(
    createProjectDocument('History', toUserId('owner'))
  );
  manager.execute(
    commandFactories.importStep({
      name: 'Undo source',
      sourceName: 'undo.step',
      artifactId: 'artifact_cloud_undo',
      stepSourceRef: ref
    })
  );
  manager.execute(
    commandFactories.deleteFeature({
      featureId: manager.document.featureOrder[0]!
    })
  );
  const mesh = await fixture('mesh');
  manager.execute(
    commandFactories.importMesh({
      name: 'Redo source',
      sourceName: 'redo.stl',
      artifactId: 'artifact_cloud_redo',
      triangleCount: 1,
      meshPayloadRef: mesh.ref
    })
  );
  manager.undo();
  const source = manager.document;
  const before = JSON.stringify(source);
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async (url) => {
      const address =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      return new Response(address.includes('undo') ? bytes : mesh.bytes);
    });
  vi.stubGlobal('fetch', fetch);
  await cacheCopySources(source, loadSourceBlob, sha256Hex);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await loadSourceBlob(ref.checksumSha256)).toEqual(bytes);
  expect(await loadSourceBlob(mesh.ref.checksumSha256)).toEqual(mesh.bytes);
  expect(JSON.stringify(source)).toBe(before);
});

it('checks every declared length even when another ref already cached the checksum', async () => {
  const { source, ref, bytes } = await fixture();
  const second = importMeshBody(source, {
    name: 'Different expected size',
    sourceName: 'bad.stl',
    artifactId: 'artifact_cloud_wrong_length',
    triangleCount: 1,
    meshPayloadRef: { ...ref, logicalBytes: ref.logicalBytes + 1 }
  }).document;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes)));
  await expect(
    cacheCopySources(second, loadSourceBlob, sha256Hex)
  ).rejects.toThrow('integrity check');
});

it('refuses a missing device-only source without a remote request', async () => {
  const { source } = await fixture();
  for (const node of Object.values(source.nodes))
    if (node.kind === 'feature' && node.data.featureKind === 'imported-mesh')
      node.data.artifactId =
        'artifact_local_missing' as typeof node.data.artifactId;
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    cacheCopySources(source, loadSourceBlob, sha256Hex)
  ).rejects.toThrow('could not be fetched');
  expect(fetch).not.toHaveBeenCalled();
});

it('copies plain models without loading or hashing any source', async () => {
  const load = vi.fn();
  const hash = vi.fn();
  await cacheCopySources(
    createProjectDocument('Plain', toUserId('owner')),
    load,
    hash
  );
  expect(load).not.toHaveBeenCalled();
  expect(hash).not.toHaveBeenCalled();
});

it('refuses damaged cached content even when its declared length matches', async () => {
  const { source, bytes } = await fixture();
  const damaged = new Uint8Array(bytes);
  damaged[0] = damaged[0]! ^ 1;
  await expect(
    cacheCopySources(source, async () => damaged, sha256Hex)
  ).rejects.toThrow('integrity check');
});

it('loads and hashes a shared import once across copies given one verified set', async () => {
  // A duplicate prepares every inherited save state, and they usually carry
  // the same import: without a shared set each save reloaded and rehashed it.
  const { bytes, source } = await fixture('step');
  await putSourceBlob(bytes);
  const load = vi.fn(loadSourceBlob);
  const hash = vi.fn(sha256Hex);
  const verified = new Set<string>();
  for (let save = 0; save < 3; save += 1) {
    await cacheCopySources(source, load, hash, verified);
  }
  expect(load).toHaveBeenCalledTimes(1);
  expect(hash).toHaveBeenCalledTimes(1);

  // Without the set every call checks the bytes again, as before.
  await cacheCopySources(source, load, hash);
  expect(load).toHaveBeenCalledTimes(2);
});

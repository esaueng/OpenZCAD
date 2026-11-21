import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toUserId,
  type ProjectDocument,
  type ProjectStorageAssetUpload,
  type SaveProjectDocumentRequest
} from '@openzcad/shared';
import { api, forgetKnownStorageAssets } from './api';
import { desktopFetch } from './desktopBridge';

vi.mock('./desktopBridge', () => ({
  desktopFetch: vi.fn(),
  isDesktopApp: () => false
}));
afterEach(() => {
  vi.clearAllMocks();
  forgetKnownStorageAssets();
});

function importedProject(name: string): ProjectDocument {
  const manager = new CommandManager(
    createProjectDocument(name, toUserId('owner'))
  );
  manager.execute(
    commandFactories.importStep({
      name: 'Bracket STEP',
      artifactId: 'artifact_step',
      sourceName: 'bracket.step',
      stepText: `ISO-10303-21;\n${'CLOSED_SHELL'.repeat(2_000)}\nEND-ISO-10303-21;`
    })
  );
  return manager.document;
}

function saved(
  document: ProjectDocument,
  extra: Record<string, unknown> = { storageAssetReferences: true }
): Response {
  return new Response(
    JSON.stringify({
      projectId: document.projectId,
      version: document.version,
      updatedAt: '2026-11-21T00:00:00.000Z',
      ...extra
    })
  );
}

function refused(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: 'Refused.', code }), { status });
}

function sentAssets(call: number): ProjectStorageAssetUpload[] {
  const body = JSON.parse(
    vi.mocked(desktopFetch).mock.calls[call]![1]!.body as string
  ) as SaveProjectDocumentRequest & {
    storageAssets: ProjectStorageAssetUpload[];
  };
  return body.storageAssets;
}

const save = (document: ProjectDocument) =>
  api.saveProjectDocument({
    projectId: document.projectId,
    expectedVersion: document.version - 1,
    document
  });

describe('autosave payload references', () => {
  it('sends an acknowledged payload as a reference on the next save', async () => {
    const document = importedProject('Bracket');
    vi.mocked(desktopFetch).mockImplementation(async () => saved(document));
    await save(document);
    await save({ ...document, version: document.version + 1 });
    expect(sentAssets(0)).toHaveLength(1);
    expect(sentAssets(0)[0]!.storedBody).toEqual(expect.any(String));
    expect(sentAssets(1)).toEqual([
      {
        kind: 'step-source',
        checksumSha256: sentAssets(0)[0]!.checksumSha256,
        logicalBytes: sentAssets(0)[0]!.logicalBytes
      }
    ]);
  });

  it('keeps sending bodies to a Worker that does not accept references', async () => {
    const document = importedProject('Bracket');
    vi.mocked(desktopFetch).mockImplementation(async () => saved(document, {}));
    await save(document);
    await save({ ...document, version: document.version + 1 });
    expect(sentAssets(1)[0]!.storedBody).toEqual(expect.any(String));
  });

  it.each([
    ['the account no longer holds a payload', 409, 'STORAGE_ASSET_MISSING'],
    ['an older Worker cannot read a reference', 400, 'STORAGE_ASSET_INVALID']
  ])('resends every body once when %s', async (_name, status, code) => {
    const document = importedProject('Bracket');
    vi.mocked(desktopFetch)
      .mockResolvedValueOnce(saved(document))
      .mockResolvedValueOnce(refused(status, code))
      .mockResolvedValueOnce(saved(document));
    await save(document);
    const response = await save({
      ...document,
      version: document.version + 1
    });
    expect(response.version).toBe(document.version);
    expect(desktopFetch).toHaveBeenCalledTimes(3);
    expect(sentAssets(1)[0]!.storedBody).toBeUndefined();
    expect(sentAssets(2)[0]!.storedBody).toEqual(expect.any(String));
  });

  it('does not retry a refusal twice', async () => {
    const document = importedProject('Bracket');
    vi.mocked(desktopFetch)
      .mockResolvedValueOnce(saved(document))
      .mockResolvedValueOnce(refused(409, 'STORAGE_ASSET_MISSING'))
      .mockResolvedValueOnce(refused(409, 'STORAGE_ASSET_MISSING'));
    await save(document);
    await expect(
      save({ ...document, version: document.version + 1 })
    ).rejects.toMatchObject({ code: 'STORAGE_ASSET_MISSING' });
    expect(desktopFetch).toHaveBeenCalledTimes(3);
  });

  it('does not carry acknowledged payloads to another project', async () => {
    const first = importedProject('First');
    const second = importedProject('Second');
    vi.mocked(desktopFetch).mockImplementation(async () => saved(first));
    await save(first);
    await save(second);
    // Same bytes, different project: the second project sends its body.
    expect(sentAssets(1)[0]!.checksumSha256).toBe(
      sentAssets(0)[0]!.checksumSha256
    );
    expect(sentAssets(1)[0]!.storedBody).toEqual(expect.any(String));
  });
});

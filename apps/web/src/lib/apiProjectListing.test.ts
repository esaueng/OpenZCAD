import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { desktopFetch } from './desktopBridge';
import { encryptedProjectShelf } from './e2ee/encryptedProjects';
import { toProjectId } from '@openzcad/shared';
import type { E2eeProjectEnvelopeRecord } from '@openzcad/shared';
import type { EncryptedShelfEntry } from './e2ee/encryptedProjects';

vi.mock('./desktopBridge', () => ({ desktopFetch: vi.fn() }));
vi.mock('./analytics', () => ({ isAnalyticsEnabled: () => false }));
vi.mock('./e2ee/encryptedProjects', () => ({ encryptedProjectShelf: vi.fn() }));
const session = vi.hoisted(() => ({ revision: 0 }));
vi.mock('./e2ee/keySession', () => ({
  getKeySessionRevision: () => session.revision,
  isCurrentKeySession: (revision: number) => revision === session.revision,
  subscribeKeySession: () => () => undefined
}));

const project = {
  projectId: toProjectId('proj_encrypted_shelf'),
  name: 'Encrypted project',
  updatedAt: '2026-10-28T12:00:00Z',
  revisionCount: 1,
  storageFormat: 2
};
const records: E2eeProjectEnvelopeRecord[] = [
  {
    projectId: project.projectId,
    kind: 'project-info',
    keyEpoch: 0,
    updatedAt: project.updatedAt,
    sequence: 1,
    envelope: '',
    signature: '',
    wrappedVersionKey: '',
    signerDeviceId: 'device_fixture'
  }
];
let finish!: (value: Map<string, EncryptedShelfEntry>) => void;
let progress: Parameters<typeof encryptedProjectShelf>[1];
beforeEach(() => {
  progress = undefined;
  session.revision = 0;
  vi.mocked(desktopFetch).mockResolvedValue(
    new Response(
      JSON.stringify({ projects: [project], encryptedProjectInfo: records })
    )
  );
  vi.mocked(encryptedProjectShelf).mockImplementation(
    async (_records, update) => {
      progress = update;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
  );
});
afterEach(() => {
  finish?.(new Map());
  vi.clearAllMocks();
});

describe('progressive project listing', () => {
  it('returns storage formats before decryption and emits only verifier output', async () => {
    const onVerified = vi.fn();
    expect(
      await api.listProjects({ isCurrent: () => true, onVerified })
    ).toEqual({
      projects: [project],
      pendingEncryptedProjectIds: new Set([project.projectId])
    });
    await vi.waitFor(() => expect(progress).toBeDefined());
    expect(onVerified).not.toHaveBeenCalled();
    progress!.onEntry(project.projectId, {
      name: 'Verified bracket',
      thumbnailBlobId: 'encrypted_thumbnail'
    });
    expect(onVerified).toHaveBeenCalledWith({
      ...project,
      name: 'Verified bracket',
      thumbnailArtifactId: 'encrypted_thumbnail'
    });
  });

  it('keeps callers needing the complete verified listing waiting', async () => {
    let settled = false;
    const listing = api.listProjects().then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(encryptedProjectShelf).toHaveBeenCalled());
    expect(settled).toBe(false);
    finish(new Map([[project.projectId, { name: 'Verified bracket' }]]));
    const result = await listing;
    expect(result.projects[0]?.name).toBe('Verified bracket');
    expect(result.pendingEncryptedProjectIds).toBeUndefined();
  });

  it('prioritizes displayed cards before unrelated encrypted envelopes', async () => {
    const visible = { ...project, projectId: toProjectId('proj_visible') };
    vi.mocked(desktopFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          projects: [project, visible],
          encryptedProjectInfo: [
            records[0],
            { ...records[0], projectId: visible.projectId }
          ]
        })
      )
    );
    await api.listProjects({
      isCurrent: () => true,
      onVerified: vi.fn(),
      priorityProjectIds: () => [visible.projectId]
    });
    await vi.waitFor(() => expect(encryptedProjectShelf).toHaveBeenCalled());
    expect(
      vi
        .mocked(encryptedProjectShelf)
        .mock.calls[0]?.[0].map((record) => record.projectId)
    ).toEqual([visible.projectId, project.projectId]);
  });

  it.each(['navigation', 'key session'])(
    'ignores metadata finishing after %s changes',
    async (change) => {
      let current = true;
      const onVerified = vi.fn();
      await api.listProjects({ isCurrent: () => current, onVerified });
      await vi.waitFor(() => expect(progress).toBeDefined());
      if (change === 'navigation') current = false;
      else session.revision++;
      progress!.onEntry(project.projectId, { name: 'Former account title' });
      expect(onVerified).not.toHaveBeenCalled();
    }
  );

  it('drops a complete decrypted listing when its key session ends during verification', async () => {
    const listing = api.listProjects();
    await vi.waitFor(() => expect(encryptedProjectShelf).toHaveBeenCalled());
    session.revision++;
    finish(new Map([[project.projectId, { name: 'Former account title' }]]));
    expect((await listing).projects[0]?.name).toBe('Encrypted project');
  });

  it('marks names pending when verification cannot produce metadata', async () => {
    const listing = api.listProjects();
    await vi.waitFor(() => expect(encryptedProjectShelf).toHaveBeenCalled());
    finish(new Map());
    expect((await listing).pendingEncryptedProjectIds).toEqual(
      new Set([project.projectId])
    );
  });

  it('does not mark a verified literal "Encrypted project" title as a placeholder', async () => {
    const listing = api.listProjects();
    await vi.waitFor(() => expect(encryptedProjectShelf).toHaveBeenCalled());
    finish(new Map([[project.projectId, { name: 'Encrypted project' }]]));
    expect((await listing).pendingEncryptedProjectIds).toBeUndefined();
  });
});

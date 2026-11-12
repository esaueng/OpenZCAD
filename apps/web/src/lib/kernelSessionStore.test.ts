import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createProjectDocument } from '@openzcad/document-core';
import type { PersistedHistorySession } from '@openzcad/kernel-adapter/exact';
import { toProjectId, toUserId } from '@openzcad/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KERNEL_SESSION_DATABASE_NAME,
  MAX_KERNEL_SESSION_BYTES,
  MAX_KERNEL_SESSION_TOTAL_BYTES,
  MAX_KERNEL_SESSIONS,
  deleteKernelSession,
  kernelSessionIdentity,
  listKernelSessions,
  loadKernelSession,
  saveKernelSession,
  touchKernelSession
} from './kernelSessionStore';
import {
  deleteLocalProject,
  saveLocalProject,
  visitLocalProjectData
} from './localProjectStore';

const IDENTITY = kernelSessionIdentity({
  appCommit: 'app-commit',
  remusVersion: '2026.1.134',
  remusCommit: 'remus-commit',
  kernelBuildId: 'remus-wasm 2026.1.0 / snapshot format 1'
})!;

/** Opaque to the store: it only keeps what it is given. */
function session(projectId: string, marker = 7): PersistedHistorySession {
  return {
    projectId,
    kernelBytes: new Uint8Array([1, 2, 3, marker]),
    build: { shapes: new Map([['body', { solids: [marker] }]]) }
  } as unknown as PersistedHistorySession;
}

async function save(
  projectId: string,
  bytes = 1024,
  now = 1,
  contentKey = 'content-a'
) {
  return saveKernelSession(
    {
      projectId,
      contentKey,
      identity: IDENTITY,
      bytes,
      session: session(projectId)
    },
    now
  );
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
});

describe('kernelSessionIdentity', () => {
  it('names every part of the build, or nothing', () => {
    expect(IDENTITY).toContain('2026.1.134');
    for (const missing of [
      { appCommit: undefined },
      { remusVersion: 'unknown' },
      { remusCommit: '' },
      { kernelBuildId: null }
    ])
      expect(
        kernelSessionIdentity({
          appCommit: 'a',
          remusVersion: 'b',
          remusCommit: 'c',
          kernelBuildId: 'd',
          ...missing
        })
      ).toBeNull();
  });
});

describe('kernel session store', () => {
  it('returns a session only for its exact content and build', async () => {
    expect(await save('proj-a')).toBe(true);
    const loaded = await loadKernelSession('proj-a', 'content-a', IDENTITY);
    expect(loaded).toEqual(session('proj-a'));
    expect(loaded?.kernelBytes).toBeInstanceOf(Uint8Array);
    expect(await loadKernelSession('proj-a', 'content-b', IDENTITY)).toBeNull();
    expect(
      await loadKernelSession('proj-a', 'content-a', `${IDENTITY}+next`)
    ).toBeNull();
    expect(await loadKernelSession('proj-b', 'content-a', IDENTITY)).toBeNull();
  });

  it('keeps one session per project, replacing the older content', async () => {
    await save('proj-a', 1024, 1, 'content-a');
    await save('proj-a', 2048, 2, 'content-b');
    expect(await listKernelSessions()).toEqual([
      expect.objectContaining({
        projectId: 'proj-a',
        contentKey: 'content-b',
        bytes: 2048
      })
    ]);
    expect(await loadKernelSession('proj-a', 'content-a', IDENTITY)).toBeNull();
  });

  it('refuses a session over its own bound', async () => {
    await save('proj-a');
    expect(await save('proj-a', MAX_KERNEL_SESSION_BYTES + 1)).toBe(false);
    // The older content is gone too: it no longer describes the project.
    expect(await listKernelSessions()).toEqual([]);
  });

  it('evicts the least recently used sessions over the count bound', async () => {
    for (let index = 0; index < MAX_KERNEL_SESSIONS; index += 1)
      await save(`proj-${index}`, 1024, 10 + index);
    // Used most recently, so it outlives a newer write.
    await touchKernelSession('proj-0', 100);
    await save('proj-new', 1024, 200);
    const kept = (await listKernelSessions()).map((row) => row.projectId);
    expect(kept).toHaveLength(MAX_KERNEL_SESSIONS);
    expect(kept).toContain('proj-0');
    expect(kept).toContain('proj-new');
    expect(kept).not.toContain('proj-1');
    expect(await loadKernelSession('proj-1', 'content-a', IDENTITY)).toBeNull();
  });

  it('evicts the least recently used sessions over the byte bound', async () => {
    // Three fit under the total, four do not; each fits its own bound.
    const third = Math.floor(MAX_KERNEL_SESSION_TOTAL_BYTES / 3.5);
    expect(third).toBeLessThanOrEqual(MAX_KERNEL_SESSION_BYTES);
    await save('proj-a', third, 1);
    await save('proj-b', third, 2);
    await save('proj-c', third, 3);
    await save('proj-d', third, 4);
    const rows = await listKernelSessions();
    expect(rows.map((row) => row.projectId).sort()).toEqual([
      'proj-b',
      'proj-c',
      'proj-d'
    ]);
    expect(rows.reduce((total, row) => total + row.bytes, 0)).toBeLessThan(
      MAX_KERNEL_SESSION_TOTAL_BYTES
    );
  });

  it('forgets a session on request', async () => {
    await save('proj-a');
    await deleteKernelSession('proj-a');
    expect(await listKernelSessions()).toEqual([]);
  });

  it('is deleted with its project', async () => {
    const document = {
      ...createProjectDocument('Bracket', toUserId('user-1')),
      projectId: toProjectId('proj-a')
    };
    await saveLocalProject(document);
    await save('proj-a');
    await save('proj-b');
    await deleteLocalProject('proj-a');
    await vi.waitFor(async () =>
      expect((await listKernelSessions()).map((row) => row.projectId)).toEqual([
        'proj-b'
      ])
    );
  });

  it('never reaches project data readers (backups, downloads, sync)', async () => {
    await saveLocalProject({
      ...createProjectDocument('Bracket', toUserId('user-1')),
      projectId: toProjectId('proj-a')
    });
    await save('proj-a');
    const visited: { store: string; value: unknown }[] = [];
    // Every store of the project database: what the device snapshot of a
    // data download, backups and the sync paths read from.
    await visitLocalProjectData((store, _key, value) =>
      visited.push({ store, value })
    );
    expect(visited.length).toBeGreaterThan(0);
    expect(
      visited.some(({ value }) =>
        JSON.stringify(value, (_key, entry: unknown) =>
          entry instanceof Map ? [...entry] : entry
        ).includes('kernelBytes')
      )
    ).toBe(false);
    const names = (await indexedDB.databases()).map(
      (database) => database.name
    );
    expect(names).toContain(KERNEL_SESSION_DATABASE_NAME);
    expect(KERNEL_SESSION_DATABASE_NAME).not.toBe('openzcad-v2');
  });
});

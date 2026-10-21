import 'fake-indexeddb/auto';
import { createProjectDocument } from '@openzcad/document-core';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { toProjectId, toUserId, type ProjectSummary } from '@openzcad/shared';
import {
  OrganizationMirrorBackground,
  ORGANIZATION_ADMISSION_PREFIX,
  prepareOrganizationMirrors,
  type OrganizationLocks
} from './projectOrganizationBackground';
import {
  OrganizationMirrorQueue,
  mirrorPendingOrganization,
  mirrorPendingReorder,
  type OrganizationMirrorHost
} from './projectOrganizationMirror';
import {
  saveLocalProjectOrganization,
  loadLocalProjectOrganizationSnapshot,
  saveLocalProjectOrganizationIfCurrent,
  purgeExpiredLocalProjects,
  saveLocalProject,
  loadLocalProject,
  saveProjectThumbnail,
  loadProjectThumbnail,
  scopedTransaction,
  BACKUP_STORE_NAME,
  loadProjectBackupFiles
} from './localProjectStore';
import type { LocalProjectOrganizationSnapshot } from './localProjectStore';

const active = { status: 'active' as const, pinned: false, sortOrder: 0 };
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    }
  };
}
function locks(): OrganizationLocks {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, action: () => T | Promise<T>) {
      const result = (tails.get(name) ?? Promise.resolve()).then(action);
      tails.set(
        name,
        result.catch(() => undefined)
      );
      return result;
    }
  };
}
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}
function harness(count = 1, shared = { storage: storage(), locks: locks() }) {
  const local = new Map<string, LocalProjectOrganizationSnapshot>();
  const remote: ProjectSummary[] = Array.from({ length: count }, (_, i) => {
    const id = `proj_${i}`;
    local.set(id, {
      organization: { ...active, pinned: true },
      revision: `rev_${i}`,
      mirrorPending: true
    });
    return {
      projectId: toProjectId(id),
      name: id,
      updatedAt: '2026-10-21T00:00:00Z',
      revisionCount: 1,
      organization: active
    };
  });
  const queue = new OrganizationMirrorQueue();
  const writes: { id: string; time: number }[] = [];
  const host = {
    readLocal: vi.fn<OrganizationMirrorHost['readLocal']>(
      async (id) => local.get(id) ?? null
    ),
    saveLocal: vi.fn<OrganizationMirrorHost['saveLocal']>(
      async (id, organization, revision, isCurrent) => {
        if (local.get(id)?.revision !== revision || (isCurrent && !isCurrent()))
          return false;
        local.set(id, {
          organization,
          revision: `ack_${id}`,
          mirrorPending: false
        });
        return true;
      }
    ),
    updateRemote: vi.fn<OrganizationMirrorHost['updateRemote']>(async (id) => {
      writes.push({ id, time: Date.now() });
    })
  };
  const background = new OrganizationMirrorBackground({ ...shared, queue });
  const scope = background.begin('account_A');
  return {
    shared,
    local,
    remote,
    queue,
    writes,
    host,
    background,
    scope,
    start: () => background.start(scope, remote, host)
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([1_000, 10_000])(
  'prepares %i pending rows without awaiting a network request, lock or rate timer',
  async (count) => {
    const h = harness(count);
    h.local.set('unlisted', {
      organization: active,
      revision: 'unlisted',
      mirrorPending: true
    });
    const prepared = await prepareOrganizationMirrors(
      h.local,
      h.remote,
      h.host,
      h.scope
    );
    expect(prepared.pending).toHaveLength(count);
    expect(prepared.protectedProjectIds.size).toBe(count + 1);
    expect(h.host.saveLocal).not.toHaveBeenCalled();
    expect(h.host.updateRemote).not.toHaveBeenCalled();
    expect(Date.now()).toBe(0);
    h.background.start(h.scope, prepared.pending, h.host);
    expect(h.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.writes).toHaveLength(60);
    expect(
      h.local.size -
        [...h.local.values()].filter((row) => row.mirrorPending).length
    ).toBe(60);
    if (count === 1_000) {
      await vi.advanceTimersByTimeAsync(1_000_000);
      expect(h.writes).toHaveLength(1_000);
      expect(
        [...h.local.values()].filter((row) => row.mirrorPending)
      ).toHaveLength(1);
    }
    h.background.dispose();
  }
);

it('adopts account state locally without joining a held network queue', async () => {
  const h = harness();
  h.local.get('proj_0')!.mirrorPending = false;
  const held = gate();
  const queued = h.queue.run(() => held.wait);
  const prepared = await prepareOrganizationMirrors(
    h.local,
    h.remote,
    h.host,
    h.scope
  );
  expect(prepared.pending).toEqual([]);
  expect(h.local.get('proj_0')?.organization).toEqual(active);
  held.open();
  await queued;
});

it('leaves even agreeing pending values deferred rather than acknowledging around an old in-flight PATCH', async () => {
  const h = harness();
  h.local.get('proj_0')!.organization = active;
  const prepared = await prepareOrganizationMirrors(
    h.local,
    h.remote,
    h.host,
    h.scope
  );
  expect(prepared.protectedProjectIds.has('proj_0')).toBe(true);
  expect(h.local.get('proj_0')?.mirrorPending).toBe(true);
  expect(h.host.saveLocal).not.toHaveBeenCalled();
});

it('shares one conservative admission allowance across independent tab controllers', async () => {
  const shared = { storage: storage(), locks: locks() };
  const first = harness(1_000, shared),
    second = harness(1_000, shared);
  first.start();
  second.start();
  await vi.advanceTimersByTimeAsync(60_000);
  const times = [...first.writes, ...second.writes]
    .map((row) => row.time)
    .sort((a, b) => a - b);
  expect(times).toHaveLength(60);
  for (let i = 1; i < times.length; i++)
    expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(1_000);
  first.background.dispose();
  second.background.dispose();
});

it('lets a fresh action execute immediately after the current background request', async () => {
  const h = harness(1_000),
    held = gate();
  h.host.updateRemote.mockImplementationOnce(async (id) => {
    h.writes.push({ id, time: Date.now() });
    await held.wait;
  });
  h.start();
  await vi.advanceTimersByTimeAsync(25);
  h.local.set('fresh', {
    organization: active,
    revision: 'fresh',
    mirrorPending: true
  });
  const fresh = mirrorPendingOrganization('fresh', h.host, h.queue, h.scope);
  held.open();
  await fresh;
  expect(h.writes.map((row) => row.id)).toEqual(['proj_0', 'fresh']);
  h.background.dispose();
});

it('backs off all tabs after a429 and retries the failed pending row without a backlog storm', async () => {
  const shared = { storage: storage(), locks: locks() };
  const first = harness(1_000, shared);
  first.host.updateRemote.mockRejectedValueOnce(
    Object.assign(new Error('limited'), { status: 429 })
  );
  first.start();
  await vi.advanceTimersByTimeAsync(25);
  const second = harness(1_000, shared);
  second.start();
  await vi.advanceTimersByTimeAsync(59_999);
  expect(first.host.updateRemote).toHaveBeenCalledTimes(1);
  expect(second.host.updateRemote).not.toHaveBeenCalled();
  expect(first.local.get('proj_0')?.mirrorPending).toBe(true);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(
    first.host.updateRemote.mock.calls.length +
      second.host.updateRemote.mock.calls.length
  ).toBeLessThanOrEqual(3);
  first.background.dispose();
  second.background.dispose();
});

it.each(['before timer', 'during admission', 'after response'] as const)(
  'cancels obsolete account work %s and retains pending intent',
  async (phase) => {
    const h = harness(1_000),
      held = gate();
    if (phase === 'after response')
      h.host.updateRemote.mockImplementationOnce(() => held.wait);
    h.start();
    if (phase !== 'before timer') await vi.advanceTimersByTimeAsync(25);
    h.background.begin('account_B');
    held.open();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.host.updateRemote).toHaveBeenCalledTimes(
      phase === 'before timer' ? 0 : 1
    );
    expect(h.local.get('proj_1')?.mirrorPending).toBe(true);
    if (phase === 'after response')
      expect(h.local.get('proj_0')?.mirrorPending).toBe(true);
    h.background.dispose();
  }
);

it('rechecks account identity after an admission lock is granted', async () => {
  const held = gate();
  const underlying = locks();
  const shared = {
    storage: storage(),
    locks: {
      request: async <T>(name: string, action: () => T | Promise<T>) => {
        if (name.startsWith(ORGANIZATION_ADMISSION_PREFIX)) await held.wait;
        return underlying.request(name, action);
      }
    }
  };
  const h = harness(1, shared);
  h.start();
  await vi.advanceTimersByTimeAsync(25);
  h.background.cancel();
  held.open();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.host.updateRemote).not.toHaveBeenCalled();
});

it('rechecks after a network lock and does not replay old work with a new account', async () => {
  const shared = { storage: storage(), locks: locks() },
    held = gate();
  vi.stubGlobal('navigator', { locks: shared.locks, onLine: true });
  const occupied = shared.locks.request(
    'openzcad-organization-mirror',
    () => held.wait
  );
  const h = harness(1, shared);
  h.start();
  await vi.advanceTimersByTimeAsync(25);
  h.background.begin('account_B');
  held.open();
  await occupied;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.host.updateRemote).not.toHaveBeenCalled();
});

it('rechecks after reading current metadata immediately before the API call', async () => {
  const h = harness(),
    held = gate();
  h.host.readLocal
    .mockImplementationOnce(async (id) => h.local.get(id) ?? null)
    .mockImplementationOnce(async (id) => {
      await held.wait;
      return h.local.get(id) ?? null;
    });
  h.start();
  await vi.advanceTimersByTimeAsync(25);
  h.background.cancel();
  held.open();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.host.updateRemote).not.toHaveBeenCalled();
});

it('observes a second tab account switch even without delivery of a storage event', async () => {
  const shared = { storage: storage(), locks: locks() };
  const h = harness(1_000, shared);
  h.start();
  await vi.advanceTimersByTimeAsync(25);
  const other = new OrganizationMirrorBackground(shared);
  other.begin('account_B');
  await vi.advanceTimersByTimeAsync(120_000);
  expect(h.writes).toHaveLength(1);
  h.background.dispose();
  other.dispose();
});

it('stops offline and resumes without clearing failed or unattempted rows', async () => {
  let online = false;
  const h = harness();
  const background = new OrganizationMirrorBackground({
    ...h.shared,
    queue: h.queue,
    online: () => online
  });
  const scope = background.begin('account_A');
  background.start(scope, h.remote, h.host);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.writes).toEqual([]);
  online = true;
  background.resume();
  await vi.advanceTimersByTimeAsync(25);
  expect(h.writes).toHaveLength(1);
  background.dispose();
});

it('fails closed without coordinated background storage while keeping explicit actions available', async () => {
  const h = harness();
  const background = new OrganizationMirrorBackground({
    storage: null,
    locks: null,
    queue: h.queue
  });
  const scope = background.begin('account_A');
  background.start(scope, h.remote, h.host);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(h.writes).toEqual([]);
  await mirrorPendingOrganization('proj_0', h.host, h.queue, scope);
  expect(h.writes).toHaveLength(1);
  background.dispose();
});

it('suppresses a stale acknowledgement inside the real IndexedDB transaction and preserves unattempted retention rows', async () => {
  vi.useRealTimers();
  vi.stubGlobal('indexedDB', new IDBFactory());
  const deleted = {
    ...active,
    status: 'deleted' as const,
    deletedAt: '2020-01-01T00:00:00Z'
  };
  await saveLocalProjectOrganization('pending', deleted, {
    mirrorPending: true
  });
  await saveLocalProjectOrganization('acknowledged', deleted);
  const before = (await loadLocalProjectOrganizationSnapshot('pending'))!;
  expect(
    await saveLocalProjectOrganizationIfCurrent(
      'pending',
      deleted,
      before.revision,
      () => false
    )
  ).toBe(false);
  expect(
    (await loadLocalProjectOrganizationSnapshot('pending'))?.mirrorPending
  ).toBe(true);
  expect(
    await purgeExpiredLocalProjects(
      Date.parse('2026-10-21T00:00:00Z'),
      new Set(),
      { deferPendingProjectIds: new Set(['pending']) }
    )
  ).toEqual(['acknowledged']);
  expect(await loadLocalProjectOrganizationSnapshot('pending')).not.toBeNull();
});

it('uses the newest pending revision after a pacing wait', async () => {
  const h = harness(2);
  h.start();
  await vi.advanceTimersByTimeAsync(25);
  h.local.set('proj_1', {
    organization: active,
    revision: 'newer',
    mirrorPending: true
  });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(h.host.updateRemote.mock.calls[1]?.slice(0, 2)).toEqual([
    'proj_1',
    active
  ]);
  expect(h.local.get('proj_1')?.mirrorPending).toBe(false);
  h.background.dispose();
});

it('does not burst reserved writes after a long network queue wait', async () => {
  const shared = { storage: storage(), locks: locks() };
  const first = harness(10, shared),
    second = harness(10, shared),
    held = gate();
  first.host.updateRemote.mockImplementationOnce(async (id) => {
    first.writes.push({ id, time: Date.now() });
    await held.wait;
  });
  first.start();
  second.start();
  await vi.advanceTimersByTimeAsync(4_000);
  expect(first.writes.length + second.writes.length).toBe(1);
  held.open();
  await vi.advanceTimersByTimeAsync(3_000);
  const times = [...first.writes, ...second.writes]
    .map((row) => row.time)
    .sort((a, b) => a - b);
  expect(times.length).toBeGreaterThan(2);
  for (let i = 1; i < times.length; i++)
    expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(1_000);
  first.background.dispose();
  second.background.dispose();
});

it.each(['queued', 'in flight'] as const)(
  'cancels an explicit reorder %s without acknowledging obsolete intent',
  async (phase) => {
    const h = harness(),
      held = gate();
    const blocked =
      phase === 'queued' ? h.queue.run(() => held.wait) : Promise.resolve();
    const reorder = vi.fn(async () => {
      if (phase === 'in flight') await held.wait;
      return h.remote;
    });
    const operation = mirrorPendingReorder(
      ['proj_0'],
      h.host,
      reorder,
      h.queue,
      h.scope
    );
    if (phase === 'in flight') {
      for (let i = 0; i < 10 && !reorder.mock.calls.length; i++)
        await Promise.resolve();
      expect(reorder).toHaveBeenCalledOnce();
    }
    h.background.begin('account_B');
    held.open();
    await Promise.all([blocked, operation]);
    expect(reorder).toHaveBeenCalledTimes(phase === 'queued' ? 0 : 1);
    expect(h.host.updateRemote).not.toHaveBeenCalled();
    expect(h.local.get('proj_0')?.mirrorPending).toBe(true);
  }
);

it('expires signed-out model and backup data while retaining only pending organization intent for a later account', async () => {
  vi.useRealTimers();
  vi.stubGlobal('indexedDB', new IDBFactory());
  const document = createProjectDocument(
    'Expired model',
    toUserId('user_local')
  );
  await saveLocalProject(document);
  await saveLocalProjectOrganization(
    document.projectId,
    { ...active, status: 'deleted', deletedAt: '2020-01-01T00:00:00Z' },
    { mirrorPending: true }
  );
  await saveProjectThumbnail(document.projectId, {
    source: 'data:image/png;base64,AAAA',
    version: 1,
    updatedAt: '2020-01-01T00:00:00Z'
  });
  await scopedTransaction('readwrite', [BACKUP_STORE_NAME], async (store) => {
    store(BACKUP_STORE_NAME).put(
      [{ path: 'model.bin', bytes: new Uint8Array([1, 2, 3]) }],
      document.projectId
    );
  });
  expect(
    await purgeExpiredLocalProjects(
      Date.parse('2026-10-21T00:00:00Z'),
      new Set(),
      { retainPendingOrganization: true }
    )
  ).toEqual([document.projectId]);
  expect(await loadLocalProject(document.projectId)).toBeNull();
  expect(await loadProjectBackupFiles(document.projectId)).toEqual([]);
  expect(await loadProjectThumbnail(document.projectId)).toBeNull();
  const remaining = (await loadLocalProjectOrganizationSnapshot(
    document.projectId
  ))!;
  expect(remaining.mirrorPending).toBe(true);
  expect(remaining.organization.status).toBe('deleted');
  // The small tombstone can still mirror when the owning account returns.
  const h = harness(0);
  h.host.readLocal.mockImplementation(loadLocalProjectOrganizationSnapshot);
  h.host.saveLocal.mockImplementation(saveLocalProjectOrganizationIfCurrent);
  await mirrorPendingOrganization(document.projectId, h.host, h.queue, h.scope);
  expect(h.host.updateRemote.mock.calls[0]?.[1].status).toBe('deleted');
  expect(
    (await loadLocalProjectOrganizationSnapshot(document.projectId))
      ?.mirrorPending
  ).toBe(false);
});

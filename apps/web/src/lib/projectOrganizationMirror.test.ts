import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  toProjectId,
  type ProjectOrganization,
  type ProjectSummary
} from '@openzcad/shared';
import {
  listLocalProjectOrganizationSnapshots,
  loadLocalProjectOrganizationSnapshot,
  saveLocalProjectOrganization,
  saveLocalProjectOrganizationIfCurrent,
  scopedTransaction,
  META_STORE_NAME
} from './localProjectStore';
import {
  mirrorPendingOrganization,
  mirrorPendingReorder,
  OrganizationMirrorQueue,
  reconcileRemoteOrganizations,
  type OrganizationMirrorHost
} from './projectOrganizationMirror';

const id = 'proj_shared';
const active: ProjectOrganization = {
  status: 'active',
  pinned: false,
  sortOrder: 0
};
const trashed: ProjectOrganization = {
  ...active,
  status: 'deleted',
  deletedAt: '2026-09-05T02:30:00.000Z'
};
function listed(
  organization?: ProjectOrganization,
  projectId = id
): ProjectSummary {
  return {
    projectId: toProjectId(projectId),
    name: 'Shared part',
    updatedAt: '2026-09-05T00:00:00.000Z',
    revisionCount: 1,
    ...(organization ? { organization } : {})
  };
}
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}
function harness() {
  const host = {
    readLocal: vi.fn(loadLocalProjectOrganizationSnapshot),
    saveLocal: vi.fn(saveLocalProjectOrganizationIfCurrent),
    updateRemote: vi
      .fn<OrganizationMirrorHost['updateRemote']>()
      .mockResolvedValue(undefined)
  };
  const queue = new OrganizationMirrorQueue();
  return {
    host,
    queue,
    mirror: (projectId = id) =>
      mirrorPendingOrganization(projectId, host, queue)
  };
}
const seed = (
  organization: ProjectOrganization,
  mirrorPending = false,
  projectId = id
) => saveLocalProjectOrganization(projectId, organization, { mirrorPending });
const read = () => loadLocalProjectOrganizationSnapshot(id);

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reconcileRemoteOrganizations', () => {
  it('adopts the account row over a device row that is not pending', async () => {
    await seed(active);
    const h = harness();
    const snapshot = await listLocalProjectOrganizationSnapshots();
    const failures = await reconcileRemoteOrganizations(
      snapshot,
      [listed(trashed)],
      h.host,
      h.queue
    );
    expect(h.host.updateRemote).not.toHaveBeenCalled();
    expect((await read())?.organization).toEqual(trashed);
    expect(failures.size).toBe(0);
  });

  it('pushes a pending device row and clears the flag once it lands', async () => {
    await seed(trashed, true);
    const h = harness();
    await reconcileRemoteOrganizations(
      await listLocalProjectOrganizationSnapshots(),
      [listed(active)],
      h.host,
      h.queue
    );
    expect(h.host.updateRemote).toHaveBeenCalledWith(id, trashed);
    expect((await read())?.mirrorPending).toBe(false);
  });

  it('keeps the flag and reports the project when the push fails', async () => {
    await seed(trashed, true);
    const h = harness();
    h.host.updateRemote.mockRejectedValue(new Error('offline'));
    const failures = await reconcileRemoteOrganizations(
      await listLocalProjectOrganizationSnapshots(),
      [listed(active)],
      h.host,
      h.queue
    );
    expect(h.host.saveLocal).not.toHaveBeenCalled();
    expect([...failures]).toEqual([id]);
    expect((await read())?.mirrorPending).toBe(true);
  });

  it('clears a pending flag the account already agrees with', async () => {
    await seed(trashed, true);
    const h = harness();
    await reconcileRemoteOrganizations(
      await listLocalProjectOrganizationSnapshots(),
      [listed(trashed)],
      h.host,
      h.queue
    );
    expect(h.host.updateRemote).not.toHaveBeenCalled();
    expect((await read())?.mirrorPending).toBe(false);
  });

  it('leaves an agreeing, unflagged row alone', async () => {
    await seed(active);
    const h = harness();
    await reconcileRemoteOrganizations(
      await listLocalProjectOrganizationSnapshots(),
      [listed(active)],
      h.host,
      h.queue
    );
    expect(h.host.updateRemote).not.toHaveBeenCalled();
    expect(h.host.saveLocal).not.toHaveBeenCalled();
  });

  it('adopts the account row when the device has none', async () => {
    const h = harness();
    await reconcileRemoteOrganizations(
      new Map(),
      [listed(trashed)],
      h.host,
      h.queue
    );
    expect((await read())?.organization).toEqual(trashed);
    expect(h.host.saveLocal).toHaveBeenCalledWith(id, trashed, null);
  });

  it('pushes the device row when the account never organised the project', async () => {
    await seed(trashed);
    const h = harness();
    await reconcileRemoteOrganizations(
      await listLocalProjectOrganizationSnapshots(),
      [listed()],
      h.host,
      h.queue
    );
    expect(h.host.updateRemote).toHaveBeenCalledWith(id, trashed);
  });

  it('keeps a newer acknowledged action when an older listing arrives', async () => {
    await seed(active);
    const initial = await listLocalProjectOrganizationSnapshots();
    const h = harness();
    await seed({ ...active, pinned: true }, true);
    await h.mirror();
    await reconcileRemoteOrganizations(
      initial,
      [listed(active)],
      h.host,
      h.queue
    );
    expect((await read())?.organization.pinned).toBe(true);
    expect((await read())?.mirrorPending).toBe(false);
    expect(h.host.updateRemote).toHaveBeenCalledTimes(1);
  });

  it('keeps a newer pending action and defers purge when an old reconciliation finishes', async () => {
    await seed({ ...active, pinned: true }, true);
    const h = harness(),
      started = gate(),
      held = gate();
    h.host.updateRemote.mockImplementationOnce(async () => {
      started.open();
      await held.wait;
    });
    const reconciling = reconcileRemoteOrganizations(
      await listLocalProjectOrganizationSnapshots(),
      [listed(active)],
      h.host,
      h.queue
    );
    await started.wait;
    await seed(active, true);
    held.open();
    expect([...(await reconciling)]).toEqual([id]);
    expect((await read())?.organization).toEqual(active);
    expect((await read())?.mirrorPending).toBe(true);
  });
});

describe('organization revision fences and serialized mirrors', () => {
  it('does not let an older successful acknowledgement erase a newer failed action', async () => {
    const h = harness(),
      started = gate(),
      held = gate();
    h.host.updateRemote
      .mockImplementationOnce(async () => {
        started.open();
        await held.wait;
      })
      .mockRejectedValueOnce(new Error('offline'));
    await seed({ ...active, pinned: true }, true);
    const first = h.mirror();
    await started.wait;
    await seed(active, true);
    const second = h.mirror();
    const failed = expect(second).rejects.toThrow('offline');
    held.open();
    await first;
    await failed;
    expect(
      h.host.updateRemote.mock.calls.map(
        ([, organization]) => organization.pinned
      )
    ).toEqual([true, false]);
    expect((await read())?.organization).toEqual(active);
    expect((await read())?.mirrorPending).toBe(true);
  });

  it('coalesces waiting actions to the newest revision and recovers after rejection', async () => {
    const h = harness(),
      started = gate(),
      held = gate();
    h.host.updateRemote.mockImplementationOnce(async () => {
      started.open();
      await held.wait;
      throw new Error('offline');
    });
    await seed({ ...active, pinned: true }, true);
    const first = h.mirror();
    const rejected = expect(first).rejects.toThrow('offline');
    await started.wait;
    await seed(trashed, true);
    const middle = h.mirror();
    await seed({ ...active, sortOrder: 4 }, true);
    const last = h.mirror();
    held.open();
    await Promise.all([rejected, middle, last]);
    expect(
      h.host.updateRemote.mock.calls.map(([, organization]) => organization)
    ).toEqual([
      { ...active, pinned: true },
      { ...active, sortOrder: 4 }
    ]);
    expect((await read())?.mirrorPending).toBe(false);
  });

  it('uses a revision fence even when a value changes A to B and back to A', async () => {
    await seed(active, true);
    const first = (await read())!;
    await seed(trashed, true);
    await seed(active, true);
    expect((await read())?.revision).not.toBe(first.revision);
    expect(
      await saveLocalProjectOrganizationIfCurrent(id, active, first.revision)
    ).toBe(false);
    expect((await read())?.mirrorPending).toBe(true);
  });

  it('reads legacy metadata without a revision and fences later writes', async () => {
    await scopedTransaction('readwrite', [META_STORE_NAME], async (store) => {
      store(META_STORE_NAME).put({
        ...active,
        projectId: id,
        mirrorPending: true
      });
    });
    expect((await read())?.revision).toBeNull();
    expect(await saveLocalProjectOrganizationIfCurrent(id, active, null)).toBe(
      true
    );
    await seed(trashed, true);
    expect(await saveLocalProjectOrganizationIfCurrent(id, active, null)).toBe(
      false
    );
    expect((await read())?.organization).toEqual(trashed);
  });

  it('uses the same Web Lock across independent queue instances', async () => {
    let tail = Promise.resolve<unknown>(undefined);
    const request = vi.fn(
      (_name: string, operation: () => Promise<unknown>) => {
        const result = tail.then(operation);
        tail = result.catch(() => undefined);
        return result;
      }
    );
    vi.stubGlobal('navigator', { locks: { request } });
    const firstQueue = new OrganizationMirrorQueue(),
      secondQueue = new OrganizationMirrorQueue();
    const started = gate(),
      held = gate();
    const order: string[] = [];
    const first = firstQueue.run(async () => {
      order.push('first');
      started.open();
      await held.wait;
    });
    await started.wait;
    const second = secondQueue.run(async () => {
      order.push('second');
    });
    await Promise.resolve();
    expect(order).toEqual(['first']);
    held.open();
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
    expect(request.mock.calls.map(([name]) => name)).toEqual([
      'openzcad-organization-mirror',
      'openzcad-organization-mirror'
    ]);
  });
});

describe('reorder batches', () => {
  it('shares acknowledgement fences with a pin queued during a reorder', async () => {
    const h = harness(),
      started = gate(),
      held = gate();
    await seed(active, true);
    const reorder = vi.fn(async () => {
      started.open();
      await held.wait;
      return [listed(active)];
    });
    const ordering = mirrorPendingReorder([id], h.host, reorder, h.queue);
    await started.wait;
    await seed({ ...active, pinned: true }, true);
    const pinning = h.mirror();
    held.open();
    await Promise.all([ordering, pinning]);
    expect(reorder).toHaveBeenCalledWith([id]);
    expect(h.host.updateRemote).toHaveBeenCalledOnce();
    expect((await read())?.organization.pinned).toBe(true);
    expect((await read())?.mirrorPending).toBe(false);
  });

  it('keeps an ordinary reorder as one batch without per-project PATCHes', async () => {
    const h = harness();
    await seed({ ...active, sortOrder: 1 }, true, 'proj_a');
    await seed(active, true, 'proj_b');
    const reorder = vi.fn(async () => [
      listed({ ...active, sortOrder: 1 }, 'proj_a'),
      listed(active, 'proj_b')
    ]);
    await mirrorPendingReorder(['proj_a', 'proj_b'], h.host, reorder, h.queue);
    expect(reorder).toHaveBeenCalledWith(['proj_b', 'proj_a']);
    expect(h.host.updateRemote).not.toHaveBeenCalled();
    expect(
      [...(await listLocalProjectOrganizationSnapshots()).values()].every(
        (snapshot) => !snapshot.mirrorPending
      )
    ).toBe(true);
  });

  it('does not mistake an order-only response for acknowledgement of a pending shelf change', async () => {
    const h = harness();
    await seed(trashed, true);
    await mirrorPendingReorder(
      [id],
      h.host,
      async () => [listed(active)],
      h.queue
    );
    expect(h.host.updateRemote).toHaveBeenCalledWith(id, trashed);
    expect((await read())?.organization).toEqual(trashed);
    expect((await read())?.mirrorPending).toBe(false);
  });
});

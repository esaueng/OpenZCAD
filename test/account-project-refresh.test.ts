import { describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { applyAccountProjectRefresh } from '../apps/web/src/lib/accountProjectRefresh';
import { CloudProjectAutosave } from '../apps/web/src/lib/cloudProjectAutosave';

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

function harness() {
  const before = createProjectDocument('Device copy', toUserId('owner'));
  const remote = {
    ...before,
    name: 'Other device',
    version: before.version + 1
  };
  let live: ProjectDocument | null = before;
  let disk = before;
  let baseline = before.version;
  const writes: number[] = [];
  const controller = new CloudProjectAutosave({
    api: {
      saveProjectDocument: async ({ expectedVersion, document }) => {
        writes.push(expectedVersion);
        return {
          projectId: document.projectId,
          version: document.version,
          updatedAt: ''
        };
      }
    },
    connectivity: { isOnline: () => true, subscribe: () => () => undefined }
  });
  controller.openProject(before.projectId, before.version);
  const options = {
    before,
    remote,
    current: () => live,
    isActive: () => true,
    hasPendingChanges: () => controller.hasPendingChanges,
    saveLocal: vi.fn(async (document: ProjectDocument) => {
      disk = document;
    }),
    apply: vi.fn((document: ProjectDocument) => {
      controller.adoptAccountVersion(document.projectId, document.version);
      live = document;
    }),
    saveBaseline: vi.fn(async (document: ProjectDocument) => {
      baseline = document.version;
    }),
    onDiverged: vi.fn((document: ProjectDocument) =>
      controller.haltForConflict(document.projectId)
    )
  };
  return {
    before,
    remote,
    controller,
    options,
    writes,
    get disk() {
      return disk;
    },
    get baseline() {
      return baseline;
    },
    setLive(document: ProjectDocument | null) {
      live = document;
    }
  };
}

describe('account freshness pull', () => {
  it('restores a racing local edit and retains the old fence for conflict resolution', async () => {
    const h = harness();
    const held = gate();
    const saveLocal = h.options.saveLocal.getMockImplementation()!;
    h.options.saveLocal.mockImplementationOnce(async (document) => {
      await held.wait;
      await saveLocal(document);
    });
    const pulling = applyAccountProjectRefresh(h.options);
    const local = {
      ...h.before,
      name: 'Unsaved local edit',
      version: h.remote.version + 1
    };
    h.setLive(local);
    h.controller.schedule(local);
    held.open();
    expect(await pulling).toBe('diverged');
    expect(h.disk).toBe(local);
    expect(h.baseline).toBe(h.before.version);
    expect(h.controller.syncedVersion).toBe(h.before.version);
    expect(h.controller.hasPendingChanges).toBe(true);
    expect(h.options.apply).not.toHaveBeenCalled();
    expect(h.options.saveBaseline).not.toHaveBeenCalled();
    await h.controller.flushPending();
    expect(h.writes).toEqual([]);
    h.controller.dispose();
  });

  it('adopts the pulled model before baseline storage so subsequent edits keep their queue', async () => {
    const h = harness();
    const held = gate();
    const started = gate();
    h.options.saveBaseline.mockImplementationOnce(async () => {
      started.open();
      await held.wait;
    });
    const pulling = applyAccountProjectRefresh(h.options);
    await started.wait;
    const local = {
      ...h.remote,
      name: 'Edit after pull',
      version: h.remote.version + 1
    };
    h.setLive(local);
    h.controller.schedule(local);
    held.open();
    expect(await pulling).toBe('applied');
    expect(h.options.apply).toHaveBeenCalledWith(h.remote);
    expect(h.controller.hasPendingChanges).toBe(true);
    await h.controller.flushPending();
    expect(h.writes).toEqual([h.remote.version]);
    h.controller.dispose();
  });

  it('skips a stale pull without writing or rebasing another project', async () => {
    const h = harness();
    h.setLive(createProjectDocument('Different project', toUserId('owner')));
    expect(await applyAccountProjectRefresh(h.options)).toBe('stale');
    expect(h.options.saveLocal).not.toHaveBeenCalled();
    expect(h.options.saveBaseline).not.toHaveBeenCalled();
    expect(h.options.apply).not.toHaveBeenCalled();
    h.controller.dispose();
  });
});

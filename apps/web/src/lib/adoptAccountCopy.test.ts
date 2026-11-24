import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  adoptAccountCopyLocally,
  stampLegacyViewUnits
} from './adoptAccountCopy';
import {
  SAVED_VIEWS_STORAGE_KEY,
  loadSavedViews,
  saveView,
  savedViewInUnits
} from './savedViews';
import {
  WORKSPACE_SESSION_STORAGE_KEY,
  loadProjectView,
  saveProjectView,
  stampProjectViewUnits
} from './workspaceSession';

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const mmCamera = {
  position: [254, 0, 0] as [number, number, number],
  target: [25.4, 0, 0] as [number, number, number],
  orthographicZoom: 1
};
const shownSettings = { showGrid: true, displayMode: 'shaded' as const };

function legacyMillimetreViews(projectId: string) {
  // Written before view state recorded its unit: no `units` field.
  saveProjectView(projectId, {
    camera: mmCamera,
    projection: 'perspective',
    settings: {
      ...shownSettings,
      sectionView: { plane: 'XY', offset: 50.8 }
    },
    hiddenBodyIds: []
  });
  saveView(projectId, {
    camera: mmCamera,
    projection: 'perspective',
    displayMode: 'shaded',
    sectionView: { plane: 'XY', offset: 50.8 }
  });
}

function copies(): { device: ProjectDocument; account: ProjectDocument } {
  const device = createProjectDocument('Bracket', toUserId('owner'), 'mm');
  // The account copy was converted to inches on another device.
  return {
    device,
    account: { ...device, units: 'inch', version: device.version + 1 }
  };
}

describe('adopting an account copy converted elsewhere (I03)', () => {
  let localStorage: MemoryStorage;
  beforeEach(() => {
    localStorage = new MemoryStorage();
    vi.stubGlobal('window', { localStorage });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stamps legacy view state before the device copy is replaced', async () => {
    const { device, account } = copies();
    legacyMillimetreViews(device.projectId);
    const order: string[] = [];
    await adoptAccountCopyLocally(account, device, {
      async stampViewUnits(projectId, units) {
        order.push(`stamp:${units}`);
        return stampLegacyViewUnits(projectId, units);
      },
      async saveLocalProject(document) {
        // The marker is already durable when the overwrite starts.
        expect(loadProjectView(device.projectId)?.units).toBe('mm');
        expect(loadSavedViews(device.projectId)[0]?.units).toBe('mm');
        order.push(`save:${document.units}`);
      },
      async saveLastSyncedVersion(_projectId, version) {
        order.push(`synced:${version}`);
      }
    });
    expect(order).toEqual([
      'stamp:mm',
      'save:inch',
      `synced:${account.version}`
    ]);
  });

  it('keeps the millimetre provenance through a crash after the overwrite and a retry', async () => {
    const { device, account } = copies();
    legacyMillimetreViews(device.projectId);
    let deviceCopy: ProjectDocument = device;
    const crashAfterOverwrite = {
      stampViewUnits: stampLegacyViewUnits,
      async saveLocalProject(document: ProjectDocument) {
        deviceCopy = document;
        throw new Error('tab closed');
      },
      async saveLastSyncedVersion() {
        throw new Error('never reached');
      }
    };
    await expect(
      adoptAccountCopyLocally(account, deviceCopy, crashAfterOverwrite)
    ).rejects.toThrow('tab closed');
    expect(deviceCopy.units).toBe('inch');

    // The next startup holds the inch copy on this device; adopting again
    // stamps nothing new and the views still say millimetres.
    const saved: ProjectDocument[] = [];
    await adoptAccountCopyLocally(account, deviceCopy, {
      stampViewUnits: stampLegacyViewUnits,
      async saveLocalProject(document) {
        saved.push(document);
      },
      async saveLastSyncedVersion() {}
    });
    expect(saved).toEqual([account]);
    expect(loadProjectView(device.projectId)?.units).toBe('mm');
    const [view] = loadSavedViews(device.projectId);
    expect(view?.units).toBe('mm');
    const shown = savedViewInUnits(view!, 'inch');
    expect(shown.camera.position[0]).toBeCloseTo(10, 12);
    expect(shown.camera.target[0]).toBeCloseTo(1, 12);
    expect(shown.sectionView?.offset).toBeCloseTo(2, 12);
  });

  it('retries safely when stopped between the marker and the overwrite', async () => {
    const { device, account } = copies();
    legacyMillimetreViews(device.projectId);
    const saveLocalProject = vi.fn(async () => undefined);
    const stopped = await adoptAccountCopyLocally(account, device, {
      stampViewUnits: stampLegacyViewUnits,
      saveLocalProject,
      saveLastSyncedVersion: vi.fn(async () => undefined),
      isCurrent: () => false
    });
    expect(stopped).toBe(false);
    expect(saveLocalProject).not.toHaveBeenCalled();
    const before = localStorage.getItem(WORKSPACE_SESSION_STORAGE_KEY);
    await adoptAccountCopyLocally(account, device, {
      stampViewUnits: stampLegacyViewUnits,
      saveLocalProject,
      saveLastSyncedVersion: vi.fn(async () => undefined)
    });
    expect(localStorage.getItem(WORKSPACE_SESSION_STORAGE_KEY)).toBe(before);
    expect(saveLocalProject).toHaveBeenCalledWith(account);
  });

  it('keeps the device copy when an existing view cannot be stamped', async () => {
    const { device, account } = copies();
    const saveLocalProject = vi.fn(async () => {});
    const saveLastSyncedVersion = vi.fn(async () => {});
    await expect(
      adoptAccountCopyLocally(account, device, {
        stampViewUnits: async () => false,
        saveLocalProject,
        saveLastSyncedVersion
      })
    ).rejects.toThrow(
      'Could not preserve the saved view units on this device.'
    );
    expect(saveLocalProject).not.toHaveBeenCalled();
    expect(saveLastSyncedVersion).not.toHaveBeenCalled();
  });

  it('stamps nothing without a device copy of the same project', async () => {
    const { account } = copies();
    const stampViewUnits = vi.fn(async () => true);
    const other = createProjectDocument('Other', toUserId('owner'), 'mm');
    for (const replaced of [null, other]) {
      await adoptAccountCopyLocally(account, replaced, {
        stampViewUnits,
        saveLocalProject: async () => undefined,
        saveLastSyncedVersion: async () => undefined
      });
    }
    expect(stampViewUnits).not.toHaveBeenCalled();
  });

  it.each([WORKSPACE_SESSION_STORAGE_KEY, SAVED_VIEWS_STORAGE_KEY])(
    'keeps the device copy when %s cannot be read',
    async (unreadableKey) => {
      const { device, account } = copies();
      legacyMillimetreViews(device.projectId);
      const read = localStorage.getItem.bind(localStorage);
      localStorage.getItem = (key) => {
        if (key === unreadableKey) throw new Error('storage unavailable');
        return read(key);
      };
      const saveLocalProject = vi.fn(async () => {});
      const saveLastSyncedVersion = vi.fn(async () => {});
      await expect(
        adoptAccountCopyLocally(account, device, {
          stampViewUnits: stampLegacyViewUnits,
          saveLocalProject,
          saveLastSyncedVersion
        })
      ).rejects.toThrow('Could not preserve the saved view units');
      expect(saveLocalProject).not.toHaveBeenCalled();
      expect(saveLastSyncedVersion).not.toHaveBeenCalled();
    }
  );
});

describe('stampProjectViewUnits (I03)', () => {
  it('stamps only an unstamped view and keeps its recency', () => {
    const storage = new MemoryStorage();
    const view = {
      camera: mmCamera,
      projection: 'perspective' as const,
      settings: shownSettings,
      hiddenBodyIds: []
    };
    saveProjectView('legacy', view, storage);
    saveProjectView('stamped', { ...view, units: 'cm' }, storage);
    const updatedAt = (id: string): unknown =>
      (
        JSON.parse(storage.getItem(WORKSPACE_SESSION_STORAGE_KEY)!) as {
          views: Record<string, { updatedAt: number }>;
        }
      ).views[id]?.updatedAt;
    const legacyAt = updatedAt('legacy');
    expect(stampProjectViewUnits('legacy', 'mm', storage)).toBe(true);
    expect(stampProjectViewUnits('stamped', 'mm', storage)).toBe(true);
    expect(stampProjectViewUnits('missing', 'mm', storage)).toBe(true);
    expect(loadProjectView('legacy', storage)?.units).toBe('mm');
    expect(loadProjectView('stamped', storage)?.units).toBe('cm');
    expect(loadProjectView('missing', storage)).toBeNull();
    expect(updatedAt('legacy')).toBe(legacyAt);
    expect(loadProjectView('legacy', storage)?.camera).toEqual(mmCamera);
  });

  it('reports a refused write', () => {
    const storage = new MemoryStorage();
    saveProjectView(
      'legacy',
      {
        camera: mmCamera,
        projection: 'perspective',
        settings: shownSettings,
        hiddenBodyIds: []
      },
      storage
    );
    storage.setItem = () => {
      throw new Error('quota');
    };
    expect(stampProjectViewUnits('legacy', 'mm', storage)).toBe(false);
  });
});

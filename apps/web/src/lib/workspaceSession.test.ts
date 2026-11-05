import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_SESSION_STORAGE_KEY,
  clearActiveProject,
  loadActiveProjectId,
  loadProjectView,
  rememberActiveProject,
  rekeyWorkspaceProject,
  saveProjectView,
  snapshotActiveProject
} from './workspaceSession';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const view = {
  camera: {
    position: [42, 31, 18] as [number, number, number],
    target: [2, 3, 4] as [number, number, number],
    orthographicZoom: 1.75,
    orthographicHalfHeight: 24
  },
  projection: 'orthographic' as const,
  settings: {
    showGrid: false,
    displayMode: 'wireframe' as const
  },
  hiddenBodyIds: ['body-hidden']
};

describe('tab-local project restoration', () => {
  afterEach(() => vi.unstubAllGlobals());

  function selectTab(
    localStorage: MemoryStorage,
    sessionStorage: MemoryStorage
  ) {
    vi.stubGlobal('window', { localStorage, sessionStorage });
  }

  it('seeds a new tab once from the device pointer and retains its own project', () => {
    const device = new MemoryStorage();
    const first = new MemoryStorage();
    const second = new MemoryStorage();
    rememberActiveProject('legacy', device);
    saveProjectView('legacy', view, device);
    selectTab(device, first);
    expect(loadActiveProjectId()).toBe('legacy');
    rememberActiveProject('first');

    selectTab(device, second);
    expect(loadActiveProjectId()).toBe('first');
    rememberActiveProject('second');
    expect(loadActiveProjectId(device)).toBe('second');

    selectTab(device, first);
    expect(loadActiveProjectId()).toBe('first');
    expect(loadProjectView('legacy')).toEqual(view);
    const opening = snapshotActiveProject();
    selectTab(device, second);
    rememberActiveProject('second-newer');
    selectTab(device, first);
    expect(rememberActiveProject('first-newer', undefined, opening)).toBe(true);
    expect(loadActiveProjectId()).toBe('first-newer');
    selectTab(device, second);
    expect(loadActiveProjectId()).toBe('second-newer');
  });

  it('keeps the library choice across reloads and changes in another tab', () => {
    const device = new MemoryStorage();
    const first = new MemoryStorage();
    const second = new MemoryStorage();
    selectTab(device, first);
    rememberActiveProject('first');
    selectTab(device, second);
    expect(clearActiveProject()).toBe(true);
    selectTab(device, first);
    expect(loadActiveProjectId()).toBe('first');
    rememberActiveProject('first');
    selectTab(device, second);
    expect(loadActiveProjectId()).toBeNull();
  });

  it('moves the current tab to an adopted identity without moving another tab', () => {
    const device = new MemoryStorage();
    const first = new MemoryStorage();
    const second = new MemoryStorage();
    selectTab(device, first);
    rememberActiveProject('device-id');
    saveProjectView('device-id', view);
    selectTab(device, second);
    rememberActiveProject('unrelated');
    selectTab(device, first);
    expect(rekeyWorkspaceProject('device-id', 'account-id')).toBe(true);
    expect(loadActiveProjectId()).toBe('account-id');
    expect(loadProjectView('account-id')).toEqual(view);
    selectTab(device, second);
    expect(loadActiveProjectId()).toBe('unrelated');
  });

  it('restores a tab when device storage is unavailable', () => {
    const device = new MemoryStorage();
    vi.spyOn(device, 'getItem').mockImplementation(() => {
      throw new Error('Storage disabled');
    });
    vi.spyOn(device, 'setItem').mockImplementation(() => {
      throw new Error('Storage disabled');
    });
    selectTab(device, new MemoryStorage());
    expect(rememberActiveProject('first')).toBe(true);
    expect(loadActiveProjectId()).toBe('first');
  });

  it("does not use another tab's pointer when session storage is denied", () => {
    const device = new MemoryStorage();
    rememberActiveProject('other-tab', device);
    vi.stubGlobal('window', {
      localStorage: device,
      get sessionStorage() {
        throw new Error('Storage disabled');
      }
    });
    expect(loadActiveProjectId()).toBeNull();
    expect(rememberActiveProject('first')).toBe(false);
    expect(clearActiveProject()).toBe(false);
    expect(loadActiveProjectId(device)).toBe('other-tab');
  });
});

describe('workspace session persistence', () => {
  it('round-trips the active project and its exact viewport state', () => {
    const storage = new MemoryStorage();

    expect(rememberActiveProject('project-1', storage)).toBe(true);
    expect(saveProjectView('project-1', view, storage)).toBe(true);

    expect(loadActiveProjectId(storage)).toBe('project-1');
    expect(loadProjectView('project-1', storage)).toEqual(view);
  });

  it('keeps sketch visibility and X-ray with the view, dropping bad entries', () => {
    const storage = new MemoryStorage();
    saveProjectView(
      'project-1',
      {
        ...view,
        settings: { ...view.settings, xray: true },
        sketchVisibility: { 'sketch-a': false, 'sketch-b': true }
      },
      storage
    );
    expect(loadProjectView('project-1', storage)).toMatchObject({
      settings: { xray: true },
      sketchVisibility: { 'sketch-a': false, 'sketch-b': true }
    });

    // Hand-edited storage: a non-boolean entry is dropped, not the view.
    const raw = JSON.parse(storage.getItem(WORKSPACE_SESSION_STORAGE_KEY)!) as {
      views: Record<string, Record<string, unknown>>;
    };
    raw.views['project-1']!.sketchVisibility = { 'sketch-a': 'no', '': true };
    (raw.views['project-1']!.settings as Record<string, unknown>).xray = 'yes';
    storage.setItem(WORKSPACE_SESSION_STORAGE_KEY, JSON.stringify(raw));
    const reloaded = loadProjectView('project-1', storage);
    expect(reloaded?.camera).toEqual(view.camera);
    expect(reloaded?.sketchVisibility).toBeUndefined();
    expect(reloaded?.settings.xray).toBe(false);
  });

  it('keeps the newest sketch visibility choices past the cap', () => {
    const storage = new MemoryStorage();
    const sketchVisibility = Object.fromEntries(
      Array.from({ length: 501 }, (_, index) => [`sketch-${index}`, false])
    );
    saveProjectView('project-1', { ...view, sketchVisibility }, storage);
    const reloaded = loadProjectView('project-1', storage)?.sketchVisibility;
    expect(Object.keys(reloaded ?? {})).toHaveLength(500);
    expect(reloaded).not.toHaveProperty('sketch-0');
    expect(reloaded).toHaveProperty('sketch-500', false);
  });

  it('round-trips hidden reference IDs and ignores invalid entries', () => {
    const storage = new MemoryStorage();
    const hiddenReferences = { datumIds: ['plane-a'], imageIds: ['image-a'] };
    saveProjectView('project-1', { ...view, hiddenReferences }, storage);
    expect(loadProjectView('project-1', storage)).toEqual({
      ...view,
      hiddenReferences
    });

    const raw = JSON.parse(storage.getItem(WORKSPACE_SESSION_STORAGE_KEY)!) as {
      views: Record<string, Record<string, unknown>>;
    };
    raw.views['project-1']!.hiddenReferences = {
      datumIds: ['plane-a', 3, ''],
      imageIds: 'image-a'
    };
    storage.setItem(WORKSPACE_SESSION_STORAGE_KEY, JSON.stringify(raw));
    expect(loadProjectView('project-1', storage)).toEqual({
      ...view,
      hiddenReferences: { datumIds: ['plane-a'], imageIds: [] }
    });
  });

  it('keeps the field of view a pose was framed at, dropping a bad one', () => {
    const storage = new MemoryStorage();
    saveProjectView(
      'project-1',
      { ...view, camera: { ...view.camera, fieldOfView: 60 } },
      storage
    );
    expect(loadProjectView('project-1', storage)?.camera?.fieldOfView).toBe(60);
    saveProjectView(
      'project-1',
      { ...view, camera: { ...view.camera, fieldOfView: Number.NaN } },
      storage
    );
    const reloaded = loadProjectView('project-1', storage);
    expect(reloaded?.camera?.position).toEqual(view.camera.position);
    expect(reloaded?.camera).not.toHaveProperty('fieldOfView');
  });

  it('keeps a project view while an explicit return home clears auto-open', () => {
    const storage = new MemoryStorage();
    rememberActiveProject('project-1', storage);
    saveProjectView('project-1', view, storage);

    expect(clearActiveProject(storage)).toBe(true);

    expect(loadActiveProjectId(storage)).toBeNull();
    expect(loadProjectView('project-1', storage)).toEqual(view);
  });

  it('keeps a pointer written after the open began', () => {
    const storage = new MemoryStorage();
    rememberActiveProject('previous', storage);
    const openBegan = snapshotActiveProject(storage);
    // A newer navigation records its choice while this open is still
    // awaiting storage.
    rememberActiveProject('newer', storage);
    saveProjectView('newer', view, storage);

    expect(rememberActiveProject('opened', storage, openBegan)).toBe(false);

    expect(loadActiveProjectId(storage)).toBe('newer');
    expect(loadProjectView('newer', storage)).toEqual(view);
  });

  it('keeps a pointer rewritten to the id it held when the open began', () => {
    const storage = new MemoryStorage();
    rememberActiveProject('a', storage);
    const openBegan = snapshotActiveProject(storage);
    rememberActiveProject('b', storage);
    rememberActiveProject('a', storage);

    expect(rememberActiveProject('c', storage, openBegan)).toBe(false);
    expect(loadActiveProjectId(storage)).toBe('a');

    const homeBegan = snapshotActiveProject(storage);
    clearActiveProject(storage);
    const homeAgain = snapshotActiveProject(storage);
    clearActiveProject(storage);

    expect(rememberActiveProject('c', storage, homeBegan)).toBe(false);
    expect(rememberActiveProject('c', storage, homeAgain)).toBe(false);
    expect(loadActiveProjectId(storage)).toBeNull();
  });

  it('clears only a pointer that has not moved since the snapshot', () => {
    const storage = new MemoryStorage();
    rememberActiveProject('missing', storage);
    const restoreBegan = snapshotActiveProject(storage);
    rememberActiveProject('newer', storage);

    expect(clearActiveProject(storage, restoreBegan)).toBe(false);
    expect(loadActiveProjectId(storage)).toBe('newer');

    const unchanged = snapshotActiveProject(storage);
    expect(clearActiveProject(storage, unchanged)).toBe(true);
    expect(loadActiveProjectId(storage)).toBeNull();
  });

  it('keeps a pointer seeded by a writer that knows no revision', () => {
    const storage = new MemoryStorage();
    const openBegan = snapshotActiveProject(storage);
    storage.setItem(
      WORKSPACE_SESSION_STORAGE_KEY,
      JSON.stringify({ version: 1, activeProjectId: 'seeded', views: {} })
    );

    expect(rememberActiveProject('opened', storage, openBegan)).toBe(false);
    expect(loadActiveProjectId(storage)).toBe('seeded');
  });

  it('records the open when the pointer has not moved since it began', () => {
    const storage = new MemoryStorage();
    const fromEmpty = snapshotActiveProject(storage);
    expect(rememberActiveProject('first', storage, fromEmpty)).toBe(true);
    expect(loadActiveProjectId(storage)).toBe('first');

    const openBegan = snapshotActiveProject(storage);
    // Camera writes touch the session but not the pointer.
    saveProjectView('first', view, storage);
    expect(rememberActiveProject('second', storage, openBegan)).toBe(true);
    expect(loadActiveProjectId(storage)).toBe('second');

    const cleared = snapshotActiveProject(storage);
    rememberActiveProject('third', storage);
    const newerOpen = snapshotActiveProject(storage);
    // A pointer that already names this project is not a conflict, and is
    // not rewritten: a newer open's snapshot must stay current.
    expect(rememberActiveProject('third', storage, cleared)).toBe(true);
    expect(snapshotActiveProject(storage)).toEqual(newerOpen);
    expect(rememberActiveProject('fourth', storage, newerOpen)).toBe(true);
    expect(loadActiveProjectId(storage)).toBe('fourth');
  });

  it('fails closed when browser storage is unavailable', () => {
    const unavailableStorage = {
      getItem() {
        throw new Error('Storage is disabled.');
      },
      setItem() {
        throw new Error('Storage is disabled.');
      }
    };

    expect(loadActiveProjectId(unavailableStorage)).toBeNull();
    expect(rememberActiveProject('project-1', unavailableStorage)).toBe(false);
    expect(clearActiveProject(unavailableStorage)).toBe(false);
  });

  it('ignores malformed or non-finite persisted camera data', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      WORKSPACE_SESSION_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        activeProjectId: 'project-1',
        views: {
          'project-1': {
            ...view,
            camera: { ...view.camera, position: [Number.NaN, 0, 0] },
            updatedAt: Date.now()
          },
          'project-2': {
            ...view,
            camera: {
              ...view.camera,
              orthographicHalfHeight: Number.POSITIVE_INFINITY
            },
            updatedAt: Date.now()
          }
        }
      })
    );

    expect(loadActiveProjectId(storage)).toBe('project-1');
    expect(loadProjectView('project-1', storage)).toBeNull();
    expect(loadProjectView('project-2', storage)).toBeNull();
  });
});

it('moves the active project and saved view without changing the viewport', () => {
  const storage = new MemoryStorage();
  rememberActiveProject('device-id', storage);
  saveProjectView('device-id', view, storage);
  rekeyWorkspaceProject('device-id', 'account-id', storage);
  expect(loadActiveProjectId(storage)).toBe('account-id');
  expect(loadProjectView('account-id', storage)).toEqual(view);
  expect(loadProjectView('device-id', storage)).toBeNull();
});

it('retains an existing account view while another account gets its own view', () => {
  const storage = new MemoryStorage();
  rememberActiveProject('account-a', storage);
  saveProjectView('account-a', view, storage);
  rekeyWorkspaceProject('account-a', 'account-b', storage, true);
  expect(loadActiveProjectId(storage)).toBe('account-b');
  expect(loadProjectView('account-a', storage)).toEqual(view);
  expect(loadProjectView('account-b', storage)).toEqual(view);
});

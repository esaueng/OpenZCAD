import { describe, expect, it } from 'vitest';
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
    // Another tab, or a test seeding the session, records a newer choice
    // while the open is still awaiting storage.
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

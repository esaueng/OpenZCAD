import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_SESSION_STORAGE_KEY,
  clearActiveProject,
  loadActiveProjectId,
  loadProjectView,
  rememberActiveProject,
  saveProjectView
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

  it('keeps a project view while an explicit return home clears auto-open', () => {
    const storage = new MemoryStorage();
    rememberActiveProject('project-1', storage);
    saveProjectView('project-1', view, storage);

    expect(clearActiveProject(storage)).toBe(true);

    expect(loadActiveProjectId(storage)).toBeNull();
    expect(loadProjectView('project-1', storage)).toEqual(view);
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

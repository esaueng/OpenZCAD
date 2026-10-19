import { describe, expect, it } from 'vitest';
import {
  MAX_SAVED_VIEWS,
  SAVED_VIEWS_STORAGE_KEY,
  deleteSavedView,
  forgetSavedViews,
  loadSavedViews,
  saveView
} from './savedViews';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data
  };
}

const pose = (x: number) => ({
  camera: {
    position: [x, 2, 3] as [number, number, number],
    target: [0, 0, 0] as [number, number, number],
    orthographicZoom: 1.5
  },
  projection: 'orthographic' as const,
  displayMode: 'wireframe' as const
});

describe('saved views (ZC-115)', () => {
  it('saves numbered views per project and reads them back exactly', () => {
    const storage = memoryStorage();
    const first = saveView('p1', pose(1), { storage, now: 10, id: 'a' });
    const second = saveView(
      'p1',
      { ...pose(2), sectionView: { plane: 'XY', offset: 4 } },
      { storage, now: 20, id: 'b' }
    );
    expect(first.ok && first.view.name).toBe('View 1');
    expect(second.ok && second.view.name).toBe('View 2');
    expect(loadSavedViews('p1', storage)).toEqual([
      { ...pose(1), id: 'a', name: 'View 1', savedAt: 10 },
      {
        ...pose(2),
        sectionView: { plane: 'XY', offset: 4 },
        id: 'b',
        name: 'View 2',
        savedAt: 20
      }
    ]);
    // Another project's views are separate.
    expect(loadSavedViews('p2', storage)).toEqual([]);
  });

  it('reuses the lowest free number after a delete', () => {
    const storage = memoryStorage();
    saveView('p1', pose(1), { storage, id: 'a' });
    saveView('p1', pose(2), { storage, id: 'b' });
    expect(deleteSavedView('p1', 'a', storage)?.map((v) => v.name)).toEqual([
      'View 2'
    ]);
    const again = saveView('p1', pose(3), { storage, id: 'c' });
    expect(again.ok && again.view.name).toBe('View 1');
  });

  it(`refuses a view past ${MAX_SAVED_VIEWS} and leaves the stored set alone`, () => {
    const storage = memoryStorage();
    for (let i = 0; i < MAX_SAVED_VIEWS; i += 1)
      expect(saveView('p1', pose(i), { storage }).ok).toBe(true);
    const before = storage.data.get(SAVED_VIEWS_STORAGE_KEY);
    const refused = saveView('p1', pose(99), { storage });
    expect(refused).toEqual({
      ok: false,
      reason: 'A project keeps up to 8 saved views. Delete one to save another.'
    });
    expect(storage.data.get(SAVED_VIEWS_STORAGE_KEY)).toBe(before);
  });

  it('ignores corrupt storage and drops malformed entries', () => {
    const storage = memoryStorage();
    storage.setItem(SAVED_VIEWS_STORAGE_KEY, '{not json');
    expect(loadSavedViews('p1', storage)).toEqual([]);
    storage.setItem(
      SAVED_VIEWS_STORAGE_KEY,
      JSON.stringify({
        p1: [{ id: 'x' }, { ...pose(1), id: 'a', name: 'View 1', savedAt: 1 }]
      })
    );
    expect(loadSavedViews('p1', storage).map((v) => v.id)).toEqual(['a']);
    // Vectors and zoom that would give the camera NaN transforms are dropped.
    const valid = { ...pose(1), name: 'View 1', savedAt: 1 };
    storage.setItem(
      SAVED_VIEWS_STORAGE_KEY,
      JSON.stringify({
        p1: [
          {
            ...valid,
            id: 'short',
            camera: { ...valid.camera, position: [1, 2] }
          },
          {
            ...valid,
            id: 'text',
            camera: { ...valid.camera, target: ['0', 0, 0] }
          },
          {
            ...valid,
            id: 'zero',
            camera: { ...valid.camera, orthographicZoom: 0 }
          },
          {
            ...valid,
            id: 'inf',
            camera: { ...valid.camera, orthographicZoom: null }
          },
          { ...valid, id: 'ok' }
        ]
      })
    );
    expect(loadSavedViews('p1', storage).map((v) => v.id)).toEqual(['ok']);
    expect(saveView('p1', pose(1), { storage: null })).toMatchObject({
      ok: false
    });
  });
});

describe('saved view upkeep', () => {
  it('keeps a captured FOV, accepts legacy views, and rejects invalid angles', () => {
    const storage = memoryStorage();
    const valid = { ...pose(1), name: 'View 1', savedAt: 1 };
    storage.setItem(
      SAVED_VIEWS_STORAGE_KEY,
      JSON.stringify({
        p1: [
          { ...valid, id: 'captured', fieldOfView: 45 },
          { ...valid, id: 'legacy' },
          ...[-1, 0, 180, null, '45'].map((fieldOfView, index) => ({
            ...valid,
            id: `invalid-${index}`,
            fieldOfView
          }))
        ]
      })
    );
    expect(loadSavedViews('p1', storage).map((view) => view.id)).toEqual([
      'captured',
      'legacy'
    ]);
    expect(loadSavedViews('p1', storage)[0]).toHaveProperty('fieldOfView', 45);
  });

  it('drops entries with an unknown display mode or a malformed section', () => {
    const storage = memoryStorage();
    const valid = { ...pose(1), name: 'View 1', savedAt: 1 };
    storage.setItem(
      SAVED_VIEWS_STORAGE_KEY,
      JSON.stringify({
        p1: [
          { ...valid, id: 'mode', displayMode: 'xray' },
          { ...valid, id: 'plane', sectionView: { plane: 'xy', offset: 1 } },
          {
            ...valid,
            id: 'offset',
            sectionView: { plane: 'XY', offset: null }
          },
          { ...valid, id: 'cut', sectionView: { plane: 'YZ', offset: -2.5 } },
          { ...valid, id: 'plain' }
        ]
      })
    );
    expect(loadSavedViews('p1', storage).map((v) => v.id)).toEqual([
      'cut',
      'plain'
    ]);
  });

  it('keeps X-ray with the view and drops a malformed flag', () => {
    const storage = memoryStorage();
    saveView('p1', { ...pose(1), xray: true }, { storage, now: 1, id: 'x' });
    expect(loadSavedViews('p1', storage)[0]?.xray).toBe(true);
    const valid = { ...pose(1), name: 'View 1', savedAt: 1 };
    storage.setItem(
      SAVED_VIEWS_STORAGE_KEY,
      JSON.stringify({
        p1: [
          { ...valid, id: 'bad', xray: 'on' },
          { ...valid, id: 'older' }
        ]
      })
    );
    expect(loadSavedViews('p1', storage).map((v) => v.id)).toEqual(['older']);
  });

  it('reports a refused delete and keeps the stored list', () => {
    const storage = memoryStorage();
    saveView('p1', pose(1), { storage, id: 'a' });
    const refusing = {
      getItem: storage.getItem,
      setItem: () => {
        throw new Error('quota');
      }
    };
    expect(deleteSavedView('p1', 'a', refusing)).toBeNull();
    expect(loadSavedViews('p1', storage).map((v) => v.id)).toEqual(['a']);
  });

  it('forgets every view of a permanently deleted project only', () => {
    const storage = memoryStorage();
    saveView('p1', pose(1), { storage });
    saveView('p2', pose(2), { storage });
    forgetSavedViews('p1', storage);
    expect(loadSavedViews('p1', storage)).toEqual([]);
    expect(loadSavedViews('p2', storage)).toHaveLength(1);
    expect(storage.data.get(SAVED_VIEWS_STORAGE_KEY)).not.toContain('"p1"');
  });
});

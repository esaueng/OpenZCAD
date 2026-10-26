import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
});

it('persists account/project-scoped work across clients without lost concurrent updates', async () => {
  const module = await import('./shareWorkStore');
  for (const store of [
    module.memoryShareWorkStore(),
    module.indexedDbShareWorkStore()
  ]) {
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.update('alice', 'project', (current) => ({
          ...current,
          retired: [
            ...current.retired,
            { shareId: `link-${index}`, mode: 'view' }
          ]
        }))
      )
    );
    expect((await store.read('alice', 'project')).retired).toHaveLength(10);
    expect((await store.read('bob', 'project')).retired).toEqual([]);
    expect((await store.read('alice', 'other')).retired).toEqual([]);
    await store.update('alice', 'project', (current) => ({
      ...current,
      notice: 'newer'
    }));
    await store.update('alice', 'project', (current) => ({
      ...current,
      notice: current.notice === 'older' ? null : current.notice
    }));
    expect((await store.read('alice', 'project')).notice).toBe('newer');
  }
  expect(
    (await module.indexedDbShareWorkStore().read('alice', 'project')).retired
  ).toHaveLength(10);
});

it('keeps invalid updates from replacing saved evidence', async () => {
  const module = await import('./shareWorkStore');
  for (const store of [
    module.memoryShareWorkStore(),
    module.indexedDbShareWorkStore()
  ]) {
    await store.update('alice', 'project', (current) => ({
      ...current,
      notice: 'kept'
    }));
    await expect(
      store.update('alice', 'project', (current) => ({
        ...current,
        retired: [{ shareId: '', mode: 'view' }]
      }))
    ).rejects.toThrow(/invalid/);
    expect((await store.read('alice', 'project')).notice).toBe('kept');
  }
});

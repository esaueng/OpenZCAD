import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
});

it('persists scoped owner intent across clients and serializes concurrent changes', async () => {
  const module = await import('./projectAuthorityStore');
  for (const store of [module.memoryProjectAuthorityStore(), module.indexedDbProjectAuthorityStore()]) {
    const owner = { userId: 'owner', identityKeyHash: 'a'.repeat(64) };
    await store.update('alice', 'project', current => ({ ...current, owner }));
    const read = await store.read('alice', 'project');
    (read.owner as { userId: string }).userId = 'mutated';
    expect((await store.read('alice', 'project')).owner).toEqual(owner);
    expect((await store.read('bob', 'project')).owner).toBeNull();
    await Promise.all(Array.from({ length: 12 }, () => store.update('alice', 'project', current => {
      expect(current.owner).toEqual(owner);
      return current;
    })));
  }
  expect((await module.indexedDbProjectAuthorityStore().read('alice', 'project')).owner?.userId).toBe('owner');
});

it('aborts invalid updates without replacing pins or owner intent', async () => {
  const module = await import('./projectAuthorityStore');
  for (const store of [module.memoryProjectAuthorityStore(), module.indexedDbProjectAuthorityStore()]) {
    const owner = { userId: 'owner', identityKeyHash: 'b'.repeat(64) };
    await store.update('alice', 'project', current => ({ ...current, owner }));
    await expect(store.update('alice', 'project', current => ({ ...current, owner: { userId: '', identityKeyHash: '' } }))).rejects.toThrow(/preserved/);
    expect((await store.read('alice', 'project')).owner).toEqual(owner);
  }
});

it('cleans one staged project or account without deleting other accounts', async () => {
  const module = await import('./projectAuthorityStore');
  for (const store of [module.memoryProjectAuthorityStore(), module.indexedDbProjectAuthorityStore()]) {
    const owner = { userId: 'owner', identityKeyHash: 'c'.repeat(64) };
    for (const [user, project] of [['alice', 'a'], ['alice', 'b'], ['bob', 'a']])
      await store.update(user!, project!, current => ({ ...current, owner }));
    await store.forgetProject('alice', 'a');
    expect((await store.read('alice', 'a')).owner).toBeNull();
    expect((await store.read('alice', 'b')).owner).toEqual(owner);
    await store.deleteAccount('alice');
    expect((await store.read('alice', 'b')).owner).toBeNull();
    expect((await store.read('bob', 'a')).owner).toEqual(owner);
  }
});

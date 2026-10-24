// @vitest-environment node
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MlsSessionStore, MlsSessionWrite } from './sessionStore';

const write = (byte: number, pending = false): MlsSessionWrite => ({
  userId: 'user_a',
  projectId: 'prj_1',
  deviceId: 'dev_1',
  sealed: new Uint8Array([byte, byte]),
  leaf: {
    signatureKey: new Uint8Array([4, byte]),
    certification: new Uint8Array([1, byte])
  },
  pendingCommit: pending
    ? { commit: new Uint8Array([9, byte]), welcome: null }
    : null
});

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

const backends: [string, () => Promise<MlsSessionStore>][] = [
  [
    'memory',
    async () => (await import('./sessionStore')).memoryMlsSessionStore()
  ],
  [
    'IndexedDB',
    async () => (await import('./sessionStore')).indexedDbMlsSessionStore()
  ]
];

describe.each(backends)('MLS session store (%s)', (_, open) => {
  it('writes with compare-and-swap on the revision', async () => {
    const store = await open();
    expect(await store.loadSession('user_a', 'prj_1')).toBeNull();
    const first = await store.writeSessionIfCurrent(0, write(1));
    expect(first?.revision).toBe(1);
    // A second context that also saw no session loses.
    expect(await store.writeSessionIfCurrent(0, write(2))).toBeNull();
    const second = await store.writeSessionIfCurrent(1, write(3, true));
    expect(second?.revision).toBe(2);
    // A stale writer still holding revision 1 is refused.
    expect(await store.writeSessionIfCurrent(1, write(4))).toBeNull();
    const stored = await store.loadSession('user_a', 'prj_1');
    expect(stored).toMatchObject({ revision: 2, deviceId: 'dev_1' });
    expect([...stored!.sealed]).toEqual([3, 3]);
    expect([...stored!.pendingCommit!.commit]).toEqual([9, 3]);
    expect(await store.loadSession('user_a', 'prj_2')).toBeNull();
    expect(await store.loadSession('user_b', 'prj_1')).toBeNull();
  });

  it('snapshots the bytes it is given and returns', async () => {
    const store = await open();
    const next = write(5);
    await store.writeSessionIfCurrent(0, next);
    next.sealed.fill(0);
    const loaded = await store.loadSession('user_a', 'prj_1');
    loaded!.sealed.fill(0);
    expect([...(await store.loadSession('user_a', 'prj_1'))!.sealed]).toEqual([
      5, 5
    ]);
  });

  it('keeps the first state key when two contexts create one', async () => {
    const store = await open();
    const generate = () =>
      crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt'
      ]);
    expect(await store.loadStateKey('user_a')).toBeNull();
    const first = await store.getOrCreateStateKey('user_a', await generate());
    const second = await store.getOrCreateStateKey('user_a', await generate());
    const loaded = await store.loadStateKey('user_a');
    // Both seal and open interchangeably: the same key.
    const iv = new Uint8Array(12);
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      first,
      new Uint8Array([1, 2, 3])
    );
    for (const key of [second, loaded!]) {
      expect(key.extractable).toBe(false);
      expect([
        ...new Uint8Array(
          await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed)
        )
      ]).toEqual([1, 2, 3]);
    }
  });

  it('writes nothing once the key session has ended', async () => {
    const store = await open();
    await store.writeSessionIfCurrent(0, write(1));
    await expect(
      store.writeSessionIfCurrent(1, write(2), () => false)
    ).rejects.toThrow();
    const stored = await store.loadSession('user_a', 'prj_1');
    expect(stored?.revision).toBe(1);
    expect([...stored!.sealed]).toEqual([1, 1]);
    expect(
      (await store.writeSessionIfCurrent(1, write(3), () => true))?.revision
    ).toBe(2);
  });

  it('deletes one project’s session only at the expected revision', async () => {
    const store = await open();
    await store.writeSessionIfCurrent(0, write(1));
    await store.writeSessionIfCurrent(1, write(2));
    await store.writeSessionIfCurrent(0, { ...write(3), projectId: 'prj_2' });
    // A stale revision, or no session, deletes nothing.
    expect(await store.deleteSessionIfCurrent('user_a', 'prj_1', 1)).toBe(
      false
    );
    expect(await store.deleteSessionIfCurrent('user_a', 'prj_9', 0)).toBe(
      false
    );
    // An ended key session refuses without deleting.
    await expect(
      store.deleteSessionIfCurrent('user_a', 'prj_1', 2, () => false)
    ).rejects.toThrow();
    expect((await store.loadSession('user_a', 'prj_1'))?.revision).toBe(2);
    expect(await store.deleteSessionIfCurrent('user_a', 'prj_1', 2)).toBe(true);
    expect(await store.loadSession('user_a', 'prj_1')).toBeNull();
    // Only that project: the account's other sessions stay.
    expect(await store.loadSession('user_a', 'prj_2')).not.toBeNull();
    // A new session for the project starts again from revision 1.
    expect((await store.writeSessionIfCurrent(0, write(4)))?.revision).toBe(1);
  });

  it('forgets one account’s state key and sessions', async () => {
    const store = await open();
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    await store.getOrCreateStateKey('user_a', key);
    await store.getOrCreateStateKey('user_b', key);
    await store.writeSessionIfCurrent(0, write(1));
    await store.writeSessionIfCurrent(0, { ...write(2), projectId: 'prj_2' });
    await store.writeSessionIfCurrent(0, { ...write(3), userId: 'user_b' });
    await store.deleteAccount('user_a');
    expect(await store.loadStateKey('user_a')).toBeNull();
    expect(await store.loadSession('user_a', 'prj_1')).toBeNull();
    expect(await store.loadSession('user_a', 'prj_2')).toBeNull();
    // Another account on this device keeps its state.
    expect(await store.loadStateKey('user_b')).not.toBeNull();
    expect(await store.loadSession('user_b', 'prj_1')).not.toBeNull();
  });
});

describe('project locks', () => {
  it('serialize one project in the memory store', async () => {
    const { memoryMlsSessionStore } = await import('./sessionStore');
    const store = memoryMlsSessionStore();
    const order: string[] = [];
    let release!: () => void;
    const held = store.withProjectLock('user_a', 'prj_1', async () => {
      order.push('first start');
      await new Promise<void>((resolve) => (release = resolve));
      order.push('first end');
    });
    const waiting = store.withProjectLock('user_a', 'prj_1', async () => {
      order.push('second');
    });
    const other = store.withProjectLock('user_a', 'prj_2', async () => {
      order.push('other project');
    });
    await other;
    release();
    await Promise.all([held, waiting]);
    expect(order).toEqual([
      'first start',
      'other project',
      'first end',
      'second'
    ]);
  });

  it('refuse to run without Web Locks in IndexedDB', async () => {
    vi.stubGlobal('navigator', {});
    const { indexedDbMlsSessionStore } = await import('./sessionStore');
    await expect(
      indexedDbMlsSessionStore().withProjectLock(
        'user_a',
        'prj_1',
        async () => 1
      )
    ).rejects.toThrow('cannot safely coordinate');
  });

  it('name one Web Lock per account and project', async () => {
    const names: string[] = [];
    vi.stubGlobal('navigator', {
      locks: {
        request: (name: string, _options: unknown, run: () => unknown) => {
          names.push(name);
          return Promise.resolve(run());
        }
      }
    });
    const { indexedDbMlsSessionStore } = await import('./sessionStore');
    const store = indexedDbMlsSessionStore();
    expect(await store.withProjectLock('user_a', 'prj_1', async () => 7)).toBe(
      7
    );
    await store.withProjectLock('user_a:prj', '1', async () => undefined);
    expect(names).toEqual([
      'openzcad-e2ee-mls:["user_a","prj_1"]',
      'openzcad-e2ee-mls:["user_a:prj","1"]'
    ]);
  });
});

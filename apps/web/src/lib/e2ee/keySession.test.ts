import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateEncryptionKeyPair } from '@openzcad/crypto';
import { createKeySessionSignals } from './keySession';

afterEach(() => vi.restoreAllMocks());

describe('cross-tab key-session teardown', () => {
  it('zeroes independent realm caches and fences both in-flight reads', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      window,
      'BroadcastChannel'
    );
    class Channel {
      static open = new Set<Channel>();
      static sent: unknown[] = [];
      listeners = new Set<(event: { data: unknown }) => void>();
      constructor(readonly name: string) {
        Channel.open.add(this);
      }
      addEventListener(
        _type: string,
        listener: (event: { data: unknown }) => void
      ) {
        this.listeners.add(listener);
      }
      postMessage(data: unknown) {
        Channel.sent.push(data);
        for (const other of Channel.open)
          if (other !== this && other.name === this.name)
            queueMicrotask(() => {
              for (const listener of other.listeners)
                listener({ data: structuredClone(data) });
            });
      }
    }
    Object.defineProperty(window, 'BroadcastChannel', {
      configurable: true,
      value: Channel
    });
    try {
      vi.resetModules();
      const left = await import('./unlockedKeys');
      const leftSession = await import('./keySession');
      vi.resetModules();
      const right = await import('./unlockedKeys');
      const rightSession = await import('./keySession');
      const key = (await generateEncryptionKeyPair(false)).privateKey;
      const a = new Uint8Array(32).fill(3),
        b = new Uint8Array(32).fill(4);
      left.rememberUnlockedAccount('same_account', {
        generation: 1,
        commitment: 'test',
        accountKey: a,
        encryptionPrivateKey: key
      });
      right.rememberUnlockedAccount('same_account', {
        generation: 1,
        commitment: 'test',
        accountKey: b,
        encryptionPrivateKey: key
      });
      const pendingLeft = left.captureAccountKeyRead('same_account');
      const pendingRight = right.captureAccountKeyRead('same_account');
      const teardown = leftSession.beginKeySessionTeardown();
      await Promise.resolve();
      await Promise.resolve();
      expect([...a, ...b]).toEqual(new Array(64).fill(0));
      expect(left.unlockedAccount('same_account')).toBeUndefined();
      expect(right.unlockedAccount('same_account')).toBeUndefined();
      expect(pendingLeft()).toBe(false);
      expect(pendingRight()).toBe(false);
      expect(rightSession.isKeySessionActive()).toBe(false);
      const revision = rightSession.getKeySessionRevision();
      expect(rightSession.allowKeySession(revision - 1)).toBe(false);
      expect(rightSession.allowKeySession(revision)).toBe(true);
      leftSession.finishKeySessionTeardown(teardown.operation, true);
      await Promise.resolve();
      expect(rightSession.isCurrentKeySession(revision)).toBe(false);
      for (const notice of Channel.sent)
        expect(Object.keys(notice as object).sort()).toEqual([
          'id',
          'operation',
          'phase'
        ]);
    } finally {
      Channel.open.clear();
      if (descriptor)
        Object.defineProperty(window, 'BroadcastChannel', descriptor);
      else Reflect.deleteProperty(window, 'BroadcastChannel');
    }
  });

  it('rejects stale reauthentication and ignores duplicate or reordered prepares', () => {
    let receive!: (notice: unknown) => void;
    let id = 0;
    const posted: unknown[] = [];
    const session = createKeySessionSignals({
      id: () => `operation_${++id}`,
      post: (notice) => {
        posted.push(notice);
      },
      subscribe: (listener) => {
        receive = listener;
      }
    });
    receive({ id: 'ended', operation: 'old', phase: 'ended' });
    const first = session.revision();
    receive({ id: 'prepare', operation: 'old', phase: 'prepare' });
    receive({ id: 'ended', operation: 'old', phase: 'ended' });
    expect(session.revision()).toBe(first);
    session.changed();
    expect(session.allow(first)).toBe(false);
    expect(session.active()).toBe(false);
    expect(session.allow(session.revision())).toBe(true);
    expect(posted).toHaveLength(1);
  });

  it('locks through the storage fallback when BroadcastChannel is unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      window,
      'BroadcastChannel'
    );
    Object.defineProperty(window, 'BroadcastChannel', {
      configurable: true,
      value: undefined
    });
    try {
      vi.resetModules();
      const cache = await import('./unlockedKeys');
      const accountKey = new Uint8Array(32).fill(7);
      cache.rememberUnlockedAccount('storage_account', {
        generation: 1,
        commitment: 'test',
        accountKey,
        encryptionPrivateKey: (await generateEncryptionKeyPair(false))
          .privateKey
      });
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'openzcad:e2ee-key-session:v1',
          newValue: JSON.stringify({
            id: 'stored-end',
            operation: 'storage-end',
            phase: 'ended'
          })
        })
      );
      expect(accountKey).toEqual(new Uint8Array(32));
      expect(cache.unlockedAccount('storage_account')).toBeUndefined();
    } finally {
      if (descriptor)
        Object.defineProperty(window, 'BroadcastChannel', descriptor);
      else Reflect.deleteProperty(window, 'BroadcastChannel');
    }
  });
});

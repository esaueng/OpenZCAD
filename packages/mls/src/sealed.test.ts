import { describe, expect, it } from 'vitest';
import { MlsError } from './errors';
import {
  assertStateKey,
  generateStateKey,
  openState,
  sealState
} from './sealed';

const state = new TextEncoder().encode('mls session state');

describe('sealed MLS session state', () => {
  it('round-trips under a non-extractable key and binds the project', async () => {
    const key = await generateStateKey();
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    const sealed = await sealState(key, 'p1', state);
    expect([...sealed.slice(0, 5)]).toEqual([0x4f, 0x5a, 0x4d, 0x53, 1]);
    expect(sealed.length).toBe(5 + 12 + state.length + 16);
    expect(await openState(key, 'p1', sealed)).toEqual(state);
    await expect(openState(key, 'p2', sealed)).rejects.toMatchObject({
      kind: 'state'
    });
    await expect(
      openState(await generateStateKey(), 'p1', sealed)
    ).rejects.toMatchObject({
      kind: 'state'
    });
  });

  it('uses a fresh IV each time', async () => {
    const key = await generateStateKey();
    const a = await sealState(key, 'p', state);
    const b = await sealState(key, 'p', state);
    expect(a.slice(5, 17)).not.toEqual(b.slice(5, 17));
  });

  it('refuses tampering, truncation and unknown versions', async () => {
    const key = await generateStateKey();
    const sealed = await sealState(key, 'p', state);
    for (const index of [0, 4, 6, sealed.length - 1]) {
      const bad = sealed.slice();
      bad[index]! ^= 1;
      await expect(openState(key, 'p', bad)).rejects.toBeInstanceOf(MlsError);
    }
    await expect(
      openState(key, 'p', sealed.slice(0, 20))
    ).rejects.toMatchObject({ kind: 'state' });
  });

  it('accepts only a non-extractable AES-256-GCM key that can seal', async () => {
    const extractable = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const short = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 128 },
      false,
      ['encrypt', 'decrypt']
    );
    const encryptOnly = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    );
    const hmac = await crypto.subtle.generateKey(
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    for (const key of [extractable, short, encryptOnly, hmac]) {
      expect(() => assertStateKey(key)).toThrow(MlsError);
    }
    await expect(sealState(extractable, 'p', state)).rejects.toMatchObject({
      kind: 'input'
    });
  });
});

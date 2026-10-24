import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VersionPinStore } from './versionPins';

const H = (digit: string) => digit.repeat(64);

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
});

async function stores(): Promise<[string, VersionPinStore][]> {
  const pins = await import('./versionPins');
  return [
    ['memory', pins.memoryVersionPins()],
    ['IndexedDB', pins.indexedDbVersionPins()]
  ];
}

describe('version pins', () => {
  it('swaps only from the head it was read at, never backwards', async () => {
    for (const [name, pins] of await stores()) {
      expect(await pins.read('u', 'p'), name).toBeNull();
      const one = { headHash: H('1'), documentVersion: 1, keyEpoch: 0 };
      expect(await pins.advance('u', 'p', null, one), name).toBe(true);
      // Another tab that read no pin loses.
      expect(
        await pins.advance('u', 'p', null, { ...one, headHash: H('2') }),
        name
      ).toBe(false);
      const two = { headHash: H('2'), documentVersion: 2, keyEpoch: 1 };
      expect(await pins.advance('u', 'p', H('1'), two), name).toBe(true);
      // Stale expectations, lower versions, lower epochs, siblings: refused.
      expect(await pins.advance('u', 'p', H('1'), two), name).toBe(false);
      expect(
        await pins.advance('u', 'p', H('2'), {
          headHash: H('3'),
          documentVersion: 1,
          keyEpoch: 1
        }),
        name
      ).toBe(false);
      expect(
        await pins.advance('u', 'p', H('2'), {
          headHash: H('3'),
          documentVersion: 3,
          keyEpoch: 0
        }),
        name
      ).toBe(false);
      expect(
        await pins.advance('u', 'p', H('2'), {
          headHash: H('3'),
          documentVersion: 2,
          keyEpoch: 1
        }),
        name
      ).toBe(false);
      expect(
        await pins.advance('u', 'p', H('2'), {
          headHash: 'not hex',
          documentVersion: 3,
          keyEpoch: 1
        }),
        name
      ).toBe(false);
      expect(await pins.read('u', 'p'), name).toEqual({
        ...two,
        infoSequence: 0,
        infoHash: null,
        envelopes: {}
      });
      // Pins are per account and project.
      expect(await pins.read('u', 'other'), name).toBeNull();
      expect(await pins.read('v', 'p'), name).toBeNull();
    }
  });

  it('raises the info sequence on its own, before or after a head', async () => {
    for (const [name, pins] of await stores()) {
      expect(await pins.advanceInfo('u', 'shelf', 3), name).toBe(true);
      expect(await pins.read('u', 'shelf'), name).toEqual({
        headHash: null,
        documentVersion: 0,
        keyEpoch: 0,
        infoSequence: 3,
        infoHash: null,
        envelopes: {}
      });
      expect(await pins.advanceInfo('u', 'shelf', 2), name).toBe(false);
      // A head pinned later keeps the info sequence.
      expect(
        await pins.advance('u', 'shelf', null, {
          headHash: H('a'),
          documentVersion: 5,
          keyEpoch: 2
        }),
        name
      ).toBe(true);
      expect((await pins.read('u', 'shelf'))?.infoSequence, name).toBe(3);
      expect(await pins.advanceInfo('u', 'shelf', 4), name).toBe(true);
      expect(await pins.read('u', 'shelf'), name).toMatchObject({
        headHash: H('a'),
        infoSequence: 4
      });
    }
  });

  it('refuses a project info or envelope at its pinned sequence with another hash', async () => {
    for (const [name, pins] of await stores()) {
      expect(await pins.advanceInfo('u', 'p', 2, H('a')), name).toBe(true);
      // The same info again is fine; another one at the same sequence is a fork.
      expect(await pins.advanceInfo('u', 'p', 2, H('a')), name).toBe(true);
      expect(await pins.advanceInfo('u', 'p', 2, H('b')), name).toBe(false);
      expect(await pins.advanceInfo('u', 'p', 1, H('c')), name).toBe(false);
      expect(await pins.advanceInfo('u', 'p', 3, H('c')), name).toBe(true);
      expect(await pins.read('u', 'p'), name).toMatchObject({
        infoSequence: 3,
        infoHash: H('c')
      });
      const one = { sequence: 4, hash: H('d') };
      expect(
        await pins.advanceEnvelope('u', 'p', 'measurements', one),
        name
      ).toBe(true);
      expect(
        await pins.advanceEnvelope('u', 'p', 'measurements', {
          ...one,
          hash: H('e')
        }),
        name
      ).toBe(false);
      expect(
        await pins.advanceEnvelope('u', 'p', 'measurements', {
          sequence: 3,
          hash: H('e')
        }),
        name
      ).toBe(false);
      // Each key has its own pin.
      expect(
        await pins.advanceEnvelope('u', 'p', 'view-state:s', {
          sequence: 1,
          hash: H('f')
        }),
        name
      ).toBe(true);
      expect((await pins.read('u', 'p'))?.envelopes, name).toEqual({
        measurements: one,
        'view-state:s': { sequence: 1, hash: H('f') }
      });
      // A head pinned later keeps them.
      expect(
        await pins.advance('u', 'p', null, {
          headHash: H('1'),
          documentVersion: 1,
          keyEpoch: 0
        }),
        name
      ).toBe(true);
      expect(await pins.read('u', 'p'), name).toMatchObject({
        infoHash: H('c'),
        envelopes: { measurements: one }
      });
    }
  });

  it('reads a pin written before project-info hashes as having none', async () => {
    const pins = await import('./versionPins');
    const store = pins.indexedDbVersionPins();
    await store.advanceInfo('u', 'old', 1);
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(pins.VERSION_PIN_DATABASE, 1);
      open.onsuccess = () => {
        const tx = open.result.transaction('pins', 'readwrite');
        tx.objectStore('pins').put(
          { headHash: null, documentVersion: 0, keyEpoch: 0, infoSequence: 5 },
          ['u', 'old']
        );
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error ?? new Error('put failed'));
      };
      open.onerror = () => reject(open.error ?? new Error('open failed'));
    });
    expect(await store.read('u', 'old')).toEqual({
      headHash: null,
      documentVersion: 0,
      keyEpoch: 0,
      infoSequence: 5,
      infoHash: null,
      envelopes: {}
    });
    expect(await store.advanceInfo('u', 'old', 5, H('a'))).toBe(true);
  });

  it('lets one of two racing tabs win in IndexedDB', async () => {
    const pins = await import('./versionPins');
    const a = pins.indexedDbVersionPins();
    const b = pins.indexedDbVersionPins();
    const results = await Promise.all([
      a.advance('u', 'race', null, {
        headHash: H('1'),
        documentVersion: 1,
        keyEpoch: 0
      }),
      b.advance('u', 'race', null, {
        headHash: H('2'),
        documentVersion: 1,
        keyEpoch: 0
      })
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

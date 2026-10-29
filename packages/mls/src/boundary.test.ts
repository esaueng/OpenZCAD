import { describe, expect, it } from 'vitest';
import { loadWasm, wasmMemoryForTests } from './test-support';

describe('raw MLS WASM boundaries', () => {
  it('refuses oversized record arrays before the glue allocates or reads entries', () => {
    const wasm = loadWasm();
    const session = wasm.MlsSession.generate('project', 'owner', 'device');
    const empty = new Uint8Array();
    const records = Array<Uint8Array>(2_000_000).fill(empty);
    const memory = wasmMemoryForTests();
    const before = memory.buffer.byteLength;
    try {
      const calls = [
        () => session.join(empty, empty, records),
        () => session.rejoin(empty, 0n, empty, undefined, empty, records),
        () => session.completeRejoin(empty, records)
      ];
      for (const call of calls) {
        expect(call).toThrow(/record budget/);
        expect(memory.buffer.byteLength - before).toBeLessThan(1024 * 1024);
      }
      // No provisional Welcome exists here; rollback keeps its state error.
      expect(() => session.completeJoin(empty, records)).toThrow(
        /no Welcome join is pending/
      );
      expect(memory.buffer.byteLength - before).toBeLessThan(1024 * 1024);
      // A sparse oversized array must be refused without visiting an entry.
      const sparse = Array<Uint8Array>(2_000_000);
      Object.defineProperty(sparse, 0, {
        get() {
          throw new Error('record getter must not run');
        }
      });
      expect(() => session.join(empty, empty, sparse)).toThrow(/record budget/);
      expect(() => session.join(empty, empty, [null])).toThrow(
        /record must be a Uint8Array/
      );
    } finally {
      session.free();
    }
  });

  it('bounds join and rejoin inputs below the TypeScript and Worker wrappers', () => {
    const wasm = loadWasm();
    const session = wasm.MlsSession.generate('project', 'owner', 'device');
    const empty = new Uint8Array();
    const records = Array.from({ length: 8193 }, () => empty);
    try {
      expect(() => session.join(empty, empty, records)).toThrow(
        /record budget/
      );
      expect(() =>
        session.rejoin(empty, 0n, empty, undefined, empty, records)
      ).toThrow(/record budget/);
      expect(() => session.completeRejoin(empty, records)).toThrow(
        /record budget/
      );
      const memory = wasmMemoryForTests();
      const before = memory.buffer.byteLength;
      expect(() =>
        session.join(empty, new Uint8Array(64 * 1024 * 1024 + 1), [])
      ).toThrow(/byte budget/);
      expect(memory.buffer.byteLength - before).toBeLessThan(1024 * 1024);
      expect(() =>
        session.rejoin(
          empty,
          0n,
          empty,
          undefined,
          new Uint8Array(64 * 1024 * 1024 + 1),
          []
        )
      ).toThrow(/byte budget/);
      expect(memory.buffer.byteLength - before).toBeLessThan(1024 * 1024);
      const status: unknown = JSON.parse(session.status());
      expect(status).toMatchObject({ inGroup: false });
    } finally {
      session.free();
    }
  });
  it('covers the full supported key archive while retaining authority proof budgets', () => {
    const wasm = loadWasm();
    const check = (count: number, anchor = new Uint8Array()) =>
      wasm.verifyEpochAuthority(
        'project',
        anchor,
        JSON.stringify(Array.from({ length: count }, () => '')),
        new Uint8Array(),
        'owner',
        '{"users":[]}',
        new Uint8Array()
      );
    expect(() => check(8193)).toThrow(/record budget/);
    let refused: unknown;
    try {
      check(8192);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeDefined(); // Invalid empty MLS target, rather than a valid history.
    expect(String(refused)).not.toContain('record budget');
    expect(() => check(0, new Uint8Array(64 * 1024 * 1024 + 1))).toThrow(
      /byte budget/
    );
  });
  it.each([undefined, null])(
    'rejects a revoked device with cutoff %s below the TypeScript wrapper',
    (cutoff) => {
      const wasm = loadWasm();
      const session = wasm.MlsSession.generate('project', 'owner', 'device');
      try {
        expect(() =>
          session.setDirectory(
            JSON.stringify({
              users: [
                {
                  userId: 'owner',
                  devices: [
                    {
                      deviceId: 'revoked',
                      status: 'revoked',
                      revocationCutoffEpoch: cutoff
                    }
                  ]
                }
              ]
            })
          )
        ).toThrow(/no revocationCutoffEpoch/);
        expect(() =>
          session.setDirectory(
            JSON.stringify({
              users: [
                {
                  userId: 'owner',
                  devices: [
                    {
                      deviceId: 'revoked',
                      status: 'revoked',
                      revocationCutoffEpoch: 0
                    }
                  ]
                }
              ]
            })
          )
        ).not.toThrow();
      } finally {
        session.free();
      }
    }
  );

  it('rejects version-one sealed-state contents instead of restoring unverified removal history', () => {
    const wasm = loadWasm();
    const session = wasm.MlsSession.generate('project', 'owner', 'device');
    try {
      const state = session.export();
      expect(state[0]).toBe(2);
      state[0] = 1;
      expect(() => wasm.MlsSession.import(state, 'project')).toThrow(
        /session state version 1 is not 2/
      );
    } finally {
      session.free();
    }
  });
});

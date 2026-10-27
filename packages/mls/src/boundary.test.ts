import { describe, expect, it } from 'vitest';
import { loadWasm } from './test-support';

describe('raw MLS WASM boundaries', () => {
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

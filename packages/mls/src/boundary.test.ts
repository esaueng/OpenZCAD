import { describe, expect, it } from 'vitest';
import { loadWasm } from './test-support';

describe('raw MLS WASM boundaries', () => {
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

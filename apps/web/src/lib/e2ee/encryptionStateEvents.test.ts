import { describe, expect, it } from 'vitest';
import type { AccountView, EncryptionState } from './accountKeys';
import {
  encryptionStateKey,
  observeEncryptionState
} from './encryptionStateEvents';
import { announceKeySessionChange } from './keySession';

function ready(
  change: Partial<AccountView> & { sequence?: number; entry?: number } = {}
): EncryptionState {
  const { sequence = 3, entry = 7, ...account } = change;
  return {
    kind: 'ready',
    account: {
      userId: 'user_alice',
      generation: 1,
      fingerprint: '1234',
      list: {
        pin: {
          identityKeyHash: new Uint8Array([1, 2]),
          sequence,
          entryHash: new Uint8Array([entry])
        }
      },
      device: { deviceId: 'device_a' },
      deviceStatus: 'certified',
      unlocked: true,
      ...account
    } as unknown as AccountView
  };
}

describe('encryption state observations', () => {
  it('keys a state by identity, device-list head, device standing and lock', () => {
    const base = encryptionStateKey(ready());
    expect(encryptionStateKey(ready())).toBe(base);
    // Informational fields do not count.
    expect(
      encryptionStateKey(ready({ approvedDevices: [{}] as never, wraps: [] }))
    ).toBe(base);
    for (const changed of [
      ready({ unlocked: false }),
      ready({ sequence: 4 }),
      ready({ entry: 8 }),
      ready({ fingerprint: '5678' }),
      ready({ generation: 2 }),
      ready({ deviceStatus: 'removed' }),
      ready({ device: null })
    ])
      expect(encryptionStateKey(changed)).not.toBe(base);
    expect(
      encryptionStateKey({
        kind: 'identity-changed',
        account: (ready() as Extract<EncryptionState, { kind: 'ready' }>)
          .account
      })
    ).not.toBe(base);
    expect(encryptionStateKey({ kind: 'not-set-up', previous: [] })).toBe(
      'not-set-up'
    );
  });

  // Regression: every Settings › Encryption load and Refresh announced a
  // change, which retired the page's encrypted-project clients and made
  // the shelf's next listing re-read every project's authority.
  it('reports a change only when the state differs from the last one observed', () => {
    const userId = 'user_observed';
    expect(observeEncryptionState(userId, ready())).toBe(true);
    expect(observeEncryptionState(userId, ready())).toBe(false);
    expect(observeEncryptionState(userId, ready({ sequence: 4 }))).toBe(true);
    expect(observeEncryptionState(userId, ready({ sequence: 4 }))).toBe(false);
    expect(observeEncryptionState('user_other', ready())).toBe(true);
  });

  it('starts again in a new key session', () => {
    const userId = 'user_session';
    observeEncryptionState(userId, ready());
    announceKeySessionChange();
    expect(observeEncryptionState(userId, ready())).toBe(true);
  });
});

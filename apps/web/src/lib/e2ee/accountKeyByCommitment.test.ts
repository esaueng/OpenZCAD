import { describe, expect, it, vi } from 'vitest';
import { accountKeyCommitment } from '@openzcad/crypto';
import { accountKeyByCommitment } from './sealedSettings';

/**
 * PR 1921 review: a recovery-key replacement starts a new identity
 * generation and keeps the old account key only in the account-key
 * history, so a record sealed before it must be found across generations.
 */
const keyOf = (generation: number, keySequence: number) =>
  Uint8Array.from({ length: 32 }, (_, i) => generation * 16 + keySequence + i);

const mocks = vi.hoisted(() => ({
  state: null as unknown,
  history: [] as { generation: number; keySequence: number }[],
  opened: [] as string[]
}));

vi.mock('./accountKeys', () => ({
  loadEncryption: vi.fn(async () => mocks.state),
  openAccountKeyChain: vi.fn(
    async (
      _ctx: unknown,
      _account: unknown,
      keySequence: number,
      generation = 2
    ) => {
      mocks.opened.push(`${generation}:${keySequence}`);
      return keyOf(generation, keySequence);
    }
  )
}));
vi.mock('./e2eeApi', () => ({
  createE2eeApi: () => ({
    accountKeyHistory: async () => ({ history: mocks.history })
  })
}));
vi.mock('./keychainDeviceKeys', () => ({ deviceKeyStore: () => ({}) }));
vi.mock('./keySession', () => ({ getKeySessionRevision: () => 1 }));

async function readyAccount() {
  // The current identity, generation 2, has one account key.
  mocks.state = {
    kind: 'ready',
    account: {
      unlocked: true,
      generation: 2,
      list: {
        entries: [
          {
            entry: {
              sequence: 0,
              accountKeyCommitment: await accountKeyCommitment(keyOf(2, 0))
            }
          }
        ]
      }
    }
  };
  mocks.history = [
    { generation: 1, keySequence: 0 },
    { generation: 1, keySequence: 3 }
  ];
  mocks.opened = [];
}

describe('accountKeyByCommitment', () => {
  it('finds a key of the current identity through its device list', async () => {
    await readyAccount();
    const key = await accountKeyByCommitment(
      'user_a',
      await accountKeyCommitment(keyOf(2, 0))
    );
    expect(key).toEqual(keyOf(2, 0));
    expect(mocks.opened).toEqual(['2:0']);
  });

  it('finds a key a recovery-key replacement retired, through the history', async () => {
    await readyAccount();
    const key = await accountKeyByCommitment(
      'user_a',
      await accountKeyCommitment(keyOf(1, 0))
    );
    expect(key).toEqual(keyOf(1, 0));
    // Newest first; the one that did not match was opened and dropped.
    expect(mocks.opened).toEqual(['1:3', '1:0']);
  });

  it('answers null for a key this account does not have', async () => {
    await readyAccount();
    expect(
      await accountKeyByCommitment('user_a', new Uint8Array(32).fill(9))
    ).toBeNull();
  });

  it('throws, rather than answer null, while the keys are locked', async () => {
    await readyAccount();
    mocks.state = { kind: 'ready', account: { unlocked: false } };
    await expect(
      accountKeyByCommitment('user_a', new Uint8Array(32))
    ).rejects.toThrow(/Unlock/);
  });
});

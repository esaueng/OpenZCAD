import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateEncryptionKeyPair } from '@openzcad/crypto';

afterEach(() => vi.resetModules());

describe('account read lifetimes', () => {
  it('closing a settings view cancels only its reads and passkey prompts', async () => {
    const keys = await import('./unlockedKeys');
    const first = {},
      second = {};
    const background = keys.captureAccountKeyRead('account');
    const view = keys.captureAccountKeyRead('account', first);
    const other = keys.captureAccountKeyRead('account', second);
    const prompt = keys.keyOperationGuard('account', first);
    keys.invalidateAccountKeyReads('account', first);
    expect(view()).toBe(false);
    expect(prompt).toThrow(/session ended/);
    expect(background()).toBe(true);
    expect(other()).toBe(true);
    expect(keys.captureAccountKeyRead('account', first)()).toBe(true);
    expect(view()).toBe(false);
    keys.lockAccount('account');
    expect(background()).toBe(false);
    expect(other()).toBe(false);
  });

  it('account and cross-tab teardown cancel every scope and zero cached secrets', async () => {
    const keys = await import('./unlockedKeys');
    const session = await import('./keySession');
    const secret = new Uint8Array(32).fill(7);
    keys.rememberUnlockedAccount('account', {
      generation: 1,
      commitment: 'test',
      accountKey: secret,
      encryptionPrivateKey: (await generateEncryptionKeyPair(false)).privateKey
    });
    const checks = [undefined, {}, {}].map((scope) =>
      keys.captureAccountKeyRead('account', scope)
    );
    const other = keys.captureAccountKeyRead('other', {});
    keys.lockAccountsExcept('account');
    expect(other()).toBe(false);
    expect(checks.every((check) => check())).toBe(true);
    session.beginKeySessionTeardown();
    expect(checks.every((check) => !check())).toBe(true);
    expect(secret).toEqual(new Uint8Array(32));
  });
});

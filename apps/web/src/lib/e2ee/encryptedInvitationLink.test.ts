import { describe, expect, it, vi } from 'vitest';
import {
  ENCRYPTED_INVITATION_SESSION_KEY,
  captureEncryptedInvitationLink,
  clearPendingEncryptedInvitation,
  encryptedInvitationTokenFromHash,
  pendingEncryptedInvitation,
  subscribePendingEncryptedInvitation
} from './encryptedInvitationLink';

const TOKEN = 'a'.repeat(43);

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key)
  };
}

describe('the #encrypted-invite= link (slice 5-3b)', () => {
  it('reads exactly one well-formed token', () => {
    expect(encryptedInvitationTokenFromHash(`#encrypted-invite=${TOKEN}`)).toBe(
      TOKEN
    );
    for (const hash of [
      `#invite=${TOKEN}`,
      '#encrypted-invite=short',
      `#encrypted-invite=${TOKEN}&encrypted-invite=${TOKEN}`,
      `#encrypted-invite=${TOKEN}&share=x`,
      `#encrypted-invite=${TOKEN}!`
    ]) {
      expect(encryptedInvitationTokenFromHash(hash)).toBeNull();
    }
  });

  it('scrubs the fragment, keeps the token for this tab and tells listeners', () => {
    const store = storage();
    const history = { state: { kept: true }, replaceState: vi.fn() };
    const heard = vi.fn();
    const unsubscribe = subscribePendingEncryptedInvitation(heard);
    expect(
      captureEncryptedInvitationLink(
        { hash: `#encrypted-invite=${TOKEN}`, pathname: '/', search: '' },
        history,
        store
      )
    ).toBe(TOKEN);
    expect(history.replaceState).toHaveBeenCalledWith({ kept: true }, '', '/');
    expect(store.values.get(ENCRYPTED_INVITATION_SESSION_KEY)).toBe(TOKEN);
    expect(pendingEncryptedInvitation(store)).toBe(TOKEN);
    expect(heard).toHaveBeenCalledTimes(1);
    clearPendingEncryptedInvitation(store);
    expect(pendingEncryptedInvitation(store)).toBeNull();
    expect(heard).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('scrubs a malformed link without keeping anything, and ignores others', () => {
    const store = storage();
    const history = { state: null, replaceState: vi.fn() };
    expect(
      captureEncryptedInvitationLink(
        { hash: '#encrypted-invite=bad', pathname: '/p', search: '?q=1' },
        history,
        store
      )
    ).toBeNull();
    expect(history.replaceState).toHaveBeenCalledTimes(1);
    expect(store.values.size).toBe(0);
    expect(
      captureEncryptedInvitationLink(
        { hash: `#invite=${TOKEN}`, pathname: '/', search: '' },
        history,
        store
      )
    ).toBeNull();
    expect(history.replaceState).toHaveBeenCalledTimes(1);
  });
});

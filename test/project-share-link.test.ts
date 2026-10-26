import { describe, expect, it } from 'vitest';
import {
  PROJECT_SHARE_HASH_PREFIX,
  isEncryptedShareLink,
  shareLinkFromHash,
  shareTokenFromHash
} from '../apps/web/src/lib/projectShareLink';

const token = 'a'.repeat(43);
describe('share link fragments', () => {
  it('reads the token out of a #share= fragment', () => {
    expect(shareTokenFromHash(`#share=${token}`)).toBe(token);
    expect(shareTokenFromHash(`share=${token}`)).toBe(token);
  });

  it('trims whitespace a mail client or chat wrapped around the token', () => {
    expect(shareTokenFromHash(`#share= ${token} `)).toBe(token);
  });

  it('rejects everything that is not a share fragment', () => {
    // The invite fragment in particular: both travel in the hash, and reading
    // one as the other would feed an invitation token to the share endpoint.
    expect(shareTokenFromHash('#invite=abc123')).toBeNull();
    expect(shareTokenFromHash('')).toBeNull();
    expect(shareTokenFromHash('#')).toBeNull();
    expect(shareTokenFromHash(`#${PROJECT_SHARE_HASH_PREFIX}`)).toBeNull();
    expect(shareTokenFromHash('#share=   ')).toBeNull();
  });

  it('opens a plaintext token unchanged and an encrypted link whole (ADR-024 slice 5-11)', () => {
    const encrypted = `${'t'.repeat(43)}.${'k'.repeat(43)}.${'o'.repeat(43)}`;
    expect(shareLinkFromHash(`#share=${token}`)).toBe(token);
    expect(isEncryptedShareLink(token)).toBe(false);
    expect(shareLinkFromHash(`#share=${encrypted}`)).toBe(encrypted);
    expect(isEncryptedShareLink(encrypted)).toBe(true);
    // The plaintext reader never takes an encrypted link for a token.
    expect(shareTokenFromHash(`#share=${encrypted}`)).toBeNull();
    expect(shareLinkFromHash(`#share=${encrypted}.x`)).toBeNull();
    expect(shareLinkFromHash(`#invite=${encrypted}`)).toBeNull();
  });
});

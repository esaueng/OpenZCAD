import { describe, expect, it } from 'vitest';
import {
  PROJECT_SHARE_HASH_PREFIX,
  isEncryptedShareLink,
  shareRequestFromHash,
  shareConfigurationFromHash,
  shareLinkFromHash,
  shareTokenFromHash,
  withShareConfiguration
} from '../apps/web/src/lib/projectShareLink';

const token = 'a'.repeat(43);
describe('share link fragments', () => {
  it('recognizes the share destination independently of token validity', () => {
    for (const payload of ['', '   ', 'truncated', 'a.b', token]) {
      expect(shareRequestFromHash(`#share=${payload}`)).toBe(payload.trim());
    }
    expect(shareRequestFromHash('#invite=truncated')).toBeNull();
    expect(shareRequestFromHash('')).toBeNull();
    expect(shareRequestFromHash('#sharing=truncated')).toBeNull();
  });
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

  it('reads the configuration a link opens on without disturbing its capability (F06)', () => {
    const encrypted = `${'t'.repeat(43)}.${'k'.repeat(43)}.${'o'.repeat(43)}`;
    const hash = `#share=${token}&configuration=large`;
    expect(shareTokenFromHash(hash)).toBe(token);
    expect(shareLinkFromHash(hash)).toBe(token);
    expect(shareRequestFromHash(hash)).toBe(token);
    expect(shareConfigurationFromHash(hash)).toBe('large');
    expect(shareLinkFromHash(`#share=${encrypted}&configuration=large`)).toBe(
      encrypted
    );
    // Ids are percent-decoded; no row, an empty one or an absurd one is none.
    expect(
      shareConfigurationFromHash(`#share=${token}&configuration=a%20b`)
    ).toBe('a b');
    expect(shareConfigurationFromHash(`#share=${token}`)).toBeNull();
    expect(
      shareConfigurationFromHash(`#share=${token}&configuration=`)
    ).toBeNull();
    expect(
      shareConfigurationFromHash(
        `#share=${token}&configuration=${'x'.repeat(129)}`
      )
    ).toBeNull();
    // Only a share fragment carries one.
    expect(
      shareConfigurationFromHash('#invite=abc&configuration=large')
    ).toBeNull();
    // A malformed capability is still reported as one, for the share page.
    expect(shareTokenFromHash('#share=short&configuration=large')).toBeNull();
    expect(shareRequestFromHash('#share=short&configuration=large')).toBe(
      'short'
    );
  });

  it('writes and replaces the configuration on a created link (F06)', () => {
    const url = `https://example.test/p#share=${token}`;
    const large = withShareConfiguration(url, 'large');
    expect(large).toBe(`${url}&configuration=large`);
    expect(withShareConfiguration(large, 'small')).toBe(
      `${url}&configuration=small`
    );
    expect(withShareConfiguration(large, null)).toBe(url);
    const odd = withShareConfiguration(url, 'a b&c');
    expect(shareConfigurationFromHash(odd.slice(odd.indexOf('#')))).toBe(
      'a b&c'
    );
    expect(shareTokenFromHash(odd.slice(odd.indexOf('#')))).toBe(token);
    // Not a share link: left alone.
    expect(withShareConfiguration('https://example.test/p', 'large')).toBe(
      'https://example.test/p'
    );
  });
});

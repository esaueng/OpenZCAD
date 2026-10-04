import { describe, expect, it } from 'vitest';
import {
  PROJECT_SHARE_HASH_PREFIX,
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
});

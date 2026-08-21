import { describe, expect, it } from 'vitest';
import {
  PROJECT_SHARE_HASH_PREFIX,
  shareTokenFromHash
} from '../apps/web/src/lib/projectShareLink';

describe('share link fragments', () => {
  it('reads the token out of a #share= fragment', () => {
    expect(shareTokenFromHash('#share=abc123')).toBe('abc123');
    expect(shareTokenFromHash('share=abc123')).toBe('abc123');
  });

  it('trims whitespace a mail client or chat wrapped around the token', () => {
    expect(shareTokenFromHash('#share= abc123 ')).toBe('abc123');
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

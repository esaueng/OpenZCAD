import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256HexSync } from './sha256-sync';

const reference = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

describe('sha256HexSync', () => {
  it('matches the published vectors', () => {
    expect(sha256HexSync('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(sha256HexSync('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('matches node across block boundaries and multi-byte text', () => {
    for (const length of [1, 54, 55, 56, 63, 64, 65, 119, 120, 1_000]) {
      const text = 'a'.repeat(length);
      expect(sha256HexSync(text)).toBe(reference(text));
    }
    for (const text of ['é', '€|/?', '🔒 encrypted', 'x'.repeat(57) + 'é']) {
      expect(sha256HexSync(text)).toBe(reference(text));
    }
  });
});

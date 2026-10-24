import { describe, expect, it } from 'vitest';
import {
  PROJECT_PREFERENCES_MAC_INFO,
  decodeProjectPreferences,
  encodeProjectPreferences,
  macProjectPreferences,
  openProjectPreferences
} from './account-records';
import { fromHex, toHex } from './bytes';
import { isE2eeError } from './errors';
import { patternBytes } from './test-support';

const ACCOUNT_KEY = patternBytes(32);
const RECORD =
  '{"v":1,"kind":"project-preferences","userId":"user_alice","encryptNewProjects":true,"sequence":3}';
/**
 * Fixed vector: HKDF-SHA-256(account key 00..1f, empty salt, info
 * "OpenZCAD E2EE v1 project preferences mac") as an HMAC-SHA-256 key over the
 * record bytes above. A change here is a storage-format change.
 */
const MAC_KEY_HEX =
  '12aaa4bdb7a67ff010e84ce60a3e34192520b1b7584f7b0808d6676849e8bb77';
const MAC_HEX =
  'bee9583c9e2c54857dd100b4e16fe854dafb29ebd6d48782b5ba03dc9f4548ff';

const utf8 = (text: string) => new TextEncoder().encode(text);

describe('project preference records (ADR-024 D2)', () => {
  it('encodes canonically and matches the fixed vector', async () => {
    const encoded = encodeProjectPreferences({
      userId: 'user_alice',
      encryptNewProjects: true,
      sequence: 3
    });
    expect(new TextDecoder().decode(encoded)).toBe(RECORD);
    expect(toHex(await macProjectPreferences(ACCOUNT_KEY, encoded))).toBe(
      MAC_HEX
    );
  });

  it('re-derives the MAC with raw WebCrypto', async () => {
    expect(PROJECT_PREFERENCES_MAC_INFO).toBe(
      'OpenZCAD E2EE v1 project preferences mac'
    );
    const base = await crypto.subtle.importKey(
      'raw',
      ACCOUNT_KEY,
      'HKDF',
      false,
      ['deriveBits']
    );
    const bits = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new Uint8Array(),
          info: utf8(PROJECT_PREFERENCES_MAC_INFO)
        },
        base,
        256
      )
    );
    expect(toHex(bits)).toBe(MAC_KEY_HEX);
    const key = await crypto.subtle.importKey(
      'raw',
      bits,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    expect(
      toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(RECORD))))
    ).toBe(MAC_HEX);
  });

  it('opens a record whose MAC verifies', async () => {
    await expect(
      openProjectPreferences(ACCOUNT_KEY, utf8(RECORD), fromHex(MAC_HEX))
    ).resolves.toEqual({
      userId: 'user_alice',
      encryptNewProjects: true,
      sequence: 3
    });
  });

  it('refuses a wrong key, altered bytes or a bad MAC', async () => {
    const refused = async (promise: Promise<unknown>, code: string) =>
      expect(
        await promise.then(
          () => null,
          (error: unknown) => error
        )
      ).toSatisfy((error: unknown) => isE2eeError(error, code as never));
    await refused(
      openProjectPreferences(
        patternBytes(32, 1),
        utf8(RECORD),
        fromHex(MAC_HEX)
      ),
      'authentication-failed'
    );
    await refused(
      openProjectPreferences(
        ACCOUNT_KEY,
        utf8(RECORD.replace('true', 'false')),
        fromHex(MAC_HEX)
      ),
      'authentication-failed'
    );
    const flipped = fromHex(MAC_HEX);
    flipped[0]! ^= 1;
    await refused(
      openProjectPreferences(ACCOUNT_KEY, utf8(RECORD), flipped),
      'authentication-failed'
    );
    await refused(
      openProjectPreferences(ACCOUNT_KEY, utf8(RECORD), flipped.slice(1)),
      'malformed'
    );
  });

  it('refuses non-canonical, unknown and malformed records', () => {
    for (const text of [
      RECORD.replace('{', '{ '),
      '{"kind":"project-preferences","v":1,"userId":"user_alice","encryptNewProjects":true,"sequence":3}',
      RECORD.replace('"sequence":3', '"sequence":0'),
      RECORD.replace('"sequence":3', '"sequence":3.5'),
      RECORD.replace('true', '1'),
      RECORD.replace('}', ',"extra":1}'),
      'not json',
      '[]'
    ]) {
      expect(() => decodeProjectPreferences(utf8(text)), text).toThrow();
    }
    expect(() =>
      decodeProjectPreferences(utf8(RECORD.replace('"v":1', '"v":2')))
    ).toThrow(/version/);
    expect(() =>
      decodeProjectPreferences(
        utf8(RECORD.replace('project-preferences', 'device-list'))
      )
    ).toThrow(/Not a project preference record/);
  });
});

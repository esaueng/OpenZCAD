import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_CONSENT_MAC_INFO,
  decodeAssistantConsent,
  encodeAssistantConsent,
  macAssistantConsent,
  openAssistantConsent
} from './assistant-consent';
import { PROJECT_PREFERENCES_MAC_INFO } from './account-records';
import { fromHex, toHex } from './bytes';
import { isE2eeError } from './errors';
import { patternBytes } from './test-support';

const ACCOUNT_KEY = patternBytes(32);
const RECORD =
  '{"v":1,"kind":"assistant-consent","userId":"user_alice","projectId":"proj_bracket","allowed":true,"copyVersion":1,"route":"deployment|openrouter|openai/gpt-5.6-sol","sequence":2}';
/**
 * Fixed vector: HKDF-SHA-256(account key 00..1f, empty salt, info
 * "OpenZCAD E2EE v1 assistant consent mac") as an HMAC-SHA-256 key over the
 * record bytes above. A change here is a storage-format change.
 */
const MAC_KEY_HEX =
  '1b1394b1c707faa20596b47de5e5d841c082ca041dbefd4536f3da670d0b026e';
const MAC_HEX =
  '24d6c4ecbcdc05b55c2a562d47850d93a48b5f5980c136c5817d908c08df477e';

const utf8 = (text: string) => new TextEncoder().encode(text);
const consent = {
  userId: 'user_alice',
  projectId: 'proj_bracket',
  allowed: true,
  copyVersion: 1,
  route: 'deployment|openrouter|openai/gpt-5.6-sol',
  sequence: 2
};

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error
  );
}

describe('assistant consent records (ADR-024 Phase 6, 6-1)', () => {
  it('encodes canonically and matches the fixed vector', async () => {
    const encoded = encodeAssistantConsent(consent);
    expect(new TextDecoder().decode(encoded)).toBe(RECORD);
    expect(toHex(await macAssistantConsent(ACCOUNT_KEY, encoded))).toBe(
      MAC_HEX
    );
  });

  it('re-derives the MAC with raw WebCrypto under its own label', async () => {
    expect(ASSISTANT_CONSENT_MAC_INFO).toBe(
      'OpenZCAD E2EE v1 assistant consent mac'
    );
    expect(ASSISTANT_CONSENT_MAC_INFO).not.toBe(PROJECT_PREFERENCES_MAC_INFO);
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
          info: utf8(ASSISTANT_CONSENT_MAC_INFO)
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
      openAssistantConsent(ACCOUNT_KEY, utf8(RECORD), fromHex(MAC_HEX))
    ).resolves.toEqual(consent);
  });

  it('records a revocation without a route', async () => {
    const revoked = encodeAssistantConsent({
      ...consent,
      allowed: false,
      route: '',
      sequence: 3
    });
    const mac = await macAssistantConsent(ACCOUNT_KEY, revoked);
    await expect(
      openAssistantConsent(ACCOUNT_KEY, revoked, mac)
    ).resolves.toMatchObject({ allowed: false, route: '', sequence: 3 });
    // An allowed record must name who receives the data.
    expect(() => encodeAssistantConsent({ ...consent, route: '' })).toThrow();
  });

  it('refuses a wrong key, altered bytes, a bad MAC or another kind’s MAC', async () => {
    const authenticationFailed = (error: unknown) =>
      isE2eeError(error, 'authentication-failed');
    expect(
      await refusal(
        openAssistantConsent(
          patternBytes(32, 1),
          utf8(RECORD),
          fromHex(MAC_HEX)
        )
      )
    ).toSatisfy(authenticationFailed);
    for (const altered of [
      RECORD.replace('true', 'false'),
      RECORD.replace('proj_bracket', 'proj_bracket2'),
      RECORD.replace('user_alice', 'user_mallory'),
      RECORD.replace('"copyVersion":1', '"copyVersion":2'),
      RECORD.replace('openrouter', 'openai'),
      RECORD.replace('"sequence":2', '"sequence":9')
    ]) {
      expect(
        await refusal(
          openAssistantConsent(ACCOUNT_KEY, utf8(altered), fromHex(MAC_HEX))
        ),
        altered
      ).toSatisfy(authenticationFailed);
    }
    const flipped = fromHex(MAC_HEX);
    flipped[0]! ^= 1;
    expect(
      await refusal(openAssistantConsent(ACCOUNT_KEY, utf8(RECORD), flipped))
    ).toSatisfy(authenticationFailed);
    expect(
      await refusal(
        openAssistantConsent(ACCOUNT_KEY, utf8(RECORD), flipped.slice(1))
      )
    ).toSatisfy((error: unknown) => isE2eeError(error, 'malformed'));
    // The same bytes MAC'd under the project-preferences label never verify.
    const base = await crypto.subtle.importKey(
      'raw',
      ACCOUNT_KEY,
      'HKDF',
      false,
      ['deriveKey']
    );
    const preferencesKey = await crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(),
        info: utf8(PROJECT_PREFERENCES_MAC_INFO)
      },
      base,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign']
    );
    const crossKind = new Uint8Array(
      await crypto.subtle.sign('HMAC', preferencesKey, utf8(RECORD))
    );
    expect(
      await refusal(openAssistantConsent(ACCOUNT_KEY, utf8(RECORD), crossKind))
    ).toSatisfy(authenticationFailed);
  });

  it('refuses non-canonical, unknown and malformed records', () => {
    for (const text of [
      RECORD.replace('{', '{ '),
      RECORD.replace(
        '"v":1,"kind":"assistant-consent"',
        '"kind":"assistant-consent","v":1'
      ),
      RECORD.replace('"sequence":2', '"sequence":0'),
      RECORD.replace('"sequence":2', '"sequence":2.5'),
      RECORD.replace('"copyVersion":1', '"copyVersion":0'),
      RECORD.replace('true', '1'),
      RECORD.replace('"projectId":"proj_bracket"', '"projectId":""'),
      RECORD.replace('"route":"deployment', '"route":"\\ndeployment'),
      RECORD.replace('}', ',"extra":1}'),
      'not json',
      '[]'
    ]) {
      expect(() => decodeAssistantConsent(utf8(text)), text).toThrow();
    }
    expect(() =>
      decodeAssistantConsent(utf8(RECORD.replace('"v":1', '"v":2')))
    ).toThrow(/version/);
    expect(() =>
      decodeAssistantConsent(
        utf8(RECORD.replace('assistant-consent', 'project-preferences'))
      )
    ).toThrow(/Not an assistant consent record/);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentPasskeyPlatform,
  detectPasskeyPlatform,
  noPrfGuidance,
  passkeyErrorHint,
  type PasskeyPlatform
} from '../apps/web/src/lib/e2ee/passkeyPlatform';

const UA = {
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
  windowsFirefox:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  linuxFirefox:
    'Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0',
  linuxChrome:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0.0.0 Mobile/15E148 Safari/604.1',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
  chromebook:
    'Mozilla/5.0 (X11; CrOS x86_64 16181.61.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
};

afterEach(() => vi.unstubAllGlobals());

describe('detectPasskeyPlatform', () => {
  it.each<[string, PasskeyPlatform]>([
    [UA.windowsChrome, { os: 'windows', browser: 'chrome' }],
    [UA.windowsEdge, { os: 'windows', browser: 'edge' }],
    [UA.windowsFirefox, { os: 'windows', browser: 'firefox' }],
    [UA.macSafari, { os: 'macos', browser: 'safari' }],
    [UA.macChrome, { os: 'macos', browser: 'chrome' }],
    [UA.linuxFirefox, { os: 'linux', browser: 'firefox' }],
    [UA.linuxChrome, { os: 'linux', browser: 'chrome' }],
    [UA.iphoneSafari, { os: 'ios', browser: 'safari' }],
    [UA.iphoneChrome, { os: 'ios', browser: 'chrome' }],
    [UA.androidChrome, { os: 'android', browser: 'chrome' }],
    [UA.chromebook, { os: 'chromeos', browser: 'chrome' }],
    ['', { os: 'unknown', browser: 'other' }]
  ])('classifies %s', (userAgent, expected) => {
    expect(detectPasskeyPlatform({ userAgent })).toEqual(expected);
  });

  it('prefers userAgentData over the user-agent string', () => {
    expect(
      detectPasskeyPlatform({
        userAgent: UA.linuxChrome,
        platform: 'Windows',
        brands: ['Not A Brand', 'Microsoft Edge', 'Chromium']
      })
    ).toEqual({ os: 'windows', browser: 'edge' });
  });

  it('recognises an iPad that reports a Mac user agent', () => {
    expect(
      detectPasskeyPlatform({ userAgent: UA.macSafari, maxTouchPoints: 5 })
    ).toEqual({ os: 'ios', browser: 'safari' });
  });

  it('reads the current navigator defensively', () => {
    vi.stubGlobal('navigator', {
      userAgent: UA.linuxChrome,
      userAgentData: {
        platform: 'macOS',
        brands: [{ brand: 'Google Chrome' }, { brand: 7 }, null]
      }
    });
    expect(currentPasskeyPlatform()).toEqual({
      os: 'macos',
      browser: 'chrome'
    });
    vi.stubGlobal('navigator', undefined);
    expect(currentPasskeyPlatform()).toEqual({
      os: 'unknown',
      browser: 'other'
    });
  });
});

describe('noPrfGuidance', () => {
  const at = (userAgent: string) => detectPasskeyPlatform({ userAgent });

  it.each([
    [
      UA.windowsEdge,
      'If you chose Windows Hello',
      'Windows 11 with the February 2026 update'
    ],
    [
      UA.windowsFirefox,
      'Google Password Manager or a security key',
      'Windows Hello'
    ],
    [UA.macSafari, 'iCloud Keychain on this Mac', 'not on another device'],
    [UA.iphoneSafari, 'iCloud Keychain on this iPhone or iPad', 'QR code'],
    [UA.iphoneChrome, 'iCloud Keychain on this iPhone or iPad', 'QR code'],
    [UA.linuxFirefox, 'Firefox on Linux', 'hmac-secret'],
    [UA.linuxChrome, 'Google Password Manager or your phone', 'hmac-secret'],
    [UA.androidChrome, 'Google Password Manager on this phone', 'security key'],
    [UA.macChrome, 'iCloud Keychain (macOS 15 or later)', 'security key'],
    ['', '1Password', 'security key']
  ])('tailors creation advice for %s', (userAgent, first, second) => {
    const message = noPrfGuidance(at(userAgent), 'create');
    expect(message).toMatch(/^This passkey can’t unlock encryption/);
    expect(message).toContain(first);
    expect(message).toContain(second);
    expect(message).toMatch(/Your recovery key still works\.$/);
  });

  it('explains unlock failures without suggesting a new passkey', () => {
    const safari = noPrfGuidance(at(UA.macSafari), 'get');
    expect(safari).toContain('another device through a QR code');
    expect(safari).toMatch(/Your recovery key still works\.$/);
    expect(noPrfGuidance(at(UA.windowsChrome), 'get')).toContain('Windows 11');
    expect(noPrfGuidance(at(''), 'get')).toContain('where you created it');
  });
});

describe('passkeyErrorHint', () => {
  const at = (userAgent: string) => detectPasskeyPlatform({ userAgent });

  it('names the likely platform cause where one is known', () => {
    expect(passkeyErrorHint('ConstraintError', at(UA.windowsChrome))).toContain(
      'Windows Hello PIN'
    );
    expect(passkeyErrorHint('ConstraintError', at(UA.macSafari))).toContain(
      'Touch ID'
    );
    expect(passkeyErrorHint('ConstraintError', at(UA.linuxChrome))).toContain(
      'security key needs a PIN'
    );
    expect(
      passkeyErrorHint('NotSupportedError', at(UA.linuxFirefox))
    ).toContain('only on security keys');
    expect(passkeyErrorHint('NotSupportedError', at(UA.windowsEdge))).toContain(
      'update Windows'
    );
  });

  it('adds nothing where the platform does not help', () => {
    expect(passkeyErrorHint('SecurityError', at(UA.windowsChrome))).toBe('');
    expect(passkeyErrorHint('NotSupportedError', at(UA.macSafari))).toBe('');
    expect(passkeyErrorHint('ConstraintError', at(''))).toBe('');
  });
});

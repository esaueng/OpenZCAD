/**
 * Platform-aware wording for passkey failures. Detection reads only the
 * browser's own user-agent signals, never sends them anywhere, and is used
 * for nothing but choosing which sentence to show: it is a hint, not a
 * capability check, and an unrecognised platform gets general advice.
 */

export type PasskeyOs =
  'windows' | 'macos' | 'ios' | 'android' | 'linux' | 'chromeos' | 'unknown';

export type PasskeyBrowser = 'chrome' | 'edge' | 'firefox' | 'safari' | 'other';

export interface PasskeyPlatform {
  readonly os: PasskeyOs;
  readonly browser: PasskeyBrowser;
}

export interface PasskeyPlatformSignals {
  readonly userAgent?: string;
  /** `navigator.userAgentData.platform`, where the browser exposes it. */
  readonly platform?: string;
  /** `navigator.userAgentData.brands[].brand`, where exposed. */
  readonly brands?: readonly string[];
  /** iPadOS reports a Mac user agent; touch points tell them apart. */
  readonly maxTouchPoints?: number;
}

export type PasskeyCeremony = 'create' | 'get';

function osFrom(signals: PasskeyPlatformSignals): PasskeyOs {
  const platform = signals.platform?.toLowerCase() ?? '';
  if (platform === 'windows') return 'windows';
  if (platform === 'macos') return 'macos';
  if (platform === 'ios') return 'ios';
  if (platform === 'android') return 'android';
  if (platform === 'chrome os' || platform === 'chromeos') return 'chromeos';
  if (platform === 'linux') return 'linux';
  const ua = signals.userAgent ?? '';
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/CrOS/.test(ua)) return 'chromeos';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua)) {
    return (signals.maxTouchPoints ?? 0) > 1 ? 'ios' : 'macos';
  }
  if (/Linux|X11/.test(ua)) return 'linux';
  return 'unknown';
}

function browserFrom(signals: PasskeyPlatformSignals): PasskeyBrowser {
  const brands = signals.brands ?? [];
  if (brands.includes('Microsoft Edge')) return 'edge';
  if (brands.includes('Google Chrome') || brands.includes('Chromium')) {
    return 'chrome';
  }
  const ua = signals.userAgent ?? '';
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return 'edge';
  if (/\b(Firefox|FxiOS)\//.test(ua)) return 'firefox';
  if (/\b(Chrome|CriOS|Chromium)\//.test(ua)) return 'chrome';
  if (/\bVersion\/[\d.]+.*\bSafari\//.test(ua)) return 'safari';
  return 'other';
}

/** Pure: classify the OS and browser family from user-agent signals. */
export function detectPasskeyPlatform(
  signals: PasskeyPlatformSignals
): PasskeyPlatform {
  return { os: osFrom(signals), browser: browserFrom(signals) };
}

/** This browser's platform, from `navigator.userAgentData` or the UA. */
export function currentPasskeyPlatform(): PasskeyPlatform {
  const nav = (globalThis as { navigator?: Partial<Navigator> }).navigator;
  const data = (
    nav as
      | {
          userAgentData?: {
            platform?: unknown;
            brands?: readonly { brand?: unknown }[];
          };
        }
      | undefined
  )?.userAgentData;
  const brands: readonly unknown[] | undefined = Array.isArray(data?.brands)
    ? (data.brands as readonly unknown[])
    : undefined;
  return detectPasskeyPlatform({
    userAgent: typeof nav?.userAgent === 'string' ? nav.userAgent : undefined,
    platform: typeof data?.platform === 'string' ? data.platform : undefined,
    brands: brands
      ?.map((item) =>
        typeof item === 'object' && item !== null
          ? (item as { brand?: unknown }).brand
          : undefined
      )
      .filter((brand): brand is string => typeof brand === 'string'),
    maxTouchPoints:
      typeof nav?.maxTouchPoints === 'number' ? nav.maxTouchPoints : undefined
  });
}

const RECOVERY = 'Your recovery key still works.';

/**
 * What to do when the chosen authenticator returned no PRF result, so the
 * passkey cannot unlock encryption. Tailored to the known platform causes
 * (see docs/qa/passkey-compatibility.md); always ends with the recovery key.
 */
export function noPrfGuidance(
  platform: PasskeyPlatform,
  ceremony: PasskeyCeremony
): string {
  const lead =
    ceremony === 'create'
      ? 'This passkey can’t unlock encryption: the place it was saved doesn’t support the PRF extension that encryption needs.'
      : 'This passkey can’t unlock encryption here: the browser got no PRF result from it.';
  return `${lead} ${platformAdvice(platform, ceremony)} ${RECOVERY}`;
}

function platformAdvice(
  { os, browser }: PasskeyPlatform,
  ceremony: PasskeyCeremony
): string {
  if (os === 'ios') {
    return ceremony === 'create'
      ? 'Save it in iCloud Keychain on this iPhone or iPad (iOS 18 or later), not on another device through a QR code.'
      : 'Use a passkey saved in iCloud Keychain on this iPhone or iPad; passkeys from another device through a QR code can’t unlock encryption here.';
  }
  if (os === 'macos' && browser === 'safari') {
    return ceremony === 'create'
      ? 'Save it in iCloud Keychain on this Mac, not on another device such as a phone through a QR code.'
      : 'Safari can’t unlock encryption with a passkey from another device through a QR code. Use a passkey saved in iCloud Keychain on this Mac.';
  }
  if (os === 'windows') {
    return ceremony === 'create'
      ? 'Windows Hello on this PC can’t unlock encryption yet: it needs Windows 11 with the February 2026 update or later. Update Windows, or save the passkey to your phone, Google Password Manager or a security key.'
      : 'If you chose Windows Hello, it needs Windows 11 with the February 2026 update or later. Otherwise use the passkey where you created it.';
  }
  if (os === 'linux' && browser === 'firefox') {
    return 'Firefox on Linux can use only a security key that supports hmac-secret for this, not a phone. Use such a key, or Chrome with Google Password Manager or your phone.';
  }
  if (os === 'macos') {
    return ceremony === 'create'
      ? 'Save it in iCloud Keychain (macOS 15 or later) or Google Password Manager on this Mac, or use a security key that supports hmac-secret.'
      : 'Use the passkey where you created it, such as iCloud Keychain or Google Password Manager on this Mac.';
  }
  if (os === 'linux' || os === 'chromeos') {
    return ceremony === 'create'
      ? 'Save it to Google Password Manager or your phone, or use a security key that supports hmac-secret.'
      : 'Use the passkey where you created it, such as Google Password Manager or your phone.';
  }
  if (os === 'android') {
    return ceremony === 'create'
      ? 'Save it in Google Password Manager on this phone, or use a security key that supports hmac-secret.'
      : 'Use the passkey where you created it, such as Google Password Manager on this phone.';
  }
  return ceremony === 'create'
    ? 'Save it somewhere that supports encryption, such as Google Password Manager, iCloud Keychain, 1Password or a security key that supports hmac-secret.'
    : 'Use the passkey on the device or in the password manager where you created it.';
}

/**
 * A short platform hint for a WebAuthn error name, or '' when the platform
 * adds nothing useful. Only for diagnosis: the main message stands alone.
 */
export function passkeyErrorHint(
  name: string,
  { os, browser }: PasskeyPlatform
): string {
  if (name === 'ConstraintError') {
    if (os === 'windows') {
      return 'On Windows, set up a Windows Hello PIN under Settings › Accounts › Sign-in options.';
    }
    if (os === 'macos') {
      return 'On a Mac, turn on Touch ID or set a login password.';
    }
    if (os === 'ios' || os === 'android') {
      return 'Turn on a screen lock for this device.';
    }
    if (os === 'linux' || os === 'chromeos') {
      return 'A security key needs a PIN before it can verify you.';
    }
    return '';
  }
  if (name === 'NotSupportedError') {
    if (os === 'linux' && browser === 'firefox') {
      return 'Firefox on Linux supports passkeys only on security keys.';
    }
    if (os === 'windows') {
      return 'Older Windows versions can’t create this kind of passkey; update Windows, or use your phone or a security key.';
    }
    return '';
  }
  return '';
}

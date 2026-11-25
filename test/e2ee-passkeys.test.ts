import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { passkeyPrfInput, toHex, type Bytes } from '@openzcad/crypto';
import {
  browserPasskeys,
  failedPasskeyEnrollment,
  PASSKEY_CEREMONY_TIMEOUT_MS,
  passkeyEnrollmentCleanup,
  passkeysAvailable,
  PasskeyError
} from '../apps/web/src/lib/e2ee/passkeys';

class CredentialResult {
  readonly type = 'public-key';
  constructor(
    readonly rawId: ArrayBuffer = Uint8Array.of(1, 2, 3).buffer,
    readonly extensions: AuthenticationExtensionsClientOutputs = {}
  ) {}
  getClientExtensionResults() {
    return this.extensions;
  }
}

const create =
  vi.fn<
    (options: CredentialCreationOptions) => Promise<CredentialResult | null>
  >();
const get =
  vi.fn<
    (options: CredentialRequestOptions) => Promise<CredentialResult | null>
  >();
const secret = () => new Uint8Array(32).fill(0x71);
const result = (bytes: BufferSource = secret()) =>
  new CredentialResult(undefined, { prf: { results: { first: bytes } } });

beforeEach(() => {
  vi.stubGlobal('PublicKeyCredential', CredentialResult);
  vi.stubGlobal('navigator', { credentials: { create, get } });
  vi.stubGlobal('location', { hostname: 'zcad.test' });
  vi.stubGlobal('isSecureContext', true);
  create.mockReset();
  get.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('browser passkey PRF ceremonies', () => {
  it('creates a discoverable, user-verified credential scoped to this host', async () => {
    const bytes = secret();
    create.mockResolvedValue(result(bytes));
    const selected = await browserPasskeys.create();
    const options = create.mock.calls[0]![0]
      .publicKey as PublicKeyCredentialCreationOptions;
    expect(options.rp).toEqual({ id: 'zcad.test', name: 'OpenZCAD' });
    expect(options.authenticatorSelection).toEqual({
      residentKey: 'required',
      userVerification: 'required'
    });
    expect(options.attestation).toBe('none');
    expect(options.challenge.byteLength).toBe(32);
    expect(options.user.id.byteLength).toBe(32);
    expect(options.user.displayName).toMatch(
      /^OpenZCAD encryption [0-9a-f]{12}$/
    );
    expect(options.user.name).toContain(options.user.displayName);
    expect(selected.enrollmentLabel).toBe(options.user.displayName);
    expect(options.extensions?.prf?.eval?.first).toEqual(passkeyPrfInput());
    expect(selected.secret).toEqual(secret());
    expect(bytes.every((b) => b === 0)).toBe(true);
    expect(selected.targetId).toBe(
      `pk_${toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.of(1, 2, 3))))}`
    );
    expect(get).not.toHaveBeenCalled();
  });

  it('evaluates PRF with an assertion restricted to the newly created credential', async () => {
    create.mockResolvedValue(
      new CredentialResult(undefined, { prf: { enabled: true } })
    );
    get.mockResolvedValue(result());
    await browserPasskeys.create();
    const options = get.mock.calls[0]![0]
      .publicKey as PublicKeyCredentialRequestOptions;
    expect(options.allowCredentials).toEqual([
      { type: 'public-key', id: Uint8Array.of(1, 2, 3).buffer }
    ]);
    expect(options.userVerification).toBe('required');
    expect(options.rpId).toBe('zcad.test');
    expect(options.extensions?.prf?.eval?.first).toEqual(passkeyPrfInput());
    expect(options.challenge).not.toEqual(
      create.mock.calls[0]![0].publicKey!.challenge
    );
  });

  it('uses a distinct user handle for each added credential', async () => {
    create.mockImplementation(async () => result());
    await browserPasskeys.create();
    await browserPasskeys.create();
    expect(create.mock.calls[0]![0].publicKey!.user.id).not.toEqual(
      create.mock.calls[1]![0].publicKey!.user.id
    );
    expect(create.mock.calls[0]![0].publicKey!.user.displayName).not.toBe(
      create.mock.calls[1]![0].publicKey!.user.displayName
    );
  });

  it('uses only a random label in provider-visible user metadata', async () => {
    create.mockImplementation(async () => result());
    const selected = await browserPasskeys.create();
    const user = create.mock.calls[0]![0].publicKey!.user;
    expect(user.name).toBe(user.displayName);
    expect(user.name).toMatch(/^OpenZCAD encryption [0-9a-f]{12}$/);
    expect(JSON.stringify(user)).not.toContain('user_email_derived_identifier');
    selected.secret.fill(0);
  });

  it('refuses a different credential in the creation fallback', async () => {
    create.mockResolvedValue(
      new CredentialResult(undefined, { prf: { enabled: true } })
    );
    const bytes = secret();
    get.mockResolvedValue(
      new CredentialResult(Uint8Array.of(9).buffer, {
        prf: { results: { first: bytes } }
      })
    );
    await expect(browserPasskeys.create()).rejects.toThrow('different passkey');
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  it('discards output when a credential explicitly reports PRF disabled', async () => {
    const bytes = secret();
    get.mockResolvedValue(
      new CredentialResult(undefined, {
        prf: { enabled: false, results: { first: bytes } }
      })
    );
    await expect(browserPasskeys.get()).rejects.toThrow(
      'can’t unlock encryption'
    );
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  it('uses discoverable selection, the fixed PRF input and fresh challenges on unlock', async () => {
    get.mockImplementation(async () => result());
    await browserPasskeys.get();
    await browserPasskeys.get();
    const options = get.mock.calls[0]![0]
      .publicKey as PublicKeyCredentialRequestOptions;
    expect(options.allowCredentials).toBeUndefined();
    expect(options.userVerification).toBe('required');
    expect(options.extensions?.prf?.eval?.first).toEqual(passkeyPrfInput());
    expect(options.challenge).not.toEqual(
      get.mock.calls[1]![0].publicKey!.challenge
    );
  });

  it('accepts BufferSource views using exactly the output slice', async () => {
    const bytes = new Uint8Array(40).fill(0x71);
    get.mockResolvedValue(result(new DataView(bytes.buffer, 4, 32)));
    expect((await browserPasskeys.get()).secret).toEqual(secret());
    expect(bytes.slice(4, 36).every((b) => b === 0)).toBe(true);
    expect(bytes[0]).toBe(0x71);
  });

  it.each([{}, { prf: { enabled: false } }, { prf: {} }])(
    'refuses missing or unsupported PRF: %j',
    async (extensions) => {
      create.mockResolvedValue(new CredentialResult(undefined, extensions));
      const failure: unknown = await browserPasskeys
        .create()
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PasskeyError);
      expect((failure as Error).message).toContain('can’t unlock encryption');
      expect(passkeyEnrollmentCleanup(failure)).toContain(
        `remove only "${create.mock.calls[0]![0].publicKey!.user.displayName}"`
      );
      expect(get).not.toHaveBeenCalled();
      get.mockResolvedValue(new CredentialResult(undefined, extensions));
      await expect(browserPasskeys.get()).rejects.toBeInstanceOf(PasskeyError);
    }
  );

  it('identifies the saved credential when the fallback assertion is canceled', async () => {
    create.mockResolvedValue(
      new CredentialResult(undefined, { prf: { enabled: true } })
    );
    get.mockRejectedValue(new DOMException('canceled', 'NotAllowedError'));
    const failure: unknown = await browserPasskeys
      .create()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PasskeyError);
    expect((failure as Error).message).toContain('canceled or timed out');
    expect(passkeyEnrollmentCleanup(failure)).toContain(
      create.mock.calls[0]![0].publicKey!.user.displayName
    );
  });

  it('does not suggest deleting a credential when creation itself is canceled', async () => {
    create.mockRejectedValue(new DOMException('canceled', 'NotAllowedError'));
    const failure: unknown = await browserPasskeys
      .create()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PasskeyError);
    expect(passkeyEnrollmentCleanup(failure)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('identifies the saved credential and erases malformed creation output', async () => {
    const bytes = new Uint8Array(31).fill(9);
    create.mockResolvedValue(result(bytes));
    const failure: unknown = await browserPasskeys
      .create()
      .catch((error: unknown) => error);
    expect((failure as Error).message).toContain('invalid PRF');
    expect(passkeyEnrollmentCleanup(failure)).toContain('remove only');
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it.each([0, 31, 33])('refuses a PRF output of %i bytes', async (length) => {
    const bytes: Bytes = new Uint8Array(length).fill(9);
    get.mockResolvedValue(result(bytes));
    await expect(browserPasskeys.get()).rejects.toThrow('invalid PRF');
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  it.each(['NotAllowedError', 'AbortError'])(
    'handles %s without returning key material',
    async (name) => {
      get.mockRejectedValue(new DOMException('browser detail', name));
      await expect(browserPasskeys.get()).rejects.toThrow(
        'canceled or timed out'
      );
    }
  );

  it('leaves recovery available on insecure origins, missing WebAuthn and desktop', async () => {
    vi.stubGlobal('isSecureContext', false);
    expect(passkeysAvailable()).toBe(false);
    await expect(browserPasskeys.get()).rejects.toThrow('unavailable');
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    expect(passkeysAvailable()).toBe(false);
    vi.stubGlobal('window', {});
    vi.stubGlobal('PublicKeyCredential', undefined);
    expect(passkeysAvailable()).toBe(false);
    expect(get).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});

const WINDOWS_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15';
const LINUX_FIREFOX =
  'Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0';

function userAgent(value: string): void {
  vi.stubGlobal('navigator', {
    credentials: { create, get },
    userAgent: value
  });
}

const signalUnknownCredential =
  vi.fn<(options: { rpId: string; credentialId: string }) => Promise<void>>();

/** A browser with the WebAuthn Signal API (Chrome/Edge 132+, Safari 26). */
class SignallingCredential extends CredentialResult {
  static signalUnknownCredential = signalUnknownCredential;
}

async function createFailure(): Promise<unknown> {
  return browserPasskeys.create().catch((error: unknown) => error);
}

const prfFirst = (first: unknown) =>
  new CredentialResult(undefined, {
    prf: { results: { first: first as BufferSource } }
  });

describe('PRF output shapes across browsers and providers', () => {
  it('treats Firefox’s empty prf object like Chrome’s enabled: false', async () => {
    for (const extensions of [{ prf: {} }, { prf: { enabled: false } }]) {
      create.mockResolvedValueOnce(new CredentialResult(undefined, extensions));
      const failure = await createFailure();
      expect(failure).toBeInstanceOf(PasskeyError);
      expect((failure as Error).message).toContain('can’t unlock encryption');
      expect(get).not.toHaveBeenCalled();
    }
  });

  it('accepts 1Password’s plain Array of exactly 32 bytes and erases it', async () => {
    const bytes = Array.from({ length: 32 }, () => 0x71);
    get.mockResolvedValue(prfFirst(bytes));
    const selected = await browserPasskeys.get();
    expect(selected.secret).toBeInstanceOf(Uint8Array);
    expect(selected.secret).toEqual(secret());
    expect(bytes.every((b) => b === 0)).toBe(true);

    const created = Array.from({ length: 32 }, () => 0x71);
    create.mockResolvedValue(
      new CredentialResult(undefined, {
        prf: {
          enabled: true,
          results: { first: created as unknown as BufferSource }
        }
      })
    );
    expect((await browserPasskeys.create()).secret).toEqual(secret());
    expect(created.every((b) => b === 0)).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['31 entries', Array.from({ length: 31 }, () => 1)],
    ['33 entries', Array.from({ length: 33 }, () => 1)],
    ['a value above 255', [...Array.from({ length: 31 }, () => 1), 256]],
    ['a negative value', [...Array.from({ length: 31 }, () => 1), -1]],
    ['a fraction', [...Array.from({ length: 31 }, () => 1), 1.5]],
    ['a string', [...Array.from({ length: 31 }, () => 1), '1']],
    // `every` skips holes; Uint8Array.from would turn them into zeros.
    ['holes', Object.assign(new Array<unknown>(32), { 5: 7 })]
  ])('refuses an Array PRF output with %s', async (_, values: unknown[]) => {
    get.mockResolvedValue(prfFirst(values));
    await expect(browserPasskeys.get()).rejects.toThrow('invalid PRF');
    expect(values.every((value) => value === 0)).toBe(true);
  });

  it('refuses a PRF output that is not bytes', async () => {
    get.mockResolvedValue(prfFirst('secret'));
    await expect(browserPasskeys.get()).rejects.toThrow('invalid PRF');
  });

  it('asserts when creation reports PRF enabled with an empty results object', async () => {
    create.mockResolvedValue(
      new CredentialResult(undefined, {
        prf: { enabled: true, results: {} as AuthenticationExtensionsPRFValues }
      })
    );
    get.mockResolvedValue(result());
    expect((await browserPasskeys.create()).secret).toEqual(secret());
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('credentials returned by password-manager extensions', () => {
  const polyfilled = (
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    type: 'public-key',
    rawId: Uint8Array.of(1, 2, 3).buffer,
    getClientExtensionResults: () => ({
      prf: { results: { first: secret() } }
    }),
    ...overrides
  });
  const resolveGet = (value: unknown) =>
    get.mockResolvedValue(value as CredentialResult | null);

  it('accepts a structurally valid object that is not a PublicKeyCredential', async () => {
    const value = polyfilled();
    expect(value).not.toBeInstanceOf(CredentialResult);
    resolveGet(value);
    const selected = await browserPasskeys.get();
    expect(selected.secret).toEqual(secret());
    expect(selected.targetId).toBe(
      `pk_${toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.of(1, 2, 3))))}`
    );
  });

  it('accepts an ArrayBuffer id from another realm', async () => {
    const foreign = runInNewContext(
      'new Uint8Array([1, 2, 3]).buffer'
    ) as ArrayBuffer;
    expect(foreign).not.toBeInstanceOf(ArrayBuffer);
    resolveGet(polyfilled({ rawId: foreign }));
    expect((await browserPasskeys.get()).secret).toEqual(secret());
  });

  it('accepts the largest allowed credential id', async () => {
    resolveGet(polyfilled({ rawId: new ArrayBuffer(1023) }));
    expect((await browserPasskeys.get()).secret).toEqual(secret());
  });

  it.each([
    ['a null result', null],
    ['a password credential', polyfilled({ type: 'password' })],
    ['an empty id', polyfilled({ rawId: new ArrayBuffer(0) })],
    ['a 1024-byte id', polyfilled({ rawId: new ArrayBuffer(1024) })],
    ['a typed-array id', polyfilled({ rawId: Uint8Array.of(1, 2, 3) })],
    [
      'an id that only claims to be an ArrayBuffer',
      polyfilled({
        rawId: { [Symbol.toStringTag]: 'ArrayBuffer', byteLength: 3 }
      })
    ],
    [
      'no extension-results function',
      polyfilled({ getClientExtensionResults: undefined })
    ]
  ])('refuses %s', async (_, value) => {
    resolveGet(value);
    await expect(browserPasskeys.get()).rejects.toThrow(
      'No passkey was selected'
    );
  });
});

describe('ceremony timeouts', () => {
  it('gives every prompt five minutes for cross-device and Windows Hello', async () => {
    expect(PASSKEY_CEREMONY_TIMEOUT_MS).toBe(300_000);
    create.mockResolvedValue(
      new CredentialResult(undefined, { prf: { enabled: true } })
    );
    get.mockImplementation(async () => result());
    (await browserPasskeys.create()).secret.fill(0);
    (await browserPasskeys.get()).secret.fill(0);
    expect(create.mock.calls[0]![0].publicKey!.timeout).toBe(300_000);
    expect(get.mock.calls[0]![0].publicKey!.timeout).toBe(300_000);
    expect(get.mock.calls[1]![0].publicKey!.timeout).toBe(300_000);
    expect(create.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
    expect(get.mock.calls[1]![0].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('orphaned credential cleanup through the Signal API', () => {
  beforeEach(() => {
    signalUnknownCredential.mockReset();
    signalUnknownCredential.mockResolvedValue(undefined);
    vi.stubGlobal('PublicKeyCredential', SignallingCredential);
  });

  it('signals an uncertified credential without PRF and keeps the label in conditional advice', async () => {
    create.mockResolvedValue(
      new CredentialResult(Uint8Array.of(0xfb, 0xff, 0x01).buffer, {
        prf: { enabled: false }
      })
    );
    const failure = await createFailure();
    expect(failure).toBeInstanceOf(PasskeyError);
    expect(signalUnknownCredential).toHaveBeenCalledExactlyOnceWith({
      rpId: 'zcad.test',
      credentialId: '-_8B'
    });
    // A resolved signal does not prove the provider removed it.
    const advice = passkeyEnrollmentCleanup(failure);
    expect(advice).toContain('was asked to delete');
    expect(advice).toContain(
      `"${create.mock.calls[0]![0].publicKey!.user.displayName}"`
    );
    expect(advice).toContain('If it still lists it, remove only that passkey');
  });

  it('signals when the creation fallback assertion returns no PRF output', async () => {
    create.mockResolvedValue(
      new CredentialResult(undefined, { prf: { enabled: true } })
    );
    get.mockResolvedValue(new CredentialResult(undefined, { prf: {} }));
    const failure = await createFailure();
    expect((failure as Error).message).toContain('can’t unlock encryption');
    expect(signalUnknownCredential).toHaveBeenCalledExactlyOnceWith({
      rpId: 'zcad.test',
      credentialId: 'AQID'
    });
    expect(passkeyEnrollmentCleanup(failure)).toContain(
      `"${create.mock.calls[0]![0].publicKey!.user.displayName}"`
    );
  });

  it('keeps the manual advice when signalling throws', async () => {
    signalUnknownCredential.mockRejectedValue(
      new DOMException('nope', 'SecurityError')
    );
    create.mockResolvedValue(new CredentialResult(undefined, {}));
    const failure = await createFailure();
    expect(signalUnknownCredential).toHaveBeenCalledOnce();
    expect(passkeyEnrollmentCleanup(failure)).toContain('remove only');
  });

  it('keeps the manual advice when signalling never settles', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      signalUnknownCredential.mockReturnValue(new Promise(() => undefined));
      create.mockResolvedValue(new CredentialResult(undefined, {}));
      const pending = createFailure();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(passkeyEnrollmentCleanup(await pending)).toContain('remove only');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the manual advice where the Signal API is missing', async () => {
    vi.stubGlobal('PublicKeyCredential', CredentialResult);
    create.mockResolvedValue(new CredentialResult(undefined, {}));
    const failure = await createFailure();
    expect(signalUnknownCredential).not.toHaveBeenCalled();
    expect(passkeyEnrollmentCleanup(failure)).toContain('remove only');
  });

  it('never signals a credential handed on for certification, a canceled creation or an unlock', async () => {
    create.mockResolvedValueOnce(result());
    (await browserPasskeys.create()).secret.fill(0);
    create.mockRejectedValueOnce(new DOMException('x', 'NotAllowedError'));
    expect(passkeyEnrollmentCleanup(await createFailure())).toBeNull();
    get.mockResolvedValueOnce(new CredentialResult(undefined, {}));
    await expect(browserPasskeys.get()).rejects.toBeInstanceOf(PasskeyError);
    expect(signalUnknownCredential).not.toHaveBeenCalled();
  });

  it('keeps manual advice for a possibly certified target after a later failure', () => {
    const failure = failedPasskeyEnrollment(
      new PasskeyError('Device list changed'),
      'OpenZCAD encryption 0123456789ab',
      'pk_0123456789abcdef'
    );
    expect(passkeyEnrollmentCleanup(failure)).toContain(
      'remove any unlock method marked 0123456789ab'
    );
  });
});

describe('WebAuthn error mapping', () => {
  it.each([
    ['InvalidStateError', 'already registered'],
    ['NotSupportedError', 'can’t make a passkey OpenZCAD can use'],
    ['SecurityError', 'secure (https) connection'],
    ['ConstraintError', 'no PIN, fingerprint or face unlock'],
    ['UnknownError', 'could not be used here'],
    ['NotAllowedError', 'canceled or timed out']
  ])('maps %s to an actionable PasskeyError', async (name, text) => {
    create.mockRejectedValue(new DOMException('browser detail', name));
    get.mockRejectedValue(new DOMException('browser detail', name));
    const failure = await createFailure();
    expect(failure).toBeInstanceOf(PasskeyError);
    expect((failure as Error).message).toContain(text);
    expect((failure as Error).message).not.toContain('browser detail');
    expect(passkeyEnrollmentCleanup(failure)).toBeNull();
    await expect(browserPasskeys.get()).rejects.toThrow(text);
  });

  it('maps errors thrown by extensions that are not DOMExceptions', async () => {
    get.mockRejectedValue({ name: 'ConstraintError', message: 'x' });
    await expect(browserPasskeys.get()).rejects.toThrow(
      'no PIN, fingerprint or face unlock'
    );
  });

  it('adds a platform hint where it helps diagnosis', async () => {
    userAgent(WINDOWS_CHROME);
    get.mockRejectedValue(new DOMException('x', 'ConstraintError'));
    await expect(browserPasskeys.get()).rejects.toThrow('Windows Hello PIN');
    userAgent(LINUX_FIREFOX);
    get.mockRejectedValue(new DOMException('x', 'NotSupportedError'));
    await expect(browserPasskeys.get()).rejects.toThrow(
      'Firefox on Linux supports passkeys only on security keys'
    );
  });
});

describe('platform guidance when the authenticator has no PRF', () => {
  it.each([
    [WINDOWS_CHROME, 'If you chose Windows Hello, it needs Windows 11'],
    [
      MAC_SAFARI,
      'Save it in iCloud Keychain on this Mac, not on another device'
    ],
    [LINUX_FIREFOX, 'Firefox on Linux can use only a security key']
  ])('tailors the creation message for %s', async (ua, text) => {
    userAgent(ua);
    create.mockResolvedValue(
      new CredentialResult(undefined, { prf: { enabled: false } })
    );
    const failure = await createFailure();
    expect((failure as Error).message).toContain(text);
    expect((failure as Error).message).toContain('recovery key still works');
  });

  it('explains Safari’s cross-device unlock gap', async () => {
    userAgent(MAC_SAFARI);
    get.mockResolvedValue(new CredentialResult(undefined, {}));
    await expect(browserPasskeys.get()).rejects.toThrow(
      'Safari can’t unlock encryption with a passkey from another device'
    );
  });
});

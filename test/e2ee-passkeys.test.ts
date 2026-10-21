import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { passkeyPrfInput, toHex, type Bytes } from '@openzcad/crypto';
import {
  browserPasskeys,
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
    const selected = await browserPasskeys.create('user_test');
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
    await browserPasskeys.create('user_test');
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
    await browserPasskeys.create('user_test');
    await browserPasskeys.create('user_test');
    expect(create.mock.calls[0]![0].publicKey!.user.id).not.toEqual(
      create.mock.calls[1]![0].publicKey!.user.id
    );
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
    await expect(browserPasskeys.create('user_test')).rejects.toThrow(
      'different passkey'
    );
    expect(bytes.every((b) => b === 0)).toBe(true);
  });

  it('discards output when a credential explicitly reports PRF disabled', async () => {
    const bytes = secret();
    get.mockResolvedValue(
      new CredentialResult(undefined, {
        prf: { enabled: false, results: { first: bytes } }
      })
    );
    await expect(browserPasskeys.get()).rejects.toThrow('does not support PRF');
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
      await expect(browserPasskeys.create('user_test')).rejects.toBeInstanceOf(
        PasskeyError
      );
      expect(get).not.toHaveBeenCalled();
      get.mockResolvedValue(new CredentialResult(undefined, extensions));
      await expect(browserPasskeys.get()).rejects.toBeInstanceOf(PasskeyError);
    }
  );

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

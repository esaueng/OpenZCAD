import { passkeyPrfInput, toHex, type Bytes } from '@openzcad/crypto';
import { isDesktopApp } from '../desktopBridge';

export class PasskeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasskeyError';
  }
}

export interface PasskeySecret {
  /** Hash of the credential id, certified by the identity-signed list. */
  readonly targetId: string;
  /** Local only. The caller must erase it in a finally block. */
  readonly secret: Bytes;
}

export interface PasskeyPrf {
  create(userId: string): Promise<PasskeySecret>;
  get(): Promise<PasskeySecret>;
}

export function passkeysAvailable(): boolean {
  return (
    !isDesktopApp() &&
    globalThis.isSecureContext === true &&
    typeof PublicKeyCredential !== 'undefined' &&
    typeof navigator.credentials?.create === 'function' &&
    typeof navigator.credentials?.get === 'function'
  );
}

function available(): void {
  if (!passkeysAvailable()) {
    throw new PasskeyError(
      'Passkeys are unavailable here. Use your recovery key or another device.'
    );
  }
}

function challenge(): Bytes {
  return crypto.getRandomValues(new Uint8Array(32));
}

function credential(value: Credential | null): PublicKeyCredential {
  if (
    !value ||
    value.type !== 'public-key' ||
    !(value instanceof PublicKeyCredential) ||
    value.rawId.byteLength === 0 ||
    value.rawId.byteLength > 1023
  ) {
    throw new PasskeyError(
      'No passkey was selected. Try again or use your recovery key.'
    );
  }
  return value;
}

function output(value: PublicKeyCredential): Bytes | null {
  const prf = value.getClientExtensionResults().prf;
  const first = prf?.results?.first;
  if (first === undefined) return null;
  const bytes = ArrayBuffer.isView(first)
    ? new Uint8Array(first.buffer, first.byteOffset, first.byteLength)
    : new Uint8Array(first);
  if (prf?.enabled === false) {
    bytes.fill(0);
    return null;
  }
  if (bytes.byteLength !== 32) {
    bytes.fill(0);
    throw new PasskeyError(
      'This passkey returned an invalid PRF result. Use another passkey or your recovery key.'
    );
  }
  const secret = new Uint8Array(bytes);
  bytes.fill(0);
  return secret;
}

async function selected(value: PublicKeyCredential): Promise<PasskeySecret> {
  const secret = output(value);
  if (!secret) {
    throw new PasskeyError(
      'This passkey does not support PRF unlock. Use another passkey or your recovery key.'
    );
  }
  try {
    const hash = await crypto.subtle.digest('SHA-256', value.rawId);
    return { targetId: `pk_${toHex(new Uint8Array(hash))}`, secret };
  } catch (error) {
    secret.fill(0);
    throw error;
  }
}

async function ceremony<T>(work: () => Promise<T>): Promise<T> {
  available();
  try {
    return await work();
  } catch (error) {
    if (error instanceof PasskeyError) throw error;
    if (
      error instanceof Error &&
      ['NotAllowedError', 'AbortError'].includes(error.name)
    ) {
      throw new PasskeyError(
        'The passkey prompt was canceled or timed out. Try again or use your recovery key.'
      );
    }
    throw new PasskeyError(
      'The passkey could not be used here. Try another passkey or your recovery key.'
    );
  }
}

/**
 * WebAuthn is a local unlock ceremony, not email-session authentication.
 * No assertion, PRF output or credential private key is sent to the Worker.
 * Discoverable credentials let a fresh browser select a passkey without an
 * unsigned server-provided credential-id mapping. Its id hash must match a
 * certified target before any wrap is opened. RP scope is this exact host.
 * https://www.w3.org/TR/webauthn-3/#prf-extension
 */
export const browserPasskeys: PasskeyPrf = {
  create: (userId) =>
    ceremony(async () => {
      const created = credential(
        await navigator.credentials.create({
          publicKey: {
            challenge: challenge(),
            rp: { name: 'OpenZCAD', id: location.hostname },
            user: {
              id: challenge(),
              name: userId,
              displayName: 'OpenZCAD encryption'
            },
            pubKeyCredParams: [
              { type: 'public-key', alg: -7 },
              { type: 'public-key', alg: -257 }
            ],
            authenticatorSelection: {
              residentKey: 'required',
              userVerification: 'required'
            },
            attestation: 'none',
            timeout: 60_000,
            extensions: { prf: { eval: { first: passkeyPrfInput() } } }
          }
        })
      );
      // Creation may enable PRF without evaluating it. Obtain an assertion
      // restricted to this exact credential before certifying any target.
      if (!created.getClientExtensionResults().prf?.results) {
        if (created.getClientExtensionResults().prf?.enabled !== true) {
          throw new PasskeyError(
            'This passkey does not support PRF unlock. Use another passkey or your recovery key.'
          );
        }
        const asserted = credential(
          await navigator.credentials.get({
            publicKey: {
              challenge: challenge(),
              rpId: location.hostname,
              allowCredentials: [{ type: 'public-key', id: created.rawId }],
              userVerification: 'required',
              timeout: 60_000,
              extensions: { prf: { eval: { first: passkeyPrfInput() } } }
            }
          })
        );
        if (
          toHex(new Uint8Array(asserted.rawId)) !==
          toHex(new Uint8Array(created.rawId))
        ) {
          output(asserted)?.fill(0);
          throw new PasskeyError(
            'A different passkey was returned. No unlock method was added.'
          );
        }
        return selected(asserted);
      }
      return selected(created);
    }),
  get: () =>
    ceremony(async () =>
      selected(
        credential(
          await navigator.credentials.get({
            publicKey: {
              challenge: challenge(),
              rpId: location.hostname,
              userVerification: 'required',
              timeout: 60_000,
              extensions: { prf: { eval: { first: passkeyPrfInput() } } }
            }
          })
        )
      )
    )
};

import { passkeyPrfInput, toHex, type Bytes } from '@openzcad/crypto';
import { isDesktopApp } from '../desktopBridge';
import {
  getKeySessionRevision,
  isCurrentKeySession,
  subscribeKeySession
} from './keySession';

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
  /** Provider-visible name, returned only for a newly created credential. */
  readonly enrollmentLabel?: string;
}

const failedEnrollments = new WeakMap<
  object,
  { label: string; targetId?: string }
>();

/** Preserve the original error's type, status and cancellation semantics. */
export function failedPasskeyEnrollment(
  error: unknown,
  label: string,
  targetId?: string
): Error {
  const failure =
    error instanceof Error
      ? error
      : new PasskeyError('Passkey enrollment could not be confirmed.');
  failedEnrollments.set(failure, { label, targetId });
  return failure;
}

export function passkeyEnrollmentCleanup(error: unknown): string | null {
  const enrollment =
    error instanceof Error ? failedEnrollments.get(error) : undefined;
  if (!enrollment) return null;
  const target = enrollment.targetId
    ? ` After reloading Encryption, remove any unlock method marked ${enrollment.targetId.slice(3, 15)} as well.`
    : '';
  return `Before creating another passkey, remove only "${enrollment.label}" from the passkey provider where you saved it.${target} Use your recovery key or another device in the meantime.`;
}

export interface PasskeyPrf {
  create(): Promise<PasskeySecret>;
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

async function ceremony(
  work: (signal: AbortSignal) => Promise<PasskeySecret>
): Promise<PasskeySecret> {
  available();
  const revision = getKeySessionRevision();
  const controller = new AbortController();
  const unsubscribe = subscribeKeySession(() => {
    if (!isCurrentKeySession(revision)) controller.abort();
  });
  try {
    if (!isCurrentKeySession(revision)) {
      throw new DOMException('The account session ended.', 'AbortError');
    }
    const result = await work(controller.signal);
    if (controller.signal.aborted) {
      result.secret.fill(0);
      throw new DOMException('The account session ended.', 'AbortError');
    }
    return result;
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
  } finally {
    unsubscribe();
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
  create: async () => {
    const handle = challenge();
    const label = `OpenZCAD encryption ${toHex(handle.slice(0, 6))}`;
    let credentialCreated = false;
    try {
      const selectedPasskey = await ceremony(async (signal) => {
        const value = await navigator.credentials.create({
          signal,
          publicKey: {
            challenge: challenge(),
            rp: { name: 'OpenZCAD', id: location.hostname },
            user: {
              id: handle,
              name: label,
              displayName: label
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
        });
        credentialCreated = value !== null;
        const created = credential(value);
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
              signal,
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
      });
      return { ...selectedPasskey, enrollmentLabel: label };
    } catch (error) {
      throw credentialCreated ? failedPasskeyEnrollment(error, label) : error;
    }
  },
  get: () =>
    ceremony(async (signal) =>
      selected(
        credential(
          await navigator.credentials.get({
            signal,
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

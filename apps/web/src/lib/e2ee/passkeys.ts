import { passkeyPrfInput, toHex, type Bytes } from '@openzcad/crypto';
import { isDesktopApp } from '../desktopBridge';
import { isIosShell } from '../nativeShell';
import {
  getKeySessionRevision,
  isCurrentKeySession,
  subscribeKeySession
} from './keySession';
import {
  currentPasskeyPlatform,
  noPrfGuidance,
  passkeyErrorHint,
  type PasskeyCeremony
} from './passkeyPlatform';

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

/**
 * Five minutes for each WebAuthn prompt. A phone reached through a QR code
 * (hybrid transport) or a slow Windows Hello prompt can take longer than a
 * minute; cancellation still aborts the prompt at once.
 */
export const PASSKEY_CEREMONY_TIMEOUT_MS = 300_000;

/** How long to wait for the browser to accept an unknown-credential signal. */
const SIGNAL_TIMEOUT_MS = 5_000;

const failedEnrollments = new WeakMap<
  object,
  { label: string; targetId?: string; signalled: boolean }
>();

/** Preserve the original error's type, status and cancellation semantics. */
export function failedPasskeyEnrollment(
  error: unknown,
  label: string,
  targetId?: string,
  options: { signalled?: boolean } = {}
): Error {
  const failure =
    error instanceof Error
      ? error
      : new PasskeyError('Passkey enrollment could not be confirmed.');
  failedEnrollments.set(failure, {
    label,
    targetId,
    signalled: options.signalled === true
  });
  return failure;
}

/**
 * Manual cleanup advice for a credential saved by a failed enrollment, or
 * null when no credential was saved. A WebAuthn signal resolving only means
 * the browser accepted the request, not that the provider removed the
 * credential (WebAuthn L3 §5.1.10), so the advice still names the label,
 * conditionally, after a signal.
 */
export function passkeyEnrollmentCleanup(error: unknown): string | null {
  const enrollment =
    error instanceof Error ? failedEnrollments.get(error) : undefined;
  if (!enrollment) return null;
  const target = enrollment.targetId
    ? ` After reloading Encryption, remove any unlock method marked ${enrollment.targetId.slice(3, 15)} as well.`
    : '';
  if (enrollment.signalled) {
    return `Your passkey provider was asked to delete "${enrollment.label}". If it still lists it, remove only that passkey before creating another.${target} Use your recovery key or another device in the meantime.`;
  }
  return `Before creating another passkey, remove only "${enrollment.label}" from the passkey provider where you saved it.${target} Use your recovery key or another device in the meantime.`;
}

export interface PasskeyPrf {
  create(): Promise<PasskeySecret>;
  get(): Promise<PasskeySecret>;
}

export function passkeysAvailable(): boolean {
  return (
    !isDesktopApp() &&
    // The iPhone and iPad app never calls `navigator.credentials` on its
    // private origin; its passkeys arrive with the native bridge (ADR-026).
    !isIosShell() &&
    globalThis.isSecureContext === true &&
    typeof PublicKeyCredential !== 'undefined' &&
    typeof navigator.credentials?.create === 'function' &&
    typeof navigator.credentials?.get === 'function'
  );
}

export type PasskeyPrfSupport = 'supported' | 'unsupported' | 'unknown';

/**
 * Whether this browser says it can evaluate the PRF extension that passkey
 * unlock needs (WebAuthn Level 3 `getClientCapabilities`). This is the
 * browser's capability, not the authenticator's: `supported` only means a
 * passkey is worth offering, because the provider the user then picks (an
 * older Windows Hello, a phone over Safari's QR flow, a security key without
 * hmac-secret) may still return no PRF result, and `create` then fails
 * closed with platform guidance. Copy must not promise success from it.
 * `unknown` where the browser does not say: offering a passkey is still worth
 * a try. A browser that says no is never offered the step at all.
 */
export async function passkeyPrfSupport(): Promise<PasskeyPrfSupport> {
  if (!passkeysAvailable()) return 'unsupported';
  const capabilities = (
    PublicKeyCredential as unknown as {
      getClientCapabilities?: () => Promise<Record<string, boolean>>;
    }
  ).getClientCapabilities;
  if (typeof capabilities !== 'function') return 'unknown';
  try {
    const reported = (await capabilities.call(PublicKeyCredential))[
      'extension:prf'
    ];
    return reported === true
      ? 'supported'
      : reported === false
        ? 'unsupported'
        : 'unknown';
  } catch {
    return 'unknown';
  }
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Brand check that also accepts an ArrayBuffer from another realm. */
function isArrayBuffer(value: unknown): value is ArrayBuffer {
  if (!isObject(value)) return false;
  try {
    ArrayBuffer.prototype.slice.call(value, 0, 0);
    return true;
  } catch {
    return false;
  }
}

/** A validated credential: its id copied, its extension outputs read once. */
interface SelectedCredential {
  readonly rawId: ArrayBuffer;
  readonly extensions: unknown;
}

/**
 * Structural, not `instanceof PublicKeyCredential`: password-manager
 * extensions (1Password, Bitwarden, Proton Pass, KeePassXC) answer with
 * their own credential objects. Accepting them costs nothing, because the
 * PRF secret must still open a certified target before anything unlocks.
 */
function credential(value: unknown): SelectedCredential {
  let rawId: ArrayBuffer | undefined;
  if (
    isObject(value) &&
    value.type === 'public-key' &&
    typeof value.getClientExtensionResults === 'function' &&
    isArrayBuffer(value.rawId)
  ) {
    const copy = ArrayBuffer.prototype.slice.call(value.rawId, 0);
    if (copy.byteLength > 0 && copy.byteLength <= 1023) rawId = copy;
  }
  if (!rawId || !isObject(value)) {
    throw new PasskeyError(
      'No passkey was selected. Try again or use your recovery key.'
    );
  }
  const extensions: unknown = (
    value.getClientExtensionResults as () => unknown
  ).call(value);
  return { rawId, extensions };
}

type PrfOutcome =
  | { readonly kind: 'output'; readonly secret: Bytes }
  | { readonly kind: 'enabled' }
  | { readonly kind: 'absent' };

function invalidPrf(): PasskeyError {
  return new PasskeyError(
    'This passkey returned an invalid PRF result. Use another passkey or your recovery key.'
  );
}

/** Erase a provider's PRF output in place, whatever its shape. */
function erase(first: unknown): void {
  if (Array.isArray(first)) first.fill(0);
  else if (ArrayBuffer.isView(first)) {
    new Uint8Array(first.buffer, first.byteOffset, first.byteLength).fill(0);
  } else if (isArrayBuffer(first)) new Uint8Array(first).fill(0);
}

/**
 * Copy a PRF output into a fresh 32-byte secret and erase the provider's
 * copy. Accepts an ArrayBuffer, any ArrayBufferView, or the plain Array of
 * byte values 1Password's extension returns (exactly 32 integers 0..255).
 */
function prfBytes(first: unknown): Bytes {
  if (Array.isArray(first)) {
    // Index every slot: `every` skips the holes of a sparse array, which
    // `Uint8Array.from` would then fill with zeros.
    let valid = first.length === 32;
    for (let index = 0; valid && index < 32; index += 1) {
      const byte: unknown = first[index];
      valid =
        Object.prototype.hasOwnProperty.call(first, index) &&
        Number.isInteger(byte) &&
        (byte as number) >= 0 &&
        (byte as number) <= 255;
    }
    const secret = valid ? Uint8Array.from(first as number[]) : undefined;
    first.fill(0);
    if (!secret) throw invalidPrf();
    return secret;
  }
  let bytes: Uint8Array;
  if (ArrayBuffer.isView(first)) {
    bytes = new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  } else if (isArrayBuffer(first)) {
    bytes = new Uint8Array(first);
  } else {
    throw invalidPrf();
  }
  if (bytes.byteLength !== 32) {
    bytes.fill(0);
    throw invalidPrf();
  }
  const secret = new Uint8Array(bytes);
  bytes.fill(0);
  return secret;
}

/**
 * Classify a credential's PRF extension output. Browsers differ:
 * Chrome reports a missing PRF as `{ enabled: false }`, Firefox as an empty
 * `{}`, Safari creates with `{ enabled: true }` and no result, and an
 * extension may return the result as a plain Array.
 */
function prfOutcome(extensions: unknown): PrfOutcome {
  const prf = isObject(extensions) ? extensions.prf : undefined;
  if (!isObject(prf)) return { kind: 'absent' };
  const first = isObject(prf.results) ? prf.results.first : undefined;
  if (prf.enabled === false) {
    erase(first);
    return { kind: 'absent' };
  }
  if (first === undefined || first === null) {
    return prf.enabled === true ? { kind: 'enabled' } : { kind: 'absent' };
  }
  return { kind: 'output', secret: prfBytes(first) };
}

function noPrf(ceremony: PasskeyCeremony): PasskeyError {
  return new PasskeyError(noPrfGuidance(currentPasskeyPlatform(), ceremony));
}

async function selected(
  rawId: ArrayBuffer,
  secret: Bytes
): Promise<PasskeySecret> {
  try {
    const hash = await crypto.subtle.digest('SHA-256', rawId);
    return { targetId: `pk_${toHex(new Uint8Array(hash))}`, secret };
  } catch (error) {
    secret.fill(0);
    throw error;
  }
}

async function selectedOutput(
  value: SelectedCredential,
  ceremony: PasskeyCeremony
): Promise<PasskeySecret> {
  const outcome = prfOutcome(value.extensions);
  if (outcome.kind !== 'output') throw noPrf(ceremony);
  return selected(value.rawId, outcome.secret);
}

function errorName(error: unknown): string | undefined {
  return isObject(error) && typeof error.name === 'string'
    ? error.name
    : undefined;
}

function withHint(message: string, name: string): string {
  const hint = passkeyErrorHint(name, currentPasskeyPlatform());
  return hint ? `${message} ${hint}` : message;
}

/** Map a WebAuthn DOMException to an actionable PasskeyError. */
function ceremonyFailure(error: unknown): PasskeyError {
  const name = errorName(error);
  switch (name) {
    case 'NotAllowedError':
    case 'AbortError':
      return new PasskeyError(
        'The passkey prompt was canceled or timed out. Try again or use your recovery key.'
      );
    case 'InvalidStateError':
      return new PasskeyError(
        'This passkey is already registered on this authenticator. Use the passkey you already have, or save the new one somewhere else.'
      );
    case 'NotSupportedError':
      return new PasskeyError(
        withHint(
          'This authenticator can’t make a passkey OpenZCAD can use: encryption needs one that stays on the authenticator and checks your PIN, fingerprint or face. Choose another passkey provider or a security key, or use your recovery key.',
          name
        )
      );
    case 'SecurityError':
      return new PasskeyError(
        'The browser refused the passkey because this page is not on the OpenZCAD site it was made for, or not on a secure (https) connection. Open OpenZCAD at its usual address and try again, or use your recovery key.'
      );
    case 'ConstraintError':
      return new PasskeyError(
        withHint(
          'This authenticator can’t verify it’s you because no PIN, fingerprint or face unlock is set up. Set one up, choose another passkey provider, or use your recovery key.',
          name
        )
      );
    default:
      return new PasskeyError(
        'The passkey could not be used here. Try another passkey or your recovery key.'
      );
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
    throw ceremonyFailure(error);
  } finally {
    unsubscribe();
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Ask the passkey provider to delete a credential this browser just created
 * and never certified (WebAuthn Signal API, `signalUnknownCredential`).
 * Returns whether the browser accepted the signal; a provider may still
 * ignore it, and false means the user must remove the passkey by hand.
 * Never call this for a credential that might have been certified.
 */
async function signalUncertified(rawId: ArrayBuffer): Promise<boolean> {
  const api = globalThis.PublicKeyCredential as unknown as
    | {
        signalUnknownCredential?: (options: {
          rpId: string;
          credentialId: string;
        }) => Promise<void>;
      }
    | undefined;
  const signal = api?.signalUnknownCredential;
  if (typeof signal !== 'function') return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal.call(api, {
        rpId: location.hostname,
        credentialId: base64url(new Uint8Array(rawId))
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Signal timed out')),
          SIGNAL_TIMEOUT_MS
        );
      })
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function sameId(a: ArrayBuffer, b: ArrayBuffer): boolean {
  return toHex(new Uint8Array(a)) === toHex(new Uint8Array(b));
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
    let createdId: ArrayBuffer | undefined;
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
            timeout: PASSKEY_CEREMONY_TIMEOUT_MS,
            extensions: { prf: { eval: { first: passkeyPrfInput() } } }
          }
        });
        credentialCreated = value !== null;
        const created = credential(value);
        createdId = created.rawId;
        const outcome = prfOutcome(created.extensions);
        if (outcome.kind === 'output') {
          return selected(created.rawId, outcome.secret);
        }
        if (outcome.kind === 'absent') throw noPrf('create');
        // Creation may enable PRF without evaluating it (Safari does). Obtain
        // an assertion restricted to this exact credential before certifying
        // any target: a second prompt on that path.
        const asserted = credential(
          await navigator.credentials.get({
            signal,
            publicKey: {
              challenge: challenge(),
              rpId: location.hostname,
              allowCredentials: [{ type: 'public-key', id: created.rawId }],
              userVerification: 'required',
              timeout: PASSKEY_CEREMONY_TIMEOUT_MS,
              extensions: { prf: { eval: { first: passkeyPrfInput() } } }
            }
          })
        );
        if (!sameId(asserted.rawId, created.rawId)) {
          try {
            const discarded = prfOutcome(asserted.extensions);
            if (discarded.kind === 'output') discarded.secret.fill(0);
          } catch {
            // Malformed output was already erased.
          }
          throw new PasskeyError(
            'A different passkey was returned. No unlock method was added.'
          );
        }
        return selectedOutput(asserted, 'create');
      });
      return { ...selectedPasskey, enrollmentLabel: label };
    } catch (error) {
      if (!credentialCreated) throw error;
      // Nothing has been certified yet: this credential can never unlock,
      // so ask the provider to forget it instead of leaving an orphan.
      const signalled = createdId ? await signalUncertified(createdId) : false;
      throw failedPasskeyEnrollment(error, label, undefined, { signalled });
    }
  },
  get: () =>
    ceremony(async (signal) =>
      selectedOutput(
        credential(
          await navigator.credentials.get({
            signal,
            publicKey: {
              challenge: challenge(),
              rpId: location.hostname,
              userVerification: 'required',
              timeout: PASSKEY_CEREMONY_TIMEOUT_MS,
              extensions: { prf: { eval: { first: passkeyPrfInput() } } }
            }
          })
        ),
        'get'
      )
    )
};

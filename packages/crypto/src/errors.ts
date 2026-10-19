/**
 * Every failure this package raises is an `E2eeError` with a stable `code`,
 * so callers can tell a hostile or corrupt blob (`authentication-failed`,
 * `malformed`) from a newer client's format (`unsupported-version`) or their
 * own bug (`invalid-argument`) without parsing messages.
 */
export type E2eeErrorCode =
  /** Bytes do not follow the format: truncated, trailing data, bad lengths. */
  | 'malformed'
  /** A version byte this build does not know; a newer client wrote it. */
  | 'unsupported-version'
  /** AES-GCM refused: wrong key, wrong context, or tampered bytes. */
  | 'authentication-failed'
  /** Authentic, but not the blob the caller asked for (project, epoch…). */
  | 'context-mismatch'
  /** The caller passed something this API does not accept. */
  | 'invalid-argument'
  /** An envelope key was offered for a second envelope (nonce reuse). */
  | 'key-reused'
  /** A version chain does not link, or does not contain the pin. */
  | 'chain-broken'
  /** A stream was cancelled or its source failed before it finished. */
  | 'aborted'
  /** A size limit was exceeded (header, chunk count, decompressed size). */
  | 'limit-exceeded'
  /** WebCrypto or CompressionStream is missing from this runtime. */
  | 'unavailable';

export class E2eeError extends Error {
  override readonly name = 'E2eeError';
  readonly code: E2eeErrorCode;

  constructor(code: E2eeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export function isE2eeError(
  error: unknown,
  code?: E2eeErrorCode
): error is E2eeError {
  return (
    error instanceof E2eeError && (code === undefined || error.code === code)
  );
}

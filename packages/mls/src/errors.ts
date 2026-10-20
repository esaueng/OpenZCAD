/**
 * Errors from the MLS layer. A `policy` error lists every rule that refused
 * the operation, each with a stable code.
 */

export type MlsErrorKind = 'policy' | 'mls' | 'state' | 'input' | 'worker';

export type PolicyReasonCode =
  | 'credential-invalid'
  | 'credential-revoked'
  | 'credential-unknown'
  | 'external-commit-foreign-removal'
  | 'external-commit-proposal'
  | 'identity-not-listed'
  | 'leaf-key-reused'
  | 'leaf-without-role'
  | 'proposal-forbidden'
  | 'rejoin-psk-before-leaf-removal'
  | 'rejoin-psk-before-revocation'
  | 'rejoin-psk-before-role-change'
  | 'rejoin-psk-future'
  | 'rejoin-psk-invalid'
  | 'rejoin-psk-missing'
  | 'rejoin-psk-multiple'
  | 'rejoin-psk-outside-window'
  | 'role-forbidden'
  | 'role-not-listed'
  | 'roles-invalid';

export interface PolicyReason {
  code: PolicyReasonCode;
  detail: string;
}

export class MlsError extends Error {
  override readonly name = 'MlsError';
  readonly kind: MlsErrorKind;
  readonly reasons: readonly PolicyReason[];

  constructor(
    kind: MlsErrorKind,
    message: string,
    reasons: readonly PolicyReason[] = []
  ) {
    super(message);
    this.kind = kind;
    this.reasons = reasons;
  }

  /** The reason codes, for matching. */
  get codes(): PolicyReasonCode[] {
    return this.reasons.map((r) => r.code);
  }
}

export function isMlsError(value: unknown): value is MlsError {
  return value instanceof MlsError;
}

const KINDS: readonly MlsErrorKind[] = [
  'policy',
  'mls',
  'state',
  'input',
  'worker'
];

/** Rebuild an MlsError from a WASM error or its structured-clone form. */
export function toMlsError(error: unknown): MlsError {
  if (error instanceof MlsError) return error;
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const kind = KINDS.includes(record.kind as MlsErrorKind)
      ? (record.kind as MlsErrorKind)
      : null;
    const message =
      typeof record.message === 'string' ? record.message : 'unknown error';
    if (kind) {
      let reasons: PolicyReason[] = [];
      if (typeof record.reasonsJson === 'string') {
        reasons = JSON.parse(record.reasonsJson) as PolicyReason[];
      } else if (Array.isArray(record.reasons)) {
        reasons = record.reasons as PolicyReason[];
      }
      return new MlsError(kind, message, reasons);
    }
    return new MlsError('worker', message);
  }
  return new MlsError('worker', String(error));
}

/** Structured-clone form, for posting across the Worker boundary. */
export function serializeError(error: unknown): {
  kind: MlsErrorKind;
  message: string;
  reasons: PolicyReason[];
} {
  const mls = toMlsError(error);
  return { kind: mls.kind, message: mls.message, reasons: [...mls.reasons] };
}

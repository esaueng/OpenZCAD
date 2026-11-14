/**
 * What this device durably knows of each project's assistant consent
 * (ADR-024 Phase 6), per account and project: the highest consent sequence
 * it accepted (the pin), and the highest sequence it revoked at. Free of
 * any crypto import, so the send gate in `api.ts` reads it synchronously,
 * immediately before every assistant request leaves (`projectWriteGate.ts`).
 *
 * A verified consent is only ever the answer to one read: it travels with
 * its request as `{userId, projectId, sequence}`, and the request is
 * refused at its send if this device has since accepted a later record (a
 * Stop or Allow saved in another tab moves the pin past it) or revoked at
 * or past its sequence (a Stop recorded here, even one whose save then
 * failed). A late answer to an earlier read can therefore never send after
 * a revocation this device saw, whatever order the account releases its
 * answers in.
 */

/** The consent a request was verified for, right before it was sent. */
export interface VerifiedAssistantConsent {
  readonly userId: string;
  readonly projectId: string;
  /** The verified record's sequence. */
  readonly sequence: number;
}

/** The highest consent sequence this device accepted, per account and project. */
export interface ConsentPinStore {
  read(userId: string, projectId: string): Promise<number | null>;
  write(userId: string, projectId: string, sequence: number): Promise<void>;
  /** The highest sequence this device revoked at; null when none. */
  revoked(userId: string, projectId: string): Promise<number | null>;
  /**
   * Records a revocation at `sequence`: no consent at or below it is used
   * again here. Only moves forward.
   */
  revoke(userId: string, projectId: string, sequence: number): Promise<void>;
}

export const ASSISTANT_CONSENT_PIN_PREFIX =
  'openzcad:e2ee-assistant-consent-pin:v1:';
export const ASSISTANT_CONSENT_REVOKED_PREFIX =
  'openzcad:e2ee-assistant-consent-revoked:v1:';

export const assistantConsentPinKey = (userId: string, projectId: string) =>
  `${ASSISTANT_CONSENT_PIN_PREFIX}${userId}:${projectId}`;
export const assistantConsentRevokedKey = (userId: string, projectId: string) =>
  `${ASSISTANT_CONSENT_REVOKED_PREFIX}${userId}:${projectId}`;

type ConsentStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): ConsentStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function sequenceOf(value: string | null): number | null {
  const parsed = Number(value ?? NaN);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

/** A key's sequence; `undefined` when storage cannot be read. */
function readSequence(
  storage: ConsentStorage | null,
  key: string
): number | null | undefined {
  if (!storage) return undefined;
  try {
    return sequenceOf(storage.getItem(key));
  } catch {
    return undefined;
  }
}

function writeForward(
  storage: ConsentStorage | null,
  key: string,
  sequence: number
): void {
  if (!storage || !Number.isSafeInteger(sequence) || sequence < 1) return;
  try {
    const current = sequenceOf(storage.getItem(key));
    // Only moves forward, whichever tab writes it.
    if (current === null || sequence > current) {
      storage.setItem(key, String(sequence));
    }
  } catch {
    /* Not saved: the send check then refuses (see `assistantConsentCurrent`). */
  }
}

/**
 * Pins in localStorage. Storage that is blocked or cleared loses the pin,
 * which only weakens rollback detection back to first use; it never makes a
 * forged record verify. The send check reads the same keys, and refuses
 * when it cannot.
 */
export function localStorageConsentPins(
  storage: ConsentStorage | null = defaultStorage()
): ConsentPinStore {
  return {
    async read(userId, projectId) {
      return (
        readSequence(storage, assistantConsentPinKey(userId, projectId)) ?? null
      );
    },
    async write(userId, projectId, sequence) {
      writeForward(
        storage,
        assistantConsentPinKey(userId, projectId),
        sequence
      );
    },
    async revoked(userId, projectId) {
      return (
        readSequence(storage, assistantConsentRevokedKey(userId, projectId)) ??
        null
      );
    },
    async revoke(userId, projectId, sequence) {
      writeForward(
        storage,
        assistantConsentRevokedKey(userId, projectId),
        sequence
      );
    }
  };
}

export function memoryConsentPins(): ConsentPinStore {
  const pins = new Map<string, number>();
  const forward = (key: string, sequence: number) => {
    if (sequence > (pins.get(key) ?? 0)) pins.set(key, sequence);
  };
  return {
    read: async (userId, projectId) =>
      pins.get(assistantConsentPinKey(userId, projectId)) ?? null,
    write: async (userId, projectId, sequence) =>
      forward(assistantConsentPinKey(userId, projectId), sequence),
    revoked: async (userId, projectId) =>
      pins.get(assistantConsentRevokedKey(userId, projectId)) ?? null,
    revoke: async (userId, projectId, sequence) =>
      forward(assistantConsentRevokedKey(userId, projectId), sequence)
  };
}

/**
 * Synchronously, immediately before an assistant request is sent: whether
 * the consent it was verified for is still this device's latest word for
 * the project. False when this device accepted a later record, revoked at
 * or past it, or cannot read what it knows (storage blocked or cleared:
 * unknown is not allowed).
 */
export function assistantConsentCurrent(
  consent: VerifiedAssistantConsent,
  storage: ConsentStorage | null = defaultStorage()
): boolean {
  if (!Number.isSafeInteger(consent.sequence) || consent.sequence < 1) {
    return false;
  }
  const pinned = readSequence(
    storage,
    assistantConsentPinKey(consent.userId, consent.projectId)
  );
  const revoked = readSequence(
    storage,
    assistantConsentRevokedKey(consent.userId, consent.projectId)
  );
  // Verifying a record pins it, so a missing pin means it was lost.
  if (pinned === undefined || pinned === null || revoked === undefined) {
    return false;
  }
  return (
    consent.sequence >= pinned &&
    (revoked === null || consent.sequence > revoked)
  );
}

/**
 * A Stop, recorded synchronously before anything is awaited: every consent
 * this device has accepted so far (up to its pin) is revoked here at once,
 * whatever becomes of the revocation's save.
 */
export function revokeKnownAssistantConsent(
  userId: string,
  projectId: string,
  storage: ConsentStorage | null = defaultStorage()
): void {
  const pinned = readSequence(
    storage,
    assistantConsentPinKey(userId, projectId)
  );
  if (pinned) {
    writeForward(
      storage,
      assistantConsentRevokedKey(userId, projectId),
      pinned
    );
  }
}

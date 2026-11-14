/**
 * What this device durably knows of each project's assistant consent
 * (ADR-024 Phase 6), per account and project: the highest consent sequence
 * it accepted (the pin), and the highest sequence it revoked at. Free of
 * any crypto import, so the send gate in `api.ts` reads it synchronously,
 * immediately before every assistant request leaves (`projectWriteGate.ts`).
 *
 * A verified consent is only ever the answer to one read: it travels with
 * its request as `{userId, projectId, sequence, stops}`, and the request is
 * refused at its send if this device has since accepted a later record (a
 * Stop or Allow saved in another tab moves the pin past it) or revoked at
 * or past its sequence (a Stop recorded here, even one whose save then
 * failed). A late answer to an earlier read can therefore never send after
 * a revocation this device saw, whatever order the account releases its
 * answers in.
 *
 * Every Stop also moves this device's stop generation for the project
 * (`assistantStopGeneration`), synchronously, before anything is awaited.
 * A verified consent carries the generation read before the read or Allow
 * that produced it began, and is refused at its send if a Stop came since:
 * an Allow that was in flight in one tab when another tab stopped cannot
 * outrank that Stop, whichever sequence its save then took.
 *
 * Storage that refuses a revocation or a Stop does not drop it: this tab
 * keeps it in memory and tells this device's other tabs over a broadcast
 * channel, so their grants are refused too.
 */

/** The consent a request was verified for, right before it was sent. */
export interface VerifiedAssistantConsent {
  readonly userId: string;
  readonly projectId: string;
  /** The verified record's sequence. */
  readonly sequence: number;
  /**
   * This device's stop generation for the project, read before the read
   * or Allow that verified the record began (`assistantStopGeneration`).
   */
  readonly stops: string;
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
export const ASSISTANT_CONSENT_STOPS_PREFIX =
  'openzcad:e2ee-assistant-consent-stops:v1:';

export const assistantConsentPinKey = (userId: string, projectId: string) =>
  `${ASSISTANT_CONSENT_PIN_PREFIX}${userId}:${projectId}`;
export const assistantConsentRevokedKey = (userId: string, projectId: string) =>
  `${ASSISTANT_CONSENT_REVOKED_PREFIX}${userId}:${projectId}`;
export const assistantConsentStopsKey = (userId: string, projectId: string) =>
  `${ASSISTANT_CONSENT_STOPS_PREFIX}${userId}:${projectId}`;

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
    /* Not saved: held in memory instead (`revokeAt`), or the send check refuses. */
  }
}

/**
 * What this tab knows of revocations and Stops whatever storage kept: the
 * highest sequence revoked, and how many Stops it saw, per account and
 * project. Only ever rises while the page lives.
 */
const heldRevocations = new Map<string, number>();
const stopsSeen = new Map<string, number>();

function holdRevocation(userId: string, projectId: string, sequence: number) {
  const key = assistantConsentRevokedKey(userId, projectId);
  if (sequence > (heldRevocations.get(key) ?? 0)) {
    heldRevocations.set(key, sequence);
  }
}

function countStop(userId: string, projectId: string) {
  const key = assistantConsentStopsKey(userId, projectId);
  stopsSeen.set(key, (stopsSeen.get(key) ?? 0) + 1);
}

/** A Stop or a revocation, as this device's other tabs hear of it. */
interface ConsentNews {
  readonly kind: 'stop' | 'revoke';
  readonly userId: string;
  readonly projectId: string;
  readonly revoked: number | null;
}

export const ASSISTANT_CONSENT_CHANNEL = 'openzcad:e2ee-assistant-consent';

/** Applies another tab's Stop or revocation to this tab's memory. */
function hear(news: unknown): void {
  if (!news || typeof news !== 'object') return;
  const { kind, userId, projectId, revoked } = news as Partial<ConsentNews>;
  if (typeof userId !== 'string' || typeof projectId !== 'string') return;
  if (kind === 'stop') countStop(userId, projectId);
  else if (kind !== 'revoke') return;
  if (typeof revoked === 'number' && Number.isSafeInteger(revoked)) {
    holdRevocation(userId, projectId, revoked);
  }
}

/** Opened when the module loads, so this tab hears of every later Stop. */
const channel: BroadcastChannel | null = (() => {
  try {
    if (typeof BroadcastChannel !== 'function') return null;
    const opened = new BroadcastChannel(ASSISTANT_CONSENT_CHANNEL);
    opened.onmessage = (event: MessageEvent) => hear(event.data);
    // Node's channel (tests) would otherwise hold the process open.
    (opened as { unref?: () => void }).unref?.();
    return opened;
  } catch {
    return null;
  }
})();

function tell(news: ConsentNews): void {
  try {
    channel?.postMessage(news);
  } catch {
    /* No other tab hears of it; this tab still holds it. */
  }
}

/**
 * The highest sequence revoked here, stored or held by this tab;
 * `undefined` when storage cannot be read.
 */
function readRevoked(
  storage: ConsentStorage | null,
  userId: string,
  projectId: string
): number | null | undefined {
  const key = assistantConsentRevokedKey(userId, projectId);
  const stored = readSequence(storage, key);
  if (stored === undefined) return undefined;
  const held = heldRevocations.get(key) ?? null;
  return stored === null || (held !== null && held > stored) ? held : stored;
}

/**
 * Records a revocation at `sequence`: held in this tab's memory, saved to
 * storage where it can be, and told to this device's other tabs.
 */
function revokeAt(
  storage: ConsentStorage | null,
  userId: string,
  projectId: string,
  sequence: number,
  kind: ConsentNews['kind']
): void {
  if (kind === 'stop') countStop(userId, projectId);
  const valid = Number.isSafeInteger(sequence) && sequence >= 1;
  if (valid) {
    holdRevocation(userId, projectId, sequence);
    writeForward(
      storage,
      assistantConsentRevokedKey(userId, projectId),
      sequence
    );
  }
  if (kind === 'stop' || valid) {
    tell({ kind, userId, projectId, revoked: valid ? sequence : null });
  }
}

/**
 * Pins in localStorage. Storage that is blocked or cleared loses the pin,
 * which only weakens rollback detection back to first use; it never makes a
 * forged record verify. The send check reads the same keys, and refuses
 * when it cannot. A revocation storage refuses is still held by this tab.
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
      return readRevoked(storage, userId, projectId) ?? null;
    },
    async revoke(userId, projectId, sequence) {
      revokeAt(storage, userId, projectId, sequence, 'revoke');
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
 * This device's stop generation for the project: the Stops any tab stored,
 * and those this tab saw. Read before a consent read or an Allow begins,
 * and compared again before its save, before its answer is accepted, and
 * at the send: any Stop in between refuses it.
 */
export function assistantStopGeneration(
  userId: string,
  projectId: string,
  storage: ConsentStorage | null = defaultStorage()
): string {
  const key = assistantConsentStopsKey(userId, projectId);
  const stored = readSequence(storage, key);
  return `${stored === undefined ? '?' : (stored ?? 0)}.${stopsSeen.get(key) ?? 0}`;
}

/**
 * Synchronously, immediately before an assistant request is sent: whether
 * the consent it was verified for is still this device's latest word for
 * the project. False when a Stop came since it was read, this device
 * accepted a later record, revoked at or past it (in storage or held by
 * this tab), or cannot read what it knows (storage blocked or cleared:
 * unknown is not allowed).
 */
export function assistantConsentCurrent(
  consent: VerifiedAssistantConsent,
  storage: ConsentStorage | null = defaultStorage()
): boolean {
  if (!Number.isSafeInteger(consent.sequence) || consent.sequence < 1) {
    return false;
  }
  if (
    consent.stops !==
    assistantStopGeneration(consent.userId, consent.projectId, storage)
  ) {
    return false;
  }
  const pinned = readSequence(
    storage,
    assistantConsentPinKey(consent.userId, consent.projectId)
  );
  const revoked = readRevoked(storage, consent.userId, consent.projectId);
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
 * A Stop, recorded synchronously before anything is awaited: the stop
 * generation moves, and every consent this device has accepted so far (up
 * to its pin) is revoked here at once, whatever becomes of the
 * revocation's save. Storage that refuses either leaves both held in this
 * tab's memory and told to this device's other tabs.
 */
export function revokeKnownAssistantConsent(
  userId: string,
  projectId: string,
  storage: ConsentStorage | null = defaultStorage()
): void {
  const key = assistantConsentStopsKey(userId, projectId);
  if (storage) {
    try {
      storage.setItem(key, String((sequenceOf(storage.getItem(key)) ?? 0) + 1));
    } catch {
      /* Counted in memory and told to the other tabs (`revokeAt`). */
    }
  }
  const pinned = readSequence(
    storage,
    assistantConsentPinKey(userId, projectId)
  );
  revokeAt(storage, userId, projectId, pinned ?? 0, 'stop');
}

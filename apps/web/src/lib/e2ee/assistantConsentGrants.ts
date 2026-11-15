/**
 * This device's own grants of the assistant on encrypted projects.
 *
 * The account's consent record (`assistantConsent.ts`) says the owner
 * allowed the assistant for a project; it is MAC'd, so the Worker cannot
 * forge one, but it is read over the network and a send gate must decide
 * synchronously. A grant is this device's durable note that its user
 * clicked Allow here for that verified record: the record's `sequence`,
 * provider `route` and copy version, a fresh id, and the project's stop
 * generation it was made under. An assistant request for an encrypted
 * project carries the grant it was confirmed under (`AssistantSendConsent`),
 * and the send gate (`api.ts`) refuses it unless that grant is still the
 * one stored here at the send, under the current stop generation, and no
 * older than the newest consent record this device has verified.
 *
 * Ordering (a Stop wins):
 * - A grant is made only by an Allow clicked on this device, never by an
 *   account read, so nothing the account answers can bring back a grant a
 *   Stop removed.
 * - Each project has a stop generation: one key holding a random token,
 *   written only by a Stop, never removed (no key reads as `none`). An
 *   Allow reads it and registers itself as pending before anything is
 *   awaited (`beginAssistantAllow`); it never writes the generation, so it
 *   cannot overwrite a Stop. A Stop, in any tab, first writes a new
 *   generation, then removes the pending id and the grant, synchronously,
 *   before it awaits anything (`stopAssistantGrant`). A grant counts only
 *   under the generation it was made under, so a grant an Allow writes
 *   after another tab's Stop, however the tabs' storage operations
 *   interleave, is never read as current by any tab. The Allow also
 *   completes only if its own pending id is still there
 *   (`completeAssistantAllow`), so of two Allows in flight only the last
 *   one clicked can grant.
 * - A Stop that cannot write its generation (a full store) still removes
 *   the keys, retries the write in the room that frees, and is held in
 *   this tab's memory until an Allow completes here. Storage that cannot
 *   be read reads as no grant, so nothing is sent.
 * - A grant whose record is older than a record this device has verified
 *   since is not current (`raiseAssistantConsentFloor`): once any tab has
 *   verified a Stop, or a newer record from another device, a request
 *   confirmed under the older one is refused at the send. The floor is one
 *   key per verified sequence, never overwritten, so concurrent writers
 *   cannot lower it; where its key cannot be written, the older grant is
 *   removed instead.
 *
 * Keyed by account and project. Free of crypto imports (as the pins are),
 * because `api.ts` checks grants synchronously at the send.
 */
import type { AssistantSendConsent } from '../projectWriteGate';

export type GrantStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'
>;

/** `<prefix><userId>:<projectId>` = the grant, as JSON. */
export const ASSISTANT_GRANT_PREFIX = 'openzcad:e2ee-assistant-grant:v1:';
/** `<prefix><userId>:<projectId>` = the id of the Allow in flight. */
export const ASSISTANT_ALLOW_PENDING_PREFIX =
  'openzcad:e2ee-assistant-allow:v1:';
/** `<prefix><userId>:<projectId>` = the project's stop generation. */
export const ASSISTANT_STOP_PREFIX = 'openzcad:e2ee-assistant-stop:v1:';
/**
 * `<prefix><userId>:<projectId>:<sequence>` = a consent record this device
 * verified (`raiseAssistantConsentFloor`). The highest is the floor.
 */
export const ASSISTANT_CONSENT_FLOOR_PREFIX =
  'openzcad:e2ee-assistant-consent-floor:v1:';

/** The generation of a project no Stop has been written for. */
const NO_STOP = 'none';

/** What an Allow clicked here granted: the record it verified. */
export interface AssistantGrant {
  readonly sequence: number;
  readonly route: string;
  readonly copyVersion: number;
  readonly id: string;
  /** The stop generation it was made under. */
  readonly stop: string;
}

/** An Allow in flight, from its click until it completes or is withdrawn. */
export interface AssistantAllowTicket {
  readonly userId: string;
  readonly projectId: string;
  readonly id: string;
  /** The stop generation when it was clicked. */
  readonly stop: string;
}

const scope = (userId: string, projectId: string) => `${userId}:${projectId}`;

/** Stops this tab made, held until an Allow completes here. */
const stoppedHere = new Set<string>();

function defaultStorage(): GrantStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** A new id, always 36 characters (never `none`). */
function newId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  let id = '';
  while (id.length < 36) id += Math.random().toString(36).slice(2);
  return id.slice(0, 36);
}

function parseGrant(raw: string | null): AssistantGrant | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const grant = value as Record<string, unknown>;
  return typeof grant.sequence === 'number' &&
    Number.isSafeInteger(grant.sequence) &&
    grant.sequence >= 1 &&
    typeof grant.route === 'string' &&
    grant.route.length > 0 &&
    typeof grant.copyVersion === 'number' &&
    Number.isSafeInteger(grant.copyVersion) &&
    typeof grant.id === 'string' &&
    grant.id.length > 0 &&
    typeof grant.stop === 'string' &&
    grant.stop.length > 0
    ? {
        sequence: grant.sequence,
        route: grant.route,
        copyVersion: grant.copyVersion,
        id: grant.id,
        stop: grant.stop
      }
    : null;
}

/** The project's floor keys and their sequences. Throws if unreadable. */
function floorKeys(
  storage: GrantStorage,
  userId: string,
  projectId: string
): { key: string; sequence: number }[] {
  const prefix = `${ASSISTANT_CONSENT_FLOOR_PREFIX}${scope(userId, projectId)}:`;
  const keys: { key: string; sequence: number }[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const sequence = Number(key.slice(prefix.length));
    if (Number.isSafeInteger(sequence) && sequence >= 1) {
      keys.push({ key, sequence });
    }
  }
  return keys;
}

/** Floors this tab could not write: held here instead. */
const floorsHere = new Map<string, number>();

/**
 * Records that this device verified the account's record at `sequence`
 * for the project: a grant of an older record is no longer current, in
 * any tab. Called for every verified record (`assistantConsent.ts`).
 * Writes a key of its own, so it never lowers what another tab wrote.
 * Where it cannot be written, removes an older grant instead and holds
 * the floor in this tab.
 */
export function raiseAssistantConsentFloor(
  userId: string,
  projectId: string,
  sequence: number,
  storage: GrantStorage | null = defaultStorage()
): void {
  if (!Number.isSafeInteger(sequence) || sequence < 1) return;
  const key = scope(userId, projectId);
  const own = `${ASSISTANT_CONSENT_FLOOR_PREFIX}${key}:${sequence}`;
  let saved = false;
  try {
    if (storage) {
      storage.setItem(own, '1');
      saved = storage.getItem(own) === '1';
    }
  } catch {
    saved = false;
  }
  if (saved && storage) {
    try {
      // Lower keys say nothing the new one does not: keep the store small.
      for (const lower of floorKeys(storage, userId, projectId)) {
        if (lower.sequence < sequence) storage.removeItem(lower.key);
      }
    } catch {
      /* Best effort. */
    }
    return;
  }
  floorsHere.set(key, Math.max(floorsHere.get(key) ?? 0, sequence));
  try {
    const grant = parseGrant(
      storage?.getItem(ASSISTANT_GRANT_PREFIX + key) ?? null
    );
    if (!grant || grant.sequence < sequence) {
      storage?.removeItem(ASSISTANT_GRANT_PREFIX + key);
    }
  } catch {
    try {
      storage?.removeItem(ASSISTANT_GRANT_PREFIX + key);
    } catch {
      /* Held in this tab above; unreadable storage reads as no grant. */
    }
  }
}

/**
 * This device's grant for the project, or null: none was made, a Stop
 * removed or outdated it (here or in another tab), this device has since
 * verified a newer record, or storage cannot be read.
 */
export function assistantGrant(
  userId: string,
  projectId: string,
  storage: GrantStorage | null = defaultStorage()
): AssistantGrant | null {
  const key = scope(userId, projectId);
  if (stoppedHere.has(key) || !storage) return null;
  try {
    const grant = parseGrant(storage.getItem(ASSISTANT_GRANT_PREFIX + key));
    if (!grant) return null;
    if (
      (storage.getItem(ASSISTANT_STOP_PREFIX + key) ?? NO_STOP) !== grant.stop
    ) {
      return null;
    }
    const floor = Math.max(
      floorsHere.get(key) ?? 0,
      ...floorKeys(storage, userId, projectId).map((entry) => entry.sequence)
    );
    return grant.sequence >= floor ? grant : null;
  } catch {
    return null;
  }
}

/**
 * Whether `consent` is still this device's grant for its project, now.
 * The send gate's test; synchronous.
 */
export function assistantGrantCurrent(
  consent: AssistantSendConsent,
  storage: GrantStorage | null = defaultStorage()
): boolean {
  const grant = assistantGrant(consent.userId, consent.projectId, storage);
  return (
    grant !== null &&
    grant.id === consent.grant &&
    grant.sequence === consent.sequence &&
    grant.route === consent.route &&
    grant.copyVersion === consent.copyVersion
  );
}

/**
 * Registers an Allow the user just clicked, before anything is awaited.
 * Null when storage cannot record it: the Allow is then refused.
 */
export function beginAssistantAllow(
  userId: string,
  projectId: string,
  storage: GrantStorage | null = defaultStorage()
): AssistantAllowTicket | null {
  if (!storage) return null;
  const key = scope(userId, projectId);
  const stopKey = ASSISTANT_STOP_PREFIX + key;
  const pendingKey = ASSISTANT_ALLOW_PENDING_PREFIX + key;
  const id = newId();
  try {
    // Read, never written here: only a Stop writes the generation.
    const stop = storage.getItem(stopKey) ?? NO_STOP;
    storage.setItem(pendingKey, id);
    return storage.getItem(pendingKey) === id
      ? { userId, projectId, id, stop }
      : null;
  } catch {
    return null;
  }
}

/**
 * Makes the grant for the record `ticket`'s Allow verified, unless a Stop
 * (or a later Allow) came after the click: then nothing is granted and
 * this answers null. Call it synchronously after the Allow's last await.
 */
export function completeAssistantAllow(
  ticket: AssistantAllowTicket,
  record: Pick<AssistantGrant, 'sequence' | 'route' | 'copyVersion'>,
  storage: GrantStorage | null = defaultStorage()
): AssistantGrant | null {
  if (!storage) return null;
  const key = scope(ticket.userId, ticket.projectId);
  const pendingKey = ASSISTANT_ALLOW_PENDING_PREFIX + key;
  const stopKey = ASSISTANT_STOP_PREFIX + key;
  const unstopped = () =>
    storage.getItem(pendingKey) === ticket.id &&
    (storage.getItem(stopKey) ?? NO_STOP) === ticket.stop;
  try {
    if (!unstopped()) return null;
    const grant: AssistantGrant = {
      sequence: record.sequence,
      route: record.route,
      copyVersion: record.copyVersion,
      id: ticket.id,
      stop: ticket.stop
    };
    const value = JSON.stringify(grant);
    storage.setItem(ASSISTANT_GRANT_PREFIX + key, value);
    // A Stop that interleaved with the write moved the generation, so no
    // tab reads this grant as current; drop it here as well.
    if (
      storage.getItem(ASSISTANT_GRANT_PREFIX + key) !== value ||
      !unstopped()
    ) {
      if (storage.getItem(ASSISTANT_GRANT_PREFIX + key) === value) {
        storage.removeItem(ASSISTANT_GRANT_PREFIX + key);
      }
      return null;
    }
    storage.removeItem(pendingKey);
    stoppedHere.delete(key);
    return grant;
  } catch {
    return null;
  }
}

/** Drops an Allow that failed or was declined, if it is still pending. */
export function withdrawAssistantAllow(
  ticket: AssistantAllowTicket,
  storage: GrantStorage | null = defaultStorage()
): void {
  const pendingKey =
    ASSISTANT_ALLOW_PENDING_PREFIX + scope(ticket.userId, ticket.projectId);
  try {
    if (storage?.getItem(pendingKey) === ticket.id) {
      storage.removeItem(pendingKey);
    }
  } catch {
    /* Nothing pending can complete without its own id anyway. */
  }
}

/**
 * A Stop, here or in Settings: moves the project's stop generation, then
 * removes its grant and any Allow in flight, synchronously, before the
 * revocation is sent. This tab holds the Stop in memory too, until an
 * Allow completes here.
 */
export function stopAssistantGrant(
  userId: string,
  projectId: string,
  storage: GrantStorage | null = defaultStorage()
): void {
  const key = scope(userId, projectId);
  stoppedHere.add(key);
  let moved = false;
  try {
    storage?.setItem(ASSISTANT_STOP_PREFIX + key, newId());
    moved = true;
  } catch {
    /* Removing the keys below still stops; retried after them. */
  }
  try {
    storage?.removeItem(ASSISTANT_ALLOW_PENDING_PREFIX + key);
  } catch {
    /* Held in memory above; see the module comment. */
  }
  try {
    storage?.removeItem(ASSISTANT_GRANT_PREFIX + key);
  } catch {
    /* Held in memory above. */
  }
  if (!moved) {
    try {
      // The removals above freed room for it.
      storage?.setItem(ASSISTANT_STOP_PREFIX + key, newId());
    } catch {
      /* Held in memory above. */
    }
  }
}

/** Whether a `storage` event concerns these grants or the consent pin. */
export function isAssistantGrantKey(key: string | null): boolean {
  return (
    key === null ||
    key.startsWith(ASSISTANT_GRANT_PREFIX) ||
    key.startsWith(ASSISTANT_ALLOW_PENDING_PREFIX) ||
    key.startsWith(ASSISTANT_STOP_PREFIX) ||
    key.startsWith(ASSISTANT_CONSENT_FLOOR_PREFIX)
  );
}

/** Tests only: forget this tab's in-memory Stops, as a reload would. */
export function resetAssistantGrantMemoryForTests(): void {
  stoppedHere.clear();
  floorsHere.clear();
}

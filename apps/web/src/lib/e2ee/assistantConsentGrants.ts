/**
 * This device's own grants of the assistant on encrypted projects.
 *
 * The account's consent record (`assistantConsent.ts`) says the owner
 * allowed the assistant for a project; it is MAC'd, so the Worker cannot
 * forge one, but it is read over the network and a send gate must decide
 * synchronously. A grant is this device's durable note that its user
 * clicked Allow here for that verified record: the record's `sequence`,
 * provider `route` and copy version, and a fresh id. An assistant request
 * for an encrypted project carries the grant it was confirmed under
 * (`AssistantSendConsent`), and the send gate (`api.ts`) refuses it unless
 * that grant is still the one stored here at the send.
 *
 * Ordering (a Stop wins):
 * - A grant is made only by an Allow clicked on this device, never by an
 *   account read, so nothing the account answers can bring back a grant a
 *   Stop removed.
 * - An Allow registers itself before anything is awaited
 *   (`beginAssistantAllow`: a pending id under the project's key). A Stop,
 *   in any tab, removes the grant and that pending id synchronously, before
 *   it awaits anything (`stopAssistantGrant`). The Allow then makes its
 *   grant only if its own pending id is still there after its last await
 *   (`completeAssistantAllow`), so an Allow that was in flight when the
 *   user stopped never makes one. A later Allow replaces the pending id,
 *   so of two Allows in flight only the last one clicked can complete.
 * - A Stop only removes keys, which works in a full store too. It is also
 *   held in this tab's memory until an Allow completes here, so this tab
 *   refuses even if the removal itself failed. Storage that cannot be read
 *   reads as no grant, so nothing is sent.
 *
 * Keyed by account and project. Free of crypto imports (as the pins are),
 * because `api.ts` checks grants synchronously at the send.
 */
import type { AssistantSendConsent } from '../projectWriteGate';

type GrantStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** `<prefix><userId>:<projectId>` = the grant, as JSON. */
export const ASSISTANT_GRANT_PREFIX = 'openzcad:e2ee-assistant-grant:v1:';
/** `<prefix><userId>:<projectId>` = the id of the Allow in flight. */
export const ASSISTANT_ALLOW_PENDING_PREFIX =
  'openzcad:e2ee-assistant-allow:v1:';

/** What an Allow clicked here granted: the record it verified. */
export interface AssistantGrant {
  readonly sequence: number;
  readonly route: string;
  readonly copyVersion: number;
  readonly id: string;
}

/** An Allow in flight, from its click until it completes or is withdrawn. */
export interface AssistantAllowTicket {
  readonly userId: string;
  readonly projectId: string;
  readonly id: string;
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

function newId(): string {
  return typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
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
    grant.id.length > 0
    ? {
        sequence: grant.sequence,
        route: grant.route,
        copyVersion: grant.copyVersion,
        id: grant.id
      }
    : null;
}

/**
 * This device's grant for the project, or null: none was made, a Stop
 * removed it (here or in another tab), or storage cannot be read.
 */
export function assistantGrant(
  userId: string,
  projectId: string,
  storage: GrantStorage | null = defaultStorage()
): AssistantGrant | null {
  const key = scope(userId, projectId);
  if (stoppedHere.has(key) || !storage) return null;
  try {
    return parseGrant(storage.getItem(ASSISTANT_GRANT_PREFIX + key));
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
  const id = newId();
  const key = ASSISTANT_ALLOW_PENDING_PREFIX + scope(userId, projectId);
  try {
    storage.setItem(key, id);
    return storage.getItem(key) === id ? { userId, projectId, id } : null;
  } catch {
    return null;
  }
}

/**
 * Makes the grant for the record `ticket`'s Allow verified, unless a Stop
 * (or a later Allow) came after the click: then nothing is granted and
 * this answers false. Call it synchronously after the Allow's last await.
 */
export function completeAssistantAllow(
  ticket: AssistantAllowTicket,
  record: Omit<AssistantGrant, 'id'>,
  storage: GrantStorage | null = defaultStorage()
): AssistantGrant | null {
  if (!storage) return null;
  const key = scope(ticket.userId, ticket.projectId);
  const pendingKey = ASSISTANT_ALLOW_PENDING_PREFIX + key;
  try {
    if (storage.getItem(pendingKey) !== ticket.id) return null;
    const grant: AssistantGrant = { ...record, id: ticket.id };
    const value = JSON.stringify(grant);
    storage.setItem(ASSISTANT_GRANT_PREFIX + key, value);
    if (storage.getItem(ASSISTANT_GRANT_PREFIX + key) !== value) return null;
    // A Stop between the two reads above removed the grant too.
    if (storage.getItem(pendingKey) !== ticket.id) {
      storage.removeItem(ASSISTANT_GRANT_PREFIX + key);
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
 * A Stop, here or in Settings: removes the project's grant and any Allow
 * in flight, synchronously, before the revocation is sent. This tab holds
 * the Stop in memory too, until an Allow completes here.
 */
export function stopAssistantGrant(
  userId: string,
  projectId: string,
  storage: GrantStorage | null = defaultStorage()
): void {
  const key = scope(userId, projectId);
  stoppedHere.add(key);
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
}

/** Whether a `storage` event concerns these grants. */
export function isAssistantGrantKey(key: string | null): boolean {
  return (
    key === null ||
    key.startsWith(ASSISTANT_GRANT_PREFIX) ||
    key.startsWith(ASSISTANT_ALLOW_PENDING_PREFIX)
  );
}

/** Tests only: forget this tab's in-memory Stops, as a reload would. */
export function resetAssistantGrantMemoryForTests(): void {
  stoppedHere.clear();
}

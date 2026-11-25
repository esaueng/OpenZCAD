/**
 * The invitations this account cancelled, for its own devices only (L11
 * plan of 2026-11-25, §3.4; ADR-024 amendment 2026-11-25). The Worker says
 * which invitations are pending, accepted or revoked, and an actively
 * malicious one could keep listing a cancelled invitation as pending. So a
 * cancellation also lands here, in one account record sealed under the
 * account key (`INVITATION_TOMBSTONES_RECORD`, the sealed-records layout),
 * and the account's devices renew, and add an acceptance of, no invitation
 * named here (`invitationRenewal.ts`, `addInvitedMember`). A device that
 * cannot read the record (keys locked, an altered record, one older than
 * the newest sequence this device saw, or none where it saw one) renews
 * and adds nothing: it fails closed.
 *
 * What remains is the limit every sealed record has: the server can
 * withhold or roll back the record for a device that never saw the newer
 * one. Every statement's renewal chain ends 30 days after it began
 * (`MAX_PROJECT_INVITATION_CHAIN_MS`), so that is the most a server can
 * keep a cancelled invitation alive. Tombstones older than
 * `INVITATION_TOMBSTONE_KEEP_MS` are dropped when the record is sealed: no
 * statement of theirs is valid any more.
 */
import {
  fromBase64Url,
  INVITATION_TOMBSTONES_RECORD,
  MAX_PROJECT_INVITATION_CHAIN_MS,
  openRecord,
  readSealedRecordHeader,
  sealRecord,
  toBase64Url
} from '@openzcad/crypto';
import {
  E2eeInvitationApiError,
  type E2eeInvitationTombstonesSnapshot,
  type E2eeInvitationsApi
} from '@openzcad/shared';
import {
  localStorageTombstonePins,
  type TombstoneSequencePins
} from './invitationTombstonePins';
import { declineInvitation, type InvitationContext } from './invitations';
import type { InvitationStore } from './invitationStore';

/** How long a tombstone is kept: past every statement it could stop. */
export const INVITATION_TOMBSTONE_KEEP_MS =
  MAX_PROJECT_INVITATION_CHAIN_MS + 30 * 24 * 60 * 60 * 1000;

export interface InvitationTombstones {
  /**
   * The invitation ids this account cancelled. Throws when the record
   * cannot be read here: callers then renew and add nothing.
   */
  cancelled(): Promise<ReadonlySet<string>>;
  /** Records a cancellation; throws when it could not be stored. */
  cancel(invitationId: string): Promise<void>;
}

export class InvitationTombstonesUnavailable extends Error {
  override readonly name = 'InvitationTombstonesUnavailable';
}

interface Book {
  readonly version: 1;
  /** Invitation id → when it was cancelled (Unix ms). */
  readonly invitations: Readonly<Record<string, number>>;
}

function parseBook(value: unknown): Book | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const book = value as { version?: unknown; invitations?: unknown };
  if (book.version !== 1) return null;
  const entries = book.invitations;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries))
    return null;
  const invitations: Record<string, number> = {};
  for (const [id, at] of Object.entries(entries)) {
    if (
      id.length > 0 &&
      id.length <= 128 &&
      typeof at === 'number' &&
      Number.isSafeInteger(at) &&
      at >= 0
    ) {
      invitations[id] = at;
    }
  }
  return { version: 1, invitations };
}

export interface SealedTombstonesDeps {
  readonly userId: string;
  readonly api: Pick<E2eeInvitationsApi, 'tombstones' | 'saveTombstones'>;
  /** A copy of the current account key, or null while locked. */
  currentKey(): Uint8Array | null;
  /** An account key of this account by its commitment, for older records. */
  keyFor(commitment: Uint8Array): Promise<Uint8Array | null>;
  /**
   * This device's own copy (`InvitationStore`, IndexedDB): what it
   * cancelled and what any record it opened named. Every answer is the
   * union of it and the account's record.
   */
  readonly local: Pick<InvitationStore, 'rememberCancelled' | 'cancelledHere'>;
  readonly pins?: TombstoneSequencePins;
  readonly now?: () => number;
}

const unavailable = (why: string): never => {
  throw new InvitationTombstonesUnavailable(
    `Cancelled invitations cannot be read on this device: ${why}`
  );
};

/** The account's sealed tombstones over the invitation routes. */
export function sealedInvitationTombstones(
  deps: SealedTombstonesDeps
): InvitationTombstones {
  const pins = deps.pins ?? localStorageTombstonePins(deps.userId);
  const now = deps.now ?? Date.now;

  /**
   * The account's record and, in `union`, it together with this device's
   * copy, which takes whatever the record names. The record alone is not
   * enough: two devices that seal from the same revision write the same
   * sequence, and the server could serve either to both.
   */
  async function read(): Promise<{
    snapshot: E2eeInvitationTombstonesSnapshot;
    union: Record<string, number>;
    stored: Book;
    sequence: number;
  }> {
    const { snapshot, book, sequence } = await readRecord();
    const union: Record<string, number> = {};
    for (const { invitationId, cancelledAt } of await deps.local.cancelledHere(
      deps.userId
    )) {
      union[invitationId] = cancelledAt;
    }
    for (const [id, at] of Object.entries(book.invitations)) {
      if (union[id] === undefined) {
        union[id] = at;
        await deps.local
          .rememberCancelled(deps.userId, { invitationId: id, cancelledAt: at })
          .catch(() => undefined);
      } else union[id] = Math.min(union[id], at);
    }
    return { snapshot, union, stored: book, sequence };
  }

  async function readRecord(): Promise<{
    snapshot: E2eeInvitationTombstonesSnapshot;
    book: Book;
    sequence: number;
  }> {
    const snapshot = await deps.api.tombstones();
    const floor = pins.read();
    if (!snapshot.record) {
      if (floor > 0) unavailable('the server no longer holds the record.');
      return { snapshot, book: { version: 1, invitations: {} }, sequence: 0 };
    }
    const sealed = fromBase64Url(snapshot.record);
    const header = readSealedRecordHeader(INVITATION_TOMBSTONES_RECORD, sealed);
    if (header.sequence < floor) {
      unavailable('the server answered with an older record.');
    }
    const key = await deps.keyFor(header.commitment);
    if (!key) return unavailable('no account key of yours opens it.');
    let plaintext: Uint8Array;
    try {
      ({ plaintext } = await openRecord(
        INVITATION_TOMBSTONES_RECORD,
        key,
        deps.userId,
        sealed
      ));
    } finally {
      key.fill(0);
    }
    let book: Book | null;
    try {
      book = parseBook(JSON.parse(new TextDecoder().decode(plaintext)));
    } catch {
      book = null;
    }
    if (!book) return unavailable('it is not a tombstones record.');
    pins.write(header.sequence);
    return { snapshot, book, sequence: header.sequence };
  }

  return {
    async cancelled() {
      const { union } = await read();
      return new Set(Object.keys(union));
    },
    async cancel(invitationId) {
      // This device's copy first: whatever the server acknowledges or
      // serves later, this device does not forget its own cancellation.
      await deps.local.rememberCancelled(deps.userId, {
        invitationId,
        cancelledAt: now()
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        const { snapshot, union, stored, sequence } = await read();
        if (stored.invitations[invitationId] !== undefined) return;
        // The union is sealed, so the record names every cancellation this
        // device knows of.
        const at = now();
        const invitations: Record<string, number> = {};
        for (const [id, cancelledAt] of Object.entries(union)) {
          if (at - cancelledAt <= INVITATION_TOMBSTONE_KEEP_MS) {
            invitations[id] = cancelledAt;
          }
        }
        const key = deps.currentKey();
        if (!key) return unavailable('unlock encryption first.');
        const next = Math.max(sequence, snapshot.sequence, pins.read()) + 1;
        let sealed: Uint8Array;
        try {
          sealed = await sealRecord(
            INVITATION_TOMBSTONES_RECORD,
            key,
            deps.userId,
            next,
            new TextEncoder().encode(
              JSON.stringify({ version: 1, invitations } satisfies Book)
            )
          );
        } finally {
          key.fill(0);
        }
        try {
          await deps.api.saveTombstones({
            expectedRevision: snapshot.revision,
            record: toBase64Url(sealed)
          });
          pins.write(next);
          return;
        } catch (error) {
          // Another device wrote meanwhile: merge its copy and seal again.
          if (
            !(error instanceof E2eeInvitationApiError) ||
            error.code !== 'E2EE_INVITATION_TOMBSTONES_CONFLICT'
          ) {
            throw error;
          }
        }
      }
      unavailable('other devices kept writing it. Try again.');
    }
  };
}

/**
 * The owner cancels (or declines) an invitation: the tombstone first, so a
 * cancellation is never sent that this account's devices could forget,
 * then the Worker's revocation. Without a tombstone store (an older
 * context) only the revocation.
 */
export async function cancelInvitation(
  ctx: InvitationContext,
  projectId: string,
  invitationId: string
): Promise<void> {
  await ctx.tombstones?.cancel(invitationId);
  await declineInvitation(ctx, projectId, invitationId);
}

/** In memory, for tests and contexts with no account record. */
export function memoryInvitationTombstones(
  initial: readonly string[] = []
): InvitationTombstones & { failing: boolean } {
  const ids = new Set(initial);
  const store = {
    failing: false,
    async cancelled() {
      if (store.failing) unavailable('the record is unavailable.');
      return new Set(ids);
    },
    async cancel(invitationId: string) {
      if (store.failing) unavailable('the record is unavailable.');
      ids.add(invitationId);
    }
  };
  return store;
}

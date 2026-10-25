/**
 * The live room's codec for end-to-end encrypted projects (ADR-024 Phase 4,
 * slice 4-9; roadmap L11). `useCollaboration` keeps its plaintext logic
 * (merge bases, conflicts, leases, kept versions) and this module sits at
 * the socket boundary:
 *
 * - **Out.** A document is sealed on the room version it descends from:
 *   validated, encrypted in the decode worker under a fresh version key,
 *   bound to the group's current epoch and signed by this device, exactly
 *   as an account save (`encryptedProjectStore.ts`).
 * - **In.** Every head the room relays is read as a current head: the
 *   account's log from this browser's pin through it verifies, its author
 *   held an editing leaf in its epoch, it decrypts and validates in the
 *   decode worker, and the pin moves. A head this browser cannot open
 *   becomes the same refusal a plaintext room's unopenable version does
 *   (#831, #841): the last good version is kept.
 * - A conflict's base is a version this browser accepted or sealed itself,
 *   so it never needs a historical read.
 */
import {
  type CollaborationServerMessage,
  type E2eeCollaborationServerMessage,
  type E2eeRoomHead,
  type E2eeRoomSubmission,
  type E2eeStoredVersion,
  type ProjectDocument
} from '@openzcad/shared';
import { fromBase64Url, toBase64Url } from '@openzcad/crypto';
import { parseServerMessage } from '../collaborationProtocol';
import { projectsHaveSameCanonicalContent } from '../localProjectStore';
import type {
  EncryptedRoomAccess,
  EncryptedRoomHeadState,
  EncryptedRoomSealed
} from './encryptedProjectStore';

/** Two base64 envelopes and their records fit; anything larger is dropped. */
const MAX_INBOUND_MESSAGE_BYTES = 4_500_000;
/** Heads kept as possible merge bases, as the room keeps 20 (judgment). */
const MAX_KNOWN_HEADS = 32;
const MAX_PENDING = 8;
const HASH = /^[0-9a-f]{64}$/;

export type EncryptedRoomEncoding =
  /** The room already holds exactly this document at `version`. */
  | { kind: 'same'; version: number }
  | { kind: 'sealed'; version: number; submission: E2eeRoomSubmission };

export interface EncryptedRoomDecoding {
  /** The plaintext frame the hook handles, or null to drop. */
  message: CollaborationServerMessage | null;
  /** A Commit moved the group: this browser caught up. */
  epochMoved?: boolean;
}

export interface EncryptedRoomCodec {
  /**
   * Seals `document` on the room version `baseVersion`. With `echo`, its
   * acknowledgement carries the stored document back (a kept version).
   */
  encode(
    document: ProjectDocument,
    baseVersion: number | null,
    options?: { echo?: boolean }
  ): Promise<EncryptedRoomEncoding>;
  decode(raw: string): Promise<EncryptedRoomDecoding>;
  catchUp(): Promise<void>;
}

export class EncryptedRoomCodecError extends Error {
  override readonly name = 'EncryptedRoomCodecError';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const uint = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0;

function storedVersion(value: unknown): value is E2eeStoredVersion {
  return (
    isRecord(value) &&
    uint(value.documentVersion) &&
    uint(value.keyEpoch) &&
    typeof value.versionHash === 'string' &&
    HASH.test(value.versionHash) &&
    typeof value.prefix === 'string' &&
    typeof value.signature === 'string' &&
    (value.signerUserId === null || typeof value.signerUserId === 'string') &&
    typeof value.signerDeviceId === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.wrappedVersionKey === 'string' &&
    uint(value.envelopeBytes)
  );
}

function roomHead(value: unknown): value is E2eeRoomHead {
  return (
    isRecord(value) &&
    storedVersion(value.record) &&
    (value.envelope === null || typeof value.envelope === 'string')
  );
}

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function createEncryptedRoomCodec(
  access: EncryptedRoomAccess,
  projectId: string
): EncryptedRoomCodec {
  /** Heads this page accepted or sealed, by version: the possible bases. */
  const known = new Map<number, EncryptedRoomHeadState>();
  const pending = new Map<
    string,
    {
      sealed: EncryptedRoomSealed;
      base: EncryptedRoomHeadState;
      requested: number;
    }
  >();

  const remember = (state: EncryptedRoomHeadState) => {
    known.delete(state.version);
    known.set(state.version, state);
    while (known.size > MAX_KNOWN_HEADS) {
      known.delete(known.keys().next().value!);
    }
  };
  const byHash = (hash: string) =>
    [...known.values()].find((state) => state.hash === hash) ?? null;
  const current = access.currentHead(projectId);
  if (current) remember(current);

  async function open(head: E2eeRoomHead): Promise<EncryptedRoomHeadState> {
    const state = await access.openHead(
      projectId,
      head.record,
      head.envelope === null ? null : fromBase64Url(head.envelope)
    );
    remember(state);
    return state;
  }

  async function decodeEncrypted(
    message: E2eeCollaborationServerMessage
  ): Promise<EncryptedRoomDecoding> {
    switch (message.type) {
      case 'e2ee-state': {
        // Members, role and lease are checked as a plaintext state frame's.
        const frame = parseServerMessage(
          JSON.stringify({
            type: 'state',
            members: message.members,
            role: message.role,
            lease: message.lease,
            document: null
          }),
          projectId
        );
        if (frame?.type !== 'state') return { message: null };
        if (!message.head) return { message: frame };
        try {
          const state = await open(message.head);
          return { message: { ...frame, document: state.document } };
        } catch (error) {
          // The last good version stays; the room's is refused.
          console.error(
            `Encrypted collaboration head refused: ${reasonOf(error)}`
          );
          return { message: frame };
        }
      }
      case 'e2ee-document': {
        if (typeof message.clientId !== 'string') return { message: null };
        try {
          const state = await open(message.head);
          return {
            message: {
              type: 'document',
              clientId: message.clientId,
              document: state.document
            }
          };
        } catch (error) {
          return { message: unopenable(error) };
        }
      }
      case 'e2ee-ack': {
        const sent = pending.get(message.record.versionHash);
        if (!sent) {
          const same = byHash(message.record.versionHash);
          return {
            message: same
              ? { type: 'ack', version: same.version }
              : {
                  type: 'error',
                  code: 'internal',
                  message:
                    'The room acknowledged a version this browser did not send.'
                }
          };
        }
        pending.delete(message.record.versionHash);
        try {
          const state = await access.accepted(
            projectId,
            sent.sealed,
            sent.base,
            message.record
          );
          remember(state);
          // The stored version can differ from the one the hook submitted
          // (a version past the base, or the checks' normal form): it
          // rides back on the ack, as a plaintext room's kept version does.
          return {
            message:
              state.version === sent.requested
                ? { type: 'ack', version: state.version }
                : {
                    type: 'ack',
                    version: state.version,
                    document: state.document
                  }
          };
        } catch (error) {
          return {
            message: {
              type: 'error',
              code: 'internal',
              message: `The room’s acknowledgement could not be checked: ${reasonOf(error)}`
            }
          };
        }
      }
      case 'e2ee-conflict': {
        let latest: EncryptedRoomHeadState;
        try {
          latest = await open(message.latest);
        } catch (error) {
          return { message: unopenable(error) };
        }
        const base = message.base
          ? byHash(message.base.record.versionHash)
          : null;
        return {
          message: {
            type: 'conflict',
            document: latest.document,
            ...(base && base.version < latest.version
              ? { base: base.document }
              : {})
          }
        };
      }
      case 'e2ee-epoch':
        await access.catchUp(projectId).catch(() => undefined);
        return { message: null, epochMoved: true };
    }
  }

  return {
    async encode(document, baseVersion, options = {}) {
      const base =
        baseVersion === null
          ? null
          : (known.get(baseVersion) ??
            (access.currentHead(projectId)?.version === baseVersion
              ? access.currentHead(projectId)
              : null));
      if (!base) {
        throw new EncryptedRoomCodecError(
          'This browser does not hold the room version this edit builds on yet.'
        );
      }
      if (
        !options.echo &&
        document.version <= base.version &&
        projectsHaveSameCanonicalContent(document, base.document)
      ) {
        return { kind: 'same', version: base.version };
      }
      const sealed = await access.seal(projectId, document, base);
      pending.set(sealed.hash, {
        sealed,
        base,
        requested: options.echo ? -1 : document.version
      });
      while (pending.size > MAX_PENDING) {
        pending.delete(pending.keys().next().value!);
      }
      return {
        kind: 'sealed',
        version: sealed.version,
        submission: {
          envelope: toBase64Url(sealed.envelope),
          signature: sealed.signature,
          wrappedVersionKey: sealed.wrappedVersionKey,
          signerDeviceId: sealed.signerDeviceId
        }
      };
    },

    async decode(raw) {
      if (raw.length > MAX_INBOUND_MESSAGE_BYTES) return { message: null };
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { message: null };
      }
      if (!isRecord(parsed) || typeof parsed.type !== 'string') {
        return { message: null };
      }
      switch (parsed.type) {
        case 'e2ee-state':
          return roomHeadOrNull(parsed.head) && uint(parsed.keyEpoch)
            ? decodeEncrypted(parsed as E2eeCollaborationServerMessage)
            : { message: null };
        case 'e2ee-document':
          return roomHead(parsed.head)
            ? decodeEncrypted(parsed as E2eeCollaborationServerMessage)
            : { message: null };
        case 'e2ee-ack':
          return storedVersion(parsed.record)
            ? decodeEncrypted(parsed as E2eeCollaborationServerMessage)
            : { message: null };
        case 'e2ee-conflict':
          return roomHead(parsed.latest) &&
            (parsed.base === undefined || roomHead(parsed.base))
            ? decodeEncrypted(parsed as E2eeCollaborationServerMessage)
            : { message: null };
        case 'e2ee-epoch':
          return uint(parsed.keyEpoch)
            ? decodeEncrypted(parsed as E2eeCollaborationServerMessage)
            : { message: null };
        // A plaintext room's document frames never belong to this one.
        case 'state':
        case 'document':
        case 'ack':
        case 'conflict':
          return { message: null };
        default:
          return { message: parseServerMessage(raw, projectId) };
      }
    },

    catchUp: () => access.catchUp(projectId)
  };
}

function roomHeadOrNull(value: unknown): boolean {
  return value === null || roomHead(value);
}

function unopenable(error: unknown): CollaborationServerMessage {
  const reason = reasonOf(error);
  console.error(`Encrypted collaboration document refused: ${reason}`);
  return {
    type: 'error',
    code: 'document-invalid',
    message: `The room holds a version this browser cannot open: ${reason}`
  };
}

/** The page's codec for one project, over its encrypted-project store. */
export async function loadEncryptedRoomCodec(
  projectId: string
): Promise<EncryptedRoomCodec> {
  const { encryptedProjectStore } = await import('./encryptedProjects');
  const store = await encryptedProjectStore();
  return createEncryptedRoomCodec(store.roomAccess(), projectId);
}

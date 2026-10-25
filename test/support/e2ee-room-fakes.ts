/**
 * An encrypted project's collaboration room over a fake account (ADR-024
 * slice 4-9). The room only ever reads envelope headers through its account
 * seam, so these "envelopes" are JSON headers the fake account inspects; the
 * real Worker seam and real envelopes are exercised in `e2ee-room.test.ts`.
 */
import { createHash } from 'node:crypto';
import {
  ProjectCollaborationRoom,
  type E2eeRoomAccount,
  type E2eeRoomCredential,
  type E2eeEnvelopeSummary
} from '@openzcad/cloudflare-adapters';
import type { E2eeStoredVersion } from '@openzcad/shared';
import type { FakeRoomStorage } from '../collaboration-room-harness';

export const ENCRYPTED_ROOM_ENV = {
  ENVIRONMENT: 'development',
  AUTH_MODE: 'development',
  E2EE_KEYS_ENABLED: 'true',
  E2EE_PROJECTS_ENABLED: 'true'
} as const;

export class EncryptedTestRoom extends ProjectCollaborationRoom {
  constructor(
    ctx: unknown,
    env: unknown,
    private readonly fake: E2eeRoomAccount | null
  ) {
    super(ctx, env);
  }

  protected override e2eeAccount(): E2eeRoomAccount | null {
    return this.fake;
  }
}

export function createEncryptedRoom(
  context: FakeRoomStorage['context'],
  account: E2eeRoomAccount | null,
  env: Record<string, unknown> = ENCRYPTED_ROOM_ENV
): ProjectCollaborationRoom {
  const room = new EncryptedTestRoom(context, env, account);
  context.activate(room);
  return room;
}

export interface FakeHeader {
  projectId: string;
  documentVersion: number;
  keyEpoch: number;
  previousVersionHash: string | null;
  /** Distinguishes two envelopes with the same header fields. */
  body: string;
  kind?: string;
}

export function fakeEnvelope(header: FakeHeader): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ kind: 'document', ...header })
  );
}

export const hashOf = (envelope: Uint8Array) =>
  createHash('sha256').update(envelope).digest('hex');

export const b64 = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString('base64url');

/** A submission as a browser sends it. */
export function submission(header: FakeHeader) {
  return {
    envelope: b64(fakeEnvelope(header)),
    signature: 'c2lnbmF0dXJl',
    wrappedVersionKey: 'd3JhcA',
    signerDeviceId: 'device_laptop'
  };
}

export interface FakeAccountWrite {
  userId: string;
  credential: E2eeRoomCredential | null;
  expectedVersion: number;
  revisionId: string | null;
  versionHash: string;
}

export interface FakeE2eeAccount extends E2eeRoomAccount {
  readonly writes: FakeAccountWrite[];
  keyEpoch: number;
  readonly headRecord: E2eeStoredVersion;
  envelopeOf(hash: string): Uint8Array | undefined;
  /** A version written to the account outside the room. */
  writeOutside(header: FakeHeader): E2eeStoredVersion;
}

function record(
  envelope: Uint8Array,
  summary: E2eeEnvelopeSummary
): E2eeStoredVersion {
  return {
    documentVersion: summary.documentVersion,
    keyEpoch: summary.keyEpoch,
    versionHash: summary.versionHash,
    prefix: 'cHJlZml4',
    signature: 'c2lnbmF0dXJl',
    signerUserId: 'user_room',
    signerDeviceId: 'device_laptop',
    createdAt: '2026-10-24T00:00:00.000Z',
    wrappedVersionKey: 'd3JhcA',
    envelopeBytes: envelope.byteLength
  };
}

function summarize(envelope: Uint8Array): E2eeEnvelopeSummary | null {
  try {
    const header = JSON.parse(new TextDecoder().decode(envelope)) as FakeHeader;
    if (typeof header.projectId !== 'string') return null;
    return {
      projectId: header.projectId,
      kind: header.kind ?? 'document',
      documentVersion: header.documentVersion,
      keyEpoch: header.keyEpoch,
      previousVersionHash: header.previousVersionHash,
      versionHash: hashOf(envelope)
    };
  } catch {
    return null;
  }
}

/** An account whose head starts at `first` (version 1, epoch 0). */
export function fakeE2eeAccount(projectId: string): FakeE2eeAccount {
  const firstEnvelope = fakeEnvelope({
    projectId,
    documentVersion: 1,
    keyEpoch: 0,
    previousVersionHash: null,
    body: 'first'
  });
  const versions = new Map<string, Uint8Array>([
    [hashOf(firstEnvelope), firstEnvelope]
  ]);
  let head = record(firstEnvelope, summarize(firstEnvelope)!);
  const writes: FakeAccountWrite[] = [];
  const account: FakeE2eeAccount = {
    writes,
    keyEpoch: 0,
    get headRecord() {
      return head;
    },
    envelopeOf: (hash) => versions.get(hash),
    writeOutside(header) {
      const envelope = fakeEnvelope(header);
      versions.set(hashOf(envelope), envelope);
      head = record(envelope, summarize(envelope)!);
      return head;
    },
    async inspect(envelope) {
      return summarize(envelope);
    },
    async head(id) {
      return id === projectId
        ? { record: head, keyEpoch: account.keyEpoch }
        : null;
    },
    async envelope(id, hash) {
      return id === projectId ? (versions.get(hash) ?? null) : null;
    },
    async write(input) {
      const summary = summarize(input.envelope)!;
      if (
        input.expectedVersion !== head.documentVersion ||
        summary.previousVersionHash !== head.versionHash
      ) {
        return { kind: 'conflict' };
      }
      if (summary.keyEpoch !== account.keyEpoch) {
        return { kind: 'epoch-stale', keyEpoch: account.keyEpoch };
      }
      versions.set(summary.versionHash, input.envelope);
      head = record(input.envelope, summary);
      writes.push({
        userId: input.userId,
        credential: input.credential,
        expectedVersion: input.expectedVersion,
        revisionId: input.revisionId,
        versionHash: summary.versionHash
      });
      return { kind: 'accepted', record: head };
    }
  };
  return account;
}

/**
 * The collaboration room's frames for end-to-end encrypted projects
 * (ADR-024 Phase 4, slice 4-9; roadmap L11). A format-2 room relays signed
 * document envelopes it cannot read and orders them by their header's
 * previous-version hash, under the group's current key epoch; browsers
 * decrypt, verify and merge. Byte strings are unpadded base64url and
 * version hashes lowercase hex, as on the encrypted document routes.
 *
 * Presence and lease frames are the plaintext room's own. A plaintext
 * `document` frame is refused by a format-2 room, and these frames by a
 * plaintext room.
 */
import type {
  CollaborationMember,
  ProjectAccessRole,
  ProjectEditLease
} from './index';
import type { E2eeStoredVersion } from './e2ee-project-documents';

/** The storage format whose room relays ciphertext. */
export const E2EE_ROOM_FORMAT = 2;

/** One signed document envelope offered to the room. */
export interface E2eeRoomSubmission {
  /** The whole envelope, as `encryptProjectEnvelope` wrote it. */
  envelope: string;
  /** `signProjectEnvelope` by `signerDeviceId`'s certified signing key. */
  signature: string;
  /** The version key under the header's key epoch's project key. */
  wrappedVersionKey: string;
  signerDeviceId: string;
}

/**
 * A version the room holds: its account log record (with the wrapped
 * version key) and, when it fits the room, its envelope. Without one the
 * browser reads the head from the account instead.
 */
export interface E2eeRoomHead {
  record: E2eeStoredVersion;
  envelope: string | null;
}

export type E2eeCollaborationClientMessage = {
  type: 'e2ee-document';
  clientId: string;
  leaseId?: string;
  version: E2eeRoomSubmission;
};

export type E2eeCollaborationServerMessage =
  /** What `state` is to a plaintext room: sent once after `hello`. */
  | {
      type: 'e2ee-state';
      members: CollaborationMember[];
      role: ProjectAccessRole;
      lease: ProjectEditLease | null;
      head: E2eeRoomHead | null;
      /** The group's current key epoch, as the sequencer holds it. */
      keyEpoch: number;
    }
  /** A version another browser published. */
  | { type: 'e2ee-document'; clientId: string; head: E2eeRoomHead }
  /** The sender's version became the room's head and the account's. */
  | { type: 'e2ee-ack'; record: E2eeStoredVersion }
  /**
   * The submission does not build on the room's head. `base` is the older
   * version it does build on, when the room still holds it: the browser
   * merges base, latest and its own document and resubmits on `latest`.
   */
  | { type: 'e2ee-conflict'; latest: E2eeRoomHead; base?: E2eeRoomHead }
  /** A Commit moved the project's group to `keyEpoch`. */
  | { type: 'e2ee-epoch'; keyEpoch: number };

/**
 * `POST /api/projects/:id/collaboration` on a format-2 project: one
 * submission too large for a socket frame, or, with `revisionId`, a named
 * save through the encrypted revision path.
 */
export interface E2eeRoomHttpSubmission {
  clientId: string;
  leaseId?: string;
  version: E2eeRoomSubmission;
  revisionId?: string;
}

/**
 * Wire types of the contacts routes (ADR-024 Phase 5, slice 5-1; roadmap
 * L11): a user's identity-signed contacts list, and the device lists of the
 * people they share a project or an invitation with. Every byte string is
 * unpadded base64url. The Worker stores and checks what it can; browsers
 * verify everything that comes back.
 */
import type { E2eeDeviceListEntryRecord } from './index';

/** One identity-signed contacts entry, as stored. */
export interface E2eeContactsEntryRecord {
  sequence: number;
  /** Canonical `encodeContactsEntry` bytes. */
  entry: string;
  /** 65-byte identity signature. */
  signature: string;
}

/**
 * Someone this account may look up (decision M2): a co-member of a
 * project, or the other side of an invitation. `email` is shown only where
 * the plaintext sharing flow already shows it (owner and member, inviter
 * and invitee); null for a co-member alone.
 */
export interface E2eeContactPerson {
  userId: string;
  email: string | null;
}

export interface E2eeContactsResponse {
  /** The identity generation the list belongs to; null before setup. */
  generation: number | null;
  /** Oldest first, starting at sequence 0. */
  entries: E2eeContactsEntryRecord[];
  people: E2eeContactPerson[];
}

export interface E2eeAppendContactsRequest {
  /** The identity generation the entry is signed under. */
  generation: number;
  entry: string;
  signature: string;
}

/** Another user's current identity and device list; null without keys. */
export interface E2eeContactDeviceListResponse {
  userId: string;
  identity: {
    generation: number;
    identityKey: string;
    /** Oldest first, starting at sequence 0. */
    entries: E2eeDeviceListEntryRecord[];
  } | null;
}

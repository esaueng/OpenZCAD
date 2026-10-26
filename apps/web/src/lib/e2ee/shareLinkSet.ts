/**
 * The active share-link set of an encrypted project's head (ADR-024 Phase 5,
 * slice 5-10; share-link revocation is project state). Every head a browser
 * accepts runs `verifyHeadShareLinks`: each grant and tombstone is signed by
 * an owner device (the owner as the MLS roles of the head's epoch name
 * them, their device as this browser's pinned device list certifies it, or
 * a removed one for entries below its revocation cutoff), no granted link
 * was tombstoned (in the set or in an earlier head this browser saw, which
 * the version pins remember across reloads), and against the parent's
 * verified set no tombstone is dropped and an editor carries the set
 * unchanged.
 *
 * Only a head's direct parent is held to "an editor changes nothing": when
 * this page skipped versions (it read a newer head than the one it held),
 * the bodies in between were never decrypted, so the owner may have changed
 * the set meanwhile; tombstones are still never dropped, and the seen
 * tombstones still refuse a revoked link. A body without a set (version 1)
 * is an empty set: after a head with links or tombstones, an editor's empty
 * set is refused as a change and a dropped tombstone always is.
 */
import {
  authorCutoffKey,
  verifyShareLinkSet,
  type ShareLinkSet,
  type VerifiedDeviceList,
  type VerifiedShareLinkSet,
  type VersionCutoff
} from '@openzcad/crypto';
import {
  epochRoles,
  projectDeviceLists,
  type ProjectGroupContext
} from './projectGroups';
import type { VersionPinStore } from './versionPins';

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

export const EMPTY_SHARE_LINK_SET: ShareLinkSet = Object.freeze({
  grants: Object.freeze([]),
  tombstones: Object.freeze([])
});

export interface HeadShareLinksInput {
  readonly projectId: string;
  /** The head's key epoch. */
  readonly keyEpoch: number;
  /** Who wrote the head. */
  readonly authorUserId: string;
  /** The head body's set; undefined for a version 1 body. */
  readonly set: ShareLinkSet | undefined;
  /**
   * The verified set of a head this page accepted before: the head's
   * direct parent (`direct`), or an older one.
   */
  readonly previous?: {
    readonly set: VerifiedShareLinkSet | null;
    readonly direct: boolean;
  };
  /** Cutoffs of removed devices, keyed by `authorCutoffKey`. */
  readonly cutoffs: ReadonlyMap<string, VersionCutoff>;
  /**
   * Whether to record the set's tombstones as seen (default true). A
   * browser checking a set it is about to write records them only once
   * the write landed.
   */
  readonly remember?: boolean;
}

/** The project owner's user id, by the MLS roles of `keyEpoch`. */
export async function projectOwnerOf(
  groups: ProjectGroupContext,
  projectId: string,
  keyEpoch: number
): Promise<string | null> {
  const roles = await epochRoles(groups, projectId, keyEpoch);
  return roles.users.find((entry) => entry.role === 'owner')?.userId ?? null;
}

/** The owner's verified device list, as this browser pinned it. */
export async function ownerDeviceList(
  groups: ProjectGroupContext,
  projectId: string,
  ownerUserId: string
): Promise<VerifiedDeviceList | null> {
  if (ownerUserId === groups.account.userId) return groups.account.list;
  return (
    (await projectDeviceLists(groups, projectId)).find(
      (list) => list.userId === ownerUserId
    ) ?? null
  );
}

/**
 * The owner device key a grant or tombstone names: a live device of the
 * owner's list, or a removed one for an entry made below its cutoff.
 */
export function ownerSigningKey(
  list: VerifiedDeviceList,
  signerKeyHash: Uint8Array,
  keyEpoch: number,
  cutoffs: ReadonlyMap<string, VersionCutoff>
): Uint8Array | null {
  const live = list.devices.find((device) =>
    sameBytes(device.signingKeyHash, signerKeyHash)
  );
  if (live) return live.signingKey;
  for (const revoked of list.revoked) {
    if (
      revoked.kind !== 'device' ||
      !revoked.device ||
      !sameBytes(revoked.device.signingKeyHash, signerKeyHash)
    ) {
      continue;
    }
    const cutoff = cutoffs.get(authorCutoffKey(list.userId, revoked.id));
    if (cutoff?.keyEpoch !== undefined && keyEpoch < cutoff.keyEpoch) {
      return revoked.device.signingKey;
    }
  }
  return null;
}

/**
 * Verifies a head's share-link set and remembers its tombstones. Resolves
 * to null for a version 1 body with nothing before it to compare; refusals
 * are `ShareLinkError`s.
 */
export async function verifyHeadShareLinks(
  groups: ProjectGroupContext,
  pins: VersionPinStore,
  input: HeadShareLinksInput
): Promise<VerifiedShareLinkSet | null> {
  const previous = input.previous?.set ?? null;
  const previousHolds =
    !!previous &&
    (previous.set.grants.length > 0 || previous.set.tombstones.length > 0);
  if (input.set === undefined && !previousHolds) return null;
  const set = input.set ?? EMPTY_SHARE_LINK_SET;
  const userId = groups.account.userId;
  const owner = await projectOwnerOf(groups, input.projectId, input.keyEpoch);
  const ownerList = owner
    ? await ownerDeviceList(groups, input.projectId, owner)
    : null;
  const seen =
    (await pins.read(userId, input.projectId).catch(() => null))?.tombstones ??
    [];
  const verified = await verifyShareLinkSet(set, {
    projectId: input.projectId,
    keyEpoch: input.keyEpoch,
    resolveOwnerKey: ({ signerKeyHash, keyEpoch }) =>
      ownerList
        ? ownerSigningKey(ownerList, signerKeyHash, keyEpoch, input.cutoffs)
        : null,
    seenTombstones: seen,
    ...(previous
      ? {
          previous,
          authorIsOwner: !input.previous!.direct || input.authorUserId === owner
        }
      : {})
  });
  const ids = verified.tombstones.map((tombstone) => tombstone.shareId);
  if (ids.length && input.remember !== false) {
    await pins.addTombstones?.(userId, input.projectId, ids);
  }
  return verified;
}

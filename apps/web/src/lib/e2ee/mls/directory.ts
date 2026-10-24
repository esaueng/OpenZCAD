/**
 * The verified device directory the MLS policy reads (ADR-024, "MLS
 * assessment": the identity layer is MLS's Authentication Service). The
 * policy runs synchronously inside WASM and cannot await WebCrypto, so
 * everything is verified here first and handed over as a snapshot:
 *
 * - which devices each user's identity key certifies, or has revoked, comes
 *   from `VerifiedDeviceList`s the caller has already verified and pinned;
 * - which leaf keys each device certified for this project comes from leaf
 *   certifications, each checked here against the certifying device's
 *   signing key (`verifyLeafCertification`);
 * - the epoch each leaf key's certification counts from (`certifiedEpoch`,
 *   which a recovery Add needs to be no earlier than the identity's latest
 *   leaf removal) is part of what the device signed, so it is passed on only
 *   once that signature verifies over it. Two verified certifications of one
 *   key keep the earlier epoch, which can only refuse more.
 *
 * Anything that cannot be verified is refused with an `MlsDirectoryError`
 * rather than left out, so a forged or unattributable record is visible
 * instead of silently weakening or narrowing the directory.
 *
 * - **Revocation cutoffs.** For a revoked device the policy needs the first
 *   epoch of this project's group whose rejoin PSK that device must not
 *   know. The device list records revocations by entry sequence, not by
 *   group epoch, so a cutoff can only come from trusted per-project state
 *   the caller passes in `revocationCutoffs` (slice 4-10: the identity-
 *   signed cutoff statement, `projectGroups.ts`). Without one the
 *   directory is refused (`revocation-cutoff-missing`): dropping the device
 *   would drop its cutoff and let a sibling rejoin with an older PSK, and
 *   guessing 0 would be a silent default. (In a shared project the caller
 *   passes the highest cutoff for such a device instead, slice 5-7: see
 *   `UNSIGNED_SHARED_CUTOFF`.)
 * - **`replacedBy`.** A device revocation may name the device replacing it
 *   (identity-signed, in the verified list); it is passed on, so the named
 *   replacement can use the last-leaf rejoin exception.
 * - **History** (slice 5-7). A Commit a device sent before its removal's
 *   rotation was valid when it was made. To process such a Commit late,
 *   the caller lists that device in `activeAt` (it decides from the
 *   identity-signed cutoff that the Commit came before the rotation): the
 *   device then counts as active for that one Commit, with its verified
 *   leaf certifications, instead of revoked.
 */
import type { VerifiedDeviceList } from '@openzcad/crypto';
import type {
  DeviceDirectory,
  DirectoryDevice,
  LeafKeyCertification,
  Mls
} from '@openzcad/mls';
import { verifyLeafCertification } from './certify';

/** A device's certification of one of its per-project leaf keys. */
export interface LeafCertification {
  readonly userId: string;
  readonly deviceId: string;
  readonly leafKey: Uint8Array;
  /** As the leaf credential carries it: the signed epoch is inside. */
  readonly certification: Uint8Array;
}

export interface DirectoryInput {
  /** Verified, pinned device lists: one per user, every user named below. */
  readonly lists: readonly VerifiedDeviceList[];
  readonly certifications: readonly LeafCertification[];
  /**
   * Per user, per revoked device id: the first epoch of this project's
   * group whose rejoin PSK the device must not know (0 when the group never
   * had an epoch it could know). Required for every revoked device (see
   * the module comment).
   */
  readonly revocationCutoffs?: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /**
   * Per user, revoked devices to count as active, for processing a Commit
   * made before their removal's rotation (see the module comment). They
   * need no revocation cutoff.
   */
  readonly activeAt?: ReadonlyMap<string, ReadonlySet<string>>;
}

export type MlsDirectoryRefusal =
  | 'list-duplicate'
  | 'user-unknown'
  | 'device-unknown'
  | 'certification-invalid'
  | 'revocation-cutoff-missing'
  | 'revocation-cutoff-invalid';

export class MlsDirectoryError extends Error {
  override readonly name = 'MlsDirectoryError';
  constructor(
    readonly code: MlsDirectoryRefusal,
    message: string
  ) {
    super(message);
  }
}

interface DeviceDraft {
  readonly deviceId: string;
  readonly status: 'active' | 'revoked';
  /** The key that certifies this device's leaves; absent if unknown. */
  readonly signingKey: Uint8Array | undefined;
  readonly revocationCutoffEpoch?: number;
  readonly replacedBy?: string;
  readonly leafKeys: LeafKeyCertification[];
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

function devicesOf(
  list: VerifiedDeviceList,
  cutoffs: ReadonlyMap<string, number> | undefined,
  activeAt: ReadonlySet<string> | undefined
): Map<string, DeviceDraft> {
  const devices = new Map<string, DeviceDraft>();
  for (const device of list.devices) {
    devices.set(device.deviceId, {
      deviceId: device.deviceId,
      status: 'active',
      signingKey: device.signingKey,
      leafKeys: []
    });
  }
  for (const revoked of list.revoked) {
    if (revoked.kind !== 'device') continue;
    if (activeAt?.has(revoked.id) && revoked.device) {
      devices.set(revoked.id, {
        deviceId: revoked.id,
        status: 'active',
        signingKey: revoked.device.signingKey,
        leafKeys: []
      });
      continue;
    }
    const cutoff = cutoffs?.get(revoked.id);
    if (cutoff === undefined) {
      throw new MlsDirectoryError(
        'revocation-cutoff-missing',
        `Device ${revoked.id} of ${list.userId} is revoked, and no revocation cutoff epoch for this project is known. The device list does not record one yet.`
      );
    }
    if (!Number.isSafeInteger(cutoff) || cutoff < 0) {
      throw new MlsDirectoryError(
        'revocation-cutoff-invalid',
        `The revocation cutoff of device ${revoked.id} of ${list.userId} is not an epoch.`
      );
    }
    // Revoked wins over a live entry: device ids are never reused.
    devices.set(revoked.id, {
      deviceId: revoked.id,
      status: 'revoked',
      signingKey: revoked.device?.signingKey,
      revocationCutoffEpoch: cutoff,
      ...(revoked.replacedBy === undefined
        ? {}
        : { replacedBy: revoked.replacedBy }),
      leafKeys: []
    });
  }
  return devices;
}

/**
 * The `DeviceDirectory` for one project's MLS group. Leaf certifications by
 * revoked devices are verified and kept under the revoked device, so the
 * policy refuses them as revoked rather than unknown.
 */
export async function buildDeviceDirectory(
  mls: Mls,
  projectId: string,
  input: DirectoryInput
): Promise<DeviceDirectory> {
  const users = new Map<string, Map<string, DeviceDraft>>();
  for (const list of input.lists) {
    if (users.has(list.userId)) {
      throw new MlsDirectoryError(
        'list-duplicate',
        `Two device lists were given for ${list.userId}.`
      );
    }
    users.set(
      list.userId,
      devicesOf(
        list,
        input.revocationCutoffs?.get(list.userId),
        input.activeAt?.get(list.userId)
      )
    );
  }
  for (const claim of input.certifications) {
    const devices = users.get(claim.userId);
    if (!devices) {
      throw new MlsDirectoryError(
        'user-unknown',
        `A leaf certification names ${claim.userId}, whose device list was not given.`
      );
    }
    const device = devices.get(claim.deviceId);
    if (!device) {
      throw new MlsDirectoryError(
        'device-unknown',
        `A leaf certification names device ${claim.deviceId}, which the device list of ${claim.userId} does not certify.`
      );
    }
    const verified =
      device.signingKey === undefined
        ? null
        : await verifyLeafCertification(
            mls,
            { projectId, ...claim },
            device.signingKey
          );
    if (!verified) {
      throw new MlsDirectoryError(
        'certification-invalid',
        `The leaf certification of device ${claim.deviceId} of ${claim.userId} does not verify.`
      );
    }
    // Only now, verified, does the signed epoch reach the policy.
    const { certifiedEpoch } = verified;
    const known = device.leafKeys.find((leaf) =>
      sameBytes(leaf.key, claim.leafKey)
    );
    if (!known) {
      device.leafKeys.push({
        key: new Uint8Array(claim.leafKey),
        certifiedEpoch
      });
    } else if (
      known.certifiedEpoch !== undefined &&
      certifiedEpoch < known.certifiedEpoch
    ) {
      known.certifiedEpoch = certifiedEpoch;
    }
  }
  return {
    users: [...users].map(([userId, devices]) => ({
      userId,
      devices: [...devices.values()].map((device): DirectoryDevice => ({
        deviceId: device.deviceId,
        status: device.status,
        leafKeys: device.leafKeys,
        ...(device.replacedBy === undefined
          ? {}
          : { replacedBy: device.replacedBy }),
        ...(device.revocationCutoffEpoch === undefined
          ? {}
          : { revocationCutoffEpoch: device.revocationCutoffEpoch })
      }))
    }))
  };
}

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
 *   signing key (`verifyLeafCertification`).
 *
 * Anything that cannot be verified is refused with an `MlsDirectoryError`
 * rather than left out, so a forged or unattributable record is visible
 * instead of silently weakening or narrowing the directory.
 *
 * Not supplied yet, and so never defaulted (later slices must fill them):
 *
 * - **Revocation cutoffs.** For a revoked device the policy needs the first
 *   epoch of this project's group whose rejoin PSK that device must not
 *   know. The device list records revocations by entry sequence, not by
 *   group epoch, so a cutoff can only come from trusted per-project state
 *   the caller passes in `revocationCutoffs`. Without one the directory is
 *   refused (`revocation-cutoff-missing`): dropping the device would drop
 *   its cutoff and let a sibling rejoin with an older PSK, and guessing 0
 *   would be a silent default.
 * - **`certifiedEpoch`.** Neither the leaf certification payload nor the
 *   device list binds the epoch from which a certification counts, so none
 *   is set. The policy reads a missing value as "before the latest leaf
 *   removal", which refuses every recovery Add; it never relaxes a rule.
 * - **`replacedBy`.** Device-list revocations do not name a replacement
 *   device, so the last-leaf rejoin exception is unavailable.
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
  readonly certification: Uint8Array;
}

export interface DirectoryInput {
  /** Verified, pinned device lists: one per user, every user named below. */
  readonly lists: readonly VerifiedDeviceList[];
  readonly certifications: readonly LeafCertification[];
  /**
   * Per user, per revoked device id: the first epoch of this project's
   * group whose rejoin PSK the device must not know (0 when the group never
   * had an epoch it could know). Required for every revoked device; nothing
   * verified supplies it yet (see the module comment).
   */
  readonly revocationCutoffs?: ReadonlyMap<string, ReadonlyMap<string, number>>;
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
  readonly leafKeys: LeafKeyCertification[];
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

function devicesOf(
  list: VerifiedDeviceList,
  cutoffs: ReadonlyMap<string, number> | undefined
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
      devicesOf(list, input.revocationCutoffs?.get(list.userId))
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
    const valid =
      device.signingKey !== undefined &&
      (await verifyLeafCertification(
        mls,
        { projectId, ...claim },
        device.signingKey
      ));
    if (!valid) {
      throw new MlsDirectoryError(
        'certification-invalid',
        `The leaf certification of device ${claim.deviceId} of ${claim.userId} does not verify.`
      );
    }
    if (!device.leafKeys.some((leaf) => sameBytes(leaf.key, claim.leafKey))) {
      // No certifiedEpoch: nothing verified binds one (see above).
      device.leafKeys.push({ key: new Uint8Array(claim.leafKey) });
    }
  }
  return {
    users: [...users].map(([userId, devices]) => ({
      userId,
      devices: [...devices.values()].map((device): DirectoryDevice => ({
        deviceId: device.deviceId,
        status: device.status,
        leafKeys: device.leafKeys,
        ...(device.revocationCutoffEpoch === undefined
          ? {}
          : { revocationCutoffEpoch: device.revocationCutoffEpoch })
      }))
    }))
  };
}

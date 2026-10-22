import {
  accountKeyCommitment,
  commitDeviceApproval,
  createApprovalNonce,
  decodeDeviceApprovalGrant,
  decodeDeviceListEntry,
  deviceApprovalCode,
  deviceKeysHash,
  deviceListEntryHash,
  exportPrivateKey,
  exportPublicKey,
  formatComparisonCode,
  fromBase32,
  fromBase64Url,
  generateEncryptionKeyPair,
  generateSigningKeyPair,
  generateSymmetricKey,
  importEncryptionPrivateKey,
  importSigningPrivateKey,
  isE2eeError,
  nextDeviceListEntry,
  openSealedKey,
  publicKeyHash,
  publicKeyOfPrivateKey,
  recoveryTarget,
  sealKey,
  signDeviceApprovalGrant,
  signDeviceListEntry,
  signIdentityTransition,
  toBase32,
  toBase64Url,
  toHex,
  unwrapKey,
  verifyDeviceApprovalCommitment,
  verifyDeviceApprovalGrant,
  verifyDeviceList,
  verifyScannedDeviceKey,
  wrapKey,
  type Bytes,
  type DeviceListEntry,
  type DeviceListPin,
  type ListedDevice,
  type UnlockTarget,
  type VerifiedDeviceList
} from '@openzcad/crypto';
import type {
  E2eeAccountResponse,
  E2eeApprovedDeviceRecord,
  E2eeApprovalRecord,
  E2eeIdentityRecord,
  E2eeWrapInput,
  E2eeWrapPurpose,
  E2eeWrapRecord
} from '@openzcad/shared';
import type { E2eeApi } from './e2eeApi';
import { confirmApprovalCancellation } from './approvalCancellation';
import {
  DeviceListPinConflict,
  type DeviceKeyStore,
  type PinUpdateOptions,
  type StoredDevice
} from './deviceStore';
import {
  lockAccount,
  captureAccountKeyRead,
  clearCachedAccountKeys,
  rememberUnlockedAccount,
  unlockedAccount,
  type UnlockedAccount
} from './unlockedKeys';

/**
 * Account-level key material for end-to-end encryption (ADR-024 Phase 3,
 * first slice). Everything here runs in the browser: the Worker stores what
 * these functions produce and relays the device-approval exchange.
 *
 * - A long-term identity key (ECDSA P-256) signs the device list. It is
 *   sealed only to the recovery key's certified target (and, later,
 *   passkeys'), never to a device, and is opened only briefly.
 * - Each device has a signing key and an unlock key, both non-extractable.
 * - A random account key is sealed to every certified unlock target: each
 *   device's unlock key and the recovery-key target. The device list
 *   commits to it, so a substituted key is caught on unlock.
 * - The encryption key pair is wrapped under the account key.
 *
 * No project data is encrypted yet, and MLS is not wired in: project-key
 * epochs on device removal arrive with Phases 4 and 5. Passkey PRF unlock
 * and desktop Keychain storage are follow-ups; `UnlockTarget.kind`
 * `passkey` and `DeviceKeyStore` are their extension points.
 */

export type EncryptionFlowErrorCode =
  | 'wrong-recovery-key'
  | 'not-unlocked'
  | 'not-certified'
  | 'scan-mismatch'
  | 'commitment-mismatch'
  | 'grant-invalid'
  | 'key-mismatch'
  | 'missing-wrap'
  | 'approval-gone'
  | 'invalid-request';

export class EncryptionFlowError extends Error {
  constructor(
    readonly code: EncryptionFlowErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'EncryptionFlowError';
  }
}

export interface DeviceKeyPairs {
  readonly signing: CryptoKeyPair;
  readonly unlock: CryptoKeyPair;
}

export interface E2eeContext {
  readonly userId: string;
  readonly api: E2eeApi;
  readonly store: DeviceKeyStore;
  readonly now?: () => number;
  /** The initiating settings/account view still owns this operation. */
  readonly isCurrent?: () => boolean;
  /**
   * Makes this device's key pairs; non-extractable by default. Tests and
   * Playwright fixtures inject extractable pairs to seed a browser.
   */
  readonly createDeviceKeys?: () => Promise<DeviceKeyPairs>;
}

export type DeviceStatus =
  /** Listed in the newest device list: unlocks and may sign. */
  | 'certified'
  /** Approved by another device without certification: reads only. */
  | 'approved'
  /** Waiting on an approval request. */
  | 'pending'
  /** Removed from the device list; its keys are dead. */
  | 'removed'
  /** No keys for this account on this device. */
  | 'none';

export interface PreviousKeySet {
  readonly generation: number;
  readonly createdAt: string;
  readonly devices: readonly Pick<
    ListedDevice,
    'deviceId' | 'label' | 'addedAt'
  >[];
}

export interface AccountView {
  readonly userId: string;
  readonly generation: number;
  readonly createdAt: string;
  readonly list: VerifiedDeviceList;
  /** Persistence snapshot this view accepted, or retained on identity change. */
  readonly persistedPin: DeviceListPin | null;
  /** The identity fingerprint people compare, 40 digits. */
  readonly fingerprint: string;
  readonly wraps: readonly E2eeWrapRecord[];
  /** Informational labels; never a source of keys for sealing or signing. */
  readonly approvedDevices: readonly E2eeApprovedDeviceRecord[];
  readonly device: StoredDevice | null;
  readonly deviceStatus: DeviceStatus;
  readonly unlocked: boolean;
  /** Why this certified or approved device could not unlock, if it failed. */
  readonly unlockError: string | null;
  /**
   * Devices of replaced identities, to help approve them again. Read
   * without verification: a replaced identity is not trusted.
   */
  readonly previous: readonly PreviousKeySet[];
}

export type EncryptionState =
  | {
      readonly kind: 'not-set-up';
      readonly previous: readonly PreviousKeySet[];
    }
  | { readonly kind: 'ready'; readonly account: AccountView }
  /** The identity differs from the one this device pinned. */
  | { readonly kind: 'identity-changed'; readonly account: AccountView }
  /** The server showed an older or forked device list. */
  | { readonly kind: 'fork'; readonly message: string };

/** Approver nonces of compare-form approvals this page started. */
const approverNonces = new Map<string, Bytes>();

export { lockAccount };

/**
 * The unlocked encryption private key, for the phases that receive project
 * keys. Null while locked.
 */
export function unlockedEncryptionKey(userId: string): CryptoKey | null {
  return unlockedAccount(userId)?.encryptionPrivateKey ?? null;
}

const b64 = toBase64Url;
const now = (ctx: E2eeContext) => (ctx.now ?? Date.now)();

function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}${toHex(bytes)}`;
}

async function defaultDeviceKeys(): Promise<DeviceKeyPairs> {
  return {
    signing: await generateSigningKeyPair(false),
    unlock: await generateEncryptionKeyPair(false)
  };
}

/** A short name for this browser, such as "Chrome on macOS". */
export function defaultDeviceLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Browser';
  const system = /iPhone|iPad/.test(userAgent)
    ? 'iOS'
    : /Android/.test(userAgent)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null;
  return system ? `${browser} on ${system}` : browser;
}

/** Trims a typed label to what a device list accepts (1–64 bytes). */
export function normalizeDeviceLabel(label: string): string {
  // eslint-disable-next-line no-control-regex
  let text = label.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  const encoder = new TextEncoder();
  while (encoder.encode(text).byteLength > 64) {
    text = Array.from(text).slice(0, -1).join('').trimEnd();
  }
  return text || 'This device';
}

async function newStoredDevice(
  ctx: E2eeContext,
  label: string
): Promise<StoredDevice> {
  const keys = await (ctx.createDeviceKeys ?? defaultDeviceKeys)();
  return {
    userId: ctx.userId,
    deviceId: randomId('dev_'),
    label: normalizeDeviceLabel(label),
    signing: keys.signing,
    unlock: keys.unlock,
    signingPublicKey: await exportPublicKey(keys.signing.publicKey),
    unlockPublicKey: await exportPublicKey(keys.unlock.publicKey),
    createdAt: now(ctx),
    approval: null
  };
}

function listed(device: StoredDevice, addedAt: number): ListedDevice {
  return {
    deviceId: device.deviceId,
    label: device.label,
    signingKey: device.signingPublicKey,
    unlockKey: device.unlockPublicKey,
    addedAt
  };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => toHex(a) === toHex(b);

// --- Wraps ----------------------------------------------------------------

function wrapOf(
  account: Pick<AccountView, 'wraps'>,
  purpose: E2eeWrapPurpose,
  targetId: string
): Bytes {
  const wrap = account.wraps.find(
    (w) => w.purpose === purpose && w.targetId === targetId
  );
  if (!wrap) {
    throw new EncryptionFlowError(
      'missing-wrap',
      `The server has no ${purpose} for ${targetId}.`
    );
  }
  return fromBase64Url(wrap.wrapped);
}

function targetMethod(target: UnlockTarget) {
  return target.kind === 'recovery-key'
    ? ('recovery-key' as const)
    : ('passkey-prf' as const);
}

async function encryptionKeyId(encryptionPublicKey: Uint8Array) {
  return toHex(await publicKeyHash(encryptionPublicKey));
}

/**
 * The account key sealed to every certified unlock target of `head`, and the
 * encryption private key wrapped under it: what a rotation writes.
 */
async function accountWraps(
  userId: string,
  accountKey: Uint8Array,
  encryption: CryptoKeyPair,
  head: Pick<DeviceListEntry, 'devices' | 'unlockTargets' | 'encryptionKey'>
): Promise<E2eeWrapInput[]> {
  const wraps: E2eeWrapInput[] = [];
  for (const device of head.devices) {
    wraps.push({
      purpose: 'account-key',
      targetId: device.deviceId,
      wrapped: b64(
        await sealKey(device.unlockKey, accountKey, {
          purpose: 'account-key',
          userId,
          method: 'device',
          unlockId: device.deviceId
        })
      )
    });
  }
  for (const target of head.unlockTargets) {
    wraps.push({
      purpose: 'account-key',
      targetId: target.targetId,
      wrapped: b64(
        await sealKey(target.publicKey, accountKey, {
          purpose: 'account-key',
          userId,
          method: targetMethod(target),
          unlockId: target.targetId
        })
      )
    });
  }
  const pkcs8 = await exportPrivateKey(encryption.privateKey);
  wraps.push({
    purpose: 'encryption-key',
    targetId: 'current',
    wrapped: b64(
      await wrapKey(accountKey, pkcs8, {
        purpose: 'encryption-private-key',
        userId,
        keyId: await encryptionKeyId(head.encryptionKey)
      })
    )
  });
  pkcs8.fill(0);
  return wraps;
}

/** A fresh identity with its recovery target, account key and encryption key. */
async function newIdentity(
  ctx: E2eeContext,
  recoverySecret: Uint8Array,
  devices: readonly ListedDevice[],
  previousIdentityKeyHash: Uint8Array | null
) {
  const identity = await generateSigningKeyPair(true);
  const identityKey = await exportPublicKey(identity.publicKey);
  const identityKeyHash = await publicKeyHash(identityKey);
  const target = await generateEncryptionKeyPair(true);
  const targetKey = await exportPublicKey(target.publicKey);
  const targetId = randomId('rk_');
  const accountKey = generateSymmetricKey();
  const encryption = await generateEncryptionKeyPair(true);
  const issuedAt = now(ctx);
  const entry: DeviceListEntry = {
    userId: ctx.userId,
    sequence: 0,
    previousEntryHash: null,
    issuedAt,
    previousIdentityKeyHash,
    encryptionKey: await exportPublicKey(encryption.publicKey),
    accountKeyCommitment: await accountKeyCommitment(accountKey),
    devices,
    unlockTargets: [
      {
        kind: 'recovery-key',
        targetId,
        publicKey: targetKey,
        addedAt: issuedAt
      }
    ],
    revoked: []
  };
  const signed = await signDeviceListEntry(identity.privateKey, entry);
  const targetPkcs8 = await exportPrivateKey(target.privateKey);
  const identityPkcs8 = await exportPrivateKey(identity.privateKey);
  const wraps: E2eeWrapInput[] = [
    {
      purpose: 'unlock-target-key',
      targetId,
      wrapped: b64(
        await wrapKey(recoverySecret, targetPkcs8, {
          purpose: 'unlock-target-key',
          userId: ctx.userId,
          method: 'recovery-key',
          unlockId: targetId,
          identityKeyHash: toHex(identityKeyHash)
        })
      )
    },
    {
      purpose: 'identity-key',
      targetId,
      wrapped: b64(
        await sealKey(targetKey, identityPkcs8, {
          purpose: 'identity-key',
          userId: ctx.userId,
          method: 'recovery-key',
          unlockId: targetId
        })
      )
    },
    ...(await accountWraps(ctx.userId, accountKey, encryption, entry))
  ];
  targetPkcs8.fill(0);
  identityPkcs8.fill(0);
  accountKey.fill(0);
  return { identityKey, signed, wraps };
}

// --- Loading and unlocking ------------------------------------------------

function decodeChain(record: E2eeIdentityRecord) {
  return record.entries.map((row) => ({
    entry: fromBase64Url(row.entry),
    signature: fromBase64Url(row.signature)
  }));
}

function previousKeySets(response: E2eeAccountResponse): PreviousKeySet[] {
  return response.previous.flatMap((record) => {
    try {
      const head = decodeDeviceListEntry(fromBase64Url(record.head.entry));
      return [
        {
          generation: record.generation,
          createdAt: record.createdAt,
          devices: head.devices.map(({ deviceId, label, addedAt }) => ({
            deviceId,
            label,
            addedAt
          }))
        }
      ];
    } catch {
      return [];
    }
  });
}

function statusOf(
  list: VerifiedDeviceList,
  device: StoredDevice | null,
  wraps: readonly E2eeWrapRecord[]
): DeviceStatus {
  if (!device) return 'none';
  const live = list.devices.find((d) => d.deviceId === device.deviceId);
  if (live) {
    return sameBytes(live.signingKey, device.signingPublicKey) &&
      sameBytes(live.unlockKey, device.unlockPublicKey)
      ? 'certified'
      : 'removed';
  }
  if (
    list.revoked.some(
      (r) =>
        r.id === device.deviceId ||
        (r.device && sameBytes(r.device.signingKey, device.signingPublicKey))
    )
  ) {
    return 'removed';
  }
  if (
    wraps.some(
      (w) =>
        w.purpose === 'account-key-approval' && w.targetId === device.deviceId
    )
  ) {
    return 'approved';
  }
  return device.approval ? 'pending' : 'none';
}

/**
 * Checks an opened account key against the commitment the identity
 * certified, opens the encryption key and keeps both for this page.
 */
async function rememberAccountKey(
  userId: string,
  generation: number,
  list: VerifiedDeviceList,
  wraps: readonly E2eeWrapRecord[],
  accountKey: Bytes,
  requireCurrent: () => void
): Promise<void> {
  const commitment = await accountKeyCommitment(accountKey);
  if (!sameBytes(commitment, list.head.accountKeyCommitment)) {
    throw new EncryptionFlowError(
      'key-mismatch',
      'The account key does not match the one your device list certifies.'
    );
  }
  const pkcs8 = await unwrapKey(
    accountKey,
    wrapOf({ wraps }, 'encryption-key', 'current'),
    {
      purpose: 'encryption-private-key',
      userId,
      keyId: await encryptionKeyId(list.head.encryptionKey)
    }
  );
  try {
    if (
      !sameBytes(
        await publicKeyOfPrivateKey(pkcs8, 'ECDH'),
        list.head.encryptionKey
      )
    ) {
      throw new EncryptionFlowError(
        'key-mismatch',
        'The encryption key does not match the one your device list certifies.'
      );
    }
    const encryptionPrivateKey = await importEncryptionPrivateKey(pkcs8, false);
    requireCurrent();
    rememberUnlockedAccount(userId, {
      generation,
      commitment: toHex(commitment),
      accountKey,
      encryptionPrivateKey
    });
  } finally {
    pkcs8.fill(0);
  }
}

async function unlockThisDevice(
  ctx: E2eeContext,
  generation: number,
  list: VerifiedDeviceList,
  wraps: readonly E2eeWrapRecord[],
  device: StoredDevice,
  status: 'certified' | 'approved',
  requireCurrent: () => void
): Promise<void> {
  requireCurrent();
  const cached = unlockedAccount(ctx.userId);
  if (
    cached?.generation === generation &&
    cached.commitment === toHex(list.head.accountKeyCommitment)
  ) {
    return;
  }
  const certified = status === 'certified';
  const accountKey = await openSealedKey(
    { privateKey: device.unlock.privateKey, publicKey: device.unlockPublicKey },
    wrapOf(
      { wraps },
      certified ? 'account-key' : 'account-key-approval',
      device.deviceId
    ),
    {
      purpose: 'account-key',
      userId: ctx.userId,
      method: certified ? 'device' : 'device-approval',
      unlockId: device.deviceId
    }
  );
  let remembered = false;
  try {
    await rememberAccountKey(
      ctx.userId,
      generation,
      list,
      wraps,
      accountKey,
      requireCurrent
    );
    remembered = true;
  } finally {
    if (!remembered) accountKey.fill(0);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function persistDeviceList(
  ctx: E2eeContext,
  list: VerifiedDeviceList,
  options: PinUpdateOptions = {},
  isCurrent: () => boolean = () => ctx.isCurrent?.() !== false
): Promise<void> {
  try {
    await ctx.store.savePin(ctx.userId, list, options);
  } catch (error) {
    if (isCurrent()) clearCachedAccountKeys(ctx.userId);
    throw error;
  }
}

/**
 * Fetches the account's key material, verifies the device list against the
 * pin this browser holds, and unlocks this device when it can. A rolled-back
 * or forked list is reported as `fork`, a replaced identity as
 * `identity-changed`, and neither unlocks anything.
 */
export async function loadEncryption(
  ctx: E2eeContext
): Promise<EncryptionState> {
  const readCurrent = captureAccountKeyRead(ctx.userId);
  const isCurrent = () => readCurrent() && ctx.isCurrent?.() !== false;
  const requireCurrent = () => {
    if (!isCurrent())
      throw new EncryptionFlowError(
        'invalid-request',
        'The account session ended. Reopen encryption settings to retry.'
      );
  };
  requireCurrent();
  const response = await ctx.api.account();
  requireCurrent();
  const previous = previousKeySets(response);
  const current = response.current;
  const pin = await ctx.store.loadPin(ctx.userId);
  requireCurrent();
  if (!current) {
    clearCachedAccountKeys(ctx.userId);
    return pin
      ? {
          kind: 'fork',
          message:
            'The server omitted the device list this browser already trusts. Reload or recover the existing identity.'
        }
      : { kind: 'not-set-up', previous };
  }
  const identityKey = fromBase64Url(current.identityKey);
  const chain = decodeChain(current);
  let list: VerifiedDeviceList;
  let identityChanged = false;
  try {
    list = await verifyDeviceList(identityKey, chain, pin ? { pin } : {});
    if (list.userId !== ctx.userId) {
      throw new EncryptionFlowError(
        'invalid-request',
        'The device list belongs to another account.'
      );
    }
    requireCurrent();
    await persistDeviceList(ctx, list, {}, isCurrent);
    requireCurrent();
  } catch (error) {
    if (!isCurrent()) throw error;
    if (
      (pin && isE2eeError(error, 'context-mismatch')) ||
      (error instanceof DeviceListPinConflict && error.reason === 'identity')
    ) {
      list = await verifyDeviceList(identityKey, chain);
      identityChanged = true;
    } else if (
      (pin && isE2eeError(error, 'chain-broken')) ||
      (error instanceof DeviceListPinConflict && error.reason === 'chain')
    ) {
      clearCachedAccountKeys(ctx.userId);
      return {
        kind: 'fork',
        message:
          'The server showed this device an older or different device list than it has already seen.'
      };
    } else {
      throw error;
    }
  }
  if (list.userId !== ctx.userId) {
    throw new EncryptionFlowError(
      'invalid-request',
      'The device list belongs to another account.'
    );
  }
  const device = await ctx.store.loadDevice(ctx.userId);
  requireCurrent();
  const deviceStatus = statusOf(list, device, current.wraps);
  let unlocked = false;
  let unlockError: string | null = null;
  if (
    !identityChanged &&
    device &&
    (deviceStatus === 'certified' || deviceStatus === 'approved')
  ) {
    try {
      await unlockThisDevice(
        ctx,
        current.generation,
        list,
        current.wraps,
        device,
        deviceStatus,
        requireCurrent
      );
      unlocked = true;
    } catch (error) {
      if (!isCurrent()) throw error;
      clearCachedAccountKeys(ctx.userId);
      unlockError = describe(error);
    }
  } else {
    clearCachedAccountKeys(ctx.userId);
  }
  const approvedMetadata = new Map(
    (current.approvedDevices ?? []).map((item) => [item.deviceId, item])
  );
  const approvedDevices = current.wraps
    .filter((wrap) => wrap.purpose === 'account-key-approval')
    .map((wrap) => ({
      deviceId: wrap.targetId,
      label: approvedMetadata.get(wrap.targetId)?.label ?? 'Read-only device',
      approvedAt:
        approvedMetadata.get(wrap.targetId)?.approvedAt ?? current.createdAt
    }));
  const account: AccountView = {
    userId: ctx.userId,
    generation: current.generation,
    createdAt: current.createdAt,
    list,
    persistedPin: identityChanged ? pin : list.pin,
    fingerprint: formatComparisonCode(list.identityKeyHash),
    wraps: current.wraps,
    approvedDevices,
    device,
    deviceStatus,
    unlocked,
    unlockError,
    previous
  };
  return identityChanged
    ? { kind: 'identity-changed', account }
    : { kind: 'ready', account };
}

/**
 * Opens the identity key with the recovery key, briefly, for certifying,
 * revoking or replacing. The recovery target's wrap binds the identity key
 * hash under the recovery secret, so a server cannot pair a genuine target
 * with an identity of its own.
 */
async function openIdentity(
  ctx: E2eeContext,
  account: AccountView,
  recoverySecret: Uint8Array
): Promise<{ identityPrivateKey: CryptoKey; accountKey: Bytes }> {
  const { list } = account;
  const target = recoveryTarget(list);
  let targetPkcs8: Bytes;
  try {
    targetPkcs8 = await unwrapKey(
      recoverySecret,
      wrapOf(account, 'unlock-target-key', target.targetId),
      {
        purpose: 'unlock-target-key',
        userId: ctx.userId,
        method: 'recovery-key',
        unlockId: target.targetId,
        identityKeyHash: toHex(list.identityKeyHash)
      }
    );
  } catch (error) {
    if (isE2eeError(error, 'authentication-failed')) {
      throw new EncryptionFlowError(
        'wrong-recovery-key',
        'That recovery key does not open these keys.'
      );
    }
    throw error;
  }
  try {
    if (
      !sameBytes(
        await publicKeyOfPrivateKey(targetPkcs8, 'ECDH'),
        target.publicKey
      )
    ) {
      throw new EncryptionFlowError(
        'key-mismatch',
        'The recovery key target does not match the device list.'
      );
    }
    const recipient = {
      privateKey: await importEncryptionPrivateKey(targetPkcs8, false),
      publicKey: target.publicKey
    };
    const identityPkcs8 = await openSealedKey(
      recipient,
      wrapOf(account, 'identity-key', target.targetId),
      {
        purpose: 'identity-key',
        userId: ctx.userId,
        method: 'recovery-key',
        unlockId: target.targetId
      }
    );
    try {
      if (
        !sameBytes(
          await publicKeyOfPrivateKey(identityPkcs8, 'ECDSA'),
          list.identityKey
        )
      ) {
        throw new EncryptionFlowError(
          'key-mismatch',
          'The identity key does not match the device list.'
        );
      }
      const identityPrivateKey = await importSigningPrivateKey(
        identityPkcs8,
        false
      );
      const accountKey = await openSealedKey(
        recipient,
        wrapOf(account, 'account-key', target.targetId),
        {
          purpose: 'account-key',
          userId: ctx.userId,
          method: 'recovery-key',
          unlockId: target.targetId
        }
      );
      if (
        !sameBytes(
          await accountKeyCommitment(accountKey),
          list.head.accountKeyCommitment
        )
      ) {
        throw new EncryptionFlowError(
          'key-mismatch',
          'The account key does not match the one your device list certifies.'
        );
      }
      return { identityPrivateKey, accountKey };
    } finally {
      identityPkcs8.fill(0);
    }
  } finally {
    targetPkcs8.fill(0);
  }
}

/**
 * Accepts the device list a write returned, never on the server's word: it
 * must be under the identity this browser expects, contain the pin the
 * write was built on (so it cannot be an older prefix), and hold the exact
 * entry this browser just signed. Only then does the pin move.
 */
async function acceptWrite(
  ctx: E2eeContext,
  response: E2eeAccountResponse,
  expected: {
    readonly identityKey: Uint8Array;
    /** The verified head the write extended; absent for a new identity. */
    readonly pin?: DeviceListPin;
    /** Snapshot bound to an explicitly authorized identity change. */
    readonly replaceIdentityFrom?: DeviceListPin | null;
    /** The canonical entry bytes this browser signed and sent. */
    readonly written: Uint8Array;
  }
): Promise<VerifiedDeviceList> {
  const current = response.current;
  if (
    !current ||
    !sameBytes(fromBase64Url(current.identityKey), expected.identityKey)
  ) {
    throw new EncryptionFlowError(
      'key-mismatch',
      'The server answered with a different identity than the one written.'
    );
  }
  const list = await verifyDeviceList(
    expected.identityKey,
    decodeChain(current),
    expected.pin ? { pin: expected.pin } : {}
  );
  const writtenHash = await deviceListEntryHash(expected.written);
  if (!list.entries.some((entry) => sameBytes(entry.hash, writtenHash))) {
    throw new EncryptionFlowError(
      'key-mismatch',
      'The server answered without the device-list entry just written.'
    );
  }
  await persistDeviceList(ctx, list, {
    replaceIdentityFrom: expected.replaceIdentityFrom
  });
  return list;
}

// --- Setup, enrolment, removal and replacement ----------------------------

/**
 * First setup: a new identity, recovery target, account key and encryption
 * key, with this device certified in a fresh device list. The recovery key
 * must have been shown to the user and confirmed before this is called.
 */
export async function setUpEncryption(
  ctx: E2eeContext,
  options: { recoverySecret: Uint8Array; label: string }
): Promise<EncryptionState> {
  const persistedPin = await ctx.store.loadPin(ctx.userId);
  if (persistedPin) {
    lockAccount(ctx.userId);
    throw new EncryptionFlowError(
      'invalid-request',
      'This browser already trusts an encryption identity. Recover it instead of setting up a replacement.'
    );
  }
  const device = await ctx.store.getOrCreateDevice(
    await newStoredDevice(ctx, options.label)
  );
  const created = await newIdentity(
    ctx,
    options.recoverySecret,
    [listed(device, now(ctx))],
    null
  );
  // Keys first: a setup that reaches the server without them still opens
  // with the recovery key, while the reverse would strand this device.
  const response = await ctx.api.setup({
    identityKey: b64(created.identityKey),
    entry: b64(created.signed.entry),
    signature: b64(created.signed.signature),
    wraps: created.wraps
  });
  await acceptWrite(ctx, response, {
    identityKey: created.identityKey,
    replaceIdentityFrom: persistedPin,
    written: created.signed.entry
  });
  return loadEncryption(ctx);
}

/**
 * Certifies this device with the recovery key: a new device, a device
 * approved read-only, or one whose identity was replaced elsewhere.
 */
export async function enrollWithRecoveryKey(
  ctx: E2eeContext,
  account: AccountView,
  recoverySecret: Uint8Array,
  label: string
): Promise<EncryptionState> {
  if (
    account.deviceStatus === 'certified' &&
    account.persistedPin &&
    sameBytes(
      account.persistedPin.identityKeyHash,
      account.list.identityKeyHash
    )
  )
    return loadEncryption(ctx);
  const { identityPrivateKey, accountKey } = await openIdentity(
    ctx,
    account,
    recoverySecret
  );
  if (account.deviceStatus === 'certified') {
    try {
      // A replacement may have reached the server while its local pin CAS
      // lost a race. The saved recovery key can explicitly trust that new
      // identity without trying to certify this already-listed device again.
      await persistDeviceList(ctx, account.list, {
        replaceIdentityFrom: account.persistedPin
      });
      return loadEncryption(ctx);
    } finally {
      accountKey.fill(0);
    }
  }
  const device =
    account.device && account.deviceStatus !== 'removed'
      ? { ...account.device, approval: null }
      : await newStoredDevice(ctx, label);
  const entry = nextDeviceListEntry(account.list, {
    issuedAt: now(ctx),
    addDevices: [listed(device, now(ctx))]
  });
  const signed = await signDeviceListEntry(identityPrivateKey, entry);
  const wraps: E2eeWrapInput[] = [
    {
      purpose: 'account-key',
      targetId: device.deviceId,
      wrapped: b64(
        await sealKey(device.unlockPublicKey, accountKey, {
          purpose: 'account-key',
          userId: ctx.userId,
          method: 'device',
          unlockId: device.deviceId
        })
      )
    }
  ];
  accountKey.fill(0);
  await ctx.store.saveDevice(device);
  const response = await ctx.api.appendDeviceList({
    generation: account.generation,
    entry: b64(signed.entry),
    signature: b64(signed.signature),
    wraps
  });
  await acceptWrite(ctx, response, {
    identityKey: account.list.identityKey,
    pin: account.list.pin,
    replaceIdentityFrom: account.persistedPin,
    written: signed.entry
  });
  return loadEncryption(ctx);
}

/**
 * Removes another device: revokes it in a new identity-signed entry and
 * rotates the account key and encryption key in the same entry, sealing the
 * new account key to every surviving device and unlock target taken from
 * that verified list, never to a key the server offers. The removed device
 * keeps no wrap. Needs the recovery key, because only the identity key may
 * sign the entry.
 *
 * Project-key epochs follow in Phases 4 and 5; no project is encrypted yet.
 */
export async function removeDevice(
  ctx: E2eeContext,
  account: AccountView,
  deviceId: string,
  recoverySecret: Uint8Array
): Promise<EncryptionState> {
  if (deviceId === account.device?.deviceId) {
    throw new EncryptionFlowError(
      'invalid-request',
      'Remove this device by signing out and removing its keys.'
    );
  }
  return rotateAccountKeys(ctx, account, recoverySecret, [deviceId]);
}

/** Revoke every read-only approval without trusting unsigned recipient keys. */
export async function revokeReadOnlyDevices(
  ctx: E2eeContext,
  account: AccountView,
  recoverySecret: Uint8Array
): Promise<EncryptionState> {
  // The server may omit approval wraps. Rotation must remain available even
  // when it reports no read-only devices; only certified recipients survive.
  return rotateAccountKeys(ctx, account, recoverySecret, []);
}

async function rotateAccountKeys(
  ctx: E2eeContext,
  account: AccountView,
  recoverySecret: Uint8Array,
  removeDeviceIds: readonly string[]
): Promise<EncryptionState> {
  const { identityPrivateKey, accountKey: oldAccountKey } = await openIdentity(
    ctx,
    account,
    recoverySecret
  );
  oldAccountKey.fill(0);
  const accountKey = generateSymmetricKey();
  const encryption = await generateEncryptionKeyPair(true);
  const entry = nextDeviceListEntry(account.list, {
    issuedAt: now(ctx),
    removeDeviceIds,
    encryptionKey: await exportPublicKey(encryption.publicKey),
    accountKeyCommitment: await accountKeyCommitment(accountKey)
  });
  const signed = await signDeviceListEntry(identityPrivateKey, entry);
  const wraps = await accountWraps(ctx.userId, accountKey, encryption, entry);
  accountKey.fill(0);
  const response = await ctx.api.appendDeviceList({
    generation: account.generation,
    entry: b64(signed.entry),
    signature: b64(signed.signature),
    wraps
  });
  await acceptWrite(ctx, response, {
    identityKey: account.list.identityKey,
    pin: account.list.pin,
    written: signed.entry
  });
  return loadEncryption(ctx);
}

/**
 * Replaces the recovery key, which always replaces the identity key: a new
 * identity with a fresh device list holding only this device and the new
 * recovery key, a new account key and encryption key, and a transition
 * statement signed by the old identity (when the old recovery key is given)
 * or by this device's certified key. Every other device must be approved
 * again, and contacts must verify the new fingerprint.
 */
export async function replaceRecoveryKey(
  ctx: E2eeContext,
  account: AccountView,
  newRecoverySecret: Uint8Array,
  oldRecoverySecret: Uint8Array | null
): Promise<EncryptionState> {
  const device = account.device;
  if (!device || account.deviceStatus !== 'certified') {
    throw new EncryptionFlowError(
      'not-certified',
      'Only a certified device can replace the recovery key.'
    );
  }
  let signer: { key: CryptoKey; raw: Uint8Array; kind: 'identity' | 'device' };
  if (oldRecoverySecret) {
    const opened = await openIdentity(ctx, account, oldRecoverySecret);
    opened.accountKey.fill(0);
    signer = {
      key: opened.identityPrivateKey,
      raw: account.list.identityKey,
      kind: 'identity'
    };
  } else {
    signer = {
      key: device.signing.privateKey,
      raw: device.signingPublicKey,
      kind: 'device'
    };
  }
  const created = await newIdentity(
    ctx,
    newRecoverySecret,
    [listed(device, now(ctx))],
    account.list.identityKeyHash
  );
  const transition = await signIdentityTransition(signer.key, {
    userId: ctx.userId,
    oldIdentityKeyHash: account.list.identityKeyHash,
    newIdentityKey: created.identityKey,
    newGenesisHash: await deviceListEntryHash(created.signed.entry),
    signer: signer.kind,
    signerKeyHash: await publicKeyHash(signer.raw),
    signedAt: now(ctx)
  });
  const response = await ctx.api.replaceIdentity({
    generation: account.generation + 1,
    identityKey: b64(created.identityKey),
    entry: b64(created.signed.entry),
    signature: b64(created.signed.signature),
    wraps: created.wraps,
    transition: {
      statement: b64(transition.statement),
      signature: b64(transition.signature)
    }
  });
  await acceptWrite(ctx, response, {
    identityKey: created.identityKey,
    replaceIdentityFrom: account.persistedPin,
    written: created.signed.entry
  });
  return loadEncryption(ctx);
}

/** Sign-out without keeping this device unlocked: its keys are deleted. */
export async function forgetThisDevice(ctx: E2eeContext): Promise<void> {
  lockAccount(ctx.userId);
  const device = await ctx.store.loadDevice(ctx.userId);
  if (device?.approval) {
    await ctx.api.cancelApproval(device.approval.id).catch(() => undefined);
  }
  await ctx.store.deleteDevice(ctx.userId);
}

// --- Device approval: the new device --------------------------------------

const SCAN_PREFIX = 'OZD1:';

/**
 * What the new device shows as a QR code (and as text to type): the full
 * 256-bit `pk_new`, the hash of both its public keys, in Crockford base32.
 */
export async function deviceScanCode(device: StoredDevice): Promise<string> {
  return `${SCAN_PREFIX}${toBase32(
    await deviceKeysHash(device.signingPublicKey, device.unlockPublicKey)
  )}`;
}

/** The 32-byte hash in a scanned or typed code, or null if it is not one. */
export function parseScanCode(text: string): Bytes | null {
  const compact = text.replace(/[\s-]/g, '').toUpperCase();
  const body = compact.startsWith(SCAN_PREFIX)
    ? compact.slice(SCAN_PREFIX.length)
    : compact;
  try {
    return fromBase32(body, 32);
  } catch {
    return null;
  }
}

export type NewDeviceApprovalStep =
  | {
      readonly step: 'waiting';
      readonly approval: E2eeApprovalRecord;
      readonly scanCode: string;
    }
  | {
      readonly step: 'compare';
      readonly approval: E2eeApprovalRecord;
      readonly code: string;
      /** The user confirmed on this device that both codes match. */
      readonly confirmed: boolean;
    }
  | { readonly step: 'done'; readonly state: EncryptionState }
  | { readonly step: 'expired' };

/**
 * Asks another device to approve this one. The request carries both public
 * keys and a commitment to a secret nonce, so the approver can use either
 * form: scan the full key hash, or compare six digits.
 */
export async function requestApproval(
  ctx: E2eeContext,
  account: Pick<AccountView, 'deviceStatus'> | null,
  label: string
): Promise<NewDeviceApprovalStep> {
  const pinAtRequest = await ctx.store.loadPin(ctx.userId);
  const stored = await ctx.store.loadDevice(ctx.userId);
  if (stored?.approval) {
    await ctx.api.cancelApproval(stored.approval.id).catch(() => undefined);
  }
  // A removed device's keys can never be listed again.
  const device =
    stored && account?.deviceStatus !== 'removed'
      ? { ...stored, label: normalizeDeviceLabel(label), approval: null }
      : await newStoredDevice(ctx, label);
  const { nonce, commitment } = await commitDeviceApproval([
    device.signingPublicKey,
    device.unlockPublicKey
  ]);
  const approval = await ctx.api.createApproval({
    deviceId: device.deviceId,
    label: device.label,
    signingKey: b64(device.signingPublicKey),
    unlockKey: b64(device.unlockPublicKey),
    commitment: b64(commitment)
  });
  await ctx.store.saveDevice({
    ...device,
    approval: {
      id: approval.id,
      nonce,
      confirmedApproverKey: null,
      pinAtRequest
    }
  });
  return { step: 'waiting', approval, scanCode: await deviceScanCode(device) };
}

/**
 * One poll of this device's approval request. When the approver has
 * answered, reveals the nonce and returns the six digits to compare; when it
 * has completed, verifies the signed grant and finishes.
 */
export async function advanceApprovalAsNewDevice(
  ctx: E2eeContext
): Promise<NewDeviceApprovalStep> {
  const device = await ctx.store.loadDevice(ctx.userId);
  if (!device?.approval) return { step: 'expired' };
  let approval: E2eeApprovalRecord;
  try {
    approval = await ctx.api.getApproval(device.approval.id);
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      await ctx.store.saveDevice({ ...device, approval: null });
      return { step: 'expired' };
    }
    throw error;
  }
  if (approval.deviceId !== device.deviceId) {
    throw new EncryptionFlowError(
      'grant-invalid',
      'The approval request names another device.'
    );
  }
  const nonce = device.approval.nonce;
  if (approval.state === 'responded' && nonce) {
    approval = await ctx.api.revealApproval(approval.id, { nonce: b64(nonce) });
  }
  // The compare form: until the user confirms the digits here, a completed
  // approval waits too, because the key that answered could be anyone's.
  const compareForm = approval.approverKey !== null;
  const confirmed =
    compareForm &&
    device.approval.confirmedApproverKey === approval.approverKey;
  if (
    nonce &&
    (approval.state === 'revealed' ||
      (approval.state === 'completed' && compareForm && !confirmed))
  ) {
    return {
      step: 'compare',
      approval,
      code: await newDeviceCode(device, nonce, approval),
      confirmed
    };
  }
  if (approval.state === 'completed') {
    return { step: 'done', state: await finishApproval(ctx, device, approval) };
  }
  return { step: 'waiting', approval, scanCode: await deviceScanCode(device) };
}

function newDeviceCode(
  device: StoredDevice,
  nonce: Uint8Array,
  approval: E2eeApprovalRecord
): Promise<string> {
  return deviceApprovalCode({
    newDevicePublicKey: [device.signingPublicKey, device.unlockPublicKey],
    approverPublicKey: fromBase64Url(approval.approverKey ?? ''),
    newDeviceNonce: nonce,
    approverNonce: fromBase64Url(approval.approverNonce ?? '')
  });
}

/**
 * The user confirmed, on this new device, that both screens show the same
 * six digits: from now on only the approver key behind them may complete.
 */
export async function confirmApprovalCode(
  ctx: E2eeContext
): Promise<NewDeviceApprovalStep> {
  const device = await ctx.store.loadDevice(ctx.userId);
  if (!device?.approval) return { step: 'expired' };
  const approval = await ctx.api.getApproval(device.approval.id);
  if (
    !approval.approverKey ||
    (approval.state !== 'revealed' && approval.state !== 'completed')
  ) {
    throw new EncryptionFlowError(
      'approval-gone',
      'There is no code to confirm yet.'
    );
  }
  await ctx.store.saveDevice({
    ...device,
    approval: { ...device.approval, confirmedApproverKey: approval.approverKey }
  });
  return advanceApprovalAsNewDevice(ctx);
}

async function finishApproval(
  ctx: E2eeContext,
  device: StoredDevice,
  approval: E2eeApprovalRecord
): Promise<EncryptionState> {
  if (!approval.grant) {
    throw new EncryptionFlowError(
      'grant-invalid',
      'The approval has no grant.'
    );
  }
  if (
    approval.approverKey &&
    device.approval?.confirmedApproverKey !== approval.approverKey
  ) {
    throw new EncryptionFlowError(
      'grant-invalid',
      'Confirm on this device that the codes match first.'
    );
  }
  const signed = {
    statement: fromBase64Url(approval.grant.statement),
    signature: fromBase64Url(approval.grant.signature)
  };
  const response = await ctx.api.account();
  const current = response.current;
  if (!current) {
    throw new EncryptionFlowError(
      'grant-invalid',
      'Encryption is not set up for this account.'
    );
  }
  const identityKey = fromBase64Url(current.identityKey);
  const chain = decodeChain(current);
  const pin = await ctx.store.loadPin(ctx.userId);
  let list: VerifiedDeviceList;
  try {
    list = await verifyDeviceList(identityKey, chain, pin ? { pin } : {});
  } catch (error) {
    // A device re-approved after its identity was replaced pins the new one
    // only on the approver's signed word, below.
    if (!(pin && isE2eeError(error, 'context-mismatch'))) throw error;
    // The scan form authenticates only this device to the approver: the
    // approver's key would come from the very list being trusted, which a
    // server could fabricate together with a new identity. Replacing a
    // pinned identity needs the compare form, whose six digits authenticate
    // the approver here, or the new recovery key.
    if (!approval.approverKey) {
      await ctx.api.cancelApproval(approval.id).catch(() => undefined);
      await ctx.store.saveDevice({ ...device, approval: null });
      throw new EncryptionFlowError(
        'grant-invalid',
        'This device trusted different encryption keys, and a scanned approval cannot replace them. Enter the new recovery key here, or ask again and choose Compare codes on the other device.'
      );
    }
    list = await verifyDeviceList(identityKey, chain);
  }
  // In the compare form the six digits authenticated the approver's key; in
  // the scan form only the approver checked us, so its key comes from the
  // device list, with the same first-sight trust as any fresh browser.
  let claimedApprover: Uint8Array;
  try {
    claimedApprover = decodeDeviceApprovalGrant(
      signed.statement
    ).approverKeyHash;
  } catch {
    throw new EncryptionFlowError(
      'grant-invalid',
      'The approval is malformed.'
    );
  }
  const approverKey = approval.approverKey
    ? fromBase64Url(approval.approverKey)
    : list.devices.find((d) => sameBytes(d.signingKeyHash, claimedApprover))
        ?.signingKey;
  if (!approverKey) {
    throw new EncryptionFlowError(
      'grant-invalid',
      'The approving device is not in your device list.'
    );
  }
  const grant = await verifyDeviceApprovalGrant(signed, approverKey).catch(
    () => {
      throw new EncryptionFlowError(
        'grant-invalid',
        'The approval was not signed by the approving device.'
      );
    }
  );
  const pinned = list.entries[grant.headSequence];
  if (
    grant.userId !== ctx.userId ||
    grant.deviceId !== device.deviceId ||
    !sameBytes(
      grant.deviceKeysHash,
      await deviceKeysHash(device.signingPublicKey, device.unlockPublicKey)
    ) ||
    !sameBytes(grant.identityKeyHash, list.identityKeyHash) ||
    !pinned ||
    !sameBytes(pinned.hash, grant.headHash)
  ) {
    throw new EncryptionFlowError(
      'grant-invalid',
      'The approval does not match this device or its device list.'
    );
  }
  if (
    grant.certified &&
    !list.devices.some((d) => d.deviceId === device.deviceId)
  ) {
    throw new EncryptionFlowError(
      'grant-invalid',
      'The approval claims a certification the device list does not hold.'
    );
  }
  await persistDeviceList(ctx, list, {
    replaceIdentityFrom: device.approval?.pinAtRequest
  });
  await ctx.store.saveDevice({ ...device, approval: null });
  await ctx.api.cancelApproval(approval.id).catch(() => undefined);
  return loadEncryption(ctx);
}

/** Withdraws this device's approval request. */
export async function cancelApprovalRequest(ctx: E2eeContext): Promise<void> {
  const device = await ctx.store.loadDevice(ctx.userId);
  if (!device?.approval) return;
  await confirmApprovalCancellation(ctx.api, device.approval.id);
  await ctx.store.clearApprovalIfCurrent(ctx.userId, device.approval.id);
}

// --- Device approval: the approving device --------------------------------

function requireUnlockedApprover(
  ctx: E2eeContext,
  account: AccountView
): { device: StoredDevice; unlocked: UnlockedAccount } {
  const unlocked = unlockedAccount(ctx.userId);
  if (!account.device || account.deviceStatus !== 'certified') {
    throw new EncryptionFlowError(
      'not-certified',
      'Only a certified device can approve another one.'
    );
  }
  if (
    !unlocked ||
    unlocked.commitment !== toHex(account.list.head.accountKeyCommitment)
  ) {
    throw new EncryptionFlowError(
      'not-unlocked',
      'Unlock this device before approving another one.'
    );
  }
  return { device: account.device, unlocked };
}

/** Starts the compare form: sends this device's key and a fresh nonce. */
export async function beginCompareApproval(
  ctx: E2eeContext,
  account: AccountView,
  approvalId: string
): Promise<E2eeApprovalRecord> {
  const { device } = requireUnlockedApprover(ctx, account);
  const nonce = createApprovalNonce();
  approverNonces.set(approvalId, nonce);
  return ctx.api.respondApproval(approvalId, {
    approverKey: b64(device.signingPublicKey),
    approverNonce: b64(nonce)
  });
}

/**
 * The six digits for a revealed compare-form approval, after checking the
 * new device's revealed nonce against its commitment. Null until revealed.
 */
export async function approverComparisonCode(
  ctx: E2eeContext,
  account: AccountView,
  approval: E2eeApprovalRecord
): Promise<string | null> {
  if (approval.state !== 'revealed') return null;
  const { device } = requireUnlockedApprover(ctx, account);
  const nonce = approverNonces.get(approval.id);
  if (
    !nonce ||
    approval.approverKey !== b64(device.signingPublicKey) ||
    approval.approverNonce !== b64(nonce) ||
    !approval.commitment ||
    !approval.deviceNonce
  ) {
    throw new EncryptionFlowError(
      'approval-gone',
      'This comparison was started elsewhere. Start it again.'
    );
  }
  const keys = [
    fromBase64Url(approval.signingKey),
    fromBase64Url(approval.unlockKey)
  ];
  if (
    !(await verifyDeviceApprovalCommitment(
      keys,
      fromBase64Url(approval.deviceNonce),
      fromBase64Url(approval.commitment)
    ))
  ) {
    throw new EncryptionFlowError(
      'commitment-mismatch',
      'The new device’s keys changed after it committed to them. Do not approve it.'
    );
  }
  return deviceApprovalCode({
    newDevicePublicKey: keys,
    approverPublicKey: device.signingPublicKey,
    newDeviceNonce: fromBase64Url(approval.deviceNonce),
    approverNonce: nonce
  });
}

/**
 * The account's device list as the server holds it now, verified to extend
 * `account`'s list under the same identity and key generation.
 */
async function currentDeviceList(
  ctx: E2eeContext,
  account: AccountView
): Promise<VerifiedDeviceList> {
  const current = (await ctx.api.account()).current;
  if (
    !current ||
    current.generation !== account.generation ||
    !sameBytes(fromBase64Url(current.identityKey), account.list.identityKey)
  ) {
    throw new EncryptionFlowError(
      'key-mismatch',
      'Your encryption keys changed since this page loaded. Reload and approve again.'
    );
  }
  const list = await verifyDeviceList(
    account.list.identityKey,
    decodeChain(current),
    { pin: account.list.pin }
  );
  await persistDeviceList(ctx, list);
  return list;
}

export type ApprovalProof =
  | { readonly kind: 'scan'; readonly code: string }
  /** The user confirmed both screens show the same six digits. */
  | { readonly kind: 'compare' };

/**
 * Approves a new device once its keys are authenticated: by the scanned
 * full hash, or by a compare-form code the user confirmed. With the
 * recovery key the device is certified in a new entry and the account key
 * sealed to its unlock key; without it the account key is sealed for
 * read-only approval, and the device certifies itself later. Either way the
 * new device receives a grant signed by this device naming the head to pin.
 */
export async function approveDevice(
  ctx: E2eeContext,
  account: AccountView,
  approval: E2eeApprovalRecord,
  proof: ApprovalProof,
  recoverySecret: Uint8Array | null
): Promise<EncryptionState> {
  const { device, unlocked } = requireUnlockedApprover(ctx, account);
  const signingKey = fromBase64Url(approval.signingKey);
  const unlockKey = fromBase64Url(approval.unlockKey);
  if (proof.kind === 'scan') {
    const scanned = parseScanCode(proof.code);
    if (
      !scanned ||
      !(await verifyScannedDeviceKey([signingKey, unlockKey], scanned))
    ) {
      throw new EncryptionFlowError(
        'scan-mismatch',
        'That code does not match the device asking for approval. Do not approve it.'
      );
    }
  } else if ((await approverComparisonCode(ctx, account, approval)) === null) {
    throw new EncryptionFlowError(
      'approval-gone',
      'Compare the codes before approving.'
    );
  }
  let list = account.list;
  let certified = false;
  let sealedAccountKey: string | undefined;
  if (recoverySecret) {
    // An earlier attempt may have certified the device and then failed
    // before `completeApproval` reached the Worker. Resume from the current
    // list with that certification instead of conflicting on a second append.
    const current = await currentDeviceList(ctx, account);
    const listed = current.devices.find(
      (d) => d.deviceId === approval.deviceId
    );
    if (listed) {
      if (
        !sameBytes(listed.signingKey, signingKey) ||
        !sameBytes(listed.unlockKey, unlockKey)
      ) {
        throw new EncryptionFlowError(
          'key-mismatch',
          'The device list already holds different keys for this device. Do not approve it.'
        );
      }
      list = current;
      certified = true;
    } else if (!sameBytes(current.headHash, account.list.headHash)) {
      // A newer entry may have rotated the account key, and this view's
      // wraps would seal the old one to the new device.
      throw new EncryptionFlowError(
        'key-mismatch',
        'Your device list changed since this page loaded. Reload and approve again.'
      );
    }
  }
  if (recoverySecret && !certified) {
    const { identityPrivateKey, accountKey } = await openIdentity(
      ctx,
      account,
      recoverySecret
    );
    const entry = nextDeviceListEntry(list, {
      issuedAt: now(ctx),
      addDevices: [
        {
          deviceId: approval.deviceId,
          label: approval.label,
          signingKey,
          unlockKey,
          addedAt: now(ctx)
        }
      ]
    });
    const signed = await signDeviceListEntry(identityPrivateKey, entry);
    const wrapped = await sealKey(unlockKey, accountKey, {
      purpose: 'account-key',
      userId: ctx.userId,
      method: 'device',
      unlockId: approval.deviceId
    });
    accountKey.fill(0);
    const response = await ctx.api.appendDeviceList({
      generation: account.generation,
      entry: b64(signed.entry),
      signature: b64(signed.signature),
      wraps: [
        {
          purpose: 'account-key',
          targetId: approval.deviceId,
          wrapped: b64(wrapped)
        }
      ]
    });
    list = await acceptWrite(ctx, response, {
      identityKey: list.identityKey,
      pin: list.pin,
      written: signed.entry
    });
    certified = true;
  } else if (!certified) {
    sealedAccountKey = b64(
      await sealKey(unlockKey, unlocked.accountKey, {
        purpose: 'account-key',
        userId: ctx.userId,
        method: 'device-approval',
        unlockId: approval.deviceId
      })
    );
  }
  const grant = await signDeviceApprovalGrant(device.signing.privateKey, {
    userId: ctx.userId,
    deviceKeysHash: await deviceKeysHash(signingKey, unlockKey),
    deviceId: approval.deviceId,
    identityKeyHash: list.identityKeyHash,
    headSequence: list.head.sequence,
    headHash: list.headHash,
    certified,
    approverKeyHash: await publicKeyHash(device.signingPublicKey),
    issuedAt: now(ctx)
  });
  await ctx.api.completeApproval(approval.id, {
    grant: { statement: b64(grant.statement), signature: b64(grant.signature) },
    ...(sealedAccountKey ? { sealedAccountKey } : {})
  });
  approverNonces.delete(approval.id);
  return loadEncryption(ctx);
}

/** Refuses a pending request from the approving side. */
export async function denyApproval(
  ctx: E2eeContext,
  approvalId: string
): Promise<void> {
  approverNonces.delete(approvalId);
  await ctx.api.cancelApproval(approvalId);
}

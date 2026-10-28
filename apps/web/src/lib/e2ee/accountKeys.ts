import {
  accountKeyCommitment,
  accountKeySequence,
  accountKeySequences,
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
  fromHex,
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
  signGroupReset,
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
  type DeviceApprovalContactsHead,
  type DeviceListEntry,
  type DeviceListPin,
  type ListedDevice,
  type SigningPrivateKey,
  type GroupReset,
  type SignedStatement,
  type UnlockTarget,
  type VerifiedDeviceList
} from '@openzcad/crypto';
import type {
  E2eeAccountKeyHistoryInput,
  E2eeAccountKeyHistoryRecord,
  E2eeAccountResponse,
  E2eeApprovedDeviceRecord,
  E2eeApprovalRecord,
  E2eeIdentityRecord,
  E2eeSignedStatementRecord,
  E2eeWrapInput,
  E2eeWrapPurpose,
  E2eeWrapRecord
} from '@openzcad/shared';
import type { E2eeApi } from './e2eeApi';
import { confirmApprovalCancellation } from './approvalCancellation';
import {
  EMPTY_CONTACTS_HASH,
  EMPTY_CONTACTS_SEQUENCE,
  contactPins,
  type ContactPinStore
} from './contactPins';
import {
  browserPasskeys,
  failedPasskeyEnrollment,
  type PasskeyPrf
} from './passkeys';
import {
  DeviceListPinConflict,
  type DeviceKeyStore,
  type DeviceSigningKeys,
  type DeviceUnlockKeys,
  type PinUpdateOptions,
  type StoredDevice
} from './deviceStore';
import {
  keyOperationGuard,
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
 *   sealed only to recovery-key and passkey certified targets, never to a
 *   device, and is opened only briefly.
 * - Each device has a signing key and an unlock key, both non-extractable.
 * - A random account key is sealed to every certified unlock target: each
 *   device's unlock key and the recovery-key target. The device list
 *   commits to it, so a substituted key is caught on unlock.
 * - The encryption key pair is wrapped under the account key.
 *
 * No project data is encrypted yet, and MLS is not wired in: project-key
 * epochs on device removal arrive with Phases 4 and 5. Desktop Keychain
 * storage is a follow-up through `DeviceKeyStore`.
 */

export type EncryptionFlowErrorCode =
  | 'wrong-recovery-key'
  | 'wrong-passkey'
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
  readonly signing: DeviceSigningKeys;
  readonly unlock: DeviceUnlockKeys;
}

export interface E2eeContext {
  readonly userId: string;
  /** Cancelling one settings view leaves independent migration reads alive. */
  readonly readScope?: object;
  readonly api: E2eeApi;
  readonly store: DeviceKeyStore;
  readonly now?: () => number;
  /** The initiating settings/account view still owns this operation. */
  readonly isCurrent?: () => boolean;
  /** Browser WebAuthn PRF; injectable for regression tests. */
  readonly passkeys?: PasskeyPrf;
  /** Reject continuation after the session that started a passkey flow ends. */
  readonly assertActive?: () => void;
  /**
   * Makes this device's key pairs; non-extractable by default. Tests and
   * Playwright fixtures inject extractable pairs to seed a browser.
   */
  readonly createDeviceKeys?: () => Promise<DeviceKeyPairs>;
  /**
   * This browser's contact pins (`contactPins()` by default): setup and
   * device approval write where its contacts-list trust starts.
   */
  readonly contactPins?: ContactPinStore;
}

const contactPinsOf = (ctx: E2eeContext): ContactPinStore =>
  ctx.contactPins ?? contactPins();

/**
 * A browser that creates an identity saw its contacts list empty, so its
 * contacts pin starts confirmed: nothing could have been signed before.
 */
async function pinEmptyContacts(
  ctx: E2eeContext,
  list: VerifiedDeviceList
): Promise<void> {
  await contactPinsOf(ctx).advanceList(ctx.userId, {
    identityKeyHash: toHex(list.identityKeyHash),
    sequence: EMPTY_CONTACTS_SEQUENCE,
    entryHash: EMPTY_CONTACTS_HASH,
    confirmed: true
  });
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

interface CompareApproval {
  readonly id: string;
  readonly deviceId: string;
  readonly signingKey: Bytes;
  readonly unlockKey: Bytes;
  readonly commitment: Bytes;
  readonly approverId: string;
  readonly approverKey: Bytes;
  readonly nonce: Bytes;
  readonly assertActive: () => void;
}

/** Private, session-bound observations made before releasing our nonce. */
const compareApprovals = new Map<string, CompareApproval>();
const comparisonId = (ctx: E2eeContext, id: string) =>
  JSON.stringify([ctx.userId, id]);

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

/**
 * Makes this device's keys and hands the new device record to `persist`,
 * whose first step must be the store write that takes it.
 *
 * Until that write, nothing holds the private keys but this call: on desktop
 * they are Keychain items reachable only through the key id in memory here.
 * So if the flow stops first (the settings close or the session changes
 * while the keys are being created or imported, or the public keys fail to
 * export), the store discards them. From the write on, the store owns them:
 * it keeps them only if its record holds them, whatever the write's outcome.
 */
async function withNewDevice<T>(
  ctx: E2eeContext,
  label: string,
  requireCurrent: () => void,
  persist: (candidate: StoredDevice) => Promise<T>
): Promise<T> {
  const keys = await (ctx.createDeviceKeys ?? defaultDeviceKeys)();
  let candidate: StoredDevice;
  try {
    candidate = {
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
    requireCurrent();
  } catch (error) {
    await ctx.store.discardCandidate({ userId: ctx.userId, ...keys });
    throw error;
  }
  return persist(candidate);
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

/** Names an account key: its identity generation and `accountKeySequence`. */
interface AccountKeyId {
  readonly generation: number;
  readonly keySequence: number;
}

const compareKeyIds = (a: AccountKeyId, b: AccountKeyId) =>
  a.generation - b.generation || a.keySequence - b.keySequence;

/**
 * The account-key history a rotation writes: the replaced key, named by
 * `replaced`, wrapped under its successor (ADR-024 Key lifecycle; the
 * `previous-account-key` purpose), so whatever was wrapped under it stays
 * reachable from the new key and never the other way round.
 */
async function historyWrap(
  userId: string,
  replaced: AccountKeyId,
  replacedKey: Uint8Array,
  successorKey: Uint8Array
): Promise<E2eeAccountKeyHistoryInput> {
  return {
    generation: replaced.generation,
    keySequence: replaced.keySequence,
    wrapped: b64(
      await wrapKey(successorKey, replacedKey, {
        purpose: 'previous-account-key',
        userId,
        generation: replaced.generation,
        keySequence: replaced.keySequence
      })
    )
  };
}

/** A fresh identity with its recovery target, account key and encryption key. */
async function newIdentity(
  ctx: E2eeContext,
  recoverySecret: Uint8Array,
  devices: readonly ListedDevice[],
  previousIdentityKeyHash: Uint8Array | null,
  /** For a replacement: the replaced identity's current account key. */
  replaced: { readonly id: AccountKeyId; readonly key: Uint8Array } | null
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
  const history = replaced
    ? await historyWrap(ctx.userId, replaced.id, replaced.key, accountKey)
    : null;
  targetPkcs8.fill(0);
  identityPkcs8.fill(0);
  accountKey.fill(0);
  return { identityKey, signed, wraps, history };
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
    requireActiveKeyContext(ctx);
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
  const readCurrent = captureAccountKeyRead(ctx.userId, ctx.readScope);
  const isCurrent = () => readCurrent() && ctx.isCurrent?.() !== false;
  const requireCurrent = () => {
    ctx.assertActive?.();
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
  ctx.assertActive?.();
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

/** A recovery secret or a fresh, user-verified passkey ceremony. */
export type UnlockAuthorization = Uint8Array | 'passkey';

function passkeyContext(ctx: E2eeContext): E2eeContext {
  const guard = keyOperationGuard(ctx.userId, ctx.readScope);
  return {
    ...ctx,
    assertActive: () => {
      requireActiveKeyContext(ctx);
      guard();
    }
  };
}

async function openIdentity(
  ctx: E2eeContext,
  account: AccountView,
  authorization: UnlockAuthorization
): Promise<{ identityPrivateKey: CryptoKey; accountKey: Bytes }> {
  if (account.userId !== ctx.userId) {
    throw new EncryptionFlowError(
      'invalid-request',
      'These keys belong to another account.'
    );
  }
  if (authorization !== 'passkey') {
    return openTargetIdentity(
      ctx,
      account,
      recoveryTarget(account.list),
      authorization
    );
  }
  const selected = await (ctx.passkeys ?? browserPasskeys).get();
  try {
    ctx.assertActive?.();
    const target = account.list.unlockTargets.find(
      (item) => item.kind === 'passkey' && item.targetId === selected.targetId
    );
    if (!target) {
      throw new EncryptionFlowError(
        'wrong-passkey',
        'That passkey is not certified for this identity. Use another passkey or your recovery key.'
      );
    }
    const opened = await openTargetIdentity(
      ctx,
      account,
      target,
      selected.secret
    );
    try {
      ctx.assertActive?.();
      return opened;
    } catch (error) {
      opened.accountKey.fill(0);
      throw error;
    }
  } finally {
    selected.secret.fill(0);
  }
}

/**
 * Opens the identity key with the recovery key or a fresh passkey ceremony
 * for one signature outside the device list (a contacts entry, ADR-024
 * Phase 5), hands it to `sign`, and forgets it. The account key opened
 * alongside is zeroed at once: a contacts entry needs only the identity.
 */
export async function withIdentityKey<T>(
  ctx: E2eeContext,
  account: AccountView,
  authorization: UnlockAuthorization,
  sign: (identityPrivateKey: CryptoKey) => Promise<T>
): Promise<T> {
  const scoped = authorization === 'passkey' ? passkeyContext(ctx) : ctx;
  requireActiveKeyContext(scoped);
  const { identityPrivateKey, accountKey } = await openIdentity(
    scoped,
    account,
    authorization
  );
  accountKey.fill(0);
  requireActiveKeyContext(scoped);
  return sign(identityPrivateKey);
}

/** Opens identity material for one operation; the target wrap binds its hash. */
async function openTargetIdentity(
  ctx: E2eeContext,
  account: AccountView,
  target: UnlockTarget,
  secret: Uint8Array,
  exportIdentity = false
): Promise<{ identityPrivateKey: CryptoKey; accountKey: Bytes }> {
  if (account.userId !== ctx.userId) {
    throw new EncryptionFlowError(
      'invalid-request',
      'These keys belong to another account.'
    );
  }
  const { list } = account;
  let targetPkcs8: Bytes;
  try {
    targetPkcs8 = await unwrapKey(
      secret,
      wrapOf(account, 'unlock-target-key', target.targetId),
      {
        purpose: 'unlock-target-key',
        userId: ctx.userId,
        method: targetMethod(target),
        unlockId: target.targetId,
        identityKeyHash: toHex(list.identityKeyHash)
      }
    );
  } catch (error) {
    if (isE2eeError(error, 'authentication-failed')) {
      throw new EncryptionFlowError(
        target.kind === 'passkey' ? 'wrong-passkey' : 'wrong-recovery-key',
        target.kind === 'passkey'
          ? 'That passkey does not open these keys.'
          : 'That recovery key does not open these keys.'
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
        'The unlock target does not match the device list.'
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
        method: targetMethod(target),
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
        exportIdentity
      );
      const accountKey = await openSealedKey(
        recipient,
        wrapOf(account, 'account-key', target.targetId),
        {
          purpose: 'account-key',
          userId: ctx.userId,
          method: targetMethod(target),
          unlockId: target.targetId
        }
      );
      if (
        !sameBytes(
          await accountKeyCommitment(accountKey),
          list.head.accountKeyCommitment
        )
      ) {
        accountKey.fill(0);
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

function requireActiveKeyContext(ctx: E2eeContext): void {
  ctx.assertActive?.();
  if (ctx.isCurrent && !ctx.isCurrent())
    throw new EncryptionFlowError(
      'invalid-request',
      'The account session ended.'
    );
}

/**
 * First setup: a new identity, recovery target, account key and encryption
 * key, with this device certified in a fresh device list. The recovery key
 * must have been shown to the user and confirmed before this is called.
 */
export async function setUpEncryption(
  ctx: E2eeContext,
  options: { recoverySecret: Uint8Array; label: string }
): Promise<EncryptionState> {
  return ctx.store.withDeviceLock(ctx.userId, async () => {
    requireActiveKeyContext(ctx);
    return setUpEncryptionLocked(ctx, options);
  });
}

async function setUpEncryptionLocked(
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
  const device = await withNewDevice(
    ctx,
    options.label,
    () => requireActiveKeyContext(ctx),
    (candidate) => ctx.store.getOrCreateDevice(candidate)
  );
  const created = await newIdentity(
    ctx,
    options.recoverySecret,
    [listed(device, now(ctx))],
    null,
    null
  );
  // Keys first: a setup that reaches the server without them still opens
  // with the recovery key, while the reverse would strand this device.
  requireActiveKeyContext(ctx);
  const response = await ctx.api.setup({
    identityKey: b64(created.identityKey),
    entry: b64(created.signed.entry),
    signature: b64(created.signed.signature),
    wraps: created.wraps
  });
  const list = await acceptWrite(ctx, response, {
    identityKey: created.identityKey,
    replaceIdentityFrom: persistedPin,
    written: created.signed.entry
  });
  await pinEmptyContacts(ctx, list);
  return loadEncryption(ctx);
}

/**
 * Certifies this device with the recovery key: a new device, a device
 * approved read-only, or one whose identity was replaced elsewhere.
 */
export function enrollWithRecoveryKey(
  ctx: E2eeContext,
  account: AccountView,
  recoverySecret: Uint8Array,
  label: string
): Promise<EncryptionState> {
  return enrollWithUnlockMethod(ctx, account, recoverySecret, label);
}

/** Certifies this browser with a passkey; identity material is never cached. */
export function enrollWithPasskey(
  ctx: E2eeContext,
  account: AccountView,
  label: string
): Promise<EncryptionState> {
  return enrollWithUnlockMethod(passkeyContext(ctx), account, 'passkey', label);
}

/** Enrolls a discoverable PRF passkey, authorized by the current recovery key. */
export async function addPasskey(
  ctx: E2eeContext,
  account: AccountView,
  recoverySecret: Uint8Array
): Promise<EncryptionState> {
  ctx = passkeyContext(ctx);
  return ctx.store.withDeviceLock(ctx.userId, async () => {
    requireActiveKeyContext(ctx);
    return addPasskeyLocked(ctx, account, recoverySecret);
  });
}

async function addPasskeyLocked(
  ctx: E2eeContext,
  account: AccountView,
  recoverySecret: Uint8Array
): Promise<EncryptionState> {
  const opened = await openTargetIdentity(
    ctx,
    account,
    recoveryTarget(account.list),
    recoverySecret,
    true
  );
  let secret: Bytes | undefined;
  let targetPkcs8: Bytes | undefined;
  let identityPkcs8: Bytes | undefined;
  let enrollment: { label: string; targetId: string } | undefined;
  try {
    requireActiveKeyContext(ctx);
    const selected = await (ctx.passkeys ?? browserPasskeys).create();
    secret = selected.secret;
    if (selected.enrollmentLabel) {
      enrollment = {
        label: selected.enrollmentLabel,
        targetId: selected.targetId
      };
    }
    ctx.assertActive?.();
    const target = await generateEncryptionKeyPair(true);
    const publicKey = await exportPublicKey(target.publicKey);
    const targetId = selected.targetId;
    const entry = nextDeviceListEntry(account.list, {
      issuedAt: now(ctx),
      addUnlockTargets: [
        { kind: 'passkey', targetId, publicKey, addedAt: now(ctx) }
      ]
    });
    targetPkcs8 = await exportPrivateKey(target.privateKey);
    identityPkcs8 = await exportPrivateKey(opened.identityPrivateKey);
    const wraps: E2eeWrapInput[] = [
      {
        purpose: 'unlock-target-key',
        targetId,
        wrapped: b64(
          await wrapKey(secret, targetPkcs8, {
            purpose: 'unlock-target-key',
            userId: ctx.userId,
            method: 'passkey-prf',
            unlockId: targetId,
            identityKeyHash: toHex(account.list.identityKeyHash)
          })
        )
      },
      {
        purpose: 'identity-key',
        targetId,
        wrapped: b64(
          await sealKey(publicKey, identityPkcs8, {
            purpose: 'identity-key',
            userId: ctx.userId,
            method: 'passkey-prf',
            unlockId: targetId
          })
        )
      },
      {
        purpose: 'account-key',
        targetId,
        wrapped: b64(
          await sealKey(publicKey, opened.accountKey, {
            purpose: 'account-key',
            userId: ctx.userId,
            method: 'passkey-prf',
            unlockId: targetId
          })
        )
      }
    ];
    const signed = await signDeviceListEntry(opened.identityPrivateKey, entry);
    requireActiveKeyContext(ctx);
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
    return await loadEncryption(ctx);
  } catch (error) {
    throw enrollment
      ? failedPasskeyEnrollment(error, enrollment.label, enrollment.targetId)
      : error;
  } finally {
    opened.accountKey.fill(0);
    secret?.fill(0);
    targetPkcs8?.fill(0);
    identityPkcs8?.fill(0);
  }
}

async function enrollWithUnlockMethod(
  ctx: E2eeContext,
  account: AccountView,
  authorization: UnlockAuthorization,
  label: string
): Promise<EncryptionState> {
  return ctx.store.withDeviceLock(ctx.userId, async () => {
    requireActiveKeyContext(ctx);
    return enrollWithUnlockMethodLocked(ctx, account, authorization, label);
  });
}

async function enrollWithUnlockMethodLocked(
  ctx: E2eeContext,
  account: AccountView,
  authorization: UnlockAuthorization,
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
    authorization
  );
  try {
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
    let stored = await ctx.store.loadDevice(ctx.userId);
    requireActiveKeyContext(ctx);
    if (stored?.approval) {
      await confirmApprovalCancellation(ctx.api, stored.approval.id, () =>
        requireActiveKeyContext(ctx)
      );
      await ctx.store.clearApprovalIfCurrent(ctx.userId, stored.approval.id);
      stored = await ctx.store.loadDevice(ctx.userId);
    }
    let device = stored;
    if (
      stored &&
      account.deviceStatus === 'removed' &&
      account.device?.deviceId === stored.deviceId
    ) {
      device = await withNewDevice(
        ctx,
        label,
        () => requireActiveKeyContext(ctx),
        async (candidate) =>
          (await ctx.store.replaceDeviceIfCurrent(stored, candidate))
            ? candidate
            : null
      );
      if (!device)
        throw new EncryptionFlowError(
          'invalid-request',
          'The device changed in another tab. Refresh and try again.'
        );
    } else if (!device) {
      device = await withNewDevice(
        ctx,
        label,
        () => requireActiveKeyContext(ctx),
        (candidate) => ctx.store.getOrCreateDevice(candidate)
      );
    }
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
    requireActiveKeyContext(ctx);
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
  } finally {
    accountKey.fill(0);
  }
}

/**
 * Removes another device: revokes it in a new identity-signed entry and
 * rotates the account key and encryption key in the same entry, sealing the
 * new account key to every surviving device and unlock target taken from
 * that verified list, never to a key the server offers. The removed device
 * keeps no wrap. A recovery key or passkey opens the identity key to sign
 * the entry. The replaced account key is wrapped under the new one (the
 * account-key history), and when this device is certified the revocation
 * names it as the removed device's replacement.
 *
 * Encrypted projects (ADR-024 Phase 4, slice 4-10): a `participant`
 * (`deviceRemoval.ts`) first refuses a removal it could not finish, then,
 * with the identity key this removal opened, signs each project's
 * revocation cutoff, which the revoking entry's append carries, and
 * rotates every project past the removal.
 */
export function removeDevice(
  ctx: E2eeContext,
  account: AccountView,
  deviceId: string,
  authorization: UnlockAuthorization,
  participant?: RemovalParticipantStep
): Promise<EncryptionState> {
  return rotateAccountKeys(
    authorization === 'passkey' ? passkeyContext(ctx) : ctx,
    account,
    deviceId,
    'device',
    authorization,
    participant
  );
}

export function removePasskey(
  ctx: E2eeContext,
  account: AccountView,
  targetId: string,
  authorization: UnlockAuthorization,
  participant?: RemovalParticipantStep
): Promise<EncryptionState> {
  return rotateAccountKeys(
    authorization === 'passkey' ? passkeyContext(ctx) : ctx,
    account,
    targetId,
    'passkey',
    authorization,
    participant
  );
}

/** Rotate even when the server omits every read-only approval wrap. */
export function revokeReadOnlyDevices(
  ctx: E2eeContext,
  account: AccountView,
  authorization: UnlockAuthorization,
  participant?: RemovalParticipantStep
): Promise<EncryptionState> {
  return rotateAccountKeys(
    authorization === 'passkey' ? passkeyContext(ctx) : ctx,
    account,
    '', // Aggregate rotation does not remove a certified id.
    'read-only',
    authorization,
    participant
  );
}

/** A removal's signed device-list entry, before and after it is appended. */
export interface SignedRemovalStep {
  readonly kind: 'device' | 'passkey' | 'read-only';
  readonly identityPrivateKey: CryptoKey;
  readonly userId: string;
  readonly generation: number;
  readonly written: { readonly sequence: number; readonly hash: Bytes };
}

/**
 * What a removal asks of encrypted projects (`removalParticipant` in
 * `deviceRemoval.ts`, loaded lazily by the caller): `prepare` runs before
 * the identity key is opened and may refuse; `complete` runs once the new
 * device list is accepted, with the identity key still open, and reports
 * rather than throws.
 */
export interface RemovalParticipantStep {
  prepare(account: AccountView): Promise<void>;
  /**
   * Right before the new device list is written: the signed cutoff
   * statement of the entry about to be appended, which the append carries
   * so the Worker stores the revocation and its statement together.
   * Undefined when there is none to sign. Never throws.
   */
  cutoffsFor?(
    step: SignedRemovalStep
  ): Promise<E2eeSignedStatementRecord | undefined>;
  /**
   * Right after the new device list is written, before the account is
   * read again: signs and keeps what can be signed without a request, so
   * a failed reload loses nothing. Never throws.
   */
  written?(step: SignedRemovalStep): Promise<void>;
  complete(step: {
    readonly kind: 'device' | 'passkey' | 'read-only';
    readonly identityPrivateKey: CryptoKey;
    readonly account: AccountView;
    /** The device-list entry this removal signed and appended. */
    readonly written: { readonly sequence: number; readonly hash: Bytes };
  }): Promise<unknown>;
}

async function rotateAccountKeys(
  ctx: E2eeContext,
  account: AccountView,
  id: string,
  kind: 'device' | 'passkey' | 'read-only',
  authorization: UnlockAuthorization,
  participant?: RemovalParticipantStep
): Promise<EncryptionState> {
  return ctx.store.withDeviceLock(ctx.userId, async () => {
    requireActiveKeyContext(ctx);
    return rotateAccountKeysLocked(
      ctx,
      account,
      id,
      kind,
      authorization,
      participant
    );
  });
}

async function rotateAccountKeysLocked(
  ctx: E2eeContext,
  account: AccountView,
  id: string,
  kind: 'device' | 'passkey' | 'read-only',
  authorization: UnlockAuthorization,
  participant?: RemovalParticipantStep
): Promise<EncryptionState> {
  if (kind === 'device' && id === account.device?.deviceId) {
    throw new EncryptionFlowError(
      'invalid-request',
      'Remove this device by signing out and removing its keys.'
    );
  }
  await participant?.prepare(account);
  requireActiveKeyContext(ctx);
  const { identityPrivateKey, accountKey: oldAccountKey } = await openIdentity(
    ctx,
    account,
    authorization
  );
  const accountKey = generateSymmetricKey();
  try {
    if (
      kind === 'passkey' &&
      !account.list.unlockTargets.some(
        (t) => t.kind === 'passkey' && t.targetId === id
      )
    ) {
      throw new EncryptionFlowError(
        'invalid-request',
        'That passkey is not certified.'
      );
    }
    // This certified device stays in the list and takes over from the
    // removed one: where that device was a project's only leaf of this
    // user, the replacement may rejoin (the MLS last-leaf exception).
    const replacement =
      kind === 'device' &&
      account.deviceStatus === 'certified' &&
      account.device &&
      account.list.devices.some((d) => d.deviceId === account.device!.deviceId)
        ? account.device.deviceId
        : undefined;
    const encryption = await generateEncryptionKeyPair(true);
    const entry = nextDeviceListEntry(account.list, {
      issuedAt: now(ctx),
      ...(kind === 'device'
        ? {
            removeDeviceIds: [id],
            ...(replacement ? { replacedBy: replacement } : {})
          }
        : kind === 'passkey'
          ? { removeUnlockTargetIds: [id] }
          : {}),
      encryptionKey: await exportPublicKey(encryption.publicKey),
      accountKeyCommitment: await accountKeyCommitment(accountKey)
    });
    const signed = await signDeviceListEntry(identityPrivateKey, entry);
    const wraps = await accountWraps(ctx.userId, accountKey, encryption, entry);
    const history = await historyWrap(
      ctx.userId,
      {
        generation: account.generation,
        keySequence: accountKeySequence(account.list)
      },
      oldAccountKey,
      accountKey
    );
    oldAccountKey.fill(0);
    accountKey.fill(0);
    // Known before the append: the cutoffs name this entry, and the Worker
    // stores a device revocation only together with them.
    const written = {
      sequence: entry.sequence,
      hash: await deviceListEntryHash(signed.entry)
    };
    const step: SignedRemovalStep = {
      kind,
      identityPrivateKey,
      userId: ctx.userId,
      generation: account.generation,
      written
    };
    const append = async () => {
      const cutoffs =
        kind === 'device'
          ? await participant?.cutoffsFor?.(step).catch(() => undefined)
          : undefined;
      requireActiveKeyContext(ctx);
      return ctx.api.appendDeviceList({
        generation: account.generation,
        entry: b64(signed.entry),
        signature: b64(signed.signature),
        wraps,
        history,
        ...(cutoffs ? { cutoffs } : {})
      });
    };
    const response = await append().catch((error: unknown) => {
      // A project was created, shared or committed to between the listing
      // and the append, and nothing was written: sign once more.
      if (
        (error as { code?: string } | null)?.code ===
          'E2EE_CUTOFFS_INCOMPLETE' &&
        participant?.cutoffsFor
      ) {
        return append();
      }
      throw error;
    });
    await acceptWrite(ctx, response, {
      identityKey: account.list.identityKey,
      pin: account.list.pin,
      written: signed.entry
    });
    await participant?.written?.(step).catch(() => undefined);
    const state = await loadEncryption(ctx);
    if (participant && state.kind === 'ready' && state.account.unlocked) {
      await participant.complete({
        kind,
        identityPrivateKey,
        account: state.account,
        // Not the reloaded head: another device may have appended since.
        written
      });
    }
    return state;
  } finally {
    oldAccountKey.fill(0);
    accountKey.fill(0);
  }
}

/**
 * This certified device's current account key, from the page's unlocked
 * copy or its own account-key wrap, checked against the commitment the
 * identity certified. The caller zeroes it.
 */
async function openDeviceAccountKey(
  ctx: E2eeContext,
  account: AccountView,
  device: StoredDevice
): Promise<Bytes> {
  const commitment = toHex(account.list.head.accountKeyCommitment);
  const cached = unlockedAccount(ctx.userId);
  if (
    cached?.generation === account.generation &&
    cached.commitment === commitment
  ) {
    return new Uint8Array(cached.accountKey);
  }
  const accountKey = await openSealedKey(
    { privateKey: device.unlock.privateKey, publicKey: device.unlockPublicKey },
    wrapOf(account, 'account-key', device.deviceId),
    {
      purpose: 'account-key',
      userId: ctx.userId,
      method: 'device',
      unlockId: device.deviceId
    }
  );
  if (toHex(await accountKeyCommitment(accountKey)) !== commitment) {
    accountKey.fill(0);
    throw new EncryptionFlowError(
      'key-mismatch',
      'The account key does not match the one your device list certifies.'
    );
  }
  return accountKey;
}

/**
 * Signs one solo group reset (decision D9) with the identity key, opened by
 * the recovery key or a passkey for this signature alone and then dropped.
 * The caller (`resetProjectGroup`) has checked the group and the owner's
 * plain-words confirmation; this only binds the reset to the current
 * device-list head the account view verified.
 */
export async function signGroupResetWithIdentity(
  ctx: E2eeContext,
  account: AccountView,
  authorization: UnlockAuthorization,
  reset: GroupReset
): Promise<SignedStatement> {
  const opContext = authorization === 'passkey' ? passkeyContext(ctx) : ctx;
  return opContext.store.withDeviceLock(ctx.userId, async () => {
    requireActiveKeyContext(opContext);
    const { identityPrivateKey, accountKey } = await openIdentity(
      opContext,
      account,
      authorization
    );
    accountKey.fill(0);
    requireActiveKeyContext(opContext);
    return signGroupReset(identityPrivateKey, {
      ...reset,
      generation: account.generation
    });
  });
}

/**
 * Replaces the recovery key, which always replaces the identity key: a new
 * identity with a fresh device list holding only this device and the new
 * recovery key, a new account key and encryption key, and a transition
 * statement signed by the old identity (when the old recovery key is given)
 * or by this device's certified key. Every other device must be approved
 * again, and contacts must verify the new fingerprint. The replaced
 * identity's account key is wrapped under the new one (the account-key
 * history), so keys wrapped under it stay reachable.
 *
 * Holds the same device lock as the other rotations, so it never races a
 * removal or another replacement from this browser.
 */
export async function replaceRecoveryKey(
  ctx: E2eeContext,
  account: AccountView,
  newRecoverySecret: Uint8Array,
  oldRecoverySecret: Uint8Array | null
): Promise<EncryptionState> {
  return ctx.store.withDeviceLock(ctx.userId, async () => {
    requireActiveKeyContext(ctx);
    return replaceRecoveryKeyLocked(
      ctx,
      account,
      newRecoverySecret,
      oldRecoverySecret
    );
  });
}

async function replaceRecoveryKeyLocked(
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
  let signer: {
    key: SigningPrivateKey;
    raw: Uint8Array;
    kind: 'identity' | 'device';
  };
  let oldAccountKey: Bytes;
  if (oldRecoverySecret) {
    const opened = await openIdentity(ctx, account, oldRecoverySecret);
    oldAccountKey = opened.accountKey;
    signer = {
      key: opened.identityPrivateKey,
      raw: account.list.identityKey,
      kind: 'identity'
    };
  } else {
    oldAccountKey = await openDeviceAccountKey(ctx, account, device);
    signer = {
      key: device.signing.privateKey,
      raw: device.signingPublicKey,
      kind: 'device'
    };
  }
  let created: Awaited<ReturnType<typeof newIdentity>>;
  try {
    created = await newIdentity(
      ctx,
      newRecoverySecret,
      [listed(device, now(ctx))],
      account.list.identityKeyHash,
      {
        id: {
          generation: account.generation,
          keySequence: accountKeySequence(account.list)
        },
        key: oldAccountKey
      }
    );
  } finally {
    oldAccountKey.fill(0);
  }
  const transition = await signIdentityTransition(signer.key, {
    userId: ctx.userId,
    oldIdentityKeyHash: account.list.identityKeyHash,
    newIdentityKey: created.identityKey,
    newGenesisHash: await deviceListEntryHash(created.signed.entry),
    signer: signer.kind,
    signerKeyHash: await publicKeyHash(signer.raw),
    signedAt: now(ctx)
  });
  requireActiveKeyContext(ctx);
  const response = await ctx.api.replaceIdentity({
    generation: account.generation + 1,
    identityKey: b64(created.identityKey),
    entry: b64(created.signed.entry),
    signature: b64(created.signed.signature),
    wraps: created.wraps,
    transition: {
      statement: b64(transition.statement),
      signature: b64(transition.signature)
    },
    history: created.history!
  });
  const list = await acceptWrite(ctx, response, {
    identityKey: created.identityKey,
    replaceIdentityFrom: account.persistedPin,
    written: created.signed.entry
  });
  // The new identity starts a new, empty contacts list.
  await pinEmptyContacts(ctx, list);
  return loadEncryption(ctx);
}

// --- Account-key history ----------------------------------------------------

/**
 * Opens an older account key of this account from the unlocked current one
 * by walking back through the account-key history: each replaced key is
 * wrapped under its successor, so the walk only ever goes from newer to
 * older. `keySequence` and `generation` name the key (`accountKeySequence`
 * within that identity's device list; the current generation by default).
 *
 * Keys of the current identity are checked against the commitments its
 * verified device list certifies. Keys of replaced identities are
 * authenticated by the wraps themselves: only a holder of the newer key
 * could have made them. Returns a copy the caller must zero.
 */
export async function openAccountKeyChain(
  ctx: E2eeContext,
  account: AccountView,
  keySequence: number,
  generation: number = account.generation
): Promise<Bytes> {
  if (account.userId !== ctx.userId) {
    throw new EncryptionFlowError(
      'invalid-request',
      'These keys belong to another account.'
    );
  }
  requireActiveKeyContext(ctx);
  const unlocked = unlockedAccount(ctx.userId);
  if (
    unlocked?.generation !== account.generation ||
    unlocked.commitment !== toHex(account.list.head.accountKeyCommitment)
  ) {
    throw new EncryptionFlowError(
      'not-unlocked',
      'Unlock this device before opening older account keys.'
    );
  }
  const target: AccountKeyId = { generation, keySequence };
  const sequences = accountKeySequences(account.list);
  const current: AccountKeyId = {
    generation: account.generation,
    keySequence: sequences.at(-1)!
  };
  if (
    !Number.isSafeInteger(generation) ||
    !Number.isSafeInteger(keySequence) ||
    compareKeyIds(target, current) > 0 ||
    (generation === account.generation && !sequences.includes(keySequence))
  ) {
    throw new EncryptionFlowError(
      'invalid-request',
      'That is not an account key of this account.'
    );
  }
  // Copy before any await: a lock or rotation meanwhile zeroes the cache.
  let key: Bytes = new Uint8Array(unlocked.accountKey);
  if (compareKeyIds(target, current) === 0) return key;
  try {
    const { history } = await ctx.api.accountKeyHistory();
    requireActiveKeyContext(ctx);
    const rows = new Map<string, E2eeAccountKeyHistoryRecord>();
    for (const row of history) {
      if (compareKeyIds(row, current) < 0) {
        rows.set(`${row.generation}:${row.keySequence}`, row);
      }
    }
    // Older identities' keys follow from the rows' order alone.
    const ordered = [...rows.values()].sort(compareKeyIds);
    let step = current;
    for (;;) {
      const index =
        step.generation === account.generation
          ? sequences.indexOf(step.keySequence)
          : -1;
      const previous: AccountKeyId | undefined =
        index > 0
          ? { generation: step.generation, keySequence: sequences[index - 1]! }
          : ordered.filter((row) => compareKeyIds(row, step) < 0).at(-1);
      const row =
        previous && rows.get(`${previous.generation}:${previous.keySequence}`);
      if (!previous || !row || compareKeyIds(previous, target) < 0) {
        throw new EncryptionFlowError(
          'missing-wrap',
          'The server has no account-key history for that key.'
        );
      }
      let opened: Bytes;
      try {
        opened = await unwrapKey(key, fromBase64Url(row.wrapped), {
          purpose: 'previous-account-key',
          userId: ctx.userId,
          generation: previous.generation,
          keySequence: previous.keySequence
        });
      } catch (error) {
        if (!isE2eeError(error)) throw error;
        throw new EncryptionFlowError(
          'key-mismatch',
          'The account-key history does not open with the newer key.'
        );
      }
      key.fill(0);
      key = opened;
      if (previous.generation === account.generation) {
        const certified =
          account.list.entries[previous.keySequence]?.entry
            .accountKeyCommitment;
        if (
          !certified ||
          !sameBytes(await accountKeyCommitment(key), certified)
        ) {
          throw new EncryptionFlowError(
            'key-mismatch',
            'An older account key does not match the one your device list certified.'
          );
        }
      }
      requireActiveKeyContext(ctx);
      if (compareKeyIds(previous, target) === 0) return key;
      step = previous;
    }
  } catch (error) {
    key.fill(0);
    throw error;
  }
}

/** Sign-out without keeping this device unlocked: its keys are deleted. */
export async function forgetThisDevice(ctx: E2eeContext): Promise<void> {
  lockAccount(ctx.userId);
  await ctx.store.withDeviceLock(ctx.userId, async () => {
    requireActiveKeyContext(ctx);
    const device = await ctx.store.loadDevice(ctx.userId);
    requireActiveKeyContext(ctx);
    if (device?.approval)
      await confirmApprovalCancellation(ctx.api, device.approval.id, () =>
        requireActiveKeyContext(ctx)
      );
    requireActiveKeyContext(ctx);
    await (
      await import('./shareWorkStore')
    )
      .shareWorkStore()
      .deleteAccount(ctx.userId);
    requireActiveKeyContext(ctx);
    await (
      await import('./projectAuthorityStore')
    )
      .projectAuthorityStore()
      .deleteAccount(ctx.userId);
    requireActiveKeyContext(ctx);
    await ctx.store.deleteDevice(ctx.userId);
  });
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
  account:
    | (Pick<AccountView, 'deviceStatus'> & Partial<Pick<AccountView, 'device'>>)
    | null,
  label: string
): Promise<NewDeviceApprovalStep> {
  return ctx.store.withDeviceLock(ctx.userId, async () => {
    const requireCurrent = () => {
      if (ctx.isCurrent && !ctx.isCurrent())
        throw new EncryptionFlowError(
          'invalid-request',
          'The account session ended.'
        );
    };
    requireCurrent();
    const pinAtRequest = await ctx.store.loadPin(ctx.userId);
    let stored = await ctx.store.loadDevice(ctx.userId);
    if (stored && account?.deviceStatus === 'removed' && !account.device)
      throw new EncryptionFlowError(
        'invalid-request',
        'Refresh the removed device before asking for approval.'
      );
    if (stored?.approval) {
      await confirmApprovalCancellation(
        ctx.api,
        stored.approval.id,
        requireCurrent
      );
      await ctx.store.clearApprovalIfCurrent(ctx.userId, stored.approval.id);
      stored = await ctx.store.loadDevice(ctx.userId);
      if (stored?.approval)
        throw new EncryptionFlowError(
          'invalid-request',
          'The approval changed in another tab. Refresh and try again.'
        );
    }
    requireCurrent();
    let device = stored;
    if (
      stored &&
      account?.deviceStatus === 'removed' &&
      account.device?.deviceId === stored.deviceId
    ) {
      device = await withNewDevice(
        ctx,
        label,
        requireCurrent,
        async (candidate) =>
          (await ctx.store.replaceDeviceIfCurrent(stored, candidate))
            ? candidate
            : null
      );
      if (!device)
        throw new EncryptionFlowError(
          'invalid-request',
          'The device changed in another tab. Refresh and try again.'
        );
    } else if (!device) {
      device = await withNewDevice(ctx, label, requireCurrent, (candidate) =>
        ctx.store.getOrCreateDevice(candidate)
      );
    }
    // Stage the only private keys before publishing their public halves.
    // The cross-tab lock serializes requests; CAS also detects explicit key
    // deletion and other device-state changes outside that lock.
    const { nonce, commitment } = await commitDeviceApproval([
      device.signingPublicKey,
      device.unlockPublicKey
    ]);
    requireCurrent();
    const approval = await ctx.api.createApproval({
      deviceId: device.deviceId,
      label: normalizeDeviceLabel(label),
      signingKey: b64(device.signingPublicKey),
      unlockKey: b64(device.unlockPublicKey),
      commitment: b64(commitment)
    });
    if (
      (ctx.isCurrent && !ctx.isCurrent()) ||
      !(await ctx.store.replaceDeviceIfCurrent(device, {
        ...device,
        label: normalizeDeviceLabel(label),
        approval: {
          id: approval.id,
          nonce,
          confirmedApproverKey: null,
          pinAtRequest,
          comparison: {
            commitment: b64(commitment),
            responder: null,
            confirmed: false
          }
        }
      }))
    ) {
      await confirmApprovalCancellation(ctx.api, approval.id);
      throw new EncryptionFlowError(
        'invalid-request',
        'The device changed while approval was starting. Refresh and try again.'
      );
    }
    return {
      step: 'waiting',
      approval,
      scanCode: await deviceScanCode(device)
    };
  });
}

/**
 * One poll of this device's approval request. When the approver has
 * answered, reveals the nonce and returns the six digits to compare; when it
 * has completed, verifies the signed grant and finishes.
 */
export async function advanceApprovalAsNewDevice(
  ctx: E2eeContext
): Promise<NewDeviceApprovalStep> {
  const guard = requesterOperationGuard(ctx);
  return ctx.store.withDeviceLock(ctx.userId, () =>
    advanceRequesterApproval(ctx, guard)
  );
}

function requesterOperationGuard(ctx: E2eeContext): () => void {
  const session = keyOperationGuard(ctx.userId, ctx.readScope);
  const guard = () => {
    session();
    requireActiveKeyContext(ctx);
  };
  guard();
  return guard;
}

function requesterDeviceSnapshot(
  device: StoredDevice | null
): StoredDevice | null {
  if (!device) return null;
  const pending = device.approval;
  return {
    ...device,
    signingPublicKey: device.signingPublicKey.slice(),
    unlockPublicKey: device.unlockPublicKey.slice(),
    approval: pending
      ? {
          ...pending,
          nonce: pending.nonce?.slice() ?? null,
          pinAtRequest: pending.pinAtRequest
            ? {
                ...pending.pinAtRequest,
                identityKeyHash: pending.pinAtRequest.identityKeyHash.slice(),
                entryHash: pending.pinAtRequest.entryHash.slice()
              }
            : pending.pinAtRequest,
          comparison: pending.comparison
            ? {
                ...pending.comparison,
                responder:
                  pending.comparison.responder === null
                    ? null
                    : { ...pending.comparison.responder }
              }
            : pending.comparison
        }
      : null
  };
}

function requesterRecordSnapshot(
  approval: E2eeApprovalRecord
): E2eeApprovalRecord {
  return { ...approval, grant: approval.grant ? { ...approval.grant } : null };
}

function requesterApprovalChanged(): never {
  throw new EncryptionFlowError(
    'grant-invalid',
    'The device comparison changed. Cancel this request and ask again.'
  );
}

/** Every response must refer to the local request and its first responder. */
function requireRequesterRecord(
  device: StoredDevice,
  approval: E2eeApprovalRecord
): void {
  const pending = device.approval;
  try {
    if (
      !pending ||
      approval.id !== pending.id ||
      approval.deviceId !== device.deviceId ||
      !sameBytes(
        fromBase64Url(approval.signingKey, 65),
        device.signingPublicKey
      ) ||
      !sameBytes(fromBase64Url(approval.unlockKey, 65), device.unlockPublicKey)
    )
      requesterApprovalChanged();
    const comparison = pending.comparison;
    if (comparison && typeof comparison.confirmed !== 'boolean')
      requesterApprovalChanged();
    if (pending.confirmedApproverKey && !comparison?.responder)
      requesterApprovalChanged();
    if (
      comparison &&
      (!approval.commitment ||
        !sameBytes(
          fromBase64Url(approval.commitment, 32),
          fromBase64Url(comparison.commitment, 32)
        ))
    )
      requesterApprovalChanged();
    const responder = comparison?.responder;
    if (responder) {
      if (!['responded', 'revealed', 'completed'].includes(approval.state))
        requesterApprovalChanged();
      if (
        !approval.approverKey ||
        !approval.approverNonce ||
        !sameBytes(
          fromBase64Url(approval.approverKey, 65),
          fromBase64Url(responder.key, 65)
        ) ||
        !sameBytes(
          fromBase64Url(approval.approverNonce, 32),
          fromBase64Url(responder.nonce, 32)
        )
      )
        requesterApprovalChanged();
      if (
        (approval.state === 'revealed' || approval.state === 'completed') &&
        (!pending.nonce ||
          !approval.deviceNonce ||
          !sameBytes(fromBase64Url(approval.deviceNonce, 32), pending.nonce))
      )
        requesterApprovalChanged();
    } else if (approval.approverKey || approval.approverNonce) {
      if (
        !comparison ||
        comparison.responder !== null ||
        !pending.nonce ||
        approval.state !== 'responded'
      )
        requesterApprovalChanged();
      fromBase64Url(approval.approverKey ?? '', 65);
      fromBase64Url(approval.approverNonce ?? '', 32);
    } else if (
      approval.state === 'responded' ||
      approval.state === 'revealed'
    ) {
      requesterApprovalChanged();
    }
  } catch {
    requesterApprovalChanged();
  }
}

async function advanceRequesterApproval(
  ctx: E2eeContext,
  guard: () => void
): Promise<NewDeviceApprovalStep> {
  guard();
  let device = requesterDeviceSnapshot(await ctx.store.loadDevice(ctx.userId));
  guard();
  if (!device) return { step: 'expired' };
  if (device.userId !== ctx.userId) requesterApprovalChanged();
  if (!device.approval) return completedApprovalElsewhere(ctx, guard);
  let approval: E2eeApprovalRecord;
  try {
    approval = requesterRecordSnapshot(
      await ctx.api.getApproval(device.approval.id)
    );
    guard();
  } catch (error) {
    guard();
    if ((error as { status?: number }).status === 404) {
      await ctx.store.clearApprovalIfCurrent(ctx.userId, device.approval.id);
      guard();
      return completedApprovalElsewhere(ctx, guard);
    }
    throw error;
  }
  requireRequesterRecord(device, approval);
  if (
    approval.state === 'responded' &&
    device.approval.comparison?.responder === null
  ) {
    const pinned: StoredDevice = {
      ...device,
      approval: {
        ...device.approval,
        comparison: {
          ...device.approval.comparison,
          responder: {
            key: b64(fromBase64Url(approval.approverKey!, 65)),
            nonce: b64(fromBase64Url(approval.approverNonce!, 32))
          }
        }
      }
    };
    guard();
    if (!(await ctx.store.replaceDeviceIfCurrent(device, pinned)))
      requesterApprovalChanged();
    guard();
    device = pinned;
  }
  const pending = device.approval;
  if (!pending) requesterApprovalChanged();
  const nonce = pending.nonce;
  if (approval.state === 'responded' && nonce) {
    guard();
    approval = requesterRecordSnapshot(
      await ctx.api.revealApproval(pending.id, { nonce: b64(nonce) })
    );
    guard();
    requireRequesterRecord(device, approval);
  }
  // The compare form: until the user confirms the digits here, a completed
  // approval waits too, because the key that answered could be anyone's.
  const compareForm = approval.approverKey !== null;
  const confirmed = compareForm && pending.comparison?.confirmed === true;
  if (
    nonce &&
    (approval.state === 'revealed' ||
      (approval.state === 'completed' && compareForm && !confirmed))
  ) {
    const code = await newDeviceCode(device, nonce);
    guard();
    return {
      step: 'compare',
      approval,
      code,
      confirmed
    };
  }
  if (approval.state === 'completed') {
    return {
      step: 'done',
      state: await finishApproval(ctx, device, approval, guard)
    };
  }
  const scanCode = await deviceScanCode(device);
  guard();
  return { step: 'waiting', approval, scanCode };
}

async function completedApprovalElsewhere(
  ctx: E2eeContext,
  guard: () => void
): Promise<NewDeviceApprovalStep> {
  // Another tab can verify and clear the shared approval before this poll.
  // Refresh verified account state instead of leaving that tab falsely expired.
  guard();
  const state = await loadEncryption(ctx);
  guard();
  if (
    state.kind === 'ready' &&
    state.account.unlocked &&
    (state.account.deviceStatus === 'certified' ||
      state.account.deviceStatus === 'approved')
  )
    return { step: 'done', state };
  return { step: 'expired' };
}

function newDeviceCode(
  device: StoredDevice,
  nonce: Uint8Array
): Promise<string> {
  const responder = device.approval?.comparison?.responder;
  if (!responder) requesterApprovalChanged();
  return deviceApprovalCode({
    newDevicePublicKey: [device.signingPublicKey, device.unlockPublicKey],
    approverPublicKey: fromBase64Url(responder.key, 65),
    newDeviceNonce: nonce,
    approverNonce: fromBase64Url(responder.nonce, 32)
  });
}

/**
 * The user confirmed, on this new device, that both screens show the same
 * six digits: from now on only the approver key behind them may complete.
 */
export async function confirmApprovalCode(
  ctx: E2eeContext,
  displayed: E2eeApprovalRecord
): Promise<NewDeviceApprovalStep> {
  if (!displayed) {
    throw new EncryptionFlowError(
      'approval-gone',
      'Display and compare the codes before confirming.'
    );
  }
  const observed = requesterRecordSnapshot(displayed);
  const guard = requesterOperationGuard(ctx);
  return ctx.store.withDeviceLock(ctx.userId, async () => {
    guard();
    const device = requesterDeviceSnapshot(
      await ctx.store.loadDevice(ctx.userId)
    );
    guard();
    if (!device?.approval) return { step: 'expired' };
    if (device.userId !== ctx.userId) requesterApprovalChanged();
    requireRequesterRecord(device, observed);
    const approval = requesterRecordSnapshot(
      await ctx.api.getApproval(device.approval.id)
    );
    guard();
    requireRequesterRecord(device, approval);
    const comparison = device.approval.comparison;
    if (
      !comparison?.responder ||
      !approval.approverKey ||
      (approval.state !== 'revealed' && approval.state !== 'completed')
    ) {
      throw new EncryptionFlowError(
        'approval-gone',
        'There is no code to confirm yet.'
      );
    }
    if (
      !(await ctx.store.replaceDeviceIfCurrent(device, {
        ...device,
        approval: {
          ...device.approval,
          confirmedApproverKey: comparison.responder.key,
          comparison: { ...comparison, confirmed: true }
        }
      }))
    )
      throw new EncryptionFlowError(
        'invalid-request',
        'The approval changed in another tab. Refresh and try again.'
      );
    guard();
    return advanceRequesterApproval(ctx, guard);
  });
}

async function finishApproval(
  ctx: E2eeContext,
  device: StoredDevice,
  approval: E2eeApprovalRecord,
  guard: () => void
): Promise<EncryptionState> {
  guard();
  requireRequesterRecord(device, approval);
  if (!approval.grant) {
    throw new EncryptionFlowError(
      'grant-invalid',
      'The approval has no grant.'
    );
  }
  if (approval.approverKey && device.approval?.comparison?.confirmed !== true) {
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
  guard();
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
  guard();
  let list: VerifiedDeviceList;
  try {
    list = await verifyDeviceList(identityKey, chain, pin ? { pin } : {});
    guard();
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
      await ctx.store.clearApprovalIfCurrent(ctx.userId, device.approval!.id);
      throw new EncryptionFlowError(
        'grant-invalid',
        'This device trusted different encryption keys, and a scanned approval cannot replace them. Enter the new recovery key here, or ask again and choose Compare codes on the other device.'
      );
    }
    list = await verifyDeviceList(identityKey, chain);
    guard();
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
  guard();
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
  guard();
  await persistDeviceList(ctx, list, {
    replaceIdentityFrom: device.approval?.pinAtRequest
  });
  guard();
  // ADR-024: the approver's newest contacts head arrives inside the
  // authenticated exchange, so this device cannot be shown an older list.
  // A version 1 grant (an older build) carries none: this device then
  // starts from the server's list, unconfirmed, like a passkey enrolment.
  if (grant.contacts) {
    const head = grant.contacts.head;
    const accepted = await contactPinsOf(ctx).advanceList(
      ctx.userId,
      {
        identityKeyHash: toHex(grant.identityKeyHash),
        sequence: head ? head.sequence : EMPTY_CONTACTS_SEQUENCE,
        entryHash: head ? toHex(head.entryHash) : EMPTY_CONTACTS_HASH,
        confirmed: grant.contacts.confirmed
      },
      { fromApproval: true }
    );
    guard();
    if (!accepted) {
      throw new EncryptionFlowError(
        'grant-invalid',
        'This device and the approving device have conflicting contacts lists. Approval could not be completed. Keep your existing keys and compare contacts on both devices.'
      );
    }
  }
  await ctx.store.clearApprovalIfCurrent(ctx.userId, device.approval!.id);
  guard();
  await ctx.api.cancelApproval(approval.id).catch(() => undefined);
  guard();
  const state = await loadEncryption(ctx);
  guard();
  return state;
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
  if (account.userId !== ctx.userId) {
    throw new EncryptionFlowError(
      'invalid-request',
      'The account session ended.'
    );
  }
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

function changedApproval(): never {
  throw new EncryptionFlowError(
    'commitment-mismatch',
    'The new device’s keys changed after it committed to them. Do not approve it.'
  );
}

function approvalBinding(approval: E2eeApprovalRecord) {
  try {
    if (
      typeof approval.id !== 'string' ||
      typeof approval.deviceId !== 'string' ||
      !approval.deviceId ||
      !approval.commitment
    )
      return changedApproval();
    return {
      id: approval.id,
      deviceId: approval.deviceId,
      signingKey: fromBase64Url(approval.signingKey, 65),
      unlockKey: fromBase64Url(approval.unlockKey, 65),
      commitment: fromBase64Url(approval.commitment, 32)
    };
  } catch {
    return changedApproval();
  }
}

function requireApprovalBinding(
  approval: E2eeApprovalRecord,
  exchange: CompareApproval
): void {
  const binding = approvalBinding(approval);
  if (
    binding.id !== exchange.id ||
    binding.deviceId !== exchange.deviceId ||
    !sameBytes(binding.signingKey, exchange.signingKey) ||
    !sameBytes(binding.unlockKey, exchange.unlockKey) ||
    !sameBytes(binding.commitment, exchange.commitment)
  )
    changedApproval();
}

function requireCurrentComparison(
  ctx: E2eeContext,
  account: AccountView,
  exchange: CompareApproval
): void {
  requireActiveKeyContext(ctx);
  const { device } = requireUnlockedApprover(ctx, account);
  if (
    compareApprovals.get(comparisonId(ctx, exchange.id)) !== exchange ||
    exchange.approverId !== device.deviceId ||
    !sameBytes(exchange.approverKey, device.signingPublicKey)
  ) {
    throw new EncryptionFlowError(
      'approval-gone',
      'This comparison was started elsewhere. Start it again.'
    );
  }
}

function requireComparisonResponse(
  approval: E2eeApprovalRecord,
  exchange: CompareApproval
): void {
  if (
    !approval.approverKey ||
    !sameBytes(fromBase64Url(approval.approverKey, 65), exchange.approverKey) ||
    !approval.approverNonce ||
    !sameBytes(fromBase64Url(approval.approverNonce, 32), exchange.nonce)
  ) {
    throw new EncryptionFlowError(
      'approval-gone',
      'This comparison was started elsewhere. Start it again.'
    );
  }
}

/** Whether this page can resume the already-started comparison in the list. */
export function canResumeCompareApproval(
  ctx: E2eeContext,
  account: AccountView,
  approval: E2eeApprovalRecord
): boolean {
  if (approval.state !== 'responded' && approval.state !== 'revealed')
    return false;
  const exchange = compareApprovals.get(comparisonId(ctx, approval.id));
  if (!exchange) return false;
  try {
    exchange.assertActive();
    requireCurrentComparison(ctx, account, exchange);
    requireApprovalBinding(approval, exchange);
    requireComparisonResponse(approval, exchange);
    return true;
  } catch {
    return false;
  }
}

/** Pins before nonce release, or resumes an unchanged local comparison. */
export async function beginCompareApproval(
  ctx: E2eeContext,
  account: AccountView,
  approvalId: string
): Promise<E2eeApprovalRecord> {
  const { device } = requireUnlockedApprover(ctx, account);
  const guard = keyOperationGuard(ctx.userId, ctx.readScope);
  const sessionGuard = keyOperationGuard(ctx.userId);
  requireActiveKeyContext(ctx);
  const initial = { ...(await ctx.api.getApproval(approvalId)) };
  guard();
  requireActiveKeyContext(ctx);
  if (initial.id !== approvalId) changedApproval();
  const key = comparisonId(ctx, approvalId);
  let exchange = compareApprovals.get(key);
  if (exchange) {
    requireCurrentComparison(ctx, account, exchange);
    requireApprovalBinding(initial, exchange);
    try {
      exchange.assertActive();
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'AbortError')
        throw error;
      if (initial.state !== 'requested') {
        throw new EncryptionFlowError(
          'approval-gone',
          'This comparison ended when the account was locked. Use Scan code, or deny this request and ask again on the new device.'
        );
      }
      // Restart only under the current unlocked session. A failed send may
      // have reached the relay: preserve every pinned field and the original
      // response nonce even when the relay still reports `requested`.
      exchange = { ...exchange, assertActive: sessionGuard };
      compareApprovals.set(key, exchange);
    }
    if (initial.state === 'responded' || initial.state === 'revealed') {
      requireComparisonResponse(initial, exchange);
      return initial;
    }
  } else {
    exchange = {
      ...approvalBinding(initial),
      approverId: device.deviceId,
      approverKey: device.signingPublicKey.slice(),
      nonce: createApprovalNonce(),
      assertActive: sessionGuard
    };
    // Retain even if the response is lost: the relay may have seen the nonce.
    // Concurrent/duplicate starts must never replace this observation.
    compareApprovals.set(key, exchange);
  }
  exchange.assertActive();
  requireCurrentComparison(ctx, account, exchange);
  const response = await ctx.api.respondApproval(approvalId, {
    approverKey: b64(exchange.approverKey),
    approverNonce: b64(exchange.nonce)
  });
  guard();
  requireCurrentComparison(ctx, account, exchange);
  requireApprovalBinding(response, exchange);
  return response;
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
  approval = { ...approval };
  const guard = keyOperationGuard(ctx.userId, ctx.readScope);
  const exchange = compareApprovals.get(comparisonId(ctx, approval.id));
  if (!exchange) {
    throw new EncryptionFlowError(
      'approval-gone',
      'This comparison was started elsewhere. Start it again.'
    );
  }
  exchange.assertActive();
  requireCurrentComparison(ctx, account, exchange);
  requireApprovalBinding(approval, exchange);
  if (approval.state !== 'revealed') return null;
  requireComparisonResponse(approval, exchange);
  if (!approval.deviceNonce) {
    throw new EncryptionFlowError(
      'approval-gone',
      'This comparison was started elsewhere. Start it again.'
    );
  }
  const keys = [exchange.signingKey, exchange.unlockKey];
  const deviceNonce = fromBase64Url(approval.deviceNonce, 32);
  if (
    !(await verifyDeviceApprovalCommitment(
      keys,
      deviceNonce,
      exchange.commitment
    ))
  ) {
    changedApproval();
  }
  const code = await deviceApprovalCode({
    newDevicePublicKey: keys,
    approverPublicKey: exchange.approverKey,
    newDeviceNonce: deviceNonce,
    approverNonce: exchange.nonce
  });
  guard();
  requireCurrentComparison(ctx, account, exchange);
  return code;
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
  approval = { ...approval };
  const { device, unlocked } = requireUnlockedApprover(ctx, account);
  const started = compareApprovals.get(comparisonId(ctx, approval.id));
  const exchange =
    started?.approverId === device.deviceId ? started : undefined;
  const guard = keyOperationGuard(ctx.userId, ctx.readScope);
  const assertComparison = () => {
    if (!exchange) return;
    // A fresh full-hash scan authenticates independently of the old nonce.
    // Its current operation must still preserve the pin and session lifetime.
    guard();
    requireCurrentComparison(ctx, account, exchange);
    requireApprovalBinding(approval, exchange);
  };
  assertComparison();
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
  assertComparison();
  let list = account.list;
  let certified = false;
  let sealedAccountKey: string | undefined;
  // A device already certified with exactly these keys asks again to have
  // its contacts head confirmed (ADR-024, verified pins): approve it as
  // certified, with no new certification and no sealed account key. (With
  // the recovery key the branch below finds it in the current list.)
  if (
    !recoverySecret &&
    list.devices.some(
      (d) =>
        d.deviceId === approval.deviceId &&
        sameBytes(d.signingKey, signingKey) &&
        sameBytes(d.unlockKey, unlockKey)
    )
  ) {
    certified = true;
  }
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
    assertComparison();
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
    assertComparison();
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
    issuedAt: now(ctx),
    contacts: await approverContactsHead(ctx, list)
  });
  assertComparison();
  await ctx.api.completeApproval(approval.id, {
    grant: { statement: b64(grant.statement), signature: b64(grant.signature) },
    ...(sealedAccountKey ? { sealedAccountKey } : {})
  });
  if (compareApprovals.get(comparisonId(ctx, approval.id)) === exchange) {
    compareApprovals.delete(comparisonId(ctx, approval.id));
  }
  return loadEncryption(ctx);
}

/**
 * The newest contacts head this approving browser accepted under `list`'s
 * identity, for the grant. With none (it never loaded the list under this
 * identity) the grant says so, unconfirmed: the approved device then
 * starts from the server's list, as a passkey enrolment does.
 */
async function approverContactsHead(
  ctx: E2eeContext,
  list: VerifiedDeviceList
): Promise<DeviceApprovalContactsHead> {
  const stored = await contactPinsOf(ctx).readList(ctx.userId);
  if (!stored || stored.identityKeyHash !== toHex(list.identityKeyHash)) {
    return { head: null, confirmed: false };
  }
  if (stored.pendingApproval) {
    throw new EncryptionFlowError(
      'grant-invalid',
      'Check the newest contacts list in Settings › Encryption › Contacts before approving another device. An earlier approval head is still unresolved.'
    );
  }
  return {
    head:
      stored.sequence === EMPTY_CONTACTS_SEQUENCE
        ? null
        : { sequence: stored.sequence, entryHash: fromHex(stored.entryHash) },
    confirmed: stored.confirmed
  };
}

/** Refuses a pending request from the approving side. */
export async function denyApproval(
  ctx: E2eeContext,
  approvalId: string
): Promise<void> {
  compareApprovals.delete(comparisonId(ctx, approvalId));
  await ctx.api.cancelApproval(approvalId);
}

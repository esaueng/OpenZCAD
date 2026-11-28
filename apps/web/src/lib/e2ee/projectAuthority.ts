/** Independent owner intent and account-authenticated MLS roots (8-C5b). */
import {
  decodeMlsAuthorityManifest,
  decodeMlsAuthorityTrust,
  fromBase64Url,
  openMlsAuthorityTrust,
  signMlsAuthorityTrust,
  toBase64Url,
  toHex,
  verifyMlsAuthorityManifest,
  verifyMlsAuthorityReset,
  mlsAuthorityResetHash,
  verifyGroupReset,
  type MlsAuthorityManifest,
  type MlsAuthorityTrust,
  type SignedStatement,
  type VerifiedDeviceList
} from '@openzcad/crypto';
import type {
  E2eeProjectAuthorityRecord,
  E2eeSaveProjectAuthorityRequest
} from '@openzcad/shared';
import type { ProjectGroupContext } from './projectGroups';
import { getKeySessionRevision, isCurrentKeySession } from './keySession';
import {
  AUTHORITY_WITHDRAWN_PROBLEM,
  IDENTITY_DISCONTINUED_PROBLEM
} from './encryptionStatus';
import {
  groupInfoContextBytes,
  parseGroupInfoContext,
  projectGroupId
} from './mls/epochRoles';
import {
  projectAuthorityStore,
  withProjectAuthorityLock,
  type ProjectAuthorityLocalState,
  type ExpectedProjectOwner
} from './projectAuthorityStore';

export class ProjectAuthorityError extends Error {
  override readonly name = 'ProjectAuthorityError';
  constructor(
    message: string,
    readonly code:
      | 'invalid'
      | 'signer-untrusted'
      /** See `identityDiscontinued`: still a refusal, never a bypass. */
      | 'identity-discontinued'
      /** See `withdrawnFromOwner`: still a refusal, never a bypass. */
      | 'authority-withdrawn'
      /** `restoreProjectAuthority` declined; nothing was written. */
      | 'restore-refused' = 'invalid'
  ) {
    super(message);
  }
}
function fail(message: string): never {
  throw new ProjectAuthorityError(message);
}
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);
const storeFor = (ctx: ProjectGroupContext) =>
  ctx.authorityStore ?? projectAuthorityStore();
const signed = (value: {
  statement: string;
  signature: string;
}): SignedStatement => ({
  statement: fromBase64Url(value.statement),
  signature: fromBase64Url(value.signature)
});
const wire = (value: SignedStatement) => ({
  statement: toBase64Url(value.statement),
  signature: toBase64Url(value.signature)
});
const hashOf = async (record: Uint8Array<ArrayBuffer>) =>
  toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', record)));
function sessionGuard() {
  const revision = getKeySessionRevision();
  return () => {
    if (!isCurrentKeySession(revision))
      throw new DOMException('The encryption session ended.', 'AbortError');
  };
}
function checkOwner(
  owner: ExpectedProjectOwner | null,
  manifest: MlsAuthorityManifest
): void {
  if (
    owner &&
    (owner.userId !== manifest.ownerUserId ||
      owner.identityKeyHash !== manifest.ownerIdentityKeyHash)
  )
    fail(
      'This project names a different owner than the one this device verified.'
    );
}
function extendsManifest(
  previous: MlsAuthorityManifest,
  next: MlsAuthorityManifest
): void {
  if (
    previous.projectId !== next.projectId ||
    previous.ownerUserId !== next.ownerUserId ||
    previous.ownerIdentityKeyHash !== next.ownerIdentityKeyHash ||
    previous.roots.length > next.roots.length ||
    previous.roots.some(
      (root, index) =>
        JSON.stringify(root) !== JSON.stringify(next.roots[index])
    )
  )
    fail('The account replaced a trusted MLS owner or generation root.');
}

function checkNewGeneration(
  current: ProjectAuthorityLocalState,
  next: MlsAuthorityManifest
): void {
  if (!current.manifest || !current.accepted) return;
  const prior = decodeMlsAuthorityManifest(signed(current.manifest).statement);
  const firstNew = next.roots[prior.roots.length];
  const latest = decodeMlsAuthorityTrust(
    fromBase64Url(current.accepted.authority.record)
  ).latestKeyEpoch;
  if (firstNew && firstNew.keyEpochBase <= latest)
    fail(
      'A new MLS generation would replace a key epoch this device already authenticated.'
    );
}
/** Keep independently pinned newer roots/checkpoints while an account write catches up. */
function newestManifest(
  previous: { statement: string; signature: string } | null,
  candidate: { statement: string; signature: string }
) {
  if (!previous) return candidate;
  const old = decodeMlsAuthorityManifest(signed(previous).statement);
  const next = decodeMlsAuthorityManifest(signed(candidate).statement);
  if (old.roots.length > next.roots.length) {
    extendsManifest(next, old);
    return previous;
  }
  extendsManifest(old, next);
  if (old.roots.length < next.roots.length) return candidate;
  const before = old.checkpoint;
  const after = next.checkpoint;
  if (
    before &&
    after &&
    before.keyEpoch === after.keyEpoch &&
    !same(
      groupInfoContextBytes(fromBase64Url(before.groupInfo)),
      groupInfoContextBytes(fromBase64Url(after.groupInfo))
    )
  )
    fail(
      'Two owner checkpoints claim different MLS states at the same key epoch.'
    );
  return before && (!after || before.keyEpoch > after.keyEpoch)
    ? previous
    : candidate;
}
/** Call only for local creation or after verifying a recipient-bound owner invitation. */
export async function rememberExpectedProjectOwner(
  ctx: ProjectGroupContext,
  projectId: string,
  owner: VerifiedDeviceList
): Promise<void> {
  const guard = sessionGuard();
  const expected = {
    userId: owner.userId,
    identityKeyHash: toHex(owner.identityKeyHash)
  };
  await storeFor(ctx).update(ctx.account.userId, projectId, (current) => {
    guard();
    if (
      current.owner &&
      (current.owner.userId !== expected.userId ||
        current.owner.identityKeyHash !== expected.identityKeyHash)
    )
      fail('The project owner differs from the independently verified owner.');
    return { ...current, owner: expected };
  });
}
export async function expectedProjectOwner(
  ctx: ProjectGroupContext,
  projectId: string
): Promise<ExpectedProjectOwner | null> {
  return (await storeFor(ctx).read(ctx.account.userId, projectId)).owner;
}
export async function cachedProjectAuthorityManifest(
  ctx: ProjectGroupContext,
  projectId: string
): Promise<SignedStatement | null> {
  const local = await storeFor(ctx).read(ctx.account.userId, projectId);
  return local.manifest ? signed(local.manifest) : null;
}
/** Previously authenticated local state remains a pin, never a server hint. */
export async function cachedProjectAuthorityState(
  ctx: ProjectGroupContext,
  projectId: string
): Promise<MlsAuthorityTrust | null> {
  const local = await storeFor(ctx).read(ctx.account.userId, projectId);
  return local.accepted
    ? decodeMlsAuthorityTrust(fromBase64Url(local.accepted.authority.record))
    : null;
}
/**
 * Whether a withdrawn authority belongs to an owner identity this account
 * no longer continues (issue #1704): the device independently pinned this
 * account as the project's owner under an identity key other than the
 * current one, and the current identity's genesis names no identity it
 * replaces, i.e. it was set up afresh (as after a profile deletion) rather
 * than rotated with a signed transition. Only the wording and next action
 * change: the load is refused exactly as any withdrawal, and every pin
 * stays. A rotated identity, an unpinned owner or another owner's project
 * keeps the generic withdrawal refusal.
 */
function identityDiscontinued(
  ctx: ProjectGroupContext,
  local: ProjectAuthorityLocalState
): boolean {
  const owner = pinnedOwner(local);
  const genesis = ctx.account.list.entries[0]?.entry;
  return (
    !!owner &&
    !!genesis &&
    owner.userId === ctx.account.userId &&
    owner.identityKeyHash !== toHex(ctx.account.list.identityKeyHash) &&
    genesis.previousIdentityKeyHash === null
  );
}
/** The owner this device pinned: its recorded intent, else its accepted roots. */
function pinnedOwner(
  local: ProjectAuthorityLocalState
): ExpectedProjectOwner | null {
  if (local.owner || !local.accepted) return local.owner;
  try {
    const manifest = decodeMlsAuthorityManifest(
      signed(
        decodeMlsAuthorityTrust(fromBase64Url(local.accepted.authority.record))
          .manifest
      ).statement
    );
    return {
      userId: manifest.ownerUserId,
      identityKeyHash: manifest.ownerIdentityKeyHash
    };
  } catch {
    // An unreadable pin says nothing about the owner: generic refusal.
    return null;
  }
}
/**
 * Whether a withdrawn authority is one the owner can restore (issue #1704):
 * the device pinned this account, under the identity it still has, as the
 * project's owner. As with `identityDiscontinued`, only the wording and
 * next action change. The load is refused, every pin stays, and nothing is
 * restored without the owner's confirmation (`restoreProjectAuthority`).
 */
function withdrawnFromOwner(
  ctx: ProjectGroupContext,
  local: ProjectAuthorityLocalState
): boolean {
  const owner = pinnedOwner(local);
  return (
    !!owner &&
    owner.userId === ctx.account.userId &&
    owner.identityKeyHash === toHex(ctx.account.list.identityKeyHash)
  );
}
export interface TrustedProjectAuthority {
  readonly record: E2eeProjectAuthorityRecord;
  readonly value: MlsAuthorityTrust;
  readonly manifest: MlsAuthorityManifest;
}
/** Both the account MAC and the currently certified device signature must verify. */
export function loadProjectAuthority(
  ctx: ProjectGroupContext,
  projectId: string,
  options: { readonly identityReset?: SignedStatement } = {}
): Promise<TrustedProjectAuthority | null> {
  return verifiedProjectAuthority(ctx, projectId, options);
}
/**
 * {@link loadProjectAuthority}, with a last word for the caller: `accept`
 * sees the record once every check passed and before anything is pinned.
 * When it throws, the load fails with that error and the pins (owner,
 * accepted record and roots) stay exactly as they were.
 */
async function verifiedProjectAuthority(
  ctx: ProjectGroupContext,
  projectId: string,
  options: { readonly identityReset?: SignedStatement },
  accept?: (verified: TrustedProjectAuthority) => void
): Promise<TrustedProjectAuthority | null> {
  const guard = sessionGuard();
  if (!ctx.api.authority)
    fail('This service needs authenticated MLS authority storage.');
  const local = await storeFor(ctx).read(ctx.account.userId, projectId);
  const { authority } = await ctx.api.authority(projectId);
  if (!authority) {
    if (local.accepted) {
      if (identityDiscontinued(ctx, local))
        throw new ProjectAuthorityError(
          IDENTITY_DISCONTINUED_PROBLEM,
          'identity-discontinued'
        );
      if (withdrawnFromOwner(ctx, local))
        throw new ProjectAuthorityError(
          AUTHORITY_WITHDRAWN_PROBLEM,
          'authority-withdrawn'
        );
      fail(
        'The account withdrew project authority this device already verified.'
      );
    }
    return null;
  }
  const record = fromBase64Url(authority.record);
  const hash = await hashOf(record);
  const value = decodeMlsAuthorityTrust(record);
  const manifest = decodeMlsAuthorityManifest(signed(value.manifest).statement);
  if (
    value.userId !== ctx.account.userId ||
    value.projectId !== projectId ||
    value.sequence !== authority.sequence ||
    value.signerDeviceId !== authority.signerDeviceId ||
    value.accountKeyGeneration !== authority.accountKeyGeneration ||
    value.accountKeySequence !== authority.accountKeySequence
  )
    fail('The project authority record names another account, project or key.');
  const live = ctx.account.list.devices.find(
    (device) => device.deviceId === value.signerDeviceId
  );
  const pinned =
    local.accepted?.hash === hash &&
    local.accepted.authority.sequence === value.sequence;
  const retired = pinned
    ? ctx.account.list.revoked.find(
        (entry) => entry.kind === 'device' && entry.id === value.signerDeviceId
      )?.device
    : undefined;
  let recoverySigner: typeof live;
  if (!live && !retired && options.identityReset) {
    const reset = await verifyGroupReset(
      options.identityReset,
      ctx.account.list,
      { generation: ctx.account.generation ?? 1 }
    );
    const expected = await mlsAuthorityResetHash(
      manifest,
      value.latestKeyEpoch,
      value.latestGroupInfo
    );
    if (
      reset.projectId !== projectId ||
      reset.priorKeyEpoch !== value.latestKeyEpoch ||
      reset.priorGroupGeneration !== manifest.roots.at(-1)!.generation ||
      reset.entrySequence !== ctx.account.list.head.sequence ||
      manifest.ownerUserId !== ctx.account.userId ||
      manifest.ownerIdentityKeyHash !==
        toHex(ctx.account.list.identityKeyHash) ||
      !reset.authorityHash ||
      !same(reset.authorityHash, expected)
    )
      fail('The identity reset does not approve this project authority state.');
    recoverySigner = ctx.account.list.revoked.find(
      (entry) => entry.kind === 'device' && entry.id === value.signerDeviceId
    )?.device;
  }
  const signer = live ?? retired ?? recoverySigner;
  if (!signer)
    throw new ProjectAuthorityError(
      'No currently certified device vouches for this project authority record.',
      'signer-untrusted'
    );
  const account = await ctx.account.currentAccountKey();
  let key = account.key;
  try {
    if (
      value.accountKeyGeneration !== account.generation ||
      value.accountKeySequence !== account.keySequence
    )
      key = await ctx.account.openAccountKey(
        value.accountKeyGeneration,
        value.accountKeySequence
      );
    await openMlsAuthorityTrust(key, signer.signingKey, {
      record,
      recordMac: fromBase64Url(authority.recordMac),
      signature: fromBase64Url(authority.signature)
    });
  } finally {
    key.fill(0);
    account.key.fill(0);
  }
  const context = parseGroupInfoContext(fromBase64Url(value.latestGroupInfo));
  if (
    manifest.projectId !== projectId ||
    !same(context.groupId, projectGroupId(projectId)) ||
    context.epoch + manifest.roots.at(-1)!.keyEpochBase !==
      value.latestKeyEpoch ||
    !context.roles.users.some(
      (user) => user.userId === manifest.ownerUserId && user.role === 'owner'
    )
  )
    fail('The project authority record carries inconsistent membership state.');
  const verified = { record: authority, value, manifest };
  await storeFor(ctx).update(ctx.account.userId, projectId, (current) => {
    guard();
    checkOwner(current.owner, manifest);
    checkNewGeneration(current, manifest);
    if (current.accepted) {
      const before = decodeMlsAuthorityTrust(
        fromBase64Url(current.accepted.authority.record)
      );
      if (
        before.sequence > value.sequence ||
        (before.sequence === value.sequence &&
          current.accepted.hash !== hash) ||
        before.latestKeyEpoch > value.latestKeyEpoch ||
        (before.latestKeyEpoch === value.latestKeyEpoch &&
          !same(
            groupInfoContextBytes(fromBase64Url(before.latestGroupInfo)),
            groupInfoContextBytes(fromBase64Url(value.latestGroupInfo))
          ))
      )
        fail('The account returned a rollback or fork of project authority.');
    }
    if (current.manifest) {
      const prior = decodeMlsAuthorityManifest(
        signed(current.manifest).statement
      );
      if (
        prior.roots.length > manifest.roots.length &&
        value.latestKeyEpoch >= prior.roots[manifest.roots.length]!.keyEpochBase
      )
        fail('The account assigned a key epoch to an older MLS generation.');
    }
    const next = {
      owner: {
        userId: manifest.ownerUserId,
        identityKeyHash: manifest.ownerIdentityKeyHash
      },
      accepted: { hash, authority },
      manifest: newestManifest(current.manifest, value.manifest)
    };
    // Last, so a record the caller turns down is never pinned.
    accept?.(verified);
    return next;
  });
  return verified;
}
/** New roots need the pinned owner's current, unrevoked device signature. */
export async function acceptProjectAuthorityManifest(
  ctx: ProjectGroupContext,
  projectId: string,
  candidate: SignedStatement
): Promise<MlsAuthorityManifest> {
  const guard = sessionGuard();
  const local = await storeFor(ctx).read(ctx.account.userId, projectId);
  if (!local.owner)
    fail('Verify this project’s owner before accepting its MLS roots.');
  const value = decodeMlsAuthorityManifest(candidate.statement);
  if (value.projectId !== projectId)
    fail('The MLS roots name another project.');
  checkOwner(local.owner, value);
  const lists = [
    ctx.account.list,
    // The account view already contains our verified device list. Looking
    // up co-members cannot add evidence about a manifest we signed ourselves.
    ...(value.ownerUserId === ctx.account.userId
      ? []
      : ((await ctx.members?.lists(projectId, [value.ownerUserId])) ?? []))
  ];
  const owner = lists.find(
    (list) =>
      list.userId === value.ownerUserId &&
      toHex(list.identityKeyHash) === value.ownerIdentityKeyHash
  );
  const signer = owner?.devices.find(
    (device) => device.deviceId === value.signerDeviceId
  );
  if (value.roots.length > 1) {
    if (!owner)
      fail(
        'The reset history needs the independently verified owner identity.'
      );
    for (let generation = 1; generation < value.roots.length; generation++)
      await verifyMlsAuthorityReset(
        value,
        generation,
        owner,
        owner.userId === ctx.account.userId
          ? (ctx.account.generation ?? 1)
          : owner.generation
      );
  }
  if (!signer) {
    if (
      local.manifest?.statement === toBase64Url(candidate.statement) &&
      local.manifest.signature === toBase64Url(candidate.signature)
    )
      return value;
    fail(
      'The MLS roots are not signed by an unrevoked device of the verified owner.'
    );
  }
  await verifyMlsAuthorityManifest(candidate, signer.signingKey);
  await storeFor(ctx).update(ctx.account.userId, projectId, (current) => {
    guard();
    checkOwner(current.owner, value);
    checkNewGeneration(current, value);
    return {
      ...current,
      manifest: newestManifest(current.manifest, wire(candidate))
    };
  });
  return value;
}
/** The caller supplies state authenticated by its own, current MLS session. */
export async function publishProjectAuthority(
  ctx: ProjectGroupContext,
  projectId: string,
  manifestSigned: SignedStatement,
  latestKeyEpoch: number,
  latestGroupInfo: Uint8Array
): Promise<void> {
  const guard = sessionGuard();
  const device = ctx.device;
  if (
    !device ||
    !ctx.account.list.devices.some(
      (entry) => entry.deviceId === device.deviceId
    )
  )
    fail('A certified device is required to publish project authority.');
  if (!ctx.api.saveAuthority || !ctx.api.authority)
    fail('This service needs authenticated MLS authority storage.');
  const manifest = await acceptProjectAuthorityManifest(
    ctx,
    projectId,
    manifestSigned
  );
  const latest = parseGroupInfoContext(latestGroupInfo);
  if (
    !same(latest.groupId, projectGroupId(projectId)) ||
    latestKeyEpoch !== manifest.roots.at(-1)!.keyEpochBase + latest.epoch
  )
    fail('The accepted MLS state names another project or generation.');
  await withProjectAuthorityLock(ctx.account.userId, projectId, async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      guard();
      let current: TrustedProjectAuthority | null;
      let replacementSequence: number | undefined;
      try {
        current = await loadProjectAuthority(ctx, projectId);
      } catch (error) {
        // A retired sibling's unpinned record cannot bootstrap a reader. A
        // caller with independently pinned roots and an authenticated live MLS
        // state can replace it, using only the opaque server sequence for CAS.
        if (
          !(error instanceof ProjectAuthorityError) ||
          error.code !== 'signer-untrusted'
        )
          throw error;
        const local = await storeFor(ctx).read(ctx.account.userId, projectId);
        if (!local.owner || !local.manifest) throw error;
        checkOwner(local.owner, manifest);
        extendsManifest(
          decodeMlsAuthorityManifest(signed(local.manifest).statement),
          manifest
        );
        const stale = (await ctx.api.authority!(projectId)).authority;
        if (
          !stale ||
          !Number.isSafeInteger(stale.sequence) ||
          stale.sequence < 1 ||
          stale.sequence >= 0xffffffff
        )
          throw error;
        replacementSequence = stale.sequence;
        current = null;
      }
      if (current) {
        extendsManifest(current.manifest, manifest);
        if (current.value.latestKeyEpoch > latestKeyEpoch) return;
        if (
          current.value.latestKeyEpoch === latestKeyEpoch &&
          !same(
            groupInfoContextBytes(fromBase64Url(current.value.latestGroupInfo)),
            groupInfoContextBytes(latestGroupInfo)
          )
        )
          fail('Two different MLS states claim the same key epoch.');
      }
      const account = await ctx.account.currentAccountKey();
      let request: E2eeSaveProjectAuthorityRequest;
      try {
        if (
          current &&
          current.value.latestKeyEpoch === latestKeyEpoch &&
          current.value.accountKeyGeneration === account.generation &&
          current.value.accountKeySequence === account.keySequence &&
          ctx.account.list.devices.some(
            (entry) => entry.deviceId === current.record.signerDeviceId
          ) &&
          current.value.manifest.statement ===
            toBase64Url(manifestSigned.statement)
        )
          return;
        const sequence =
          (replacementSequence ?? current?.value.sequence ?? 0) + 1;
        const sealed = await signMlsAuthorityTrust(
          account.key,
          device.signing.privateKey,
          {
            userId: ctx.account.userId,
            projectId,
            sequence,
            accountKeyGeneration: account.generation,
            accountKeySequence: account.keySequence,
            signerDeviceId: device.deviceId,
            manifest: wire(manifestSigned),
            latestKeyEpoch,
            latestGroupInfo: toBase64Url(latestGroupInfo)
          }
        );
        request = {
          expectedSequence: sequence - 1,
          sequence,
          accountKeyGeneration: account.generation,
          accountKeySequence: account.keySequence,
          signerDeviceId: device.deviceId,
          record: toBase64Url(sealed.record),
          recordMac: toBase64Url(sealed.recordMac),
          signature: toBase64Url(sealed.signature)
        };
      } finally {
        account.key.fill(0);
      }
      guard();
      try {
        await ctx.api.saveAuthority!(projectId, request);
      } catch (error) {
        const stored = await loadProjectAuthority(ctx, projectId).catch(
          () => null
        );
        if (stored?.record.record === request.record) return;
        if ((error as { code?: unknown }).code === 'E2EE_AUTHORITY_CONFLICT')
          continue;
        throw error;
      }
      guard();
      const stored = await loadProjectAuthority(ctx, projectId);
      if (!stored || stored.record.record !== request.record)
        fail('The account did not retain the authority record it accepted.');
      return;
    }
    fail('Other devices kept changing project authority. Retry the operation.');
  });
}

/**
 * The plain words the owner confirms before a restoration. The server's
 * word never stands in for them (owner decision, PR #1418).
 */
export const AUTHORITY_RESTORE_CONFIRMATION =
  'This is my project. Restore its verification record from this device.';

/** What this device could do about a project's authority record. */
export type AuthorityRecovery =
  /** The account returns a record, or this device pinned none. */
  | 'none'
  /** Withdrawn, and this device's pin names this account as the owner. */
  | 'restorable'
  /** Withdrawn under an identity the account no longer continues. */
  | 'identity-discontinued'
  /** Withdrawn from a project another account owns. */
  | 'not-owner';

/** Reads only: this device's pins and whether the account returns a record. */
export async function projectAuthorityRecovery(
  ctx: ProjectGroupContext,
  projectId: string
): Promise<AuthorityRecovery> {
  if (!ctx.api.authority) return 'none';
  const local = await storeFor(ctx).read(ctx.account.userId, projectId);
  if (!local.accepted) return 'none';
  if ((await ctx.api.authority(projectId)).authority) return 'none';
  if (identityDiscontinued(ctx, local)) return 'identity-discontinued';
  return withdrawnFromOwner(ctx, local) ? 'restorable' : 'not-owner';
}

/**
 * Put back an authority record the account no longer returns, from this
 * device's own accepted pin (issue #1704). Only after the owner confirmed
 * {@link AUTHORITY_RESTORE_CONFIRMATION}; a missing record is otherwise
 * refused exactly as before.
 *
 * Nothing the server says is trusted here. The record written restates the
 * state this device already authenticated (the same roots, key epoch and
 * membership state) one sequence later, sealed by this certified device
 * under the current account key. It is written only when:
 *
 * - the pin names this account, under its current identity, as the owner;
 * - the pinned record still opens under an account key this device holds
 *   and carries the signature of a device in the account's list;
 * - the account still returns no record. A record that reappeared, from
 *   another device's restoration for one, goes through the ordinary load
 *   and its rollback and fork checks instead.
 *
 * Other devices accept the restored record as any newer one: by its account
 * MAC, its certified signer and their own pins. The pins here are never
 * dropped or loosened; when anything fails they stay exactly as they were.
 *
 * Like a group reset, this is a recovery tool and claims nothing stronger.
 * The record restates what this device last verified, which may be older
 * than what another device of the account verified. Such a device refuses
 * it as a rollback, keeps its own pin and can restore from that instead; a
 * device with no pin learns no more from it than from the original record.
 */
export async function restoreProjectAuthority(
  ctx: ProjectGroupContext,
  projectId: string,
  confirmation: string
): Promise<TrustedProjectAuthority> {
  const refuse = (message: string): never => {
    throw new ProjectAuthorityError(message, 'restore-refused');
  };
  if (confirmation !== AUTHORITY_RESTORE_CONFIRMATION)
    refuse('Confirm that this is your project before restoring its record.');
  const guard = sessionGuard();
  const device = ctx.device;
  if (
    !device ||
    !ctx.account.list.devices.some(
      (entry) => entry.deviceId === device.deviceId
    )
  )
    return refuse(
      'Only a device that can edit encrypted projects can restore this record. Use one of your other devices.'
    );
  const { authority: read, saveAuthority: save } = ctx.api;
  if (!read || !save)
    return fail('This service needs authenticated MLS authority storage.');
  return withProjectAuthorityLock(ctx.account.userId, projectId, async () => {
    guard();
    const local = await storeFor(ctx).read(ctx.account.userId, projectId);
    const pin = local.accepted;
    if (!pin)
      return refuse(
        'This device never verified this project’s record, so it has nothing to restore it from.'
      );
    if ((await read(projectId)).authority) {
      // Nothing is missing (any more): only the ordinary checks decide.
      return (await loadProjectAuthority(ctx, projectId))!;
    }
    if (identityDiscontinued(ctx, local))
      throw new ProjectAuthorityError(
        IDENTITY_DISCONTINUED_PROBLEM,
        'identity-discontinued'
      );
    const record = fromBase64Url(pin.authority.record);
    const value = decodeMlsAuthorityTrust(record);
    const manifest = decodeMlsAuthorityManifest(
      signed(value.manifest).statement
    );
    if (
      (await hashOf(record)) !== pin.hash ||
      value.userId !== ctx.account.userId ||
      value.projectId !== projectId ||
      manifest.projectId !== projectId ||
      value.sequence !== pin.authority.sequence ||
      value.signerDeviceId !== pin.authority.signerDeviceId ||
      value.accountKeyGeneration !== pin.authority.accountKeyGeneration ||
      value.accountKeySequence !== pin.authority.accountKeySequence
    )
      refuse('This device’s saved record of this project is inconsistent.');
    if (manifest.ownerUserId !== ctx.account.userId)
      refuse('Only the project’s owner can restore its verification record.');
    if (
      manifest.ownerIdentityKeyHash !== toHex(ctx.account.list.identityKeyHash)
    )
      refuse(
        'This project was secured under an earlier set of your account’s encryption keys, so this device cannot restore its record.'
      );
    checkOwner(local.owner, manifest);
    if (value.sequence >= 0xffffffff)
      refuse('This project’s record cannot be advanced any further.');
    // Pinned earlier, so a since-removed device of this identity still
    // vouches for it, as it does when the account returns the record.
    const signer =
      ctx.account.list.devices.find(
        (entry) => entry.deviceId === value.signerDeviceId
      ) ??
      ctx.account.list.revoked.find(
        (entry) => entry.kind === 'device' && entry.id === value.signerDeviceId
      )?.device;
    if (!signer)
      return refuse(
        'No device of this account vouches for the record this device kept.'
      );
    const context = parseGroupInfoContext(fromBase64Url(value.latestGroupInfo));
    if (
      !same(context.groupId, projectGroupId(projectId)) ||
      context.epoch + manifest.roots.at(-1)!.keyEpochBase !==
        value.latestKeyEpoch ||
      !context.roles.users.some(
        (user) => user.userId === manifest.ownerUserId && user.role === 'owner'
      )
    )
      refuse('This device’s saved record of this project is inconsistent.');
    const account = await ctx.account.currentAccountKey();
    let request: E2eeSaveProjectAuthorityRequest;
    try {
      // The pin is this device's own, but it is the whole basis of the
      // restoration: prove again that this account's keys sealed it.
      const sealedUnderCurrent =
        value.accountKeyGeneration === account.generation &&
        value.accountKeySequence === account.keySequence;
      const key = sealedUnderCurrent
        ? account.key
        : await ctx.account.openAccountKey(
            value.accountKeyGeneration,
            value.accountKeySequence
          );
      try {
        await openMlsAuthorityTrust(key, signer.signingKey, {
          record,
          recordMac: fromBase64Url(pin.authority.recordMac),
          signature: fromBase64Url(pin.authority.signature)
        });
      } finally {
        if (!sealedUnderCurrent) key.fill(0);
      }
      const sequence = value.sequence + 1;
      const sealed = await signMlsAuthorityTrust(
        account.key,
        device.signing.privateKey,
        {
          userId: ctx.account.userId,
          projectId,
          sequence,
          accountKeyGeneration: account.generation,
          accountKeySequence: account.keySequence,
          signerDeviceId: device.deviceId,
          manifest: value.manifest,
          latestKeyEpoch: value.latestKeyEpoch,
          latestGroupInfo: value.latestGroupInfo
        }
      );
      request = {
        expectedSequence: sequence - 1,
        sequence,
        accountKeyGeneration: account.generation,
        accountKeySequence: account.keySequence,
        signerDeviceId: device.deviceId,
        record: toBase64Url(sealed.record),
        recordMac: toBase64Url(sealed.recordMac),
        signature: toBase64Url(sealed.signature),
        restoreMissing: true
      };
    } finally {
      account.key.fill(0);
    }
    guard();
    try {
      await save(projectId, request);
    } catch (error) {
      // A lost response, or another device's restoration landing first:
      // whatever the account returns now passes the ordinary checks, with
      // their own refusals, or the restoration failed. A record that is
      // still missing was not stored.
      guard();
      const now = await read(projectId).catch(() => null);
      if (now?.authority) return (await loadProjectAuthority(ctx, projectId))!;
      if ((error as { code?: unknown }).code === 'E2EE_AUTHORITY_CONFLICT')
        refuse(
          'The server did not store the restored record, and nothing was changed. It may not support restoring yet.'
        );
      throw error;
    }
    guard();
    // The ordinary checks verify whatever the account returns now against
    // this device's pin (account MAC, certified signer, rollback and fork
    // checks). Another device may have published the next record by the
    // ordinary compare-and-swap since the Worker stored this one: such a
    // verified successor, at a later sequence, is the restored record
    // carried on, and the restoration succeeded. Other bytes at the
    // restored sequence are not what the Worker accepted, however validly
    // sealed: they are refused before anything is pinned, so the record the
    // Worker did store still verifies against the unchanged pins when the
    // account serves it.
    const notRetained =
      'The account did not retain the authority record it accepted.';
    const stored = await verifiedProjectAuthority(
      ctx,
      projectId,
      {},
      (candidate) => {
        if (
          candidate.record.record !== request.record &&
          candidate.value.sequence <= request.sequence
        )
          fail(notRetained);
      }
    );
    return stored ?? fail(notRetained);
  });
}

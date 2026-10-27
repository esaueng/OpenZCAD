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
    readonly code: 'invalid' | 'signer-untrusted' = 'invalid'
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
export interface TrustedProjectAuthority {
  readonly record: E2eeProjectAuthorityRecord;
  readonly value: MlsAuthorityTrust;
  readonly manifest: MlsAuthorityManifest;
}
/** Both the account MAC and the currently certified device signature must verify. */
export async function loadProjectAuthority(
  ctx: ProjectGroupContext,
  projectId: string
): Promise<TrustedProjectAuthority | null> {
  const guard = sessionGuard();
  if (!ctx.api.authority)
    fail('This service needs authenticated MLS authority storage.');
  const local = await storeFor(ctx).read(ctx.account.userId, projectId);
  const { authority } = await ctx.api.authority(projectId);
  if (!authority) {
    if (local.accepted)
      fail(
        'The account withdrew project authority this device already verified.'
      );
    return null;
  }
  const record = fromBase64Url(authority.record);
  const hash = await hashOf(record);
  const value = decodeMlsAuthorityTrust(record);
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
  const signer = live ?? retired;
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
  const manifest = decodeMlsAuthorityManifest(signed(value.manifest).statement);
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
    return {
      owner: {
        userId: manifest.ownerUserId,
        identityKeyHash: manifest.ownerIdentityKeyHash
      },
      accepted: { hash, authority },
      manifest: newestManifest(current.manifest, value.manifest)
    };
  });
  return { record: authority, value, manifest };
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
    ...((await ctx.members?.lists(projectId, [value.ownerUserId])) ?? [])
  ];
  const owner = lists.find(
    (list) =>
      list.userId === value.ownerUserId &&
      toHex(list.identityKeyHash) === value.ownerIdentityKeyHash
  );
  const signer = owner?.devices.find(
    (device) => device.deviceId === value.signerDeviceId
  );
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

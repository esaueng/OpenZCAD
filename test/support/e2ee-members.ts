/**
 * Shared encrypted projects for the member tests (ADR-024 Phase 5, slices
 * 5-4 and 5-5): the owner's project with another account a member of it,
 * seeded through MLS as `test/e2ee-member-storage.test.ts` does (the
 * owner's `setRoles` Commit lists the member, the Worker mirrors the row,
 * and the member's device joins by External Commit with the epoch's keys
 * handed over in process, standing in for the Welcome of slice 5-3), plus
 * the forged-write and refusal helpers those tests share.
 */
import type { DatabaseSync } from 'node:sqlite';
import { expect } from 'vitest';
import {
  epochBinding,
  fromHex,
  signProjectEnvelope,
  toBase64Url,
  toHex,
  wrapKey
} from '@openzcad/crypto';
import type { ProjectDocument } from '@openzcad/shared';
import { ApiError } from '../../apps/web/src/lib/api';
import { sealDocumentJob } from '../../apps/web/src/lib/e2ee/decodeJobs';
import { EncryptedProjectIntegrityError } from '../../apps/web/src/lib/e2ee/encryptedProjectStore';
import {
  commitProjectGroup,
  joinProjectGroup,
  postOwnEpochKeys
} from '../../apps/web/src/lib/e2ee/projectGroups';
import { forgetAllProjectKeys } from '../../apps/web/src/lib/e2ee/unlockedProjectKeys';
import {
  OWNER,
  createEncrypted,
  device,
  newServer,
  rows,
  type Account,
  type Device,
  type Server
} from './e2ee-documents';

export type MemberRole = 'editor' | 'viewer';

/** A `project_members` row, however a server got it (an honest or a lying one). */
export function memberRow(
  srv: Server,
  projectId: string,
  userId: string,
  role: MemberRole
) {
  srv.db
    .prepare(
      `INSERT INTO project_members
         (project_id, user_id, role, added_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`
    )
    .run(projectId, userId, role, OWNER);
}

export const ownerRef = (projectId: string, deviceId = 'owner_laptop') => ({
  userId: OWNER,
  deviceId,
  projectId
});

/**
 * Adds `member` to the owner's project in `role`: the row, the owner's
 * `setRoles` Commit (which the Worker mirrors), the member's own wraps of
 * the new epoch and its External Commit. Returns the member's device.
 */
export async function addMember(
  srv: Server,
  ownerDevice: Device,
  projectId: string,
  member: Account,
  role: MemberRole,
  deviceId: string,
  others: readonly Account[]
): Promise<Device> {
  memberRow(srv, projectId, member.userId, role);
  const state = await commitProjectGroup(ownerDevice.groups, projectId, {
    setRoles: [{ userId: member.userId, role }]
  });
  const joined = device(srv, member, deviceId, { members: others });
  await postOwnEpochKeys(
    joined.groups,
    projectId,
    state.keyEpoch,
    await ownerDevice.sessions.epochMaterial(
      ownerRef(projectId, ownerDevice.deviceId!)
    )
  );
  forgetAllProjectKeys();
  await joinProjectGroup(joined.groups, projectId);
  return joined;
}

/** The owner's encrypted project, with `member` a member of it in `role`. */
export async function sharedProject(
  accounts: readonly Account[],
  owner: Account,
  member: Account,
  role: MemberRole,
  /** The database, when not every migration is applied. */
  db?: DatabaseSync
) {
  const srv = newServer(accounts, db);
  const laptop = device(srv, owner, 'owner_laptop', {
    members: accounts.filter((a) => a !== owner)
  });
  const { document } = await createEncrypted(laptop);
  const projectId = document.projectId;
  const memberDevice = await addMember(
    srv,
    laptop,
    projectId,
    member,
    role,
    member.devices.keys().next().value!,
    accounts.filter((a) => a !== member)
  );
  return { srv, laptop, member: memberDevice, projectId, document };
}

export async function refusedWith(
  promise: Promise<unknown>,
  status: number,
  code: string
) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === status &&
      error.code === code
  );
}

export async function integrityRefusal(
  promise: Promise<unknown>,
  reason: EncryptedProjectIntegrityError['reason']
) {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof EncryptedProjectIntegrityError && error.reason === reason
  );
}

export function head(srv: Server, projectId: string) {
  return rows<{
    document_version: number;
    version_hash: string;
    key_epoch: number;
    signer_user_id: string | null;
  }>(
    srv,
    `SELECT document_version, version_hash, key_epoch, signer_user_id
     FROM e2ee_project_versions WHERE project_id = ?
     ORDER BY document_version DESC LIMIT 1`,
    projectId
  )[0]!;
}

/** The group's current key epoch on the server. */
export function serverKeyEpoch(srv: Server, projectId: string): number {
  return rows<{ key_epoch: number }>(
    srv,
    `SELECT key_epoch_base + epoch AS key_epoch FROM e2ee_project_groups
     WHERE project_id = ?`,
    projectId
  )[0]!.key_epoch;
}

/**
 * A version signed by `d`'s device with keys it should not have (leaked
 * from another member's session), sent straight to the Worker: what a
 * stolen key or a hostile client could write past its own browser's checks.
 */
export async function forgeVersion(
  srv: Server,
  d: Device,
  projectId: string,
  base: ProjectDocument,
  keys: { projectKey: Uint8Array; epochAuthenticator: Uint8Array },
  name = 'Forged'
) {
  const current = head(srv, projectId);
  const keyEpoch = serverKeyEpoch(srv, projectId);
  const documentVersion = current.document_version + 1;
  const document = { ...base, name, version: documentVersion };
  const sealed = await sealDocumentJob({
    type: 'seal-document',
    header: {
      kind: 'document',
      projectId,
      documentVersion,
      previousVersionHash: fromHex(current.version_hash),
      epochBindingHash: await epochBinding(
        projectId,
        keyEpoch,
        keys.epochAuthenticator
      ),
      schemaVersion: 1,
      keyEpoch
    },
    document,
    revisionVersionHashes: new Map()
  });
  const hash = toHex(sealed.versionHash);
  const wrappedVersionKey = toBase64Url(
    await wrapKey(keys.projectKey, sealed.versionKey, {
      purpose: 'version-key',
      projectId,
      keyEpoch,
      kind: 'document',
      versionId: hash
    })
  );
  const signer = d.account.devices.get(d.deviceId!)!;
  return d.documents.saveDocument(
    projectId,
    {
      expectedVersion: current.document_version,
      signature: toBase64Url(
        await signProjectEnvelope(signer.signing.privateKey, sealed.envelope)
      ),
      wrappedVersionKey,
      signerDeviceId: signer.deviceId
    },
    sealed.envelope
  );
}

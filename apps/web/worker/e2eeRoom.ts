/**
 * The collaboration room for end-to-end encrypted projects (ADR-024 Phase 4,
 * slice 4-9; roadmap L11): the Worker's room class, which gives the
 * adapters' room its account seam (`E2eeRoomAccount`), and the notices the
 * encrypted routes send the room.
 *
 * The seam reads envelope headers (never content), the account's head and
 * its retained bodies, and writes room versions with the very `writeVersion`
 * the encrypted document and revision routes use, so a room version lands
 * in the same version log under the same fences: forward from the head the
 * room holds, naming that head's hash, under the group's current key epoch,
 * signed by a device the owner's newest list certifies, counted against the
 * owner's storage. Each write is bound to the session the socket or request
 * was admitted under (by its token hash), so signing out, session expiry,
 * desktop revocation and erasure stop the room's writes as they stop the
 * routes'.
 */
import {
  ProjectCollaborationRoom as AdapterProjectCollaborationRoom,
  isE2eeContentBlobStorageReady,
  isE2eeProjectGroupStorageReady,
  isE2eeProjectVersionStorageReady,
  isProjectStorageFormatReady,
  type CloudflareEnv,
  type E2eeRoomAccount,
  type E2eeRoomWriteResult
} from '@openzcad/cloudflare-adapters';
import { parseEnvelope, toHex, versionHash } from '@openzcad/crypto';
import { projectBucket } from './e2ee';
import { blobBucket } from './e2eeContentBlobs';
import { RouteError, requireEncryptedProjectAccess } from './e2eeProjects';
import { roomVersionStore } from './e2eeProjectDocuments';
import { sessionHashWriteAuthorization } from './e2eeWriteAuthorization';
import { assertPlaintextRoomAccess } from './projectFormatGate';
import { sessionWriteCredential } from './sessionCredentials';
import type { ProjectAccess } from '@openzcad/persistence';

/** The Durable Object class the Worker exports (`PROJECT_ROOM`). */
export class ProjectCollaborationRoom extends AdapterProjectCollaborationRoom {
  protected override e2eeAccount(env: CloudflareEnv): E2eeRoomAccount | null {
    return e2eeRoomAccount(env);
  }
}

/** Why a refused version write cannot land, in the room's terms. */
function writeRefusal(error: RouteError): E2eeRoomWriteResult {
  switch (error.code) {
    case 'REVISION_CONFLICT':
    case 'E2EE_HEAD_MISMATCH':
      return { kind: 'conflict' };
    case 'E2EE_EPOCH_STALE':
      return {
        kind: 'epoch-stale',
        keyEpoch: Number(error.extra.keyEpoch ?? 0)
      };
    case 'E2EE_BLOB_UNKNOWN': {
      // The browser stores the lost blobs again and resubmits (slice 5-6),
      // as an account save does (slice 4-7).
      const listed = error.extra.blobIds;
      return {
        kind: 'refused',
        code: 'blob-unknown',
        message: error.message,
        ...(Array.isArray(listed) &&
        listed.every((id) => typeof id === 'string')
          ? { blobIds: listed }
          : {})
      };
    }
  }
  return {
    kind: 'refused',
    code:
      error.status === 413
        ? 'document-too-large'
        : error.status === 401 || error.status === 403 || error.status === 404
          ? 'permission-denied'
          : error.status >= 500
            ? 'internal'
            : 'document-invalid',
    message: error.message
  };
}

/** The room's view of the account's encrypted versions; null without D1. */
export function e2eeRoomAccount(env: CloudflareEnv): E2eeRoomAccount | null {
  const db = env.DB;
  if (!db) return null;
  const bucket = projectBucket(env);
  // Content blobs (slice 4-6): a room version naming blobs gets the same
  // checks, blob rows and garbage collection as an account save.
  const blobs = async () => ({
    ready: await isE2eeContentBlobStorageReady(db),
    bucket: blobBucket(env)
  });
  const development =
    env.ENVIRONMENT === 'development' && env.AUTH_MODE === 'development';
  const ready = async () =>
    (await isProjectStorageFormatReady(db)) &&
    (await isE2eeProjectGroupStorageReady(db)) &&
    (await isE2eeProjectVersionStorageReady(db));
  const readContext = async (userId: string) => ({
    db,
    bucket,
    userId,
    authorization: { sql: '0', binds: [] },
    blobs: await blobs()
  });

  return {
    async inspect(envelope) {
      try {
        const { header } = parseEnvelope(envelope);
        if (header.class !== 'project') return null;
        return {
          projectId: header.projectId,
          kind: header.kind,
          documentVersion: header.documentVersion,
          keyEpoch: header.keyEpoch,
          previousVersionHash: header.previousVersionHash
            ? toHex(header.previousVersionHash)
            : null,
          versionHash: toHex(await versionHash(envelope))
        };
      } catch {
        return null;
      }
    },

    async head(projectId) {
      if (!(await ready())) return null;
      const project = await db
        .prepare(
          `SELECT document_version FROM projects
           WHERE id = ? AND storage_format = 2 AND status <> 'deleted'`
        )
        .bind(projectId)
        .first<{ document_version: number }>();
      if (!project) return null;
      const head = await roomVersionStore.headRow(db, projectId);
      if (!head || head.document_version !== project.document_version) {
        return null;
      }
      const group = await db
        .prepare(
          `SELECT key_epoch_base + epoch AS key_epoch FROM e2ee_project_groups
           WHERE project_id = ?`
        )
        .bind(projectId)
        .first<{ key_epoch: number }>();
      if (!group) return null;
      return {
        record: roomVersionStore.storedVersion(head),
        keyEpoch: group.key_epoch
      };
    },

    async envelope(projectId, hash) {
      if (!(await ready())) return null;
      const row = await roomVersionStore.rowByHash(db, projectId, hash);
      if (!row) return null;
      try {
        return await roomVersionStore.versionBody(await readContext(''), row);
      } catch {
        // Pruned, or its storage cannot be read: browsers read the account.
        return null;
      }
    },

    async write(input) {
      if (!(await ready())) {
        return {
          kind: 'refused',
          code: 'internal',
          message:
            'Encrypted projects are unavailable until the database is updated.'
        };
      }
      const authorization = input.credential
        ? sessionHashWriteAuthorization(input.credential, input.userId)
        : development
          ? {
              // Development sessions are not durable; erasure still fences.
              sql: 'NOT EXISTS (SELECT 1 FROM account_erasure_requests WHERE user_id = ?)',
              binds: [input.userId]
            }
          : null;
      if (!authorization) {
        return {
          kind: 'refused',
          code: 'permission-denied',
          message: 'Sign in again before saving this encrypted project.'
        };
      }
      try {
        // The same storage access as the document route (slice 5-2): the
        // owner or an editor, read from the Worker's mirror of the MLS roles
        // at the moment of the write (slice 5-6).
        await requireEncryptedProjectAccess(
          db,
          input.userId,
          input.projectId,
          'write'
        );
        const saved = await roomVersionStore.writeVersion(
          {
            db,
            bucket,
            userId: input.userId,
            authorization,
            blobs: await blobs()
          },
          input.projectId,
          {
            expectedVersion: input.expectedVersion,
            signature: input.signature,
            wrappedVersionKey: input.wrappedVersionKey,
            signerDeviceId: input.signerDeviceId
          },
          input.envelope,
          input.revisionId
        );
        const row = await roomVersionStore.rowByHash(
          db,
          input.projectId,
          saved.version.hash
        );
        if (!row) return { kind: 'conflict' };
        return {
          kind: 'accepted',
          record: roomVersionStore.storedVersion(row)
        };
      } catch (error) {
        if (error instanceof RouteError) return writeRefusal(error);
        throw error;
      }
    }
  };
}

const NOTICE_ROUTE =
  /^\/api\/e2ee\/projects\/([^/]+)\/(mls\/commits|mls\/proposals|document|revisions)$/;

/**
 * After an encrypted route's write lands, tells the project's room: a
 * Commit moved the group to a new key epoch, or a version reached the
 * account outside the room. Best effort, like the plaintext room's
 * notices: the write already committed, and the room also re-reads the
 * account's head whenever it next orders a submission.
 */
export async function notifyEncryptedRoom(
  env: {
    PROJECT_ROOM?: {
      getByName(name: string): {
        fetch(request: Request): Promise<Response>;
      };
    };
  },
  request: Request,
  response: Response
): Promise<void> {
  if (!response.ok || !env.PROJECT_ROOM) return;
  const match = NOTICE_ROUTE.exec(new URL(request.url).pathname);
  if (!match) return;
  let projectId: string;
  try {
    projectId = decodeURIComponent(match[1]!);
  } catch {
    return;
  }
  const route = match[2]!;
  let notice:
    | { kind: 'epoch'; keyEpoch: number }
    | { kind: 'head' }
    | { kind: 'members' };
  if (route === 'mls/commits' && request.method === 'POST') {
    try {
      const { group } = (await response.clone().json()) as {
        group?: { keyEpochBase?: unknown; epoch?: unknown };
      };
      const keyEpoch = Number(group?.keyEpochBase) + Number(group?.epoch);
      if (!Number.isSafeInteger(keyEpoch) || keyEpoch < 0) return;
      notice = { kind: 'epoch', keyEpoch };
    } catch {
      return;
    }
  } else if (route === 'mls/proposals' && request.method === 'POST') {
    // A member left by its SelfRemove (slice 5-5), losing access at once
    // (decision M4): its sockets close (slice 5-6).
    notice = { kind: 'members' };
  } else if (
    (route === 'document' && request.method === 'PUT') ||
    (route === 'revisions' && request.method === 'POST')
  ) {
    notice = { kind: 'head' };
  } else {
    return;
  }
  try {
    const url = new URL('https://project-room.internal/_internal/e2ee-notice');
    url.searchParams.set('projectId', projectId);
    await env.PROJECT_ROOM.getByName(projectId).fetch(
      new Request(url, {
        method: 'POST',
        headers: {
          'x-openzcad-internal-e2ee-notice': 'v1',
          'content-type': 'application/json'
        },
        body: JSON.stringify(notice)
      })
    );
  } catch {
    console.error(
      JSON.stringify({ event: 'e2ee_room_notice_failed', kind: notice.kind })
    );
  }
}

/**
 * The room a caller may reach for a project, as headers for the room
 * request: none for a plaintext project; for an encrypted project's owner
 * or member while encrypted projects are open to the account, the format and
 * the session's write credential (members since slice 5-6: editors submit,
 * viewers receive; the room re-reads the role on every submission). Anything
 * else is refused as before.
 */
export async function encryptedRoomHeaders(
  request: Request,
  access: Pick<ProjectAccess, 'projectId' | 'role' | 'storageFormat'>,
  encryptedProjectsEnabled: boolean
): Promise<Record<string, string>> {
  if (!encryptedProjectsEnabled || access.storageFormat !== 2) {
    assertPlaintextRoomAccess(access);
    return {};
  }
  const credential = await sessionWriteCredential(request);
  return {
    'x-openzcad-project-format': '2',
    ...(credential
      ? {
          'x-openzcad-write-credential': `${credential.table}:${credential.tokenHash}`
        }
      : {})
  };
}

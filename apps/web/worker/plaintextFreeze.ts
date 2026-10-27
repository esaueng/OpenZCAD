/** Phase 8: block legacy writes before parsing or buffering their bodies. */
import {
  isCloudflareFeatureEnabled,
  isE2eeContentBlobStorageReady,
  type CloudflareEnv
} from '@openzcad/cloudflare-adapters';
import {
  isPlaintextStorageFormat,
  PlaintextProjectFrozenError,
  ProjectNotFoundError,
  type ProjectAccess
} from '@openzcad/persistence';
import type { UserId } from '@openzcad/shared';
import { projectRouteFormatRule } from './projectFormatGate';

export async function assertPlaintextRouteWritable(
  env: CloudflareEnv,
  persistence: {
    requireProjectRead(
      userId: UserId,
      projectId: string
    ): Promise<ProjectAccess>;
  },
  userId: UserId,
  method: string,
  pathname: string
): Promise<void> {
  if (
    !isCloudflareFeatureEnabled(env, 'E2EE_PLAINTEXT_FROZEN') ||
    ['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(method)
  )
    return;
  const upload = /^\/api\/uploads\/([^/]+)\//.exec(pathname);
  // Encrypted blobs deliberately use the shared upload transport. Only the
  // server's typed session marker grants this exception, never request JSON.
  if (upload && env.DB && (await isE2eeContentBlobStorageReady(env.DB))) {
    const encrypted = await env.DB.prepare(
      `SELECT 1 AS encrypted FROM upload_sessions u
      JOIN projects p ON p.id = u.project_id
      WHERE u.id = ? AND u.kind = 'e2ee-blob' AND u.e2ee_blob_kind IS NOT NULL
        AND (p.user_id = ? OR EXISTS (SELECT 1 FROM project_members m
          WHERE m.project_id = p.id AND m.user_id = ? AND m.role = 'editor'))`
    )
      .bind(upload[1], userId, userId)
      .first();
    if (encrypted) return;
  }
  if (
    pathname === '/api/projects' ||
    pathname.startsWith('/api/uploads') ||
    pathname.startsWith('/api/imports/') ||
    pathname.startsWith('/api/artifacts/') ||
    pathname === '/api/project-invitations/accept'
  )
    throw new PlaintextProjectFrozenError();
  const route = projectRouteFormatRule(method, pathname);
  // Shelf organization and erasure stay available on either storage format.
  if (!route || route.rule === 'metadata') return;
  let access: ProjectAccess;
  try {
    access = await persistence.requireProjectRead(userId, route.projectId);
  } catch (error) {
    if (error instanceof ProjectNotFoundError) return;
    throw error;
  }
  if (isPlaintextStorageFormat(access.storageFormat))
    throw new PlaintextProjectFrozenError();
}

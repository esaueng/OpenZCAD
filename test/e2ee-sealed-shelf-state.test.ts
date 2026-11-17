import { describe, expect, it } from 'vitest';
import worker from '../apps/web/worker/index';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import {
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  PROJECT_SHELF_STATE_SEALED_CODE,
  toUserId,
  type ListProjectsResponse
} from '@openzcad/shared';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

/**
 * ADR-024 amendment 2026-11-14: an account whose library is encrypted keeps
 * pins, manual order and archive in its sealed library record. The Worker
 * stores the defaults on its project rows and refuses anything else; trash
 * and restore stay readable.
 */

/** The Worker's development identity owns an encrypted project. */
const OWNER = toUserId('user_beta_dev');
/** A member of that encrypted project. */
const MEMBER = toUserId('user_member');
/** Holds no encrypted project and never opted in. */
const PLAIN = toUserId('user_plain');

const projectsOn = {
  E2EE_KEYS_ENABLED: 'true',
  E2EE_PROJECTS_ENABLED: 'true'
};

async function seed(extraEnv: Record<string, unknown> = {}) {
  const db = migratedDatabase();
  for (const user of [OWNER, MEMBER, PLAIN]) {
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
    ).run(user, `${user}@example.test`, '2026-11-14T00:00:00.000Z');
  }
  const service = new D1R2PersistenceService({
    DB: sqliteD1(db),
    PROJECT_SHARING_ENABLED: 'true'
  });
  const create = async (owner: typeof OWNER, name: string) =>
    (
      await service.createProject(owner, {
        name,
        initialDocument: withoutDerivedProjection(
          createProjectDocument(name, owner)
        )
      })
    ).document.projectId;
  const encryptedId = await create(OWNER, 'Secret bracket');
  const plaintextId = await create(OWNER, 'Plain bracket');
  const secondId = await create(OWNER, 'Second bracket');
  const plainUsersId = await create(PLAIN, 'Somebody else');
  db.prepare(
    `INSERT INTO project_members
       (project_id, user_id, role, added_by_user_id, created_at, updated_at)
     VALUES (?, ?, 'editor', ?, 1, 1)`
  ).run(encryptedId, MEMBER, OWNER);
  db.prepare(
    "UPDATE projects SET storage_format = 2, document_json = 'e2ee-v1:x' WHERE id = ?"
  ).run(encryptedId);
  const env = {
    ENVIRONMENT: 'development',
    AUTH_MODE: 'development',
    DB: sqliteD1(db),
    PROJECT_SHARING_ENABLED: 'true',
    PROJECT_PERSONAL_SYNC_ENABLED: 'true',
    ...extraEnv
  };
  const call = (
    method: string,
    path: string,
    options: { body?: unknown; user?: string } = {}
  ) => {
    const headers = new Headers();
    if (options.user) headers.set('x-openzcad-development-user', options.user);
    if (options.body !== undefined)
      headers.set('content-type', 'application/json');
    return worker.fetch(
      new Request(`https://example.com${path}`, {
        method,
        headers,
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) })
      }),
      env as never
    );
  };
  const row = (projectId: string) =>
    db
      .prepare(
        'SELECT status, pinned, sort_order, archived_at, deleted_at FROM projects WHERE id = ?'
      )
      .get(projectId) as {
      status: string;
      pinned: number;
      sort_order: number;
      archived_at: string | null;
      deleted_at: string | null;
    };
  return {
    db,
    call,
    row,
    encryptedId,
    plaintextId,
    secondId,
    plainUsersId
  };
}

async function codeOf(response: Response): Promise<string | undefined> {
  return ((await response.clone().json()) as { code?: string }).code;
}

describe('sealed shelf state (ADR-024 amendment 2026-11-14)', () => {
  it('refuses readable pins, order and archive for an account holding encrypted projects', async () => {
    const { call, row, encryptedId, plaintextId } = await seed(projectsOn);
    for (const projectId of [encryptedId, plaintextId]) {
      for (const body of [
        { pinned: true },
        { sortOrder: 3 },
        { status: 'archived' },
        { status: 'active', pinned: true, sortOrder: 0 }
      ]) {
        const response = await call('PATCH', `/api/projects/${projectId}`, {
          body
        });
        expect(response.status, JSON.stringify(body)).toBe(409);
        expect(await codeOf(response)).toBe(PROJECT_SHELF_STATE_SEALED_CODE);
      }
      expect(row(projectId)).toMatchObject({
        status: 'active',
        pinned: 0,
        sort_order: 0,
        archived_at: null
      });
    }
    const reorder = await call('POST', '/api/projects/reorder', {
      body: { projectIds: [plaintextId, encryptedId] }
    });
    expect(reorder.status).toBe(409);
    expect(await codeOf(reorder)).toBe(PROJECT_SHELF_STATE_SEALED_CODE);
    expect(row(encryptedId).sort_order).toBe(0);
  });

  it('keeps trash, restore and the defaults readable', async () => {
    const { call, row, plaintextId } = await seed(projectsOn);
    const trash = await call('PATCH', `/api/projects/${plaintextId}`, {
      body: { status: 'deleted' }
    });
    expect(trash.status).toBe(200);
    expect(row(plaintextId).status).toBe('deleted');
    expect(row(plaintextId).deleted_at).not.toBeNull();
    const restore = await call('PATCH', `/api/projects/${plaintextId}`, {
      body: { status: 'active', pinned: false, sortOrder: 0 }
    });
    expect(restore.status).toBe(200);
    expect(row(plaintextId)).toMatchObject({
      status: 'active',
      deleted_at: null
    });
    // A one-project reorder writes position 0, the default.
    expect(
      (
        await call('POST', '/api/projects/reorder', {
          body: { projectIds: [plaintextId] }
        })
      ).status
    ).toBe(200);
  });

  it('lets the migration reset readable rows to the defaults', async () => {
    const { call, db, row, plaintextId } = await seed(projectsOn);
    // Stored readable before the account's library was encrypted.
    db.prepare(
      `UPDATE projects SET status = 'archived', pinned = 1, sort_order = 4,
         archived_at = '2026-11-01T00:00:00.000Z' WHERE id = ?`
    ).run(plaintextId);
    const reset = await call('PATCH', `/api/projects/${plaintextId}`, {
      body: { status: 'active', pinned: false, sortOrder: 0 }
    });
    expect(reset.status).toBe(200);
    expect(row(plaintextId)).toEqual({
      status: 'active',
      pinned: 0,
      sort_order: 0,
      archived_at: null,
      deleted_at: null
    });
  });

  it('resets a sealed row as it stands, never touching the trash', async () => {
    const { call, db, row, plaintextId, secondId, encryptedId } =
      await seed(projectsOn);
    // Both rows held readable shelf state from before the library was
    // encrypted; a listing saw both archived and pinned.
    db.prepare(
      `UPDATE projects SET status = 'archived', pinned = 1, sort_order = 4,
         archived_at = '2026-11-01T00:00:00.000Z' WHERE id IN (?, ?)`
    ).run(plaintextId, secondId);
    // Before this device's migration resets them, another device trashes
    // one of them.
    const trash = await call('PATCH', `/api/projects/${plaintextId}`, {
      body: { status: 'deleted' }
    });
    expect(trash.status).toBe(200);
    const trashed = row(plaintextId);
    expect(trashed.status).toBe('deleted');
    expect(trashed.deleted_at).not.toBeNull();

    const reset = await call(
      'POST',
      `/api/projects/${plaintextId}/shelf/reset`
    );
    expect(reset.status).toBe(200);
    // Still in the trash, from the same time; only pin and order cleared.
    expect(row(plaintextId)).toMatchObject({
      status: 'deleted',
      deleted_at: trashed.deleted_at,
      pinned: 0,
      sort_order: 0
    });
    expect(
      ((await reset.json()) as { project: { organization?: unknown } }).project
        .organization
    ).toMatchObject({ status: 'deleted', pinned: false, sortOrder: 0 });

    // A row still archived leaves the archive.
    expect(
      (await call('POST', `/api/projects/${secondId}/shelf/reset`)).status
    ).toBe(200);
    expect(row(secondId)).toEqual({
      status: 'active',
      pinned: 0,
      sort_order: 0,
      archived_at: null,
      deleted_at: null
    });

    // Only the owner's row: a member's reset changes nothing.
    db.prepare('UPDATE projects SET pinned = 1 WHERE id = ?').run(encryptedId);
    const memberReset = await call(
      'POST',
      `/api/projects/${encryptedId}/shelf/reset`,
      { user: MEMBER }
    );
    expect(memberReset.status, await memberReset.clone().text()).toBe(404);
    expect(row(encryptedId).pinned).toBe(1);
    // The owner resets it, encrypted or not: the route reads no document.
    expect(
      (await call('POST', `/api/projects/${encryptedId}/shelf/reset`)).status
    ).toBe(200);
    expect(row(encryptedId).pinned).toBe(0);
  });

  it('applies to a member of an encrypted project', async () => {
    const { call, encryptedId } = await seed(projectsOn);
    const response = await call('PATCH', `/api/projects/${encryptedId}`, {
      user: MEMBER,
      body: { pinned: true }
    });
    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe(PROJECT_SHELF_STATE_SEALED_CODE);
  });

  it("starts a sealed account's copy at the default order", async () => {
    const { call, db, row, plaintextId } = await seed(projectsOn);
    db.prepare('UPDATE projects SET sort_order = 6 WHERE id = ?').run(
      plaintextId
    );
    const response = await call(
      'POST',
      `/api/projects/${plaintextId}/duplicate`,
      { body: {} }
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const copy = (await response.json()) as {
      project: { projectId: string };
    };
    expect(row(copy.project.projectId).sort_order).toBe(0);
  });

  it('changes nothing for a plaintext library or with the flags off', async () => {
    const plain = await seed(projectsOn);
    const pin = await plain.call(
      'PATCH',
      `/api/projects/${plain.plainUsersId}`,
      { user: PLAIN, body: { pinned: true, sortOrder: 2, status: 'archived' } }
    );
    expect(pin.status).toBe(200);
    expect(plain.row(plain.plainUsersId)).toMatchObject({
      status: 'archived',
      pinned: 1,
      sort_order: 2
    });

    const off = await seed();
    expect(
      (
        await off.call('PATCH', `/api/projects/${off.encryptedId}`, {
          body: { pinned: true, sortOrder: 5 }
        })
      ).status
    ).toBe(200);
    expect(
      (
        await off.call('POST', '/api/projects/reorder', {
          body: { projectIds: [off.plaintextId, off.secondId] }
        })
      ).status
    ).toBe(200);
    expect(off.row(off.secondId).sort_order).toBe(1);
    off.db
      .prepare('UPDATE projects SET sort_order = 6 WHERE id = ?')
      .run(off.plaintextId);
    const copy = await off.call(
      'POST',
      `/api/projects/${off.plaintextId}/duplicate`,
      { body: {} }
    );
    expect(copy.status).toBe(201);
    const listed = (await (
      await off.call('GET', '/api/projects')
    ).json()) as ListProjectsResponse;
    const copyId = ((await copy.json()) as { project: { projectId: string } })
      .project.projectId;
    expect(
      listed.projects.find((project) => project.projectId === copyId)
        ?.organization?.sortOrder
    ).toBe(6);
  });
});

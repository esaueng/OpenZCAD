/**
 * ADR-024 Phase 8, slice 8-1: end-to-end encryption by default, Worker side,
 * over the real Worker and SQLite. Behind E2EE_DEFAULT_ON, which applies only
 * where migration is open to the account (keys, encrypted projects and
 * migration all on): `/api/e2ee/config` reports `defaultOn`; no plaintext
 * project is created, adopted or duplicated whatever the account's
 * preference; "Encrypt new projects" cannot be turned off; the reverse path
 * is closed and the sweep abandons decrypt stagings; and plaintext share
 * links and invitations are refused. With the flag off nothing changes.
 */
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import worker from '../apps/web/worker/index';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import {
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  encodeProjectPreferences,
  macProjectPreferences,
  toBase64Url
} from '@openzcad/crypto';
import {
  E2EE_DEFAULT_ON_CODE,
  ENCRYPTED_PROJECT_SHARING_UNAVAILABLE_CODE,
  ENCRYPTED_PROJECTS_REQUIRED_CODE,
  toUserId
} from '@openzcad/shared';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

/** The Worker's development identity, and another account. */
const OWNER = toUserId('user_beta_dev');
const OTHER = toUserId('user_other');

/** Every flag default-on depends on, without default-on itself. */
const MIGRATION_OPEN = {
  E2EE_KEYS_ENABLED: 'true',
  E2EE_PROJECTS_ENABLED: 'true',
  E2EE_MIGRATION_ENABLED: 'true'
};
const DEFAULT_ON = { ...MIGRATION_OPEN, E2EE_DEFAULT_ON: 'true' };

interface Seeded {
  db: DatabaseSync;
  /** An encrypted project (format 2) of the owner's. */
  encryptedId: string;
  /** A plaintext project (format 1) of the owner's. */
  plaintextId: string;
  /** A plaintext project of another account's. */
  othersId: string;
  env: Record<string, unknown>;
  send: ReturnType<typeof vi.fn>;
  call(method: string, path: string, body?: unknown): Promise<Response>;
}

async function seed(extraEnv: Record<string, unknown> = {}): Promise<Seeded> {
  const db = migratedDatabase();
  for (const user of [OWNER, OTHER]) {
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
    ).run(user, `${user}@example.test`, '2026-10-26T00:00:00.000Z');
  }
  const service = new D1R2PersistenceService({ DB: sqliteD1(db) });
  const create = async (userId: typeof OWNER, name: string) =>
    (
      await service.createProject(userId, {
        name,
        initialDocument: withoutDerivedProjection(
          createProjectDocument(name, userId)
        )
      })
    ).document.projectId;
  const encryptedId = await create(OWNER, 'Secret bracket');
  const plaintextId = await create(OWNER, 'Plain bracket');
  const othersId = await create(OTHER, 'Their bracket');
  db.prepare(
    "UPDATE projects SET storage_format = 2, document_json = 'e2ee-v1:x' WHERE id = ?"
  ).run(encryptedId);
  const bucket = {
    put: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
    head: vi.fn(async () => null),
    delete: vi.fn(async () => undefined)
  };
  const send = vi.fn(async () => undefined);
  const env: Record<string, unknown> = {
    ENVIRONMENT: 'development',
    AUTH_MODE: 'development',
    DB: sqliteD1(db),
    PROJECT_STORAGE: bucket,
    ARTIFACTS: bucket,
    PROJECT_SHARING_ENABLED: 'true',
    PROJECT_PERSONAL_SYNC_ENABLED: 'true',
    PROJECT_INVITATION_EMAIL_FROM: 'invites@example.test',
    PUBLIC_APP_ORIGIN: 'https://example.com',
    EMAIL: { send },
    ...extraEnv
  };
  const call: Seeded['call'] = (method, path, body) =>
    worker.fetch(
      new Request(`https://example.com${path}`, {
        method,
        headers:
          body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }),
      env
    );
  return { db, encryptedId, plaintextId, othersId, env, send, call };
}

async function codeOf(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { code?: string }).code;
}

const ACCOUNT_KEY = new Uint8Array(32).fill(7);

async function preferenceRecord(sequence: number, encryptNewProjects: boolean) {
  const bytes = encodeProjectPreferences({
    userId: OWNER,
    encryptNewProjects,
    sequence
  });
  return {
    record: toBase64Url(bytes),
    recordMac: toBase64Url(await macProjectPreferences(ACCOUNT_KEY, bytes))
  };
}

/** A stored preference, as the D2 tests seed it. */
function storePreference(db: DatabaseSync, encryptNewProjects: boolean) {
  db.prepare(
    `INSERT INTO e2ee_project_preferences
       (user_id, encrypt_new_projects, record, record_mac, sequence, updated_at)
     VALUES (?, ?, 'cmVjb3Jk', ?, 1, '2026-10-26T00:00:00.000Z')`
  ).run(OWNER, encryptNewProjects ? 1 : 0, 'A'.repeat(43));
}

const createBody = () => ({
  name: 'New part',
  initialDocument: withoutDerivedProjection(
    createProjectDocument('New part', OWNER)
  )
});

/** A version 1 adoption of a device project (still accepted for a release). */
const adoptBody = () => ({
  name: 'Adopted',
  adoptionProtocolVersion: 1,
  document: createProjectDocument('Adopted', toUserId('user_local'))
});

/** A version 2 adoption, refused before its document is read. */
const adoptV2Body = () => ({
  name: 'Adopted',
  adoptionProtocolVersion: 2,
  localProjectId: 'proj_local',
  document: createProjectDocument('Adopted', OWNER)
});

function ownedCount(db: DatabaseSync): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM projects WHERE user_id = ?')
      .get(OWNER) as { n: number }
  ).n;
}

function count(db: DatabaseSync, table: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  ).n;
}

describe('/api/e2ee/config defaultOn', () => {
  it('is reported only when E2EE_DEFAULT_ON and every dependency hold', async () => {
    const config = async (env: Record<string, unknown>) =>
      (await seed(env))
        .call('GET', '/api/e2ee/config')
        .then((r) => r.json() as Promise<unknown>);
    expect(await config(DEFAULT_ON)).toEqual({
      enabled: true,
      projectsEnabled: true,
      migrationEnabled: true,
      defaultOn: true
    });
    // The flag off: exactly as before.
    expect(await config(MIGRATION_OPEN)).toEqual({
      enabled: true,
      projectsEnabled: true,
      migrationEnabled: true
    });
    // Each dependency missing withholds it.
    expect(
      await config({ ...DEFAULT_ON, E2EE_MIGRATION_ENABLED: 'false' })
    ).toEqual({ enabled: true, projectsEnabled: true });
    expect(
      await config({ ...DEFAULT_ON, E2EE_PROJECTS_ENABLED: 'false' })
    ).toEqual({ enabled: true, projectsEnabled: false });
    expect(await config({ ...DEFAULT_ON, E2EE_KEYS_ENABLED: 'false' })).toEqual(
      { enabled: false, projectsEnabled: false }
    );
    expect(await config({ E2EE_DEFAULT_ON: 'true' })).toEqual({
      enabled: false,
      projectsEnabled: false
    });
    // The reverse path reads as closed under default-on.
    expect(
      await config({ ...MIGRATION_OPEN, E2EE_REVERSE_ENABLED: 'true' })
    ).toMatchObject({ reverseEnabled: true });
    expect(
      await config({ ...DEFAULT_ON, E2EE_REVERSE_ENABLED: 'true' })
    ).toEqual({
      enabled: true,
      projectsEnabled: true,
      migrationEnabled: true,
      defaultOn: true
    });
  });

  it('is withheld while migration 0042 is missing', async () => {
    const srv = await seed(DEFAULT_ON);
    srv.db.exec('DROP TABLE e2ee_project_migrations');
    expect(await (await srv.call('GET', '/api/e2ee/config')).json()).toEqual({
      enabled: true,
      projectsEnabled: true
    });
  });
});

describe('plaintext creation under default-on', () => {
  it('refuses plaintext create, adopt and duplicate whatever the preference', async () => {
    for (const preference of [null, false, true] as const) {
      const srv = await seed(DEFAULT_ON);
      if (preference !== null) storePreference(srv.db, preference);
      const before = ownedCount(srv.db);
      for (const [path, body] of [
        ['/api/projects', createBody()],
        ['/api/projects', adoptBody()],
        ['/api/projects', adoptV2Body()],
        [`/api/projects/${srv.plaintextId}/duplicate`, {}]
      ] as const) {
        const response = await srv.call('POST', path, body);
        expect(response.status, `${path} ${preference}`).toBe(409);
        expect(await codeOf(response)).toBe(ENCRYPTED_PROJECTS_REQUIRED_CODE);
      }
      expect(ownedCount(srv.db)).toBe(before);
      expect(count(srv.db, 'project_adoptions')).toBe(0);
    }
  });

  it('creates, adopts and duplicates plaintext as before with the flag off', async () => {
    for (const env of [{}, MIGRATION_OPEN]) {
      const srv = await seed(env);
      storePreference(srv.db, false);
      for (const [path, body] of [
        ['/api/projects', createBody()],
        ['/api/projects', adoptBody()],
        [`/api/projects/${srv.plaintextId}/duplicate`, {}]
      ] as const) {
        expect(
          (await srv.call('POST', path, body)).status,
          `${path} ${JSON.stringify(env)}`
        ).toBe(201);
      }
    }
    // An opted-in account still meets D2 with the flag off.
    const optedIn = await seed(MIGRATION_OPEN);
    storePreference(optedIn.db, true);
    const response = await optedIn.call('POST', '/api/projects', createBody());
    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe(ENCRYPTED_PROJECTS_REQUIRED_CODE);
  });

  it('needs migration open: the flag alone changes nothing', async () => {
    const srv = await seed({
      E2EE_KEYS_ENABLED: 'true',
      E2EE_PROJECTS_ENABLED: 'true',
      E2EE_DEFAULT_ON: 'true'
    });
    expect((await srv.call('POST', '/api/projects', createBody())).status).toBe(
      201
    );
  });
});

describe('"Encrypt new projects" under default-on', () => {
  it('refuses turning it off and still stores turning it on', async () => {
    const srv = await seed(DEFAULT_ON);
    const off = await srv.call(
      'PUT',
      '/api/e2ee/project-preferences',
      await preferenceRecord(1, false)
    );
    expect(off.status).toBe(409);
    expect(await codeOf(off)).toBe(E2EE_DEFAULT_ON_CODE);
    expect(count(srv.db, 'e2ee_project_preferences')).toBe(0);
    const on = await srv.call(
      'PUT',
      '/api/e2ee/project-preferences',
      await preferenceRecord(1, true)
    );
    expect(on.status).toBe(200);
    expect(
      ((await on.json()) as { preference: unknown }).preference
    ).toMatchObject({ encryptNewProjects: true, sequence: 1 });
    // A later "off" is refused too, and the stored record stays.
    const laterOff = await srv.call(
      'PUT',
      '/api/e2ee/project-preferences',
      await preferenceRecord(2, false)
    );
    expect(laterOff.status).toBe(409);
    expect(await codeOf(laterOff)).toBe(E2EE_DEFAULT_ON_CODE);
    expect(
      await (await srv.call('GET', '/api/e2ee/project-preferences')).json()
    ).toMatchObject({ preference: { sequence: 1, encryptNewProjects: true } });
  });

  it('stores turning it off as before with the flag off', async () => {
    const srv = await seed(MIGRATION_OPEN);
    const off = await srv.call(
      'PUT',
      '/api/e2ee/project-preferences',
      await preferenceRecord(1, false)
    );
    expect(off.status).toBe(200);
  });
});

describe('the reverse path under default-on', () => {
  const REVERSE = { E2EE_REVERSE_ENABLED: 'true' };

  it('refuses a decrypt start as if E2EE_REVERSE_ENABLED were off', async () => {
    const srv = await seed({ ...DEFAULT_ON, ...REVERSE });
    const response = await srv.call(
      'POST',
      `/api/e2ee/projects/${srv.encryptedId}/migration`,
      { direction: 'decrypt', deviceId: 'owner_laptop' }
    );
    expect(response.status).toBe(501);
    expect(await codeOf(response)).toBe('FEATURE_DISABLED');
    expect(count(srv.db, 'e2ee_project_migrations')).toBe(0);
    // With the flag off the reverse route answers (here: no such device).
    const open = await seed({ ...MIGRATION_OPEN, ...REVERSE });
    const answered = await open.call(
      'POST',
      `/api/e2ee/projects/${open.encryptedId}/migration`,
      { direction: 'decrypt', deviceId: 'owner_laptop' }
    );
    expect(answered.status).not.toBe(501);
  });

  function stage(
    db: DatabaseSync,
    projectId: string,
    direction: 'encrypt' | 'decrypt',
    leaseExpiresAt: number
  ) {
    db.prepare(
      `INSERT INTO e2ee_project_migrations
         (project_id, direction, state, owner_user_id, device_id, lease_id,
          lease_expires_at, source_version, started_at, updated_at)
       VALUES (?, ?, 'staging', ?, 'owner_laptop', ?, ?, 0, 'now', 'now')`
    ).run(projectId, direction, OWNER, 'L'.repeat(43), leaseExpiresAt);
  }

  function stateOf(db: DatabaseSync, projectId: string) {
    return db
      .prepare(
        'SELECT state, lease_id, purge_cursor FROM e2ee_project_migrations WHERE project_id = ?'
      )
      .get(projectId);
  }

  it('abandons a leased decrypt staging on the sweep, and leaves an encrypt staging', async () => {
    const srv = await seed({ ...DEFAULT_ON, ...REVERSE });
    const live = Date.now() + 10 * 60_000;
    stage(srv.db, srv.encryptedId, 'decrypt', live);
    stage(srv.db, srv.plaintextId, 'encrypt', live);
    await worker.scheduled({}, srv.env);
    expect(stateOf(srv.db, srv.encryptedId)).toEqual({
      state: 'abandoned',
      lease_id: null,
      purge_cursor: null
    });
    expect(stateOf(srv.db, srv.plaintextId)).toMatchObject({
      state: 'staging'
    });
  });

  it('leaves a leased decrypt staging alone with the flag off', async () => {
    const srv = await seed({ ...MIGRATION_OPEN, ...REVERSE });
    stage(srv.db, srv.encryptedId, 'decrypt', Date.now() + 10 * 60_000);
    await worker.scheduled({}, srv.env);
    expect(stateOf(srv.db, srv.encryptedId)).toMatchObject({
      state: 'staging'
    });
  });
});

describe('plaintext sharing under default-on', () => {
  const routes = (projectId: string) =>
    [
      [
        `/api/projects/${projectId}/invitations`,
        { email: 'invitee@example.test', role: 'viewer' }
      ],
      [`/api/projects/${projectId}/share-links`, { mode: 'view' }]
    ] as const;

  it('refuses plaintext share links and invitations on plaintext projects', async () => {
    const srv = await seed(DEFAULT_ON);
    for (const [path, body] of routes(srv.plaintextId)) {
      const response = await srv.call('POST', path, body);
      expect(response.status, path).toBe(409);
      expect(await codeOf(response)).toBe(E2EE_DEFAULT_ON_CODE);
    }
    expect(count(srv.db, 'project_invitations')).toBe(0);
    expect(count(srv.db, 'project_share_links')).toBe(0);
    expect(srv.send).not.toHaveBeenCalled();
    // An encrypted project meets its own refusal, as before.
    for (const [path, body] of routes(srv.encryptedId)) {
      const response = await srv.call('POST', path, body);
      expect(response.status, path).toBe(409);
      expect(await codeOf(response)).toBe(
        ENCRYPTED_PROJECT_SHARING_UNAVAILABLE_CODE
      );
    }
    // Another account's project answers as missing, revealing nothing.
    for (const [path, body] of routes(srv.othersId)) {
      const response = await srv.call('POST', path, body);
      expect(response.status, path).toBe(404);
    }
  });

  it('creates plaintext share links and invitations as before with the flag off', async () => {
    const srv = await seed(MIGRATION_OPEN);
    for (const [path, body] of routes(srv.plaintextId)) {
      expect((await srv.call('POST', path, body)).status, path).toBe(201);
    }
    expect(count(srv.db, 'project_invitations')).toBe(1);
    expect(count(srv.db, 'project_share_links')).toBe(1);
    expect(srv.send).toHaveBeenCalledTimes(1);
  });
});

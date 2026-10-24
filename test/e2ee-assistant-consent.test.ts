import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../apps/web/worker/index';
import { D1R2PersistenceService } from '@openzcad/cloudflare-adapters';
import {
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  encodeAssistantConsent,
  macAssistantConsent,
  toBase64Url
} from '@openzcad/crypto';
import {
  ASSISTANT_CONSENT_COPY_VERSION,
  DEFAULT_APP_SETTINGS,
  ENCRYPTED_PROJECT_ASSISTANT_CONSENT_REQUIRED_CODE,
  ENCRYPTED_PROJECT_ASSISTANT_UNAVAILABLE_CODE,
  assistantConsentRoute,
  toUserId
} from '@openzcad/shared';
import { migratedDatabase, sqliteD1 } from './support/sqlite-d1';

/** The Worker's development identity, a member, and a stranger. */
const OWNER = toUserId('user_beta_dev');
const MEMBER = toUserId('user_member');
const STRANGER = toUserId('user_stranger');
const ACCOUNT_KEY = new Uint8Array(32).fill(9);
const FLAGS_ON = {
  E2EE_KEYS_ENABLED: 'true',
  E2EE_PROJECTS_ENABLED: 'true'
};
/** What the provider would see: the stub records every upstream call. */
const PROVIDER_REPLY =
  'data: {"type":"response.output_text.done","text":"{}"}\n\n' +
  'data: {"type":"response.completed"}\n\n';

async function seed(
  extraEnv: Record<string, unknown> = {},
  { dropConsents = false } = {}
) {
  const db = migratedDatabase();
  if (dropConsents) db.exec('DROP TABLE e2ee_assistant_consents');
  for (const user of [OWNER, MEMBER, STRANGER]) {
    db.prepare(
      'INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)'
    ).run(user, `${user}@example.test`, '2026-10-24T00:00:00.000Z');
    // The assistant switched on with the deployment's key.
    const settings = structuredClone(DEFAULT_APP_SETTINGS);
    settings.assistant.enabled = true;
    db.prepare(
      'INSERT INTO user_settings (user_id, settings_json, revision, updated_at) VALUES (?, ?, 1, ?)'
    ).run(user, JSON.stringify(settings), '2026-10-24T00:00:00.000Z');
  }
  const service = new D1R2PersistenceService({
    DB: sqliteD1(db),
    PROJECT_SHARING_ENABLED: 'true'
  });
  const create = async (name: string) =>
    (
      await service.createProject(OWNER, {
        name,
        initialDocument: withoutDerivedProjection(
          createProjectDocument(name, OWNER)
        )
      })
    ).document;
  const encrypted = await create('Secret bracket');
  const plaintext = await create('Plain bracket');
  db.prepare(
    `INSERT INTO project_members
       (project_id, user_id, role, added_by_user_id, created_at, updated_at)
     VALUES (?, ?, 'editor', ?, 1, 1)`
  ).run(encrypted.projectId, MEMBER, OWNER);
  db.prepare(
    'UPDATE projects SET storage_format = 2, document_json = ? WHERE id = ?'
  ).run('e2ee-v1:not-a-document', encrypted.projectId);
  const bucket = {
    put: vi.fn(async () => undefined),
    get: vi.fn(async () => null),
    head: vi.fn(async () => null),
    delete: vi.fn(async () => undefined)
  };
  const env = {
    ENVIRONMENT: 'development',
    AUTH_MODE: 'development',
    DB: sqliteD1(db),
    OPENROUTER_API_KEY: 'test-key',
    AI_PROVIDER: 'openrouter',
    AI_MODEL: 'openai/gpt-5.6-sol',
    PROJECT_SHARING_ENABLED: 'true',
    PROJECT_STORAGE: bucket,
    ARTIFACTS: bucket,
    PROJECT_ROOM: {
      getByName: vi.fn(() => ({
        fetch: async () => new Response('{"ok":true}', { status: 200 })
      }))
    },
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
  return {
    db,
    call,
    projectId: encrypted.projectId,
    plaintextId: plaintext.projectId,
    service
  };
}

function proposal(projectId: string) {
  return {
    prompt: 'Make it thicker',
    digest: {
      schemaVersion: 1,
      projectId,
      name: 'x',
      units: 'mm',
      version: 1,
      parameters: [],
      features: [],
      warnings: []
    }
  };
}

async function consentBody(
  projectId: string,
  sequence: number,
  {
    allowed = true,
    userId = String(OWNER),
    route = assistantConsentRoute({
      source: 'deployment',
      provider: 'openrouter',
      model: 'openai/gpt-5.6-sol'
    }),
    copyVersion = ASSISTANT_CONSENT_COPY_VERSION
  } = {}
) {
  const record = encodeAssistantConsent({
    userId,
    projectId,
    allowed,
    copyVersion,
    route: allowed ? route : '',
    sequence
  });
  return {
    record: toBase64Url(record),
    recordMac: toBase64Url(await macAssistantConsent(ACCOUNT_KEY, record))
  };
}

const codeOf = async (response: Response) =>
  ((await response.json()) as { code?: string }).code;

let provider: { mockRestore(): void } | undefined;
function stubProvider() {
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(PROVIDER_REPLY, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
  );
  provider = spy;
  return spy;
}

afterEach(() => {
  provider?.mockRestore();
});

describe('assistant consent on encrypted projects (ADR-024 6-1)', () => {
  it('refuses an encrypted project as before without the flag; plaintext is untouched', async () => {
    const { call, projectId, plaintextId } = await seed();
    const upstream = stubProvider();
    const refused = await call('POST', '/api/assistant/proposals', {
      body: proposal(projectId)
    });
    expect(refused.status).toBe(409);
    expect(await codeOf(refused)).toBe(
      ENCRYPTED_PROJECT_ASSISTANT_UNAVAILABLE_CODE
    );
    expect(upstream).not.toHaveBeenCalled();
    // The consent routes stay closed.
    expect(
      (await call('GET', `/api/e2ee/assistant-consents/${projectId}`)).status
    ).toBe(501);
    const plain = await call('POST', '/api/assistant/proposals', {
      body: proposal(plaintextId)
    });
    expect(plain.status).toBe(200);
    await plain.text();
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('keeps refusing as before while migration 0041 is missing', async () => {
    const { call, projectId, plaintextId } = await seed(FLAGS_ON, {
      dropConsents: true
    });
    const upstream = stubProvider();
    const refused = await call('POST', '/api/assistant/proposals', {
      body: proposal(projectId)
    });
    expect(refused.status).toBe(409);
    expect(await codeOf(refused)).toBe(
      ENCRYPTED_PROJECT_ASSISTANT_UNAVAILABLE_CODE
    );
    const route = await call(
      'PUT',
      `/api/e2ee/assistant-consents/${projectId}`,
      {
        body: await consentBody(projectId, 1)
      }
    );
    expect(route.status).toBe(503);
    expect(await codeOf(route)).toBe('E2EE_UNAVAILABLE');
    const plain = await call('POST', '/api/assistant/proposals', {
      body: proposal(plaintextId)
    });
    expect(plain.status).toBe(200);
    await plain.text();
    expect(upstream).toHaveBeenCalledTimes(1);
    // Erasure works without the table.
    expect(
      (
        await call('POST', '/api/account/delete-data', {
          body: { scope: 'profile', confirmation: 'DELETE CLOUD PROFILE' }
        })
      ).status
    ).toBe(200);
  });

  it('refuses without consent, sends with it, and refuses again after revocation', async () => {
    const { call, db, projectId } = await seed(FLAGS_ON);
    const upstream = stubProvider();
    const refused = await call('POST', '/api/assistant/proposals', {
      body: proposal(projectId)
    });
    expect(refused.status).toBe(409);
    expect(await codeOf(refused)).toBe(
      ENCRYPTED_PROJECT_ASSISTANT_CONSENT_REQUIRED_CODE
    );
    expect(upstream).not.toHaveBeenCalled();

    const stored = await call(
      'PUT',
      `/api/e2ee/assistant-consents/${projectId}`,
      { body: await consentBody(projectId, 1) }
    );
    expect(stored.status).toBe(200);
    expect(await stored.json()).toMatchObject({
      consent: { projectId, allowed: true, sequence: 1, revokedAt: null }
    });
    const sent = await call('POST', '/api/assistant/proposals', {
      body: proposal(projectId)
    });
    expect(sent.status).toBe(200);
    await sent.text();
    expect(upstream).toHaveBeenCalledTimes(1);

    // Stop: the next sequence with allowed = false marks the row revoked.
    const revoked = await call(
      'PUT',
      `/api/e2ee/assistant-consents/${projectId}`,
      { body: await consentBody(projectId, 2, { allowed: false }) }
    );
    expect(revoked.status).toBe(200);
    expect(
      db
        .prepare(
          'SELECT allowed, sequence, revoked_at IS NOT NULL AS revoked FROM e2ee_assistant_consents'
        )
        .get()
    ).toEqual({ allowed: 0, sequence: 2, revoked: 1 });
    const after = await call('POST', '/api/assistant/proposals', {
      body: proposal(projectId)
    });
    expect(after.status).toBe(409);
    expect(await codeOf(after)).toBe(
      ENCRYPTED_PROJECT_ASSISTANT_CONSENT_REQUIRED_CODE
    );
    expect(upstream).toHaveBeenCalledTimes(1);

    // A replayed allowing record cannot undo the revocation.
    const replay = await call(
      'PUT',
      `/api/e2ee/assistant-consents/${projectId}`,
      { body: await consentBody(projectId, 1) }
    );
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      code: 'E2EE_ASSISTANT_CONSENT_STALE',
      consent: { allowed: false, sequence: 2 }
    });
    expect(
      (
        await call('POST', '/api/assistant/proposals', {
          body: proposal(projectId)
        })
      ).status
    ).toBe(409);
  });

  it('honours only the caller’s own consent, for its project, route and copy', async () => {
    const { call, projectId, plaintextId } = await seed(FLAGS_ON);
    const upstream = stubProvider();
    expect(
      (
        await call('PUT', `/api/e2ee/assistant-consents/${projectId}`, {
          body: await consentBody(projectId, 1)
        })
      ).status
    ).toBe(200);
    // Another user (a member) has not allowed it.
    const member = await call('POST', '/api/assistant/proposals', {
      body: proposal(projectId),
      user: MEMBER
    });
    expect(member.status).toBe(409);
    expect(await codeOf(member)).toBe(
      ENCRYPTED_PROJECT_ASSISTANT_CONSENT_REQUIRED_CODE
    );
    // A record naming someone else, or another project, is not stored.
    expect(
      (
        await call('PUT', `/api/e2ee/assistant-consents/${projectId}`, {
          body: await consentBody(projectId, 1, { userId: MEMBER }),
          user: STRANGER
        })
      ).status
    ).toBe(400);
    expect(
      (
        await call('PUT', `/api/e2ee/assistant-consents/${projectId}`, {
          body: await consentBody(plaintextId, 2)
        })
      ).status
    ).toBe(400);
    // A stranger cannot consent for a project they cannot open, and a
    // plaintext project needs no consent at all.
    const stranger = await call(
      'PUT',
      `/api/e2ee/assistant-consents/${projectId}`,
      {
        body: await consentBody(projectId, 1, { userId: STRANGER }),
        user: STRANGER
      }
    );
    expect(stranger.status).toBe(404);
    expect(
      (
        await call('PUT', `/api/e2ee/assistant-consents/${plaintextId}`, {
          body: await consentBody(plaintextId, 1)
        })
      ).status
    ).toBe(404);
    // Consent for an older copy, or for another provider route, is not
    // live for this request.
    expect(
      (
        await call('PUT', `/api/e2ee/assistant-consents/${projectId}`, {
          body: await consentBody(projectId, 2, {
            route: assistantConsentRoute({
              source: 'personal',
              provider: 'openai',
              model: 'gpt-5'
            })
          })
        })
      ).status
    ).toBe(200);
    const otherRoute = await call('POST', '/api/assistant/proposals', {
      body: proposal(projectId)
    });
    expect(otherRoute.status).toBe(409);
    expect(await codeOf(otherRoute)).toBe(
      ENCRYPTED_PROJECT_ASSISTANT_CONSENT_REQUIRED_CODE
    );
    expect(upstream).not.toHaveBeenCalled();
  });

  it('lists the caller’s consents and shows co-members who allowed it (M6)', async () => {
    const { call, projectId } = await seed(FLAGS_ON);
    await call('PUT', `/api/e2ee/assistant-consents/${projectId}`, {
      body: await consentBody(projectId, 1)
    });
    await call('PUT', `/api/e2ee/assistant-consents/${projectId}`, {
      body: await consentBody(projectId, 1, {
        userId: MEMBER,
        allowed: false
      }),
      user: MEMBER
    });
    const mine = (await (
      await call('GET', '/api/e2ee/assistant-consents')
    ).json()) as { consents: { projectId: string; allowed: boolean }[] };
    expect(mine.consents).toEqual([
      expect.objectContaining({ projectId, allowed: true })
    ]);
    const members = (await (
      await call('GET', `/api/e2ee/assistant-consents/${projectId}/members`, {
        user: MEMBER
      })
    ).json()) as { consents: { userId: string; allowed: boolean }[] };
    expect(
      members.consents
        .map(({ userId, allowed }) => ({ userId, allowed }))
        .sort((a, b) => a.userId.localeCompare(b.userId))
    ).toEqual(
      [
        { userId: OWNER, allowed: true },
        { userId: MEMBER, allowed: false }
      ].sort((a, b) => a.userId.localeCompare(b.userId))
    );
    expect(
      (
        await call('GET', `/api/e2ee/assistant-consents/${projectId}/members`, {
          user: STRANGER
        })
      ).status
    ).toBe(404);
  });

  it('erases consents with the profile and with the project', async () => {
    const { call, db, projectId } = await seed(FLAGS_ON);
    await call('PUT', `/api/e2ee/assistant-consents/${projectId}`, {
      body: await consentBody(projectId, 1)
    });
    await call('PUT', `/api/e2ee/assistant-consents/${projectId}`, {
      body: await consentBody(projectId, 1, { userId: MEMBER }),
      user: MEMBER
    });
    const count = () =>
      (
        db
          .prepare('SELECT COUNT(*) AS n FROM e2ee_assistant_consents')
          .get() as { n: number }
      ).n;
    expect(count()).toBe(2);
    // The member's profile erasure removes only the member's consent.
    expect(
      (
        await call('POST', '/api/account/delete-data', {
          body: { scope: 'profile', confirmation: 'DELETE CLOUD PROFILE' },
          user: MEMBER
        })
      ).status
    ).toBe(200);
    expect(count()).toBe(1);
    // An account being erased cannot write one, whoever writes.
    db.prepare(
      'INSERT INTO account_erasure_requests (user_id, scope, started_at, updated_at) VALUES (?, ?, 1, 1)'
    ).run(STRANGER, 'profile');
    expect(() =>
      db
        .prepare(
          `INSERT INTO e2ee_assistant_consents
             (user_id, project_id, allowed, copy_version, route, record,
              record_mac, sequence, updated_at)
           VALUES (?, ?, 1, 1, 'r', 'x', ?, 1, 'now')`
        )
        .run(STRANGER, projectId, 'A'.repeat(43))
    ).toThrow(/ACCOUNT_ERASURE_IN_PROGRESS/);
    // Deleting the owner's projects purges the project's consents.
    expect(
      (
        await call('POST', '/api/account/delete-data', {
          body: { scope: 'projects', confirmation: 'DELETE CLOUD PROJECTS' }
        })
      ).status
    ).toBe(200);
    expect(count()).toBe(0);
  });
});

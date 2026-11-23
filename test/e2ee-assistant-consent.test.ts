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
  CONSENTED_ASSISTANT_PROPOSAL_PATH,
  assistantConsentVersion,
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
const QWEN_ENV = {
  AI_QWEN_FREE_ACCOUNT_ID: 'a'.repeat(32),
  AI_QWEN_FREE_API_TOKEN: 'test-qwen-secret'
};
const QWEN_ACCOUNT_URL = `https://api.cloudflare.com/client/v4/accounts/${QWEN_ENV.AI_QWEN_FREE_ACCOUNT_ID}`;
const QWEN_MODEL = '@cf/qwen/qwen3.8-27b';
const QWEN_URL = `${QWEN_ACCOUNT_URL}/ai/run/${QWEN_MODEL}`;
const QWEN_ROUTE = assistantConsentRoute({
  source: 'deployment',
  provider: 'workers-ai',
  model: QWEN_MODEL,
  endpoint: QWEN_URL
});
const qwenProposal = (projectId: string, sequence: number) => ({
  ...proposal(projectId),
  expectedConsent: assistantConsentVersion({
    route: QWEN_ROUTE,
    sequence,
    copyVersion: ASSISTANT_CONSENT_COPY_VERSION
  })
});

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
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ objects: [], truncated: false }))
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
    env,
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

function consentedProposal(
  projectId: string,
  sequence: number,
  endpoint?: string
) {
  const route = assistantConsentRoute({
    source: 'deployment',
    provider: 'openrouter',
    model: 'openai/gpt-5.6-sol',
    endpoint: endpoint ?? 'https://openrouter.ai/api/v1/responses'
  });
  return {
    ...proposal(projectId),
    expectedConsent: assistantConsentVersion({
      route,
      sequence,
      copyVersion: ASSISTANT_CONSENT_COPY_VERSION
    })
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
      model: 'openai/gpt-5.6-sol',
      endpoint: 'https://openrouter.ai/api/v1/responses'
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
  it('requires consent for the Qwen endpoint and keeps plaintext on OpenRouter', async () => {
    const { call, projectId, plaintextId } = await seed({
      ...FLAGS_ON,
      ...QWEN_ENV
    });
    const upstream = stubProvider().mockImplementation(async (url) => {
      if (url === `${QWEN_ACCOUNT_URL}/subscriptions`) {
        return Response.json({ success: true, result: [] });
      }
      if (url === QWEN_URL) {
        return Response.json({
          success: true,
          result: {
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    replyKind: 'message',
                    proposal: null,
                    questions: null,
                    message: 'Test Qwen reply.',
                    readings: null
                  })
                }
              }
            ]
          }
        });
      }
      return new Response(PROVIDER_REPLY);
    });

    const status = await call('GET', '/api/assistant/status');
    expect(status.status).toBe(200);
    const statusText = await status.text();
    expect(statusText).not.toContain(QWEN_ENV.AI_QWEN_FREE_API_TOKEN);
    expect(JSON.parse(statusText)).toMatchObject({
      provider: 'openrouter',
      encryptedProject: {
        configured: true,
        provider: 'workers-ai',
        model: QWEN_MODEL,
        endpoint: QWEN_URL
      }
    });

    const consentPath = `/api/e2ee/assistant-consents/${projectId}`;
    expect(
      (
        await call('PUT', consentPath, {
          body: await consentBody(projectId, 1)
        })
      ).status
    ).toBe(200);
    const stale = await call('POST', CONSENTED_ASSISTANT_PROPOSAL_PATH, {
      body: consentedProposal(projectId, 1)
    });
    expect(stale.status).toBe(409);
    expect(await codeOf(stale)).toBe(
      ENCRYPTED_PROJECT_ASSISTANT_CONSENT_REQUIRED_CODE
    );
    expect(upstream).not.toHaveBeenCalled();

    expect(
      (
        await call('PUT', consentPath, {
          body: await consentBody(projectId, 2, { route: QWEN_ROUTE })
        })
      ).status
    ).toBe(200);
    const encrypted = await call('POST', CONSENTED_ASSISTANT_PROPOSAL_PATH, {
      body: {
        ...qwenProposal(projectId, 2),
        customInstructions: 'Use millimeters.'
      }
    });
    expect(encrypted.status).toBe(200);
    expect(await encrypted.text()).toContain('Test Qwen reply.');
    expect(upstream.mock.calls.map(([url]) => url)).toEqual([
      `${QWEN_ACCOUNT_URL}/subscriptions`,
      QWEN_URL
    ]);
    expect(upstream.mock.calls[0]?.[1]?.body).toBeUndefined();
    const request = JSON.parse(upstream.mock.calls[1]?.[1]?.body as string) as {
      messages: Array<{ content: unknown }>;
    };
    expect(request).toMatchObject({
      store: false,
      stream: false,
      max_completion_tokens: 4096,
      response_format: { type: 'json_schema', json_schema: { strict: true } }
    });
    expect(request.messages[0]?.content).toContain('Use millimeters.');

    const plain = await call('POST', '/api/assistant/proposals', {
      body: proposal(plaintextId)
    });
    expect(plain.status).toBe(200);
    await plain.text();
    expect(upstream.mock.calls.at(-1)?.[0]).toBe(
      'https://openrouter.ai/api/v1/responses'
    );
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['subscription present', { success: true, result: [{ price: 0 }] }, 200],
    ['malformed billing response', { success: true, result: null }, 200],
    ['billing permission denied', {}, 403]
  ])(
    'sends no encrypted content when Qwen cannot verify zero-overage billing (%s)',
    async (_label, payload, status) => {
      const { call, projectId } = await seed({ ...FLAGS_ON, ...QWEN_ENV });
      expect(
        (
          await call('PUT', `/api/e2ee/assistant-consents/${projectId}`, {
            body: await consentBody(projectId, 1, { route: QWEN_ROUTE })
          })
        ).status
      ).toBe(200);
      const upstream = stubProvider().mockImplementation(async () =>
        Response.json(payload, { status })
      );
      const reply = await call('POST', CONSENTED_ASSISTANT_PROPOSAL_PATH, {
        body: qwenProposal(projectId, 1)
      });
      expect(reply.status).toBe(503);
      expect(await codeOf(reply)).toBe('AI_QWEN_BILLING_UNVERIFIED');
      expect(upstream.mock.calls.map(([url]) => url)).toEqual([
        `${QWEN_ACCOUNT_URL}/subscriptions`
      ]);
    }
  );

  it('stops at the free allowance without a paid fallback', async () => {
    const { call, projectId } = await seed({ ...FLAGS_ON, ...QWEN_ENV });
    expect(
      (
        await call('PUT', `/api/e2ee/assistant-consents/${projectId}`, {
          body: await consentBody(projectId, 1, { route: QWEN_ROUTE })
        })
      ).status
    ).toBe(200);
    const upstream = stubProvider()
      .mockResolvedValueOnce(Response.json({ success: true, result: [] }))
      .mockResolvedValueOnce(
        Response.json({ errors: [{ code: 3036 }] }, { status: 429 })
      );
    const reply = await call('POST', CONSENTED_ASSISTANT_PROPOSAL_PATH, {
      body: qwenProposal(projectId, 1)
    });
    expect(reply.status).toBe(429);
    expect(await codeOf(reply)).toBe('AI_QWEN_FREE_LIMIT');
    expect(upstream.mock.calls.map(([url]) => url)).toEqual([
      `${QWEN_ACCOUNT_URL}/subscriptions`,
      QWEN_URL
    ]);
  });

  it('checks consent again after verifying the free account', async () => {
    const { call, projectId } = await seed({ ...FLAGS_ON, ...QWEN_ENV });
    const path = `/api/e2ee/assistant-consents/${projectId}`;
    const allowed = await consentBody(projectId, 1, { route: QWEN_ROUTE });
    expect((await call('PUT', path, { body: allowed })).status).toBe(200);
    const upstream = stubProvider().mockImplementation(async () => {
      const revoked = await consentBody(projectId, 2, { allowed: false });
      expect((await call('PUT', path, { body: revoked })).status).toBe(200);
      return Response.json({ success: true, result: [] });
    });
    const reply = await call('POST', CONSENTED_ASSISTANT_PROPOSAL_PATH, {
      body: qwenProposal(projectId, 1)
    });
    expect(reply.status).toBe(409);
    expect(await codeOf(reply)).toBe(
      ENCRYPTED_PROJECT_ASSISTANT_CONSENT_REQUIRED_CODE
    );
    expect(upstream.mock.calls.map(([url]) => url)).toEqual([
      `${QWEN_ACCOUNT_URL}/subscriptions`
    ]);
  });

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
    const [, init] = upstream.mock.calls[0]!;
    expect(
      (JSON.parse(init?.body as string) as { provider: object }).provider
    ).not.toHaveProperty('data_collection');
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
          body: {
            scope: 'profile',
            confirmation: 'DELETE CLOUD PROFILE',
            acknowledgedEncryptedProjectCount: 1
          }
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
    // The client cannot opt out: the Worker decides from the consent.
    const sent = await call('POST', CONSENTED_ASSISTANT_PROPOSAL_PATH, {
      body: { ...consentedProposal(projectId, 1), encryptedProject: false }
    });
    expect(sent.status).toBe(200);
    await sent.text();
    expect(upstream).toHaveBeenCalledTimes(1);
    // An encrypted project's model goes only to providers that do not
    // collect it (ADR-024 amendment 2026-11-14).
    const [, init] = upstream.mock.calls[0]!;
    expect(
      (JSON.parse(init?.body as string) as { provider: unknown }).provider
    ).toMatchObject({ data_collection: 'deny' });

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

  // The browser's Stop runs while an Allow may still be in flight, both
  // numbered from the same floor: whichever the account stores first, the
  // other gets the stale answer, and the Stop is retried past an Allow
  // stored meanwhile (`consentGate.ts`). The account then ends revoked.
  it('keeps a Stop that races an Allow in flight: the late Allow is stale, a late Stop goes past it', async () => {
    const { call, projectId } = await seed(FLAGS_ON);
    const upstream = stubProvider();
    const put = async (body: unknown) =>
      call('PUT', `/api/e2ee/assistant-consents/${projectId}`, { body });
    expect((await put(await consentBody(projectId, 1))).status).toBe(200);

    // The Stop landed first: the Allow numbered from the same floor is
    // refused as stale and names the Stop it lost to.
    expect(
      (await put(await consentBody(projectId, 2, { allowed: false }))).status
    ).toBe(200);
    const lateAllow = await put(await consentBody(projectId, 2));
    expect(lateAllow.status).toBe(409);
    expect(await lateAllow.json()).toMatchObject({
      code: 'E2EE_ASSISTANT_CONSENT_STALE',
      consent: { allowed: false, sequence: 2 }
    });

    // The Allow landed first: the Stop's first try is stale, and its retry
    // past the stored Allow revokes it.
    expect((await put(await consentBody(projectId, 3))).status).toBe(200);
    const firstStop = await put(
      await consentBody(projectId, 3, { allowed: false })
    );
    expect(firstStop.status).toBe(409);
    expect(await codeOf(firstStop)).toBe('E2EE_ASSISTANT_CONSENT_STALE');
    const retried = await put(
      await consentBody(projectId, 4, { allowed: false })
    );
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      consent: { allowed: false, sequence: 4 }
    });
    const after = await call('POST', '/api/assistant/proposals', {
      body: proposal(projectId)
    });
    expect(after.status).toBe(409);
    expect(await codeOf(after)).toBe(
      ENCRYPTED_PROJECT_ASSISTANT_CONSENT_REQUIRED_CODE
    );
    expect(upstream).not.toHaveBeenCalled();
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

  it('asks again when the upstream endpoint changes under the same provider and model', async () => {
    const { call, env, projectId } = await seed(FLAGS_ON);
    const upstream = stubProvider();
    await call('PUT', `/api/e2ee/assistant-consents/${projectId}`, {
      body: await consentBody(projectId, 1)
    });
    // The deployment now forwards to another endpoint: same provider and
    // model, but not where the user agreed to send this project.
    (env as Record<string, unknown>).AI_BASE_URL =
      'https://openrouter.ai/api/v1/other';
    const moved = await call('POST', CONSENTED_ASSISTANT_PROPOSAL_PATH, {
      body: consentedProposal(projectId, 1)
    });
    expect(moved.status).toBe(409);
    expect(await codeOf(moved)).toBe(
      ENCRYPTED_PROJECT_ASSISTANT_CONSENT_REQUIRED_CODE
    );
    expect(upstream).not.toHaveBeenCalled();
    // The status the browser reads names the new endpoint, so it asks again.
    const status = (await (
      await call('GET', '/api/assistant/status')
    ).json()) as { endpoint?: string };
    expect(status.endpoint).toBe('https://openrouter.ai/api/v1/other');
  });

  it('refuses a pending request after the account changes consent and the provider together', async () => {
    const { call, env, projectId } = await seed(FLAGS_ON);
    const upstream = stubProvider();
    const consentPath = '/api/e2ee/assistant-consents/' + projectId;
    expect(
      (
        await call('PUT', consentPath, {
          body: await consentBody(projectId, 1)
        })
      ).status
    ).toBe(200);
    const newBase = 'https://openrouter.ai/api/v1/other';
    (env as Record<string, unknown>).AI_BASE_URL = newBase;
    const endpoint = newBase;
    const route = assistantConsentRoute({
      source: 'deployment',
      provider: 'openrouter',
      model: 'openai/gpt-5.6-sol',
      endpoint
    });
    expect(
      (
        await call('PUT', consentPath, {
          body: await consentBody(projectId, 2, { route })
        })
      ).status
    ).toBe(200);
    const stale = await call('POST', CONSENTED_ASSISTANT_PROPOSAL_PATH, {
      body: consentedProposal(projectId, 1)
    });
    expect(stale.status).toBe(409);
    expect(await codeOf(stale)).toBe(
      ENCRYPTED_PROJECT_ASSISTANT_CONSENT_REQUIRED_CODE
    );
    expect(upstream).not.toHaveBeenCalled();
    const current = await call('POST', CONSENTED_ASSISTANT_PROPOSAL_PATH, {
      body: consentedProposal(projectId, 2, endpoint)
    });
    expect(current.status).toBe(200);
    await current.text();
    expect(upstream).toHaveBeenCalledTimes(1);
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
          body: {
            scope: 'profile',
            confirmation: 'DELETE CLOUD PROFILE',
            acknowledgedEncryptedProjectCount: 1
          },
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

import type { Page, Route } from '@playwright/test';
import { withoutDerivedProjection } from '@openzcad/document-core';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import worker from '../../apps/web/worker/index';
import { d1Database } from '../d1-sqlite';
import { expect, stubApi, test } from './openzcad-fixtures';
import {
  addE2eeUser,
  createE2eeServer,
  E2E_USER_ID,
  openEncryptionSettings,
  seedE2eeDevice,
  type E2eeServer
} from './e2ee-fixtures';
import {
  ALICE_EMAIL,
  BOB_EMAIL,
  BOB_ID,
  COMMIT_BUDGET_MS,
  SYNC_BUDGET_MS,
  closeSettings,
  signIn
} from './encrypted-members-fixtures';

const NAME = 'Secret shared bracket';

/** The whole Worker over the server's SQLite and bucket, migration open. */
function workerEnv(server: E2eeServer) {
  return {
    ENVIRONMENT: 'development',
    AUTH_MODE: 'development',
    DB: d1Database(server.db),
    PROJECT_STORAGE: server.bucket,
    ARTIFACTS: server.bucket,
    PROJECT_SHARING_ENABLED: 'true',
    E2EE_KEYS_ENABLED: 'true',
    E2EE_PROJECTS_ENABLED: 'true',
    E2EE_MIGRATION_ENABLED: 'true'
  };
}

async function call(
  server: E2eeServer,
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  return worker.fetch(
    new Request(`https://zcad.test${path}`, {
      method,
      headers: {
        'x-openzcad-development-user': E2E_USER_ID,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }),
    workerEnv(server) as never
  );
}

/** Alice's plaintext project with a save state, a view link, Bob an editor. */
async function seedSharedProject(server: E2eeServer): Promise<string> {
  const created = await call(server, 'POST', '/api/projects', {
    name: NAME,
    initialDocument: withoutDerivedProjection(
      createProjectDocument(NAME, toUserId(E2E_USER_ID))
    )
  });
  expect(created.status).toBe(201);
  const document = ((await created.json()) as { document: ProjectDocument })
    .document;
  const saved = await call(
    server,
    'POST',
    `/api/projects/${document.projectId}/revisions`,
    {
      projectId: document.projectId,
      reason: 'Secret first save',
      expectedVersion: document.version,
      document
    }
  );
  expect(saved.status).toBe(200);
  expect(
    (
      await call(
        server,
        'POST',
        `/api/projects/${document.projectId}/share-links`,
        {
          mode: 'view'
        }
      )
    ).status
  ).toBe(201);
  server.db
    .prepare(
      `INSERT INTO project_members
         (project_id, user_id, role, added_by_user_id, created_at, updated_at)
       VALUES (?, ?, 'editor', ?, 1, 1)`
    )
    .run(document.projectId, BOB_ID, E2E_USER_ID);
  return document.projectId;
}

/** Alice's account routes go to the whole Worker, as the owner. */
async function serveWorker(page: Page, server: E2eeServer) {
  await page.route(
    /\/api\/(projects|artifacts|uploads|e2ee|account)(\/|\?|$)/,
    async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      const body = request.postDataBuffer();
      try {
        const response = await worker.fetch(
          new Request(`https://zcad.test${url.pathname}${url.search}`, {
            method: request.method(),
            headers: {
              ...request.headers(),
              'x-openzcad-development-user': E2E_USER_ID,
              origin: 'https://zcad.test',
              'content-type':
                request.headers()['content-type'] ?? 'application/json'
            },
            ...(body === null ? {} : { body: new Uint8Array(body) })
          }),
          workerEnv(server) as never
        );
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          body: Buffer.from(await response.arrayBuffer())
        });
      } catch {
        // The page went away meanwhile.
      }
    }
  );
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        userId: E2E_USER_ID,
        displayName: ALICE_EMAIL,
        email: ALICE_EMAIL,
        mode: 'development'
      }
    })
  );
}

/** Compares codes with `name` in the open contact panel and signs it. */
async function verifyContact(
  settings: ReturnType<Page['getByRole']>,
  name: string,
  recoveryKey: string
) {
  await settings.getByRole('button', { name: 'Codes match — verify' }).click();
  const confirm = settings.getByRole('group', { name: `Verify ${name}` });
  await confirm.getByLabel('Recovery key').fill(recoveryKey);
  await confirm.getByRole('button', { name: 'Verify contact' }).click();
  await expect(
    settings.getByRole('button', { name: 'Stop trusting' })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
}

/**
 * ADR-024 Phase 7, slice 7-4: Alice encrypts a plaintext project she shares
 * with Bob. Settings › Encryption lists Bob as not ready and says what each
 * of them needs to do; once Bob compared codes with her (his browser then
 * publishes his keys) and she with him, the project is encrypted, Bob is
 * added back by Welcome as an editor, her plaintext link is revoked and an
 * encrypted one is offered, and Bob opens the encrypted project.
 */
test('encrypts a shared project once its member is ready, and the member opens it', async ({
  browser
}) => {
  test.setTimeout(300_000);
  const server = createE2eeServer({
    projectsEnabled: true,
    migrationEnabled: true
  });
  server.db
    .prepare('UPDATE users SET email = ? WHERE id = ?')
    .run(ALICE_EMAIL, E2E_USER_ID);
  addE2eeUser(server, BOB_ID, BOB_EMAIL);
  const projectId = await seedSharedProject(server);
  const errors: string[] = [];

  const aliceContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  alice.on('pageerror', (error) => errors.push(error.message));
  await stubApi(alice);
  await serveWorker(alice, server);
  await alice.goto('/');
  const aliceSeed = await seedE2eeDevice(alice, server, {
    label: 'Alice browser'
  });

  const bobContext = await browser.newContext();
  const bob = await signIn(bobContext, server, BOB_ID, BOB_EMAIL);
  bob.on('pageerror', (error) => errors.push(error.message));
  await bob.goto('/');
  const bobSeed = await seedE2eeDevice(bob, server, {
    label: 'Bob browser',
    userId: BOB_ID
  });

  // Alice starts: Bob is listed as not ready, and nothing is locked.
  let settings = await openEncryptionSettings(alice);
  await expect(settings.getByText('1 project not encrypted')).toBeVisible({
    timeout: SYNC_BUDGET_MS
  });
  await settings.getByRole('button', { name: 'Encrypt projects' }).click();
  const row = settings.getByRole('listitem', { name: NAME });
  await expect(row.getByText('Waiting for members')).toBeVisible({
    timeout: SYNC_BUDGET_MS
  });
  const members = row.getByRole('list', { name: `Members of ${NAME}` });
  await expect(members.getByText(BOB_EMAIL, { exact: true })).toBeVisible();
  await expect(members.getByText(/needs to open OpenZCAD/)).toBeVisible();
  expect(
    server.db.prepare('SELECT COUNT(*) AS n FROM e2ee_project_migrations').get()
  ).toEqual({ n: 0 });

  // Bob compares codes with Alice; his browser publishes his keys.
  await bob.reload();
  const bobSettings = await openEncryptionSettings(bob);
  await expect(
    bobSettings.getByText(`${ALICE_EMAIL} invited you as an editor`)
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await bobSettings
    .getByRole('button', { name: `Verify ${ALICE_EMAIL}` })
    .first()
    .click();
  await verifyContact(bobSettings, ALICE_EMAIL, bobSeed.recoveryKey);
  await expect
    .poll(
      () =>
        server.db
          .prepare(
            `SELECT COUNT(*) AS n FROM e2ee_key_packages
             WHERE project_id = ? AND user_id = ?`
          )
          .get(projectId, BOB_ID),
      { timeout: SYNC_BUDGET_MS }
    )
    .toEqual({ n: 1 });
  await closeSettings(bob);

  // Alice checks again: now she has to compare codes with Bob.
  await row.getByRole('button', { name: 'Check again' }).click();
  await expect(
    members.getByText(/Compare codes with bob@example\.com/)
  ).toBeVisible({
    timeout: SYNC_BUDGET_MS
  });
  await settings
    .getByRole('button', { name: `Verify ${BOB_EMAIL}` })
    .first()
    .click();
  await verifyContact(settings, BOB_EMAIL, aliceSeed.recoveryKey);
  await closeSettings(alice);
  settings = await openEncryptionSettings(alice);
  const again = settings.getByRole('listitem', { name: NAME });
  await again.getByRole('button', { name: 'Check again' }).click();
  await expect(again.getByText('Encrypted', { exact: true })).toBeVisible({
    timeout: COMMIT_BUDGET_MS
  });

  // Bob is a member of the encrypted project as an editor; the plaintext
  // link is revoked and an encrypted one is offered.
  expect(
    server.db
      .prepare('SELECT storage_format FROM projects WHERE id = ?')
      .get(projectId)
  ).toEqual({ storage_format: 2 });
  expect(
    server.db
      .prepare(
        'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?'
      )
      .get(projectId, BOB_ID)
  ).toEqual({ role: 'editor' });
  expect(
    server.db
      .prepare(
        'SELECT COUNT(*) AS n FROM project_share_links WHERE revoked_at IS NULL'
      )
      .get()
  ).toEqual({ n: 0 });
  await expect(again.getByText(/share link stopped working/)).toBeVisible();
  await expect(
    again.getByRole('button', { name: 'Create encrypted link' })
  ).toBeVisible();

  // Bob opens it from his shelf: his browser joins by the Welcome.
  await bob.reload();
  await expect(
    bob
      .getByRole('dialog', { name: 'Settings' })
      .or(bob.getByRole('button', { name: 'Open settings' }))
      .first()
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await closeSettings(bob);
  const card = bob.locator('.start-tile-project', { hasText: NAME });
  await expect(card).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await card.locator('.start-tile-open').click();
  await expect(bob.locator('.breadcrumb')).toContainText(NAME, {
    timeout: SYNC_BUDGET_MS
  });
  expect(errors).toEqual([]);
});

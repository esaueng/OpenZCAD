import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import worker from '../../apps/web/worker/index';
import { d1Database } from '../d1-sqlite';
import { expect, expectBodyCount, stubApi, test } from './openzcad-fixtures';
import {
  createE2eeServer,
  E2E_USER_ID,
  openEncryptionSettings,
  seedE2eeDevice,
  type E2eeServer
} from './e2ee-fixtures';

/** The MLS Worker starts on first use; a project rebuild takes a while. */
const SYNC_BUDGET_MS = 30_000;
const STEP = readFileSync('test/parity/corpus/b-unit-mm-cube.step');
const STEP_SHA256 = createHash('sha256').update(STEP).digest('hex');

/** The whole Worker over the server's SQLite and bucket, migration open. */
function workerEnv(server: E2eeServer) {
  return {
    ENVIRONMENT: 'development',
    AUTH_MODE: 'development',
    DB: d1Database(server.db),
    PROJECT_STORAGE: server.bucket,
    ARTIFACTS: server.bucket,
    E2EE_KEYS_ENABLED: 'true',
    E2EE_PROJECTS_ENABLED: 'true',
    E2EE_MIGRATION_ENABLED: 'true'
  };
}

async function call(
  server: E2eeServer,
  method: string,
  path: string,
  body?: unknown,
  raw?: Uint8Array<ArrayBuffer>
): Promise<Response> {
  return worker.fetch(
    new Request(`https://zcad.test${path}`, {
      method,
      headers: {
        'x-openzcad-development-user': E2E_USER_ID,
        ...(raw
          ? { 'content-type': 'application/octet-stream' }
          : body === undefined
            ? {}
            : { 'content-type': 'application/json' })
      },
      ...(raw
        ? { body: raw }
        : body === undefined
          ? {}
          : { body: JSON.stringify(body) })
    }),
    workerEnv(server) as never
  );
}

/**
 * A plaintext project as an older beta left it: a STEP import and two save
 * states, written through the real plaintext routes.
 */
async function seedPlaintextProject(server: E2eeServer): Promise<string> {
  const initial = withoutDerivedProjection(
    createProjectDocument('Secret migrated', toUserId(E2E_USER_ID))
  );
  const created = await call(server, 'POST', '/api/projects', {
    name: 'Secret migrated',
    initialDocument: initial
  });
  expect(created.status).toBe(201);
  let document = ((await created.json()) as { document: ProjectDocument })
    .document;
  const projectId = document.projectId;
  const upload = await call(server, 'POST', '/api/uploads', {
    projectId,
    fileName: 'secret-cube.step',
    contentType: 'model/step',
    kind: 'step-import'
  });
  expect(upload.status).toBe(201);
  const { session } = (await upload.json()) as {
    session: { uploadSessionId: string; uploadUrl: string; artifactId: string };
  };
  expect(
    (
      await call(
        server,
        'PUT',
        session.uploadUrl,
        undefined,
        new Uint8Array(STEP)
      )
    ).status
  ).toBe(204);
  expect(
    (
      await call(server, 'POST', '/api/artifacts/finalize', {
        projectId,
        uploadSessionId: session.uploadSessionId,
        artifactId: session.artifactId
      })
    ).status
  ).toBe(200);
  const manager = new CommandManager(document);
  manager.execute(
    commandFactories.importStep({
      name: 'Secret cube',
      sourceName: 'secret-cube.step',
      artifactId: session.artifactId,
      stepSourceRef: {
        marker: 'openzcad-source-ref',
        version: 1,
        hashAlgorithm: 'sha256',
        checksumSha256: STEP_SHA256,
        logicalBytes: STEP.byteLength
      }
    })
  );
  const next = { ...manager.document, version: document.version + 1 };
  expect(
    (
      await call(server, 'PUT', `/api/projects/${projectId}/document`, {
        projectId,
        expectedVersion: document.version,
        document: next
      })
    ).status
  ).toBe(200);
  document = next;
  for (const reason of ['Secret first save', 'Secret second save']) {
    const saved = await call(
      server,
      'POST',
      `/api/projects/${projectId}/revisions`,
      { projectId, reason, expectedVersion: document.version, document }
    );
    expect(saved.status).toBe(200);
    document = (await saved.json()) as ProjectDocument;
  }
  return projectId;
}

/**
 * The page's account routes go to the Worker. `hold` may keep a request
 * from it (the page reloads while it waits); answering nothing is how a
 * closed tab looks to the account.
 */
async function serveWorker(
  page: Page,
  server: E2eeServer,
  hold: (method: string, path: string) => Promise<void> | void = () => undefined
) {
  await page.route(
    /\/api\/(projects|artifacts|uploads|e2ee|account)(\/|\?|$)/,
    async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = `${url.pathname}${url.search}`;
      try {
        await hold(request.method(), url.pathname);
      } catch {
        // Never answered: the page reloads while it waits.
        return;
      }
      const body = request.postDataBuffer();
      try {
        const response = await worker.fetch(
          new Request(`https://zcad.test${path}`, {
            method: request.method(),
            // The page's own headers (the migration lease among them), as
            // the development user on the Worker's origin.
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
}

const count = (server: E2eeServer, sql: string, ...binds: string[]) =>
  (server.db.prepare(sql).get(...binds) as { n: number }).n;

/**
 * ADR-024 Phase 7, slice 7-2: Settings › Encryption › "Encrypt existing
 * projects" encrypts a plaintext project in the built app. The page is
 * reloaded while the engine waits on its second save state; after the
 * reload the staging reads as paused, resumes from the staged journal
 * (with the lease this browser kept), cuts over and purges the plaintext.
 * The project then opens from the shelf as an encrypted project and
 * rebuilds its STEP import from the encrypted blob.
 */
test('encrypts an existing project, resumes after a reload, and opens it', async ({
  page
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const server = createE2eeServer({ projectsEnabled: true });
  const projectId = await seedPlaintextProject(server);

  // The first run is cut off at its second save state.
  let namedSaves = 0;
  let cutOff = false;
  let releaseHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  await stubApi(page);
  await serveWorker(page, server, async (method, path) => {
    if (
      !cutOff &&
      method === 'POST' &&
      path === `/api/e2ee/projects/${projectId}/revisions` &&
      ++namedSaves === 2
    ) {
      cutOff = true;
      await held;
      throw new Error('The tab was reloaded.');
    }
  });

  await page.goto('/');
  await seedE2eeDevice(page, server);
  let settings = await openEncryptionSettings(page);
  const panel = settings.getByText('Encrypt existing projects');
  await expect(panel).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await expect(settings.getByText(/up to 30 days in backups/)).toBeVisible();
  await expect(settings.getByText('1 project not encrypted')).toBeVisible();
  await settings.getByRole('button', { name: 'Encrypt projects' }).click();
  await expect(
    settings.getByText(/Keep this tab open until encryption finishes/)
  ).toBeVisible();
  await expect.poll(() => cutOff, { timeout: SYNC_BUDGET_MS }).toBe(true);
  await expect(
    settings
      .getByRole('listitem', { name: 'Secret migrated' })
      .getByText(/1 of 2 save states · [0-9.]+ of [0-9.]+ MB/)
  ).toBeVisible();
  // The shelf badges the project while it is being encrypted.
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(
    page
      .locator('.start-tile-project', { hasText: 'Secret migrated' })
      .getByRole('img', { name: 'Encrypting' })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  // Opened meanwhile, it is read-only: held in View, every edit refused
  // with the reason, so nothing is edited that the encrypted copy would
  // not carry.
  await page
    .locator('.start-tile-project', { hasText: 'Secret migrated' })
    .locator('.start-tile-open')
    .click();
  await expectBodyCount(page, 1);
  const workspaceMode = page.getByRole('group', { name: 'Workspace mode' });
  await expect(
    workspaceMode.getByRole('button', { name: 'Build' })
  ).toBeDisabled();
  await expect(
    workspaceMode.getByRole('button', { name: 'View' })
  ).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('b');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Cannot use Box: This project is being end-to-end encrypted.'
  );
  await page.getByTitle('Back to projects').click();
  // Mid-way: the staged group, versions and the first save state only.
  expect(
    count(
      server,
      'SELECT COUNT(*) AS n FROM e2ee_project_revisions WHERE project_id = ?',
      projectId
    )
  ).toBe(1);
  expect(
    server.db
      .prepare('SELECT state FROM e2ee_project_migrations WHERE project_id = ?')
      .get(projectId)
  ).toEqual({ state: 'staging' });

  // Reload mid-way.
  await page.reload();
  releaseHeld();
  settings = await openEncryptionSettings(page);
  const row = settings.getByRole('listitem', { name: 'Secret migrated' });
  await expect(row.getByText('Paused')).toBeVisible({
    timeout: SYNC_BUDGET_MS
  });
  await settings.getByRole('button', { name: 'Resume' }).first().click();
  await expect(row.getByText('Encrypted', { exact: true })).toBeVisible({
    timeout: 120_000
  });
  await expect(
    settings.getByText('All your projects are encrypted')
  ).toBeVisible();

  // The account holds only ciphertext, the plaintext is gone, and the
  // resumed run staged the remaining save state once.
  expect(
    server.db
      .prepare(
        'SELECT state, purge_cursor FROM e2ee_project_migrations WHERE project_id = ?'
      )
      .get(projectId)
  ).toEqual({ state: 'done', purge_cursor: null });
  expect(
    server.db
      .prepare('SELECT storage_format, name, document_json FROM projects')
      .get()
  ).toEqual({ storage_format: 2, name: '', document_json: 'e2ee-v1' });
  expect(
    count(
      server,
      'SELECT COUNT(*) AS n FROM e2ee_project_revisions WHERE project_id = ?',
      projectId
    )
  ).toBe(2);
  expect(count(server, 'SELECT COUNT(*) AS n FROM revisions')).toBe(0);
  expect(count(server, 'SELECT COUNT(*) AS n FROM artifacts')).toBe(0);
  const stored = [
    ...server.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) =>
        JSON.stringify(
          server.db
            .prepare(`SELECT * FROM "${(row as { name: string }).name}"`)
            .all()
        )
      ),
    ...[...server.objects.values()].map((bytes) =>
      Buffer.from(bytes).toString('latin1')
    )
  ].join('\n');
  for (const secret of [
    'Secret migrated',
    'Secret cube',
    'Secret first save',
    'secret-cube',
    'ISO-10303-21'
  ]) {
    expect(stored, secret).not.toContain(secret);
  }

  // It opens from the shelf as an encrypted project and rebuilds its STEP
  // import from the encrypted blob.
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await page.reload();
  const card = page.locator('.start-tile-project', {
    hasText: 'Secret migrated'
  });
  // The page reopens the project it last opened (above, read-only).
  const back = page.getByTitle('Back to projects');
  await expect(card.or(back).first()).toBeVisible({ timeout: SYNC_BUDGET_MS });
  if (await back.isVisible()) await back.click();
  await expect(card).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await expect(
    card.getByRole('img', { name: 'End-to-end encrypted' })
  ).toBeVisible();
  await card.locator('.start-tile-open').click();
  await expectBodyCount(page, 1);
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await expect(page.getByText(/could not be fetched/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

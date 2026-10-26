import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Locator, Page, Route } from '@playwright/test';
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

/** The whole Worker, migration and the beta-only reverse path open. */
function workerEnv(server: E2eeServer) {
  return {
    ENVIRONMENT: 'development',
    AUTH_MODE: 'development',
    DB: d1Database(server.db),
    PROJECT_STORAGE: server.bucket,
    ARTIFACTS: server.bucket,
    E2EE_KEYS_ENABLED: 'true',
    E2EE_PROJECTS_ENABLED: 'true',
    E2EE_MIGRATION_ENABLED: 'true',
    E2EE_REVERSE_ENABLED: 'true'
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

/** A plaintext project with a STEP import and two save states. */
async function seedPlaintextProject(server: E2eeServer): Promise<string> {
  const initial = withoutDerivedProjection(
    createProjectDocument('Secret reversed', toUserId(E2E_USER_ID))
  );
  const created = await call(server, 'POST', '/api/projects', {
    name: 'Secret reversed',
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

/** The page's account routes go to the Worker. */
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
}

const count = (server: E2eeServer, sql: string, ...binds: string[]) =>
  (server.db.prepare(sql).get(...binds) as { n: number }).n;

const stopPanel = (settings: Locator) =>
  settings.locator('.settings-group', { hasText: 'Stop encrypting a project' });

/**
 * ADR-024 Phase 7, slice 7-3: with the beta-only reverse path open, an
 * encrypted project (encrypted here through "Encrypt existing projects")
 * is turned back into plaintext through Settings › Encryption › "Stop
 * encrypting a project", after a plain-words warning and confirmation.
 * The account then holds it in plaintext with its history and STEP file,
 * no ciphertext of it remains, and it opens from the shelf as an ordinary
 * plaintext project that rebuilds its STEP import.
 */
test('stops encrypting a project through the UI, and it opens as plaintext', async ({
  page
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const server = createE2eeServer({ projectsEnabled: true });
  const projectId = await seedPlaintextProject(server);
  await stubApi(page);
  await serveWorker(page, server);

  await page.goto('/');
  await seedE2eeDevice(page, server);
  const settings = await openEncryptionSettings(page);
  await expect(settings.getByText('Encrypt existing projects')).toBeVisible({
    timeout: SYNC_BUDGET_MS
  });
  await settings.getByRole('button', { name: 'Encrypt projects' }).click();
  await expect(
    settings.getByText('All your projects are encrypted')
  ).toBeVisible({ timeout: 120_000 });
  expect(
    count(
      server,
      'SELECT COUNT(*) AS n FROM projects WHERE id = ? AND storage_format = 2',
      projectId
    )
  ).toBe(1);

  // The reverse panel lists it, with the warning in plain words.
  const panel = stopPanel(settings);
  // Listed when the panel opened, before the project was encrypted.
  await panel.getByRole('button', { name: 'Refresh' }).click();
  const row = panel.getByRole('listitem', { name: 'Secret reversed' });
  await expect(row).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await expect(
    panel.getByText(/readable by the OpenZCAD server again/)
  ).toBeVisible();
  await row
    .getByRole('button', { name: 'Stop encrypting this project' })
    .click();
  const confirm = row.getByRole('group', {
    name: 'Stop encrypting Secret reversed'
  });
  await expect(
    confirm.getByText(/will be stored readable by the server again/)
  ).toBeVisible();
  const stop = confirm.getByRole('button', { name: 'Stop encrypting' });
  await expect(stop).toBeDisabled();
  await confirm.getByRole('checkbox').check();
  await stop.click();
  await expect(row.getByText('Not encrypted', { exact: true })).toBeVisible({
    timeout: 120_000
  });

  // The account holds it in plaintext, with its history and its file, and
  // no ciphertext of it.
  expect(
    server.db
      .prepare(
        'SELECT direction, state, purge_cursor FROM e2ee_project_migrations WHERE project_id = ?'
      )
      .get(projectId)
  ).toEqual({ direction: 'decrypt', state: 'done', purge_cursor: null });
  expect(
    server.db
      .prepare('SELECT storage_format, name FROM projects WHERE id = ?')
      .get(projectId)
  ).toEqual({ storage_format: 1, name: 'Secret reversed' });
  expect(
    count(
      server,
      'SELECT COUNT(*) AS n FROM revisions WHERE project_id = ?',
      projectId
    )
  ).toBe(2);
  expect(
    count(
      server,
      "SELECT COUNT(*) AS n FROM artifacts WHERE project_id = ? AND kind = 'step-import'",
      projectId
    )
  ).toBe(1);
  for (const table of [
    'e2ee_project_groups',
    'e2ee_project_versions',
    'e2ee_project_revisions',
    'e2ee_project_envelopes',
    'e2ee_project_keys',
    'e2ee_content_blobs'
  ]) {
    expect(
      count(
        server,
        `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`,
        projectId
      ),
      table
    ).toBe(0);
  }
  expect(
    [...server.objects.keys()].filter((key) =>
      key.startsWith(`e2ee/${projectId}/`)
    )
  ).toEqual([]);

  // It opens from the shelf as a plaintext project and rebuilds its STEP
  // import from the plaintext file.
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await page.reload();
  const card = page.locator('.start-tile-project', {
    hasText: 'Secret reversed'
  });
  await expect(card).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await expect(
    card.getByRole('img', { name: 'End-to-end encrypted' })
  ).toHaveCount(0);
  await card.locator('.start-tile-open').click();
  await expectBodyCount(page, 1);
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await expect(page.getByText(/could not be fetched/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

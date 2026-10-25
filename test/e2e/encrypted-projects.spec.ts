import { withEncryptedProjectInfo } from '../../apps/web/worker/e2eeProjectDocuments';
import { d1Database } from '../d1-sqlite';
import {
  createPrimitiveInPlace,
  expect,
  stubApi,
  test
} from './openzcad-fixtures';
import {
  createE2eeServer,
  E2E_USER_ID,
  installE2eeServer,
  openEncryptionSettings,
  seedE2eeDevice,
  type E2eeServer
} from './e2ee-fixtures';

/** Autosave waits out a 3 s idle delay; the MLS Worker starts on first use. */
const SYNC_BUDGET_MS = 30_000;

/** The shelf as the Worker lists it: format-2 rows and their project info. */
async function listing(server: E2eeServer) {
  const rows = server.db
    .prepare(
      `SELECT id, document_version, revision_count, last_revision_id, updated_at
       FROM projects WHERE user_id = ? AND storage_format = 2`
    )
    .all(E2E_USER_ID) as {
    id: string;
    document_version: number;
    revision_count: number;
    last_revision_id: string | null;
    updated_at: string;
  }[];
  return withEncryptedProjectInfo(d1Database(server.db), E2E_USER_ID, {
    projects: rows.map((row) => ({
      projectId: row.id as never,
      name: 'Encrypted project',
      revisionCount: row.revision_count,
      ...(row.last_revision_id
        ? { lastRevisionId: row.last_revision_id as never }
        : {}),
      updatedAt: row.updated_at,
      documentVersion: row.document_version,
      organization: { status: 'active', pinned: false, sortOrder: 0 },
      storageFormat: 2
    }))
  });
}

const count = (server: E2eeServer, sql: string) =>
  (server.db.prepare(sql).get() as { n: number }).n;

/**
 * ADR-024 Phase 4, slice 4-5: an account that encrypts new projects creates,
 * edits, autosaves, reloads and saves a named version of an end-to-end
 * encrypted project in the built app. The real `/api/e2ee/*` Worker routes
 * run over SQLite, the browser runs the real MLS Worker, and no plaintext
 * project route ever receives the document.
 */
test('creates, autosaves, reloads and saves an encrypted project', async ({
  page,
  context
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  const server = createE2eeServer({ projectsEnabled: true });
  await installE2eeServer(context, server);
  const plaintextWrites: string[] = [];
  let headReads = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() === 'GET' &&
      /^\/api\/e2ee\/projects\/[^/]+\/document$/.test(path)
    ) {
      headReads += 1;
    }
    if (
      path.startsWith('/api/projects') &&
      !['GET', 'HEAD'].includes(request.method())
    ) {
      plaintextWrites.push(`${request.method()} ${path}`);
    }
  });
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({
        status: 409,
        json: {
          error: 'Plaintext projects are refused for this account.',
          code: 'ENCRYPTED_PROJECTS_REQUIRED'
        }
      });
    }
    return route.fulfill({ json: await listing(server) });
  });
  // Every plaintext route of a format-2 project answers as the Worker's
  // format gate does (slice 4-1).
  await page.route(/\/api\/projects\/proj_[^/]+(\/.*)?$/, (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: 'This project is end-to-end encrypted.',
        code: 'PROJECT_FORMAT_UNSUPPORTED'
      }
    })
  );

  await page.goto('/');
  await seedE2eeDevice(page, server);
  const settings = await openEncryptionSettings(page);
  const toggle = settings.getByRole('checkbox', {
    name: 'Encrypt new projects'
  });
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);

  await page.getByLabel('Project name').fill('Secret bracket');
  await page.getByRole('button', { name: 'Create project' }).click();
  await createPrimitiveInPlace(page, 'box');
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await expect
    .poll(
      () => count(server, 'SELECT COUNT(*) AS n FROM e2ee_project_versions'),
      { timeout: SYNC_BUDGET_MS }
    )
    .toBeGreaterThan(1);
  // The account holds ciphertext: no name, no document.
  expect(
    server.db
      .prepare('SELECT name, document_json, storage_format FROM projects')
      .all()
  ).toEqual([{ name: '', document_json: 'e2ee-v1', storage_format: 2 }]);
  const stored = JSON.stringify(
    server.db.prepare('SELECT * FROM e2ee_project_versions').all()
  );
  expect(stored).not.toContain('Secret bracket');

  // A named save writes a revision.
  await page.keyboard.press('ControlOrMeta+s');
  await expect
    .poll(
      () => count(server, 'SELECT COUNT(*) AS n FROM e2ee_project_revisions'),
      { timeout: SYNC_BUDGET_MS }
    )
    .toBe(1);

  // Reload: the shelf names it from its project info, and it reopens from
  // the account copy, verified against this browser's pin.
  const readsBeforeReload = headReads;
  await page.reload();
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await page.getByTitle('Back to projects').click();
  const card = page.locator('.start-tile-project', {
    hasText: 'Secret bracket'
  });
  await expect(card).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await expect(
    card.getByRole('img', { name: 'End-to-end encrypted' })
  ).toBeVisible();
  await card.locator('.start-tile-open').click();
  await expect(
    page.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await expect(
    page.getByRole('dialog', { name: 'This project changed in two places' })
  ).toHaveCount(0);

  // Reopening read and verified the account's encrypted head.
  expect(headReads).toBeGreaterThan(readsBeforeReload);
  expect(plaintextWrites).toEqual([]);
  expect(errors).toEqual([]);
});

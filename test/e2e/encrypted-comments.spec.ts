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

/**
 * L08 encrypted comments (held for the owner, #1667): on an end-to-end
 * encrypted project a comment pinned to the model is sealed into the
 * member's signed comment log, the real `/api/e2ee/*` Worker over SQLite
 * stores only ciphertext, and the comment reads back after a reload.
 */

const SYNC_BUDGET_MS = 30_000;

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

/** Every table the account holds, as text. */
function stored(server: E2eeServer): string {
  const tables = (
    server.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]
  ).map((row) => row.name);
  return tables
    .map((table) =>
      JSON.stringify(server.db.prepare(`SELECT * FROM "${table}"`).all())
    )
    .join('\n');
}

test(
  'pins an encrypted comment that the account stores only as ciphertext',
  { tag: '@ci-smoke' },
  async ({ page, context }) => {
    test.setTimeout(120_000);
    await stubApi(page);
    const server = createE2eeServer({ projectsEnabled: true });
    await installE2eeServer(context, server);
    await page.route('**/api/projects', async (route) =>
      route.request().method() !== 'GET'
        ? route.fulfill({
            status: 409,
            json: {
              error: 'Plaintext projects are refused for this account.',
              code: 'ENCRYPTED_PROJECTS_REQUIRED'
            }
          })
        : route.fulfill({ json: await listing(server) })
    );
    const plaintextComments: string[] = [];
    // Every plaintext route of a format-2 project answers as the Worker's
    // format gate does; the plaintext comment route must never be asked.
    await page.route(/\/api\/projects\/proj_[^/]+(\/.*)?$/, (route) => {
      if (route.request().url().includes('/comments'))
        plaintextComments.push(route.request().url());
      return route.fulfill({
        status: 409,
        json: {
          error: 'This project is end-to-end encrypted.',
          code: 'PROJECT_FORMAT_UNSUPPORTED'
        }
      });
    });

    await page.goto('/');
    await seedE2eeDevice(page, server);
    const settings = await openEncryptionSettings(page);
    const toggle = settings.getByRole('checkbox', {
      name: 'Encrypt new projects'
    });
    await toggle.click();
    await expect(toggle).toBeChecked();
    await page.keyboard.press('Escape');
    await page.getByLabel('Project name').fill('Secret bracket');
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(page.locator('.workspace-reveal')).toHaveClass(/is-ready/, {
      timeout: SYNC_BUDGET_MS
    });
    await createPrimitiveInPlace(page, 'box');
    await expect(
      page.getByRole('status', { name: 'Saved', exact: true })
    ).toBeVisible({ timeout: SYNC_BUDGET_MS });

    await page.locator('summary', { hasText: 'File' }).click();
    await page.getByRole('button', { name: 'Comments', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Comments' });
    await expect(panel).toContainText('No comments yet', {
      timeout: SYNC_BUDGET_MS
    });
    await panel.getByRole('button', { name: 'Add comment' }).click();
    await page.locator('.viewer-host canvas').click();
    await panel
      .getByRole('textbox', { name: 'New comment' })
      .fill('Secret fillet question');
    await panel.getByRole('button', { name: 'Post' }).click();
    await expect(page.locator('.comment-pin')).toHaveText('1', {
      timeout: SYNC_BUDGET_MS
    });
    await expect(panel).toContainText('Secret fillet question');

    // One signed, encrypted log; no plaintext anywhere in the account.
    expect(
      server.db
        .prepare('SELECT user_id, sequence FROM e2ee_project_comment_logs')
        .all()
    ).toEqual([{ user_id: E2E_USER_ID, sequence: 1 }]);
    expect(stored(server)).not.toContain('Secret fillet question');
    expect(plaintextComments).toEqual([]);

    // It reads back after a reload, decrypted in this browser.
    await page.reload();
    await expect(page.locator('.workspace-reveal')).toHaveClass(/is-ready/, {
      timeout: SYNC_BUDGET_MS
    });
    await page.locator('summary', { hasText: 'File' }).click();
    await page.getByRole('button', { name: 'Comments', exact: true }).click();
    await expect(
      page.getByRole('complementary', { name: 'Comments' })
    ).toContainText('Secret fillet question', { timeout: SYNC_BUDGET_MS });
  }
);

import { withEncryptedProjectInfo } from '../../apps/web/worker/e2eeProjectDocuments';
import {
  ASSISTANT_CONSENT_DIGEST_FIELDS,
  ASSISTANT_CONSENT_REQUEST_FIELDS
} from '../../apps/web/src/lib/assistant/consentCopy';
import { d1Database } from '../d1-sqlite';
import {
  askAssistant,
  createPrimitiveInPlace,
  expect,
  openAssistant,
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
const CONSENT_DIALOG = 'Let the assistant read this encrypted project?';
const REPLY = `data: ${JSON.stringify({
  type: 'response.output_text.done',
  text: JSON.stringify({
    replyKind: 'message',
    proposal: null,
    questions: null,
    message: 'The block is 10 mm on each side.',
    readings: null
  })
})}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`;

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

const consentRow = (server: E2eeServer) =>
  server.db
    .prepare(
      `SELECT allowed, sequence, revoked_at IS NOT NULL AS revoked
       FROM e2ee_assistant_consents WHERE user_id = ?`
    )
    .get(E2E_USER_ID) as
    { allowed: number; sequence: number; revoked: number } | undefined;

/**
 * ADR-024 Phase 6, slice 6-1: on an end-to-end encrypted project the
 * assistant asks first, sends exactly the fields its consent lists once
 * allowed, and sends nothing after Stop or Revoke. The real `/api/e2ee/*`
 * Worker routes store the MAC'd consent over SQLite; the provider is a stub
 * that records every request the browser makes.
 */
test('asks before reading an encrypted project and stops on revocation', async ({
  page,
  context
}) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page, { assistantEnabled: true });
  const server = createE2eeServer({ projectsEnabled: true });
  await installE2eeServer(context, server);
  const proposals: Record<string, unknown>[] = [];
  await page.route('**/api/assistant/proposals', async (route) => {
    proposals.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: REPLY
    });
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
  const projectId = (
    server.db.prepare('SELECT id FROM projects').get() as { id: string }
  ).id;

  // First use: the question, and nothing sent while it is open or declined.
  await openAssistant(page);
  await askAssistant(page, 'How big is the block?');
  const dialog = page.getByRole('dialog', { name: CONSENT_DIALOG });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    'OpenZCAD’s AI provider, OpenRouter, model openai/gpt-5.6-sol'
  );
  await expect(dialog).toContainText('cannot be recalled');
  await dialog.getByRole('button', { name: 'Not now' }).click();
  await expect(dialog).toHaveCount(0);
  expect(proposals).toEqual([]);
  expect(consentRow(server)).toBeUndefined();

  // Allowed: exactly the listed fields leave, once.
  await askAssistant(page, 'How big is the block?');
  await page
    .getByRole('dialog', { name: CONSENT_DIALOG })
    .getByRole('button', { name: 'Allow for this project' })
    .click();
  await expect.poll(() => proposals.length).toBe(1);
  expect(Object.keys(proposals[0]!).sort()).toEqual([
    ...ASSISTANT_CONSENT_REQUEST_FIELDS
  ]);
  const digest = proposals[0]!.digest as Record<string, unknown>;
  for (const key of Object.keys(digest)) {
    expect(ASSISTANT_CONSENT_DIGEST_FIELDS as readonly string[]).toContain(key);
  }
  expect(digest.projectId).toBe(projectId);
  expect(consentRow(server)).toEqual({ allowed: 1, sequence: 1, revoked: 0 });
  await expect(
    page.getByText('The block is 10 mm on each side.')
  ).toBeVisible();
  const chip = page.getByText('Allowed for this project');
  await expect(chip).toBeVisible();

  // Stop in the panel: the Worker row is revoked and nothing more is sent.
  await page
    .getByRole('button', { name: 'Stop the assistant reading this project' })
    .click();
  await expect
    .poll(() => consentRow(server))
    .toEqual({
      allowed: 0,
      sequence: 2,
      revoked: 1
    });
  await expect(chip).toHaveCount(0);
  await askAssistant(page, 'And now?');
  await expect(
    page.getByRole('dialog', { name: CONSENT_DIALOG })
  ).toBeVisible();
  await page
    .getByRole('dialog', { name: CONSENT_DIALOG })
    .getByRole('button', { name: 'Allow for this project' })
    .click();
  await expect.poll(() => proposals.length).toBe(2);
  expect(Object.keys(proposals[1]!).sort()).toEqual([
    ...ASSISTANT_CONSENT_REQUEST_FIELDS
  ]);
  expect(consentRow(server)).toEqual({ allowed: 1, sequence: 3, revoked: 0 });

  // Revoke from Settings › Encryption › Assistant access.
  const open = await openEncryptionSettings(page);
  const access = open.getByRole('button', {
    name: 'Revoke assistant access to Secret bracket'
  });
  await expect(access).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await access.click();
  await expect
    .poll(() => consentRow(server))
    .toEqual({
      allowed: 0,
      sequence: 4,
      revoked: 1
    });
  await page.keyboard.press('Escape');
  await expect(open).toHaveCount(0);
  await openAssistant(page);
  await askAssistant(page, 'Still there?');
  const again = page.getByRole('dialog', { name: CONSENT_DIALOG });
  await expect(again).toBeVisible();
  await again.getByRole('button', { name: 'Not now' }).click();
  expect(proposals).toHaveLength(2);
  expect(errors).toEqual([]);
});

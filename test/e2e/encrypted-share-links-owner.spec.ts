import { handleEncryptedSharedSnapshot } from '../../apps/web/worker/e2eeShareLinks';
import { openSharedSnapshot } from '../../apps/web/src/lib/e2ee/sharedSnapshot';
import { parseShareFragment } from '../../apps/web/src/lib/e2ee/shareLinkFragment';
import { decodeE2eeFrame } from '@openzcad/shared';
import { d1Database } from '../d1-sqlite';
import { createPrimitiveInPlace, expect, test } from './openzcad-fixtures';
import {
  ALICE_EMAIL,
  COMMIT_BUDGET_MS,
  PROJECT_NAME,
  SYNC_BUDGET_MS,
  signIn
} from './encrypted-members-fixtures';
import {
  E2E_USER_ID,
  createE2eeServer,
  openEncryptionSettings,
  seedE2eeDevice,
  type E2eeServer
} from './e2ee-fixtures';

/** The anonymous route, as the Worker serves `GET /api/e2ee/share/:token`. */
async function anonymous(server: E2eeServer, token: string) {
  return handleEncryptedSharedSnapshot(
    `/api/e2ee/share/${token}`,
    d1Database(server.db),
    server.bucket as never,
    true
  );
}

/**
 * ADR-024 Phase 5, slice 5-10: the owner of an end-to-end encrypted project
 * confirms sharing with the recovery key, creates a share link from the
 * sharing dialog and revokes it. The real `/api/e2ee/*` routes run over
 * SQLite and the browser runs the real MLS Worker. The visitor page is
 * slice 5-11, so the link's anonymous route is checked here in Node: it
 * serves a snapshot that verifies end to end, and nothing once revoked.
 */
test('the owner creates and revokes an encrypted share link from the dialog', async ({
  browser
}) => {
  test.setTimeout(240_000);
  const server = createE2eeServer({ projectsEnabled: true });
  server.db
    .prepare('UPDATE users SET email = ? WHERE id = ?')
    .run(ALICE_EMAIL, E2E_USER_ID);
  const context = await browser.newContext();
  const alice = await signIn(context, server, E2E_USER_ID, ALICE_EMAIL);
  const errors: string[] = [];
  alice.on('pageerror', (error) => errors.push(error.message));

  await alice.goto('/');
  const seeded = await seedE2eeDevice(alice, server, {
    label: 'Alice browser'
  });
  const settings = await openEncryptionSettings(alice);
  const toggle = settings.getByRole('checkbox', {
    name: 'Encrypt new projects'
  });
  await toggle.click();
  await expect(toggle).toBeChecked();
  await alice.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await alice.getByLabel('Project name').fill(PROJECT_NAME);
  await alice.getByRole('button', { name: 'Create project' }).click();
  await createPrimitiveInPlace(alice, 'box');
  await expect(
    alice.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });

  await alice.getByRole('button', { name: /Open project sharing/ }).click();
  const dialog = alice.getByRole('dialog', { name: 'Project sharing' });
  const links = dialog.getByRole('region', { name: 'Encrypted share links' });
  await expect(links.getByText('No links yet.')).toBeVisible({
    timeout: SYNC_BUDGET_MS
  });

  // Sharing needs the identity key's confirmation (the share delegation).
  await links.getByRole('button', { name: 'Confirm sharing…' }).click();
  const confirm = links.getByRole('group', { name: 'Confirm sharing' });
  await confirm.getByLabel('Recovery key').fill(seeded.recoveryKey);
  await confirm
    .getByRole('button', { name: 'Confirm with recovery key' })
    .click();
  await expect(confirm).toHaveCount(0, { timeout: COMMIT_BUDGET_MS });
  await expect(
    links.getByRole('button', { name: 'Confirm sharing…' })
  ).toHaveCount(0);
  expect(
    server.db.prepare('SELECT COUNT(*) AS n FROM e2ee_share_delegations').get()
  ).toEqual({ n: 1 });

  await links.getByRole('button', { name: 'Create link' }).click();
  const url = links.getByRole('textbox', { name: 'Share link', exact: true });
  await expect(url).toHaveValue(/#share=[\w-]{43}\.[\w-]{43}\.[\w-]{43}$/, {
    timeout: COMMIT_BUDGET_MS
  });
  await expect(links.getByText(/^Active until /)).toBeVisible({
    timeout: SYNC_BUDGET_MS
  });
  const link = await url.inputValue();
  const parts = parseShareFragment(new URL(link).hash)!;

  // The anonymous route serves a snapshot that verifies end to end.
  const served = await anonymous(server, parts.token);
  expect(served.status).toBe(200);
  const frame = decodeE2eeFrame(new Uint8Array(await served.arrayBuffer()));
  const opened = await openSharedSnapshot({
    parts,
    metadata: frame.metadata as never,
    envelope: frame.payload,
    now: Date.now()
  });
  expect(opened.document.name).toBe(PROJECT_NAME);
  expect(opened.document.featureOrder.length).toBeGreaterThan(0);
  expect(new TextDecoder().decode(frame.payload)).not.toContain(PROJECT_NAME);

  await links.getByRole('button', { name: 'Revoke View only link' }).click();
  await expect(links.getByText('No links yet.')).toBeVisible({
    timeout: COMMIT_BUDGET_MS
  });
  expect((await anonymous(server, parts.token)).status).toBe(404);
  expect(
    server.db
      .prepare('SELECT revoked_at IS NOT NULL AS revoked FROM e2ee_share_links')
      .get()
  ).toEqual({ revoked: 1 });

  // Autosave keeps working on top of the share-link versions.
  await dialog.getByRole('button', { name: 'Close sharing' }).click();
  await createPrimitiveInPlace(alice, 'box');
  await expect(
    alice.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  expect(errors).toEqual([]);
  await context.close();
});

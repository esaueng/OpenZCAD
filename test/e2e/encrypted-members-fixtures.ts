import type { BrowserContext, Page, Browser } from '@playwright/test';
import { withEncryptedProjectInfo } from '../../apps/web/worker/e2eeProjectDocuments';
import { d1Database } from '../d1-sqlite';
import { expect, stubApi } from './openzcad-fixtures';
import {
  addE2eeUser,
  createE2eeServer,
  E2E_USER_ID,
  installE2eeServer,
  openEncryptionSettings,
  seedE2eeDevice,
  type E2eeServer
} from './e2ee-fixtures';

/**
 * Two accounts sharing an end-to-end encrypted project, for the member
 * specs of ADR-024 Phase 5 (slices 5-4 and 5-5). The flow is slice 5-3b's
 * (`encrypted-sharing.spec.ts`): Alice invites Bob from the sharing
 * dialog, Bob accepts after setting up encryption, both verify each other
 * by digit groups, and Alice's browser adds Bob by an MLS Commit. The real
 * `/api/e2ee/*` Worker routes run over SQLite; each browser runs the real
 * MLS Worker.
 */

/** Autosave waits out a 3 s idle delay; the MLS Worker starts on first use. */
export const SYNC_BUDGET_MS = 30_000;
/**
 * A membership Commit: checks the people involved, catches up, builds the
 * Commit and its key archive, over routed requests.
 */
export const COMMIT_BUDGET_MS = 90_000;

export const ALICE_EMAIL = 'alice@example.com';
export const BOB_ID = 'user_bob_e2e';
export const BOB_EMAIL = 'bob@example.com';
export const PROJECT_NAME = 'Secret bracket';

/** The shelf as the Worker lists it: owned and shared format-2 projects. */
async function listing(server: E2eeServer, userId: string) {
  const rows = server.db
    .prepare(
      `SELECT id, document_version, revision_count, updated_at
       FROM projects p WHERE storage_format = 2 AND (user_id = ?1 OR EXISTS (
         SELECT 1 FROM project_members m
         WHERE m.project_id = p.id AND m.user_id = ?1))`
    )
    .all(userId) as {
    id: string;
    document_version: number;
    revision_count: number;
    updated_at: string;
  }[];
  return withEncryptedProjectInfo(d1Database(server.db), userId, {
    projects: rows.map((row) => ({
      projectId: row.id as never,
      name: 'Encrypted project',
      revisionCount: row.revision_count,
      updatedAt: row.updated_at,
      documentVersion: row.document_version,
      organization: { status: 'active', pinned: false, sortOrder: 0 },
      storageFormat: 2
    }))
  });
}

/** The metadata route the sharing dialog reads members from. */
function sharing(server: E2eeServer, projectId: string) {
  const owner = server.db
    .prepare('SELECT user_id FROM projects WHERE id = ?')
    .get(projectId) as { user_id: string };
  const members = server.db
    .prepare(
      `SELECT m.user_id, u.email, m.role, m.created_at, m.updated_at
       FROM project_members m JOIN users u ON u.id = m.user_id
       WHERE m.project_id = ?`
    )
    .all(projectId) as {
    user_id: string;
    email: string | null;
    role: 'editor' | 'viewer';
    created_at: number;
    updated_at: number;
  }[];
  return {
    projectId,
    ownerUserId: owner.user_id,
    members: members.map((row) => ({
      userId: row.user_id,
      email: row.email,
      role: row.role,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })),
    invitations: []
  };
}

export async function signIn(
  context: BrowserContext,
  server: E2eeServer,
  userId: string,
  email: string
): Promise<Page> {
  const page = await context.newPage();
  await stubApi(page);
  // Routes registered later win: this page is signed in as `userId`.
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: { userId, displayName: email, email, mode: 'development' }
    })
  );
  await installE2eeServer(context, server, userId);
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
    return route.fulfill({ json: await listing(server, userId) });
  });
  // Every plaintext route of a format-2 project answers as the Worker's
  // format gate does (slice 4-1), except the metadata ones it lets through.
  await page.route(/\/api\/projects\/proj_[^/]+(\/.*)?$/, (route) => {
    const url = new URL(route.request().url());
    const sharingMatch = /^\/api\/projects\/(proj_[^/]+)\/sharing$/.exec(
      url.pathname
    );
    if (sharingMatch && route.request().method() === 'GET') {
      return route.fulfill({ json: sharing(server, sharingMatch[1]!) });
    }
    return route.fulfill({
      status: 409,
      json: {
        error: 'This project is end-to-end encrypted.',
        code: 'PROJECT_FORMAT_UNSUPPORTED'
      }
    });
  });
  return page;
}

/** Closes Settings (and any panel open in it). */
export async function closeSettings(page: Page) {
  const settings = page.getByRole('dialog', { name: 'Settings' });
  // Each Escape closes one layer (a panel, then Settings); under load the
  // dialog can take a while to go, so wait after each.
  for (let attempt = 0; attempt < 3 && (await settings.count()); attempt++) {
    await page.keyboard.press('Escape');
    await settings
      .waitFor({ state: 'detached', timeout: 5_000 })
      .catch(() => undefined);
  }
  await expect(settings).toHaveCount(0, { timeout: SYNC_BUDGET_MS });
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

export interface SharedWorld {
  server: E2eeServer;
  alice: Page;
  bob: Page;
  aliceContext: BrowserContext;
  bobContext: BrowserContext;
  projectId: string;
  errors: string[];
}

/**
 * Alice's encrypted project with one Box, Bob a member of it in `role`
 * (invited, accepted, verified both ways, added by Alice's MLS Commit), and
 * Bob's page showing the project.
 */
export async function shareWithBob(
  browser: Browser,
  role: 'editor' | 'viewer'
): Promise<SharedWorld> {
  const server = createE2eeServer({ projectsEnabled: true });
  server.db
    .prepare('UPDATE users SET email = ? WHERE id = ?')
    .run(ALICE_EMAIL, E2E_USER_ID);
  addE2eeUser(server, BOB_ID, BOB_EMAIL);
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const errors: string[] = [];
  const alice = await signIn(aliceContext, server, E2E_USER_ID, ALICE_EMAIL);
  const bob = await signIn(bobContext, server, BOB_ID, BOB_EMAIL);
  for (const page of [alice, bob]) {
    page.on('pageerror', (error) => errors.push(error.message));
  }

  // Alice encrypts new projects and makes one.
  await alice.goto('/');
  const aliceSeed = await seedE2eeDevice(alice, server, {
    label: 'Alice browser'
  });
  const aliceSettings = await openEncryptionSettings(alice);
  const toggle = aliceSettings.getByRole('checkbox', {
    name: 'Encrypt new projects'
  });
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await alice.keyboard.press('Escape');
  await expect(aliceSettings).toHaveCount(0);
  await alice.getByLabel('Project name').fill(PROJECT_NAME);
  await alice.getByRole('button', { name: 'Create project' }).click();
  await alice.getByRole('button', { name: /^Box \(B\)/ }).click();
  await alice
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    alice.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });

  // She invites Bob in `role`; an encrypted project's editors need no
  // edit-lease rollout (slice 5-4).
  await alice.getByRole('button', { name: /Open project sharing/ }).click();
  const dialog = alice.getByRole('dialog', { name: 'Project sharing' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Email').fill(BOB_EMAIL);
  await dialog.getByLabel('Role').selectOption(role);
  await dialog.getByRole('button', { name: 'Invite' }).click();
  await expect(dialog.getByText('Invitation sent.')).toBeVisible({
    timeout: SYNC_BUDGET_MS
  });
  const projectId = (
    server.db.prepare('SELECT id FROM projects').get() as { id: string }
  ).id;
  await dialog.getByRole('button', { name: 'Close sharing' }).click();

  // Bob opens the link, is sent to set up encryption, and accepts.
  await bob.goto(`/#encrypted-invite=${server.mailbox[0]!.token}`);
  await expect(
    bob
      .getByRole('dialog', { name: 'Settings' })
      .getByRole('button', { name: 'Set up encryption' })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  const bobSeed = await seedE2eeDevice(bob, server, {
    label: 'Bob browser',
    userId: BOB_ID
  });
  await bob.reload();
  const bobEncryption = await openEncryptionSettings(bob);
  await bobEncryption
    .getByRole('button', { name: 'Accept invitation' })
    .click();
  await expect(
    bobEncryption.getByText(
      `${ALICE_EMAIL} invited you as ${role === 'editor' ? 'an editor' : 'a viewer'}`
    )
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await bobEncryption
    .getByRole('button', { name: `Verify ${ALICE_EMAIL}` })
    .first()
    .click();
  await verifyContact(bobEncryption, ALICE_EMAIL, bobSeed.recoveryKey);
  await expect(
    bobEncryption.getByText(
      'Your keys are ready. Waiting for them to verify you and add you.'
    )
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });

  // Alice verifies Bob; her browser adds him by an MLS Commit.
  await alice.getByRole('button', { name: /Open project sharing/ }).click();
  await dialog.getByRole('button', { name: /^Verify / }).click();
  const aliceEncryption = alice.getByRole('dialog', { name: 'Settings' });
  await verifyContact(aliceEncryption, BOB_EMAIL, aliceSeed.recoveryKey);
  await expect
    .poll(
      () =>
        server.db
          .prepare(
            'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?'
          )
          .get(projectId, BOB_ID),
      { timeout: COMMIT_BUDGET_MS }
    )
    .toEqual({ role });
  await closeSettings(alice);

  // Bob opens the project from his shelf.
  await bob.reload();
  await expect(
    bob
      .getByRole('dialog', { name: 'Settings' })
      .or(bob.getByRole('button', { name: 'Open settings' }))
      .first()
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await closeSettings(bob);
  await openFromShelf(bob);
  await expect(bob.getByText('Box 1').first()).toBeVisible({
    timeout: SYNC_BUDGET_MS
  });
  return { server, alice, bob, aliceContext, bobContext, projectId, errors };
}

/** Opens the shared project from the shelf. */
export async function openFromShelf(page: Page) {
  const card = page.locator('.start-tile-project', { hasText: PROJECT_NAME });
  await expect(card).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await card.locator('.start-tile-open').click();
  await expect(page.locator('.breadcrumb')).toContainText(PROJECT_NAME, {
    timeout: SYNC_BUDGET_MS
  });
}

/** The workspace-mode switch's Build button. */
export const buildButton = (page: Page) =>
  page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name: 'Build' });

/** Who signed each stored version of the project, oldest first. */
export function versionSigners(server: E2eeServer, projectId: string) {
  return (
    server.db
      .prepare(
        `SELECT signer_user_id FROM e2ee_project_versions
         WHERE project_id = ? ORDER BY document_version`
      )
      .all(projectId) as { signer_user_id: string }[]
  ).map((row) => row.signer_user_id);
}

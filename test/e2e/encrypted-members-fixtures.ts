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

/**
 * Connects a signed-in context to the encrypted room (slice 5-6,
 * `encrypted-room-fixtures.ts`): called after `stubApi`, with the page's
 * real WebSocket back in place.
 */
export type LiveRoom = (
  context: BrowserContext,
  page: Page,
  userId: string
) => Promise<void>;

export async function signIn(
  context: BrowserContext,
  server: E2eeServer,
  userId: string,
  email: string,
  room?: LiveRoom
): Promise<Page> {
  const page = await context.newPage();
  if (room) {
    // stubApi replaces the page's WebSocket with a static stand-in; a page
    // that talks to the room keeps the real one.
    await page.addInitScript(() => {
      (window as unknown as { __nativeSocket: unknown }).__nativeSocket =
        window.WebSocket;
    });
  }
  await stubApi(page);
  if (room) {
    await page.addInitScript(() => {
      window.WebSocket = (
        window as unknown as { __nativeSocket: typeof WebSocket }
      ).__nativeSocket;
    });
    await room(context, page, userId);
  }
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
  /** Alice's recovery key, which signs her contacts entries. */
  aliceRecoveryKey: string;
  /** Connects each signed-in context to the encrypted room (slice 5-6). */
  room?: LiveRoom;
}

export interface SharedWorldOptions {
  /** The server, when the caller wires something to it first. */
  server?: E2eeServer;
  /** Connects every signed-in context to the encrypted room (slice 5-6). */
  room?: LiveRoom;
}

/**
 * Alice's encrypted project with one Box, Bob a member of it in `role`
 * (invited, accepted, verified both ways, added by Alice's MLS Commit), and
 * Bob's page showing the project.
 */
export async function shareWithBob(
  browser: Browser,
  role: 'editor' | 'viewer',
  options: SharedWorldOptions = {}
): Promise<SharedWorld> {
  const server = options.server ?? createE2eeServer({ projectsEnabled: true });
  server.db
    .prepare('UPDATE users SET email = ? WHERE id = ?')
    .run(ALICE_EMAIL, E2E_USER_ID);
  const aliceContext = await browser.newContext();
  const errors: string[] = [];
  const alice = await signIn(
    aliceContext,
    server,
    E2E_USER_ID,
    ALICE_EMAIL,
    options.room
  );
  alice.on('pageerror', (error) => errors.push(error.message));

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
  const projectId = (
    server.db.prepare('SELECT id FROM projects').get() as { id: string }
  ).id;

  const world = {
    server,
    alice,
    aliceContext,
    projectId,
    errors,
    aliceRecoveryKey: aliceSeed.recoveryKey,
    ...(options.room ? { room: options.room } : {})
  };
  const bob = await addSharedMember(browser, world, {
    userId: BOB_ID,
    email: BOB_EMAIL,
    label: 'Bob browser',
    role
  });
  return { ...world, bob: bob.page, bobContext: bob.context };
}

/**
 * One more member of Alice's project, in a browser context of its own:
 * Alice invites it in `role` from the sharing dialog (an encrypted
 * project's editors need no edit-lease rollout, slice 5-4), it accepts
 * after setting up encryption, both verify each other by digit groups, and
 * Alice's browser adds it by an MLS Commit. Its page then shows the
 * project.
 */
export async function addSharedMember(
  browser: Browser,
  world: Omit<SharedWorld, 'bob' | 'bobContext'>,
  member: {
    userId: string;
    email: string;
    label: string;
    role: 'editor' | 'viewer';
  }
): Promise<{ page: Page; context: BrowserContext }> {
  const { server, alice, projectId, errors } = world;
  const { role } = member;
  addE2eeUser(server, member.userId, member.email);
  const context = await browser.newContext();
  const page = await signIn(
    context,
    server,
    member.userId,
    member.email,
    world.room
  );
  page.on('pageerror', (error) => errors.push(error.message));
  const invitations = server.mailbox.length;

  await alice.getByRole('button', { name: /Open project sharing/ }).click();
  const dialog = alice.getByRole('dialog', { name: 'Project sharing' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Email').fill(member.email);
  await dialog.getByLabel('Role', { exact: true }).selectOption(role);
  await dialog.getByRole('button', { name: 'Invite' }).click();
  await expect(dialog.getByText('Invitation sent.')).toBeVisible({
    timeout: SYNC_BUDGET_MS
  });
  await expect.poll(() => server.mailbox.length).toBe(invitations + 1);
  await dialog.getByRole('button', { name: 'Close sharing' }).click();

  // The member opens the link, is sent to set up encryption, and accepts.
  await page.goto(`/#encrypted-invite=${server.mailbox.at(-1)!.token}`);
  await expect(
    page
      .getByRole('dialog', { name: 'Settings' })
      .getByRole('button', { name: 'Set up encryption' })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  const seed = await seedE2eeDevice(page, server, {
    label: member.label,
    userId: member.userId
  });
  await page.reload();
  const encryption = await openEncryptionSettings(page);
  await encryption.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(
    encryption.getByText(
      `${ALICE_EMAIL} invited you as ${role === 'editor' ? 'an editor' : 'a viewer'}`
    )
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await encryption
    .getByRole('button', { name: `Verify ${ALICE_EMAIL}` })
    .first()
    .click();
  await verifyContact(encryption, ALICE_EMAIL, seed.recoveryKey);
  await expect(
    encryption.getByText(
      'Your keys are ready. Waiting for them to verify you and add you.'
    )
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });

  // Alice verifies the member; her browser adds it by an MLS Commit.
  await alice.getByRole('button', { name: /Open project sharing/ }).click();
  await dialog.getByRole('button', { name: /^Verify / }).click();
  const aliceEncryption = alice.getByRole('dialog', { name: 'Settings' });
  await verifyContact(aliceEncryption, member.email, world.aliceRecoveryKey);
  await expect
    .poll(
      () =>
        server.db
          .prepare(
            'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?'
          )
          .get(projectId, member.userId),
      { timeout: COMMIT_BUDGET_MS }
    )
    .toEqual({ role });
  await closeSettings(alice);

  // The member opens the project from its shelf.
  await page.reload();
  await expect(
    page
      .getByRole('dialog', { name: 'Settings' })
      .or(page.getByRole('button', { name: 'Open settings' }))
      .first()
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  await closeSettings(page);
  await openFromShelf(page);
  await expect(page.getByText('Box 1').first()).toBeVisible({
    timeout: SYNC_BUDGET_MS
  });
  return { page, context };
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

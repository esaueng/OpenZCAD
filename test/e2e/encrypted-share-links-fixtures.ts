import { readFileSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import {
  handleEncryptedSharedBlob,
  handleEncryptedSharedSnapshot
} from '../../apps/web/worker/e2eeShareLinks';
import { d1Database } from '../d1-sqlite';
import {
  createPrimitiveInPlace,
  expect,
  expectBodyCount,
  stubAnonymousApi
} from './openzcad-fixtures';
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
  installUploadRoutes,
  openEncryptionSettings,
  seedE2eeDevice,
  type E2eeServer
} from './e2ee-fixtures';

/**
 * Share links of end-to-end encrypted projects in the browser (ADR-024
 * Phase 5): the owner's side (slice 5-10, `encrypted-share-links-owner.
 * spec.ts`) and the visitor's (slice 5-11, `encrypted-share-links.spec.ts`).
 * The real `/api/e2ee/*` routes run over SQLite, the owner's browser runs
 * the real MLS Worker, and a visitor's context reaches only the anonymous
 * routes, as the Worker serves them.
 */

export const STEP = readFileSync('test/parity/corpus/b-unit-mm-cube.step');

/** The anonymous route, as the Worker serves `GET /api/e2ee/share/:token`. */
export function anonymousSnapshot(server: E2eeServer, token: string) {
  return handleEncryptedSharedSnapshot(
    `/api/e2ee/share/${token}`,
    d1Database(server.db),
    server.bucket as never,
    true
  );
}

/**
 * Routes a visitor context's `/api/e2ee/share/…` calls (the snapshot and
 * its content blobs) to the Worker's anonymous handlers. Nothing else of
 * `/api/e2ee` is served to it: a visitor has no session.
 */
export async function installAnonymousShareRoutes(
  context: BrowserContext,
  server: E2eeServer
): Promise<void> {
  await context.route('**/api/e2ee/share/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const db = d1Database(server.db);
    const response = pathname.includes('/blobs/')
      ? await handleEncryptedSharedBlob(
          pathname,
          db,
          server.bucket as never,
          server.bucket as never,
          true
        )
      : await handleEncryptedSharedSnapshot(
          pathname,
          db,
          server.bucket as never,
          true
        );
    await route.fulfill({
      status: response.status,
      contentType: response.headers.get('content-type') ?? 'application/json',
      body: Buffer.from(await response.arrayBuffer())
    });
  });
}

export interface OwnerWithLink {
  server: E2eeServer;
  context: BrowserContext;
  alice: Page;
  errors: string[];
  /** The encrypted share links section of the open sharing dialog. */
  links: ReturnType<Page['getByRole']>;
  dialog: ReturnType<Page['getByRole']>;
  /** The link the dialog created. */
  link: string;
}

/**
 * Alice's encrypted project, saved: one Box, or (`content: 'step'`) one
 * imported STEP file stored as an encrypted content blob. She confirms
 * sharing with the recovery key and creates a link from the sharing
 * dialog, which stays open.
 */
export async function ownerWithShareLink(
  browser: Browser,
  {
    content = 'box',
    viewport,
    hasTouch = false
  }: {
    content?: 'box' | 'step';
    viewport?: { width: number; height: number };
    hasTouch?: boolean;
  } = {}
): Promise<OwnerWithLink> {
  const server = createE2eeServer({ projectsEnabled: true });
  server.db
    .prepare('UPDATE users SET email = ? WHERE id = ?')
    .run(ALICE_EMAIL, E2E_USER_ID);
  const context = await browser.newContext({ viewport, hasTouch });
  const alice = await signIn(context, server, E2E_USER_ID, ALICE_EMAIL);
  await installUploadRoutes(alice, server);
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
  if (content === 'step') {
    await alice.getByLabel(/^Import FreeCAD, STEP or /).setInputFiles({
      name: 'secret-cube.step',
      mimeType: 'application/step',
      buffer: STEP
    });
    await expectBodyCount(alice, 1);
  } else {
    await createPrimitiveInPlace(alice, 'box');
  }
  await expect(
    alice.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  if (content === 'step') {
    await expect
      .poll(
        () =>
          (
            server.db
              .prepare('SELECT COUNT(*) AS n FROM e2ee_version_blobs')
              .get() as { n: number }
          ).n,
        { timeout: SYNC_BUDGET_MS }
      )
      .toBeGreaterThan(0);
  }

  await alice.getByRole('button', { name: /Open project sharing/ }).click();
  const dialog = alice.getByRole('dialog', { name: 'Project sharing' });
  const links = dialog.getByRole('region', { name: 'Encrypted share links' });
  await expect(links.getByText('No links yet.')).toBeVisible({
    timeout: SYNC_BUDGET_MS
  });

  // Sharing needs the identity key's confirmation (the share delegation).
  await expect(
    links.getByRole('button', { name: 'Create link' })
  ).toBeDisabled();
  const confirmSharing = links.getByRole('button', {
    name: 'Confirm sharing…'
  });
  // Opacity-zero controls still pass toBeVisible and click in Playwright.
  // The owner must be able to discover confirmation without hover or focus.
  await alice.mouse.move(0, 0);
  await expect(confirmSharing).toHaveCSS('opacity', '1');
  await confirmSharing.click();
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
  return {
    server,
    context,
    alice,
    errors,
    links,
    dialog,
    link: await url.inputValue()
  };
}

export interface Visitor {
  context: BrowserContext;
  page: Page;
  errors: string[];
  /** Every `/api/…` path this visitor's page requested. */
  requests: string[];
}

/**
 * A visitor in a fresh context, signed out, opening `link`. With
 * `clockOffsetMs`, the page's clock runs that far ahead of the owner's.
 */
export async function openAsVisitor(
  browser: Browser,
  server: E2eeServer,
  link: string,
  { clockOffsetMs = 0 }: { clockOffsetMs?: number } = {}
): Promise<Visitor> {
  const context = await browser.newContext();
  if (clockOffsetMs) {
    await context.addInitScript((offset) => {
      const now = Date.now.bind(Date);
      Date.now = () => now() + offset;
    }, clockOffsetMs);
  }
  const page = await context.newPage();
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/')) requests.push(pathname);
  });
  await stubAnonymousApi(page);
  await installAnonymousShareRoutes(context, server);
  await page.goto(link);
  return { context, page, errors, requests };
}

import type { BrowserContext, Page, Request } from '@playwright/test';
import { withEncryptedProjectInfo } from '../../apps/web/worker/e2eeProjectDocuments';
import { d1Database } from '../d1-sqlite';
import {
  createPrimitiveInPlace,
  expect,
  stubApi,
  test
} from './openzcad-fixtures';
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
 * ADR-024 Phase 5, slice 5-3b, with the 2026-11-25 trust-on-first-use
 * amendment: the owner invites someone to an end-to-end encrypted project
 * from the sharing dialog; the invitee, sent to set up encryption first,
 * has the opened link accepted with no further click; nobody compares
 * codes; the invitee's browser publishes its KeyPackage, the owner's adds
 * it by an MLS Commit with the role (shown Not verified), and the invitee
 * opens the project from the shelf and decrypts it. The real
 * `/api/e2ee/*` Worker routes run over SQLite; each browser runs the real
 * MLS Worker.
 */

/** Autosave waits out a 3 s idle delay; the MLS Worker starts on first use. */
const SYNC_BUDGET_MS = 30_000;
/**
 * The owner's Add: checks the invitee's contact and KeyPackages, catches
 * up, builds the Commit and its key archive, over routed requests.
 */
const ADD_BUDGET_MS = 90_000;

const ALICE_EMAIL = 'alice@example.com';
const BOB_ID = 'user_bob_e2e';
const BOB_EMAIL = 'bob@example.com';

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

async function signIn(
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
async function closeSettings(page: Page) {
  const settings = page.getByRole('dialog', { name: 'Settings' });
  for (let attempt = 0; attempt < 3 && (await settings.count()); attempt++) {
    await page.keyboard.press('Escape');
  }
  await expect(settings).toHaveCount(0);
}

test(
  'invites to an encrypted project, adds the invitee on first use with no code comparison, and opens it as them',
  { tag: '@ci-smoke' },
  async ({ browser }) => {
    test.setTimeout(240_000);
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
    await seedE2eeDevice(alice, server, { label: 'Alice browser' });
    const aliceSettings = await openEncryptionSettings(alice);
    const toggle = aliceSettings.getByRole('checkbox', {
      name: 'Encrypt new projects'
    });
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(toggle).toBeChecked();
    // One Escape can land while the toggle's save still holds focus.
    await closeSettings(alice);
    await alice.getByLabel('Project name').fill('Secret bracket');
    await alice.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(alice, 'box');
    await expect(
      alice.getByRole('status', { name: 'Saved', exact: true })
    ).toBeVisible({ timeout: SYNC_BUDGET_MS });

    // She invites Bob from the sharing dialog: the encrypted branch.
    // Design review I79 saw the Worker's format-gate refusal in a red banner
    // and suspected a plaintext sharing call. The dialog reads only the
    // metadata route the gate lets through; every other call is encrypted.
    const plaintextCalls: string[] = [];
    const recordPlaintext = (request: Request) => {
      const path = new URL(request.url()).pathname;
      // `/api/share` and `/api/share/…` are the plaintext share routes; the
      // sealed link-names record (`/api/share-link-names`) is not one.
      if (/^\/api\/(projects\/proj_|share(?:\/|$))/.test(path)) {
        plaintextCalls.push(`${request.method()} ${path}`);
      }
    };
    alice.on('request', recordPlaintext);
    await alice.getByRole('button', { name: /Open project sharing/ }).click();
    const dialog = alice.getByRole('dialog', { name: 'Project sharing' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: /^Links/ }).click();
    await expect(
      dialog.getByRole('region', { name: 'Encrypted share links' })
    ).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    alice.off('request', recordPlaintext);
    expect(
      plaintextCalls.filter(
        (call) => !/^GET \/api\/projects\/proj_[^/]+\/sharing$/.test(call)
      )
    ).toEqual([]);
    // Its only link is an encrypted one (slice 5-10), never a plaintext one.
    await expect(
      dialog.getByRole('region', { name: 'Encrypted share links' })
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Create link' })
    ).toHaveCount(1);
    await dialog.getByRole('tab', { name: /^People/ }).click();
    await dialog.getByLabel('Email').fill(BOB_EMAIL);
    // Editor invitations need enforced edit leases (the plaintext rule the
    // encrypted route shares), which this static preview does not run.
    await expect(dialog.getByLabel('Role')).toHaveValue('viewer');
    await dialog.getByRole('button', { name: 'Invite' }).click();
    await expect(dialog.getByText('Invitation sent.')).toBeVisible({
      timeout: SYNC_BUDGET_MS
    });
    await expect(dialog.getByText(/^Invited · Viewer · 7d$/)).toBeVisible();
    expect(server.mailbox.map((mail) => mail.to)).toEqual([BOB_EMAIL]);
    const projectId = (
      server.db.prepare('SELECT id FROM projects').get() as { id: string }
    ).id;
    // The server holds the email's hash, never the address.
    expect(
      JSON.stringify(server.db.prepare('SELECT * FROM e2ee_invitations').all())
    ).not.toContain(BOB_EMAIL);
    await dialog.getByRole('button', { name: 'Close sharing' }).click();

    // Bob opens the emailed link without keys: he is sent to set them up.
    await bob.goto(`/#encrypted-invite=${server.mailbox[0]!.token}`);
    const bobSettings = bob.getByRole('dialog', { name: 'Settings' });
    await expect(
      bobSettings.getByText(
        'You were invited to an end-to-end encrypted project. Set up encryption on this device first: the invitation is then accepted here.'
      )
    ).toBeVisible({ timeout: SYNC_BUDGET_MS });
    await expect(
      bobSettings.getByRole('button', { name: 'Set up encryption' })
    ).toBeVisible();
    expect(new URL(bob.url()).hash).toBe('');

    // Set up (seeded), he comes back: the link he opened is his acceptance,
    // so there is no Accept click, and nobody compares codes.
    await seedE2eeDevice(bob, server, { label: 'Bob browser', userId: BOB_ID });
    await bob.reload();
    const bobEncryption = await openEncryptionSettings(bob);
    await expect(
      bobEncryption.getByText(
        'Your keys are ready. Waiting for them to add you.'
      )
    ).toBeVisible({ timeout: SYNC_BUDGET_MS });
    await expect(
      bobEncryption.getByRole('button', { name: 'Accept invitation' })
    ).toHaveCount(0);
    expect(
      server.db
        .prepare('SELECT user_id, consumed_at FROM e2ee_key_packages')
        .all()
    ).toEqual([{ user_id: BOB_ID, consumed_at: null }]);
    await closeSettings(bob);

    // Alice's sharing dialog adds Bob on first use by an MLS Commit with the
    // role: no verification, no confirm-add card.
    await alice.getByRole('button', { name: /Open project sharing/ }).click();
    await expect
      .poll(
        () =>
          server.db
            .prepare(
              'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?'
            )
            .get(projectId, BOB_ID),
        { timeout: ADD_BUDGET_MS }
      )
      .toEqual({ role: 'viewer' });
    expect(
      server.db
        .prepare(
          'SELECT user_id, device_id FROM e2ee_welcomes WHERE project_id = ?'
        )
        .all(projectId)
    ).toHaveLength(1);
    // Nobody signed a verification into a contacts list.
    expect(
      server.db.prepare('SELECT COUNT(*) AS n FROM e2ee_contact_entries').get()
    ).toEqual({ n: 0 });
    await expect(dialog.getByRole('group', { name: /^Confirm / })).toHaveCount(
      0
    );
    await dialog.getByRole('button', { name: 'Close sharing' }).click();
    await alice.getByRole('button', { name: /Open project sharing/ }).click();
    await expect(dialog.getByText(BOB_EMAIL)).toHaveCount(0);
    await expect(dialog.getByText('Collaborator 1')).toBeVisible({
      timeout: SYNC_BUDGET_MS
    });
    // Shown Not verified, with a way to compare codes; nothing waits on it.
    await expect(dialog.getByText('Not verified')).toBeVisible({
      timeout: SYNC_BUDGET_MS
    });
    await expect(
      dialog.getByRole('button', { name: 'Verify Collaborator 1' })
    ).toBeVisible();
    await expect(dialog.getByText(/Waiting for/)).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close sharing' }).click();

    // Bob's shelf decrypts the shared project's name; he opens and reads it.
    await bob.reload();
    await expect(
      bob
        .getByRole('dialog', { name: 'Settings' })
        .or(bob.getByRole('button', { name: 'Open settings' }))
        .first()
    ).toBeVisible({ timeout: SYNC_BUDGET_MS });
    await closeSettings(bob);
    const card = bob.locator('.start-tile-project', {
      hasText: 'Secret bracket'
    });
    await expect(card).toBeVisible({ timeout: SYNC_BUDGET_MS });
    await card.locator('.start-tile-open').click();
    await expect(bob.locator('.breadcrumb')).toContainText('Secret bracket', {
      timeout: SYNC_BUDGET_MS
    });
    await expect(bob.getByText('Box 1').first()).toBeVisible({
      timeout: SYNC_BUDGET_MS
    });
    // His browser joined by its Welcome and posted his own wraps.
    expect(
      server.db
        .prepare(
          `SELECT COUNT(*) AS n FROM e2ee_project_keys
         WHERE project_id = ? AND user_id = ?`
        )
        .get(projectId, BOB_ID)
    ).toEqual({ n: 2 });

    expect(errors).toEqual([]);
    await aliceContext.close();
    await bobContext.close();
  }
);

/**
 * A pin this browser kept for `userId`'s identity before (as the contact
 * pins record what a browser saw of someone), with another identity than
 * the one the server now shows: the next lookup is a key change.
 */
async function pinOtherIdentity(page: Page, ownerId: string, userId: string) {
  await page.evaluate(
    ([owner, contact]) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('openzcad-e2ee-contacts', 1);
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('lists'))
            db.createObjectStore('lists');
          if (!db.objectStoreNames.contains('contacts'))
            db.createObjectStore('contacts');
        };
        open.onerror = () =>
          reject(open.error ?? new Error('IndexedDB did not open'));
        open.onsuccess = () => {
          const tx = open.result.transaction('contacts', 'readwrite');
          tx.objectStore('contacts').put(
            {
              contactUserId: contact,
              identityKeyHash: 'ab'.repeat(32),
              sequence: 0,
              entryHash: '00'.repeat(32),
              keyChanged: false,
              seenAt: Date.now()
            },
            [owner, contact]
          );
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
          tx.onerror = () =>
            reject(tx.error ?? new Error('IndexedDB write failed'));
        };
      }),
    [ownerId, userId] as const
  );
}

test(
  'blocks the automatic add of an invitee whose keys changed until the owner trusts the new keys',
  { tag: '@ci-smoke' },
  async ({ browser }) => {
    test.setTimeout(240_000);
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
    await alice.goto('/');
    await seedE2eeDevice(alice, server, { label: 'Alice browser' });
    const aliceSettings = await openEncryptionSettings(alice);
    const toggle = aliceSettings.getByRole('checkbox', {
      name: 'Encrypt new projects'
    });
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await closeSettings(alice);
    await alice.getByLabel('Project name').fill('Secret bracket');
    await alice.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(alice, 'box');
    await expect(
      alice.getByRole('status', { name: 'Saved', exact: true })
    ).toBeVisible({ timeout: SYNC_BUDGET_MS });
    const projectId = (
      server.db.prepare('SELECT id FROM projects').get() as { id: string }
    ).id;
    // Alice's browser saw another identity for Bob before.
    await pinOtherIdentity(alice, E2E_USER_ID, BOB_ID);

    await alice.getByRole('button', { name: /Open project sharing/ }).click();
    const dialog = alice.getByRole('dialog', { name: 'Project sharing' });
    await dialog.getByLabel('Email').fill(BOB_EMAIL);
    await dialog.getByRole('button', { name: 'Invite' }).click();
    await expect(dialog.getByText('Invitation sent.')).toBeVisible({
      timeout: SYNC_BUDGET_MS
    });
    await dialog.getByRole('button', { name: 'Close sharing' }).click();

    // Bob sets up and his opened link is accepted; his keys are published.
    await bob.goto(`/#encrypted-invite=${server.mailbox[0]!.token}`);
    await expect(
      bob
        .getByRole('dialog', { name: 'Settings' })
        .getByRole('button', { name: 'Set up encryption' })
    ).toBeVisible({ timeout: SYNC_BUDGET_MS });
    await seedE2eeDevice(bob, server, { label: 'Bob browser', userId: BOB_ID });
    await bob.reload();
    const bobEncryption = await openEncryptionSettings(bob);
    await expect(
      bobEncryption.getByText(
        'Your keys are ready. Waiting for them to add you.'
      )
    ).toBeVisible({ timeout: SYNC_BUDGET_MS });
    await closeSettings(bob);

    // Alice's dialog does not add him: his keys are not the ones her
    // browser pinned. Review and Trust new keys are offered.
    await alice.getByRole('button', { name: /Open project sharing/ }).click();
    const changed = dialog.getByRole('group', {
      name: "Invitation 1's encryption keys changed"
    });
    await expect(changed).toBeVisible({ timeout: ADD_BUDGET_MS });
    await expect(changed.getByRole('button', { name: 'Review' })).toBeVisible();
    const member = () =>
      server.db
        .prepare(
          'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?'
        )
        .get(projectId, BOB_ID);
    expect(member()).toBeUndefined();
    expect(
      server.db
        .prepare('SELECT COUNT(*) AS n FROM e2ee_welcomes WHERE project_id = ?')
        .get(projectId)
    ).toEqual({ n: 0 });

    // Trusting the new keys is a first use again: he is added.
    await changed.getByRole('button', { name: 'Trust new keys' }).click();
    await expect
      .poll(member, { timeout: ADD_BUDGET_MS })
      .toEqual({ role: 'viewer' });
    // The trust is the account's: recorded in its sealed first-use pins.
    expect(
      server.db
        .prepare(
          'SELECT COUNT(*) AS n FROM e2ee_first_use_pins WHERE user_id = ?'
        )
        .get(E2E_USER_ID)
    ).toEqual({ n: 1 });
    expect(errors).toEqual([]);
    await aliceContext.close();
    await bobContext.close();
  }
);

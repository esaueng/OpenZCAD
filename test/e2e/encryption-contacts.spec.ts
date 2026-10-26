import type { BrowserContext, Page } from '@playwright/test';
import { expect, stubApi, test } from './openzcad-fixtures';
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
 * ADR-024 Phase 5, slice 5-1: two accounts that share a project verify each
 * other in Settings › Encryption › Contacts by comparing digit groups, each
 * signing the verification into their own contacts list with the recovery
 * key, over the real Worker routes.
 */

const BOB_ID = 'user_bob_e2e';
const ALICE_EMAIL = 'alice@example.com';
const BOB_EMAIL = 'bob@example.com';

async function signIn(
  context: BrowserContext,
  server: E2eeServer,
  userId: string
): Promise<Page> {
  const page = await context.newPage();
  await stubApi(page);
  if (userId !== E2E_USER_ID) {
    // Routes registered later win: this page is signed in as `userId`.
    await page.route('**/api/session', (route) =>
      route.fulfill({
        json: { userId, displayName: 'Bob', mode: 'development' }
      })
    );
  }
  await installE2eeServer(context, server, userId);
  await page.goto('/');
  return page;
}

test('two accounts verify each other by comparing digit groups', async ({
  browser
}) => {
  const server = createE2eeServer();
  server.db
    .prepare('UPDATE users SET email = ? WHERE id = ?')
    .run(ALICE_EMAIL, E2E_USER_ID);
  addE2eeUser(server, BOB_ID, BOB_EMAIL);
  server.db
    .prepare(
      `INSERT INTO projects (id, user_id, name, document_json, updated_at)
       VALUES ('proj_shared', ?, 'Shared', '{}', ?)`
    )
    .run(E2E_USER_ID, new Date().toISOString());
  server.db
    .prepare(
      `INSERT INTO project_members
         (project_id, user_id, role, added_by_user_id, created_at, updated_at)
       VALUES ('proj_shared', ?, 'editor', ?, 1, 1)`
    )
    .run(BOB_ID, E2E_USER_ID);

  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await signIn(aliceContext, server, E2E_USER_ID);
  const bob = await signIn(bobContext, server, BOB_ID);
  const aliceSeed = await seedE2eeDevice(alice, server, {
    label: 'Alice browser'
  });
  const bobSeed = await seedE2eeDevice(bob, server, {
    label: 'Bob browser',
    userId: BOB_ID
  });
  const aliceSettings = await openEncryptionSettings(alice);
  const bobSettings = await openEncryptionSettings(bob);
  for (const settings of [aliceSettings, bobSettings]) {
    await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
    await expect(settings.getByText('0 verified')).toBeVisible();
  }

  // Each opens the other; nobody is verified yet, only seen.
  await aliceSettings
    .getByRole('button', { name: `Verify ${BOB_EMAIL}` })
    .click();
  await bobSettings
    .getByRole('button', { name: `Verify ${ALICE_EMAIL}` })
    .click();
  const code = (settings: typeof aliceSettings, label: string) =>
    settings.getByLabel(label, { exact: true });
  const digits = /^(\d{5} ){7}\d{5}$/;
  // Bob reads his code; Alice's screen shows the same digits for him.
  const bobReads = (await code(
    bobSettings,
    'Your contact code'
  ).textContent())!;
  expect(bobReads).toMatch(digits);
  await expect(code(aliceSettings, `${BOB_EMAIL}’s contact code`)).toHaveText(
    bobReads
  );
  await expect(code(bobSettings, 'Your code to read')).toHaveText(bobReads);
  // Alice reads hers back in the same call.
  const aliceReads = (await code(
    aliceSettings,
    'Your contact code'
  ).textContent())!;
  expect(aliceReads).toMatch(digits);
  expect(aliceReads).not.toBe(bobReads);
  await expect(code(bobSettings, `${ALICE_EMAIL}’s contact code`)).toHaveText(
    aliceReads
  );
  await expect(code(aliceSettings, 'Your code to read')).toHaveText(aliceReads);

  // Both codes match: each signs the verification with the recovery key.
  for (const [settings, name, recoveryKey] of [
    [aliceSettings, BOB_EMAIL, aliceSeed.recoveryKey],
    [bobSettings, ALICE_EMAIL, bobSeed.recoveryKey]
  ] as const) {
    await settings
      .getByRole('button', { name: 'Codes match — verify' })
      .click();
    const confirm = settings.getByRole('group', { name: `Verify ${name}` });
    await confirm.getByLabel('Recovery key').fill(recoveryKey);
    await confirm.getByRole('button', { name: 'Verify contact' }).click();
    await expect(
      settings.getByRole('button', { name: 'Stop trusting' })
    ).toBeVisible();
    await expect(settings.getByText('1 verified')).toBeVisible();
  }
  expect(
    server.db
      .prepare(
        'SELECT user_id, sequence FROM e2ee_contact_entries ORDER BY user_id'
      )
      .all()
  ).toEqual([
    { user_id: BOB_ID, sequence: 0 },
    { user_id: E2E_USER_ID, sequence: 0 }
  ]);

  // A reload keeps the verification: it comes from the signed list.
  await alice.reload();
  const reloaded = await openEncryptionSettings(alice);
  await expect(reloaded.getByText('1 verified')).toBeVisible();
  await expect(reloaded.getByText('Verified', { exact: true })).toBeVisible();

  await aliceContext.close();
  await bobContext.close();
});

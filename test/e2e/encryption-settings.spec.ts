import { expect, stubApi, test } from './openzcad-fixtures';
import {
  createE2eeServer,
  installE2eeServer,
  finishSetupDialog,
  lastRecoveryGroup,
  openEncryptionSettings,
  seedE2eeDevice
} from './e2ee-fixtures';

test('shows the reload instruction when automatic migration fails to download', async ({
  page,
  context
}) => {
  await stubApi(page);
  await installE2eeServer(context, createE2eeServer());
  await page.route('**/api/e2ee/config', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        projectsEnabled: true,
        migrationEnabled: true,
        defaultOn: true
      }
    })
  );
  await page.route(/\/assets\/projectMigrations-[^/]+\.js$/, (route) =>
    route.abort('failed')
  );
  const cloudSave = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/settings' &&
      response.request().method() === 'PATCH'
  );
  await page.goto('/');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible({ timeout: 15_000 });
  // A later successful profile save must not replace the reload instruction.
  await cloudSave;
  await expect(settings).toContainText(
    'Automatic encryption could not load. Reload to try again.'
  );
});

// Every CI run includes these (`@ci-smoke`): untagged, they ran only when
// this file changed, so #1418 broke them unseen. It loaded the migration
// controller before checking any gate, and a blocked chunk opened Settings.
for (const available of [false, 'older-server'] as const) {
  test(
    `does not load optional migration code or open Settings with closed gates: ${available}`,
    { tag: '@ci-smoke' },
    async ({ page, context }) => {
      await stubApi(page);
      await installE2eeServer(context, createE2eeServer());
      let checks = 0;
      await page.route('**/api/e2ee/config', (route) => {
        checks++;
        return available === 'older-server'
          ? route.fulfill({ status: 404, json: { error: 'Not found' } })
          : route.fulfill({
              json: {
                enabled: true,
                projectsEnabled: true,
                migrationEnabled: true,
                defaultOn: false
              }
            });
      });
      let optionalRequests = 0;
      await page.route(
        /\/assets\/(?:automaticMigration|projectMigrations)-[^/]+\.js$/,
        (route) => {
          optionalRequests++;
          return route.abort('failed');
        }
      );
      await page.goto('/');
      await expect(
        page.getByRole('button', { name: 'Open settings' })
      ).toBeVisible();
      await expect.poll(() => checks).toBeGreaterThan(0);
      await expect(
        page.getByRole('dialog', { name: 'Settings', exact: true })
      ).toHaveCount(0);
      expect(optionalRequests).toBe(0);
    }
  );
}

test('rechecks default-on after reconnect and opens setup without reloading', async ({
  page,
  context
}) => {
  await stubApi(page);
  await installE2eeServer(
    context,
    createE2eeServer({ projectsEnabled: true, migrationEnabled: true })
  );
  let online = false;
  let checks = 0;
  await page.route('**/api/e2ee/config', (route) => {
    checks++;
    return online
      ? route.fulfill({
          json: {
            enabled: true,
            projectsEnabled: true,
            migrationEnabled: true,
            defaultOn: true
          }
        })
      : route.abort('failed');
  });
  await page.goto('/');
  await expect.poll(() => checks).toBeGreaterThan(0);
  await expect(
    page.getByRole('dialog', { name: 'Settings', exact: true })
  ).toHaveCount(0);
  online = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(
    settings.getByRole('button', { name: 'Set up encryption', exact: true })
  ).toBeVisible();
});

test('default-on opens Encryption setup immediately when Settings was closed', async ({
  page,
  context
}) => {
  await stubApi(page);
  await installE2eeServer(
    context,
    createE2eeServer({ projectsEnabled: true, migrationEnabled: true })
  );
  await page.route('**/api/e2ee/config', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true,
        projectsEnabled: true,
        migrationEnabled: true,
        defaultOn: true
      })
    })
  );
  await page.goto('/');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible({ timeout: 15_000 });
  await expect(
    settings.getByRole('button', { name: 'Set up encryption', exact: true })
  ).toBeVisible();
});

test('hides Encryption while the server keeps the beta closed', async ({
  page,
  context
}) => {
  await stubApi(page);
  await installE2eeServer(context, createE2eeServer({ enabled: false }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(
    settings.getByRole('button', { name: 'Account', exact: true })
  ).toBeVisible();
  await expect(
    settings.getByRole('button', { name: 'Encryption', exact: true })
  ).toHaveCount(0);
});

test('sets up with a recovery key only after its last group is typed back', async ({
  page,
  context
}) => {
  const server = createE2eeServer();
  await stubApi(page);
  await installE2eeServer(context, server);
  await page.goto('/');
  const settings = await openEncryptionSettings(page);
  await settings.getByRole('button', { name: 'Set up encryption' }).click();
  const intro = settings.getByRole('dialog', { name: 'Turn on encryption' });
  // The first screen says plainly what losing every way in costs (I80),
  // passkeys included, before any key exists.
  await expect(intro).toContainText(
    'If you lose every device, every passkey and the recovery key, your encrypted cloud projects can’t be recovered, by you or by us.'
  );
  await intro
    .getByRole('button', { name: 'Use a recovery key only', exact: true })
    .or(intro.getByRole('button', { name: 'Continue', exact: true }))
    .click();

  const setup = settings.getByRole('dialog', {
    name: 'Save your recovery key'
  });
  const shown = setup.getByLabel('Recovery key', { exact: true });
  const recoveryKey = (await shown.textContent())!;
  expect(recoveryKey).toMatch(/^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/);
  const turnOn = setup.getByRole('button', { name: 'Turn on encryption' });
  await expect(turnOn).toBeDisabled();
  await setup
    .getByRole('checkbox', { name: /I saved my recovery key/ })
    .check();
  // The group asked for is hidden, so it is read from the saved copy (D2).
  await expect(shown).toHaveText(`${recoveryKey.slice(0, -4)}••••`);

  // A group that does not match is refused at its field; nothing is set up.
  const confirm = setup.getByLabel('Last group of your recovery key');
  const last = recoveryKey.slice(-4);
  await confirm.fill(last === '0000' ? '1111' : '0000');
  await turnOn.click();
  await expect(confirm).toHaveAttribute('aria-invalid', 'true');
  await expect(setup.getByRole('alert')).toContainText(
    'That does not match. Check the copy you saved.'
  );
  expect(
    server.db.prepare('SELECT COUNT(*) AS n FROM e2ee_identities').get()
  ).toEqual({ n: 0 });

  await confirm.fill(last.toLowerCase());
  await turnOn.click();
  await finishSetupDialog(settings);
  await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
  await expect(settings.getByText('Encryption is on')).toBeVisible();
  // The fingerprint is for comparing your own devices, so it lives under
  // Advanced; people compare the contact code (design review I76).
  await expect(settings.getByLabel('Your fingerprint')).toBeHidden();
  await settings.getByText('Advanced encryption settings').click();
  await expect(settings.getByLabel('Your fingerprint')).toHaveText(
    /^(\d{5} ){7}\d{5}$/
  );
  // Replacing keys makes a new identity, so the hint must not call it fixed.
  await expect(settings).toContainText(
    'Changes only when you replace your keys.'
  );
  // The server holds wrapped keys only.
  const wraps = server.db
    .prepare('SELECT purpose FROM e2ee_key_wraps ORDER BY purpose')
    .all() as { purpose: string }[];
  expect(wraps.map((row) => row.purpose)).toEqual([
    'account-key',
    'account-key',
    'encryption-key',
    'identity-key',
    'unlock-target-key'
  ]);

  // A reload unlocks again from this device's key alone.
  await page.reload();
  const again = await openEncryptionSettings(page);
  await expect(again.getByText('Unlocked', { exact: true })).toBeVisible();
});

// Design review I75: setup said "Encryption is on" while new projects were
// still created unencrypted. Setup now ends with "Encrypt new projects",
// ticked by default (owner decision 2026-11-16).
test('ends setup by encrypting new projects, ticked by default', async ({
  page,
  context
}) => {
  const server = createE2eeServer({ projectsEnabled: true });
  await stubApi(page);
  await installE2eeServer(context, server);
  await page.goto('/');
  const settings = await openEncryptionSettings(page);
  await settings.getByRole('button', { name: 'Set up encryption' }).click();
  const intro = settings.getByRole('dialog', { name: 'Turn on encryption' });
  await intro
    .getByRole('button', { name: 'Use a recovery key only', exact: true })
    .or(intro.getByRole('button', { name: 'Continue', exact: true }))
    .click();
  const recoveryKey = (await settings
    .getByLabel('Recovery key', { exact: true })
    .textContent())!;
  await settings
    .getByRole('checkbox', { name: /I saved my recovery key/ })
    .check();
  await settings
    .getByLabel('Last group of your recovery key')
    .fill(lastRecoveryGroup(recoveryKey));
  await settings.getByRole('button', { name: 'Turn on encryption' }).click();
  const projects = settings.getByRole('dialog', { name: 'You’re set' });
  await expect(projects).toBeVisible({ timeout: 30_000 });
  const choice = projects.getByRole('checkbox', {
    name: /Encrypt new projects/
  });
  await expect(choice).toBeChecked();
  await projects.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(projects).toHaveCount(0);
  await expect(
    settings.getByRole('checkbox', { name: 'Encrypt new projects' })
  ).toBeChecked();
  await expect(settings.getByText('Encryption is on')).toBeVisible();
  expect(
    server.db
      .prepare(
        'SELECT encrypt_new_projects AS on_ FROM e2ee_project_preferences'
      )
      .get()
  ).toEqual({ on_: 1 });
});

test('removes another device with the recovery key and rotates the keys', async ({
  page,
  context
}) => {
  const server = createE2eeServer();
  await stubApi(page);
  await installE2eeServer(context, server);
  await page.goto('/');
  const seeded = await seedE2eeDevice(page, server, {
    label: 'This browser',
    otherDevices: ['Old laptop']
  });
  const settings = await openEncryptionSettings(page);
  await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
  await expect(settings.getByText('Old laptop')).toBeVisible();
  const before = server.db
    .prepare('SELECT COUNT(*) AS n FROM e2ee_key_wraps')
    .get() as { n: number };

  await settings.getByRole('button', { name: 'Remove Old laptop' }).click();
  const recoveryKey = settings.getByLabel('Recovery key', { exact: true });
  // A mistyped key is said under the field, not in the page's top alert.
  await recoveryKey.fill('not-a-key');
  await settings.getByRole('button', { name: 'Remove device' }).click();
  await expect(recoveryKey).toHaveAttribute('aria-invalid', 'true');
  await expect(recoveryKey).toHaveAccessibleDescription(
    /^That is not a recovery key\./
  );
  await expect(settings.getByText('Old laptop', { exact: true })).toBeVisible();
  await recoveryKey.fill(seeded.recoveryKey);
  await expect(recoveryKey).not.toHaveAttribute('aria-invalid');
  await settings.getByRole('button', { name: 'Remove device' }).click();
  await expect(settings.getByText('Old laptop')).toHaveCount(0);
  await expect(settings.getByText('1 device', { exact: true })).toBeVisible();
  await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
  // The rotation replaced every account-key wrap; the removed device has none.
  const after = server.db
    .prepare('SELECT COUNT(*) AS n FROM e2ee_key_wraps')
    .get() as { n: number };
  expect(after.n).toBe(before.n - 1);
  expect(
    server.db
      .prepare('SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
      .get()
  ).toEqual({ n: 3 });
});

for (const deletionFails of [false, true]) {
  test(`asks at sign-out whether to keep this device unlocked${deletionFails ? ' and retries failed key deletion' : ''}`, async ({
    page,
    context
  }) => {
    const server = createE2eeServer();
    await stubApi(page);
    let logoutRequests = 0;
    const storedDeviceCount = () =>
      page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const open = indexedDB.open('openzcad-e2ee', 1);
            open.onsuccess = () => {
              const request = open.result
                .transaction('devices')
                .objectStore('devices')
                .count();
              request.onsuccess = () => {
                open.result.close();
                resolve(request.result);
              };
              request.onerror = () => reject(new Error('count failed'));
            };
            open.onerror = () => reject(new Error('open failed'));
          })
      );
    await page.route('**/api/auth/logout', async (route) => {
      logoutRequests += 1;
      expect(await storedDeviceCount()).toBe(0);
      await route.fulfill({ json: { ok: true } });
    });
    await installE2eeServer(context, server);
    await page.goto('/');
    await seedE2eeDevice(page, server);
    await page.getByRole('button', { name: 'Open settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings
      .getByRole('button', { name: 'Account', exact: true })
      .click();
    await settings.getByRole('button', { name: 'Sign out' }).click();
    await expect(settings.getByRole('alert')).toContainText(
      'Keep this device unlocked for your next sign-in?'
    );
    if (deletionFails) {
      await page.evaluate(() => {
        const remove = IDBObjectStore.prototype.delete;
        IDBObjectStore.prototype.delete = function (query) {
          if (this.name === 'devices') {
            IDBObjectStore.prototype.delete = remove;
            throw new DOMException(
              'Injected device deletion failure',
              'UnknownError'
            );
          }
          return remove.call(this, query);
        };
      });
    }
    await settings.getByRole('button', { name: 'Remove device keys' }).click();
    if (deletionFails) {
      await expect(
        settings.getByText(
          'Could not complete sign-out. Retry your device-key choice.'
        )
      ).toBeVisible();
      expect(logoutRequests).toBe(0);
      expect(await storedDeviceCount()).toBe(1);
      await expect(
        settings.getByRole('button', { name: 'Remove device keys' })
      ).toBeEnabled();
      await settings
        .getByRole('button', { name: 'Remove device keys' })
        .click();
    }
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            new Promise<number>((resolve, reject) => {
              const open = indexedDB.open('openzcad-e2ee', 1);
              open.onsuccess = () => {
                const request = open.result
                  .transaction('devices')
                  .objectStore('devices')
                  .count();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(new Error('count failed'));
              };
              open.onerror = () => reject(new Error('open failed'));
            })
        )
      )
      .toBe(0);
    await expect.poll(() => logoutRequests).toBe(1);
  });
}

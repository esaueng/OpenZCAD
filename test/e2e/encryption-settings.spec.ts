import { expect, stubApi, test } from './openzcad-fixtures';
import { loadEncryption } from '../../apps/web/src/lib/e2ee/accountKeys';
import {
  createE2eeServer,
  E2E_USER_ID,
  installE2eeServer,
  finishSetupDialog,
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

test('sets up encryption only after the recovery key is confirmed', async ({
  page,
  context
}) => {
  const server = createE2eeServer();
  await stubApi(page);
  await installE2eeServer(context, server);
  await page.goto('/');
  const settings = await openEncryptionSettings(page);
  await settings.getByRole('button', { name: 'Set up encryption' }).click();
  const setup = settings.getByRole('dialog', { name: 'Set up encryption' });
  // The first step says plainly what losing every way in costs (I80),
  // passkeys included, before any key exists.
  await expect(setup).toContainText(
    'If you lose every device, every passkey and the recovery key, your encrypted cloud projects can’t be recovered, by you or by us.'
  );
  await setup.getByRole('button', { name: 'Start' }).click();

  const recoveryKey = (await setup
    .getByLabel('Recovery key', { exact: true })
    .textContent())!;
  expect(recoveryKey).toMatch(/^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/);
  const proceed = setup.getByRole('button', { name: 'Continue' });
  await expect(proceed).toBeDisabled();
  await setup
    .getByRole('checkbox', { name: /I saved my recovery key/ })
    .check();
  await proceed.click();

  // A key that does not match is refused at its field; nothing is set up.
  const confirm = setup.getByLabel('Confirm recovery key');
  await confirm.fill(recoveryKey.replace(/^.{4}/, '0000'));
  await setup.getByRole('button', { name: 'Turn on encryption' }).click();
  await expect(confirm).toHaveAttribute('aria-invalid', 'true');
  await expect(setup.getByRole('alert')).toContainText(
    'That does not match. Go back and check what you saved.'
  );
  expect(
    server.db.prepare('SELECT COUNT(*) AS n FROM e2ee_identities').get()
  ).toEqual({ n: 0 });

  await confirm.fill(recoveryKey.toLowerCase().replaceAll('-', ' '));
  await setup.getByRole('button', { name: 'Turn on encryption' }).click();
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
  await settings.getByRole('button', { name: 'Start' }).click();
  const recoveryKey = (await settings
    .getByLabel('Recovery key', { exact: true })
    .textContent())!;
  await settings
    .getByRole('checkbox', { name: /I saved my recovery key/ })
    .check();
  await settings.getByRole('button', { name: 'Continue' }).click();
  await settings.getByLabel('Confirm recovery key').fill(recoveryKey);
  await settings.getByRole('button', { name: 'Turn on encryption' }).click();
  const skip = settings.getByRole('button', { name: 'Skip', exact: true });
  await expect(
    skip.or(settings.getByRole('dialog', { name: 'Your projects' })).first()
  ).toBeVisible({ timeout: 30_000 });
  if (await skip.isVisible()) await skip.click();
  const projects = settings.getByRole('dialog', { name: 'Your projects' });
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

test('removes every device unused for 30 days with one rotation (L11 plan §6)', async ({
  page,
  context
}) => {
  const server = createE2eeServer();
  await stubApi(page);
  await installE2eeServer(context, server);
  await page.goto('/');
  const seeded = await seedE2eeDevice(page, server, {
    label: 'This browser',
    otherDevices: ['Old laptop', 'Old phone', 'Office PC']
  });
  // Days as the Worker recorded them: two devices last read their keys
  // three months ago; recording itself started then too.
  const listed = await loadEncryption(server.nodeDevice());
  if (listed.kind !== 'ready') throw new Error('seed failed');
  const idOf = (label: string) =>
    listed.account.list.devices.find((d) => d.label === label)!.deviceId;
  const old = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  server.db
    .prepare('UPDATE e2ee_device_last_used SET first_day = ?')
    .run(old);
  for (const label of ['Old laptop', 'Old phone'])
    server.db
      .prepare(
        `INSERT INTO e2ee_device_last_used (user_id, device_id, first_day, last_day)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, device_id) DO UPDATE SET last_day = excluded.last_day`
      )
      .run(E2E_USER_ID, idOf(label), old, old);
  const entries = () =>
    (
      server.db
        .prepare('SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
        .get() as { n: number }
    ).n;
  const before = entries();

  const settings = await openEncryptionSettings(page);
  await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
  // Four devices: three listed, this one first, the rest behind Show all.
  await expect(settings.getByText('4 devices', { exact: true })).toBeVisible();
  await expect(settings.getByText('In use now', { exact: false })).toBeVisible();
  await expect(
    settings.getByRole('button', { name: 'Show all 4' })
  ).toBeVisible();
  await settings
    .getByRole('button', { name: 'Remove them', exact: true })
    .click();
  const dialog = settings.getByRole('dialog', {
    name: 'Remove 2 unused devices'
  });
  await expect(dialog).toContainText('Old laptop');
  await expect(dialog).toContainText('Old phone');
  await dialog.getByLabel('Recovery key', { exact: true }).fill(seeded.recoveryKey);
  await dialog.getByRole('button', { name: 'Remove devices' }).click();
  await expect(settings.getByText('2 devices', { exact: true })).toBeVisible();
  await expect(settings.getByText('Old laptop')).toHaveCount(0);
  await expect(settings.getByText('Old phone')).toHaveCount(0);
  await expect(
    settings.getByRole('button', { name: 'Remove them', exact: true })
  ).toHaveCount(0);
  // One device-list entry revoked both, and neither keeps a wrap.
  expect(entries()).toBe(before + 1);
  for (const label of ['Old laptop', 'Old phone'])
    expect(
      server.db
        .prepare('SELECT COUNT(*) AS n FROM e2ee_key_wraps WHERE target_id = ?')
        .get(idOf(label))
    ).toEqual({ n: 0 });
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

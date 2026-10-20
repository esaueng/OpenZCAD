import { expect, stubApi, test } from './openzcad-fixtures';
import {
  createE2eeServer,
  installE2eeServer,
  openEncryptionSettings,
  seedE2eeDevice
} from './e2ee-fixtures';

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

  const recoveryKey = (await settings
    .getByLabel('Recovery key', { exact: true })
    .textContent())!;
  expect(recoveryKey).toMatch(/^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/);
  const proceed = settings.getByRole('button', { name: 'Continue' });
  await expect(proceed).toBeDisabled();
  await settings.getByRole('checkbox', { name: 'I saved my recovery key' }).check();
  await proceed.click();

  // A key that does not match is refused and nothing is set up.
  const confirm = settings.getByLabel('Confirm recovery key');
  await confirm.fill(recoveryKey.replace(/^.{4}/, '0000'));
  await settings.getByRole('button', { name: 'Finish setup' }).click();
  await expect(settings.getByRole('alert')).toContainText(
    'does not match the recovery key above'
  );
  expect(
    server.db.prepare('SELECT COUNT(*) AS n FROM e2ee_identities').get()
  ).toEqual({ n: 0 });

  await confirm.fill(recoveryKey.toLowerCase().replaceAll('-', ' '));
  await settings.getByRole('button', { name: 'Finish setup' }).click();
  await expect(settings.getByText('Certified', { exact: true })).toBeVisible();
  await expect(settings.getByLabel('Your fingerprint')).toHaveText(
    /^(\d{5} ){7}\d{5}$/
  );
  await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
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
  await expect(settings.getByText('Certified', { exact: true })).toBeVisible();
  await expect(settings.getByText('Old laptop')).toBeVisible();
  const before = server.db
    .prepare('SELECT COUNT(*) AS n FROM e2ee_key_wraps')
    .get() as { n: number };

  await settings.getByRole('button', { name: 'Remove Old laptop' }).click();
  await settings.getByLabel('Recovery key', { exact: true }).fill(
    seeded.recoveryKey
  );
  await settings.getByRole('button', { name: 'Remove device' }).click();
  await expect(settings.getByText('Old laptop')).toHaveCount(0);
  await expect(settings.getByText('1 certified')).toBeVisible();
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

test('asks at sign-out whether to keep this device unlocked', async ({
  page,
  context
}) => {
  const server = createE2eeServer();
  await stubApi(page);
  await page.route('**/api/auth/logout', (route) =>
    route.fulfill({ json: { ok: true } })
  );
  await installE2eeServer(context, server);
  await page.goto('/');
  await seedE2eeDevice(page, server);
  await page.getByRole('button', { name: 'Open settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Account', exact: true }).click();
  await settings.getByRole('button', { name: 'Sign out' }).click();
  await expect(settings.getByRole('alert')).toContainText(
    'Keep this device unlocked for your next sign-in?'
  );
  await settings.getByRole('button', { name: 'Remove device keys' }).click();
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
});

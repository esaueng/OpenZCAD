import { expect, stubApi, test } from './openzcad-fixtures';
import {
  createE2eeServer,
  installE2eeServer,
  openEncryptionSettings,
  seedE2eeDevice
} from './e2ee-fixtures';

test('enrolls, unlocks and revokes with a real WebAuthn PRF virtual authenticator', async ({
  page,
  context,
  baseURL
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true
    }
  });
  const server = createE2eeServer();
  await stubApi(page);
  await installE2eeServer(context, server);
  const appUrl = new URL(baseURL!);
  appUrl.hostname = 'localhost';
  await page.goto(appUrl.href);
  const seeded = await seedE2eeDevice(page, server);
  let settings = await openEncryptionSettings(page);
  const fingerprint = await settings
    .getByLabel('Your fingerprint')
    .textContent();
  await settings
    .getByRole('button', { name: 'Add passkey', exact: true })
    .click();
  await settings
    .getByLabel('Recovery key', { exact: true })
    .fill(seeded.recoveryKey);
  await settings
    .getByRole('button', { name: 'Create passkey', exact: true })
    .click();
  await expect(
    settings.getByRole('button', { name: 'Remove passkey 1', exact: true })
  ).toBeVisible();
  await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
  await expect(page).toHaveTitle(/OpenZCAD/);
  expect(new URL(page.url()).pathname).toBe('/');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  if (process.env.PASSKEY_QA_SCREENSHOTS) {
    await page.screenshot({
      path: `${process.env.PASSKEY_QA_SCREENSHOTS}/passkey-enrolled.png`
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await settings
      .getByRole('button', { name: 'Remove passkey 1', exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${process.env.PASSKEY_QA_SCREENSHOTS}/passkey-mobile.png`
    });
    await page.setViewportSize({ width: 1280, height: 720 });
  }

  // Retain only the rollback pin and authenticator: reload loses the page's
  // account cache. PRF must open its target and certify fresh device keys.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('openzcad-e2ee', 1);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('devices', 'readwrite');
          tx.objectStore('devices').clear();
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () =>
            reject(
              new Error(tx.error?.message ?? 'Device-key transaction failed')
            );
        };
        request.onerror = () =>
          reject(
            new Error(
              request.error?.message ?? 'Device-key database did not open'
            )
          );
      })
  );
  await page.reload();
  settings = await openEncryptionSettings(page);
  await settings
    .getByRole('button', { name: 'Use passkey', exact: true })
    .click();
  await expect(settings.getByText('Certified', { exact: true })).toBeVisible();
  await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
  await expect(settings.getByLabel('Your fingerprint')).toHaveText(
    fingerprint!
  );

  await settings
    .getByRole('button', { name: 'Remove passkey 1', exact: true })
    .click();
  await settings
    .getByRole('button', { name: 'Confirm with passkey', exact: true })
    .click();
  await expect(
    settings.getByRole('button', { name: 'Remove passkey 1', exact: true })
  ).toHaveCount(0);
  await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
  expect(
    server.db
      .prepare(
        "SELECT COUNT(*) AS n FROM e2ee_key_wraps WHERE target_id LIKE 'pk_%'"
      )
      .get()
  ).toEqual({ n: 0 });
  expect(
    server.db
      .prepare('SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
      .get()
  ).toEqual({ n: 4 });
  expect(errors).toEqual([]);
});

test('reports unsupported PRF and keeps recovery enrollment intact', async ({
  page,
  context,
  baseURL
}) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: false
    }
  });
  const server = createE2eeServer();
  await stubApi(page);
  await installE2eeServer(context, server);
  const appUrl = new URL(baseURL!);
  appUrl.hostname = 'localhost';
  await page.goto(appUrl.href);
  const seeded = await seedE2eeDevice(page, server);
  const settings = await openEncryptionSettings(page);
  await settings
    .getByRole('button', { name: 'Add passkey', exact: true })
    .click();
  await settings
    .getByLabel('Recovery key', { exact: true })
    .fill(seeded.recoveryKey);
  await settings
    .getByRole('button', { name: 'Create passkey', exact: true })
    .click();
  await expect(settings.getByRole('alert')).toContainText(
    'does not support PRF'
  );
  expect(
    server.db
      .prepare('SELECT COUNT(*) AS n FROM e2ee_device_list_entries')
      .get()
  ).toEqual({ n: 1 });
  await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(settings.getByText('Confirmed', { exact: true })).toBeVisible();
  await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
});

test('disables passkeys when WebAuthn is unavailable', async ({
  page,
  context
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'PublicKeyCredential', { value: undefined });
  });
  const server = createE2eeServer();
  await stubApi(page);
  await installE2eeServer(context, server);
  await page.goto('/');
  await seedE2eeDevice(page, server);
  const settings = await openEncryptionSettings(page);
  await expect(
    settings.getByRole('button', { name: 'Add passkey', exact: true })
  ).toBeDisabled();
  await expect(
    settings.getByText(
      'Passkeys are unavailable here. Use your recovery key or another device.'
    )
  ).toBeVisible();
  await expect(settings.getByText('Unlocked', { exact: true })).toBeVisible();
});
